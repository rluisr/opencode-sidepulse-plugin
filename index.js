import { open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import profile from "./profile.json" with { type: "json" }

const BUILTIN = {
  "amber-pulse": "off\n#FF3A00 1.6s pulse\nrepeat\n",
  "cyan-complete": "#00E5FF 320ms cosine\n",
  "cyan-roll":
    "off 320ms cosine\n0:#00E5FF 760ms pulse 0ms; 1:#00E5FF 760ms pulse 95ms; 2:#00E5FF 760ms pulse 190ms; 3:#00E5FF 760ms pulse 285ms; 4:#00E5FF 760ms pulse 380ms; 5:#00E5FF 760ms pulse 475ms; 6:#00E5FF 760ms pulse 570ms; 7:#00E5FF 760ms pulse 665ms\nrepeat\n",
}

function program(state) {
  const id = profile.animations[state]
  const text = profile.custom_animations[id]?.program ?? BUILTIN[id]
  if (!text) throw new Error(`sidepulse: no LED program for animation "${id}"`)
  return text
}

const PROGRAMS = {
  waiting: program("waiting_for_input"),
  working: program("working"),
  idle: program("completed"),
}

const TYPES = [
  "session.execution.started",
  "session.step.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
]

const STALL = 45_000
const RETRY = 5_000

// Not module scope: OpenCode runs setup once per location and a reload can
// leave an older copy listening, and every copy receives every event.
const shared = (globalThis.__opencodeSidepulse ??= { seen: new Set(), queue: Promise.resolve() })
shared.sources ??= new Map()
shared.remotes ??= new Map()

function source(key) {
  if (!shared.sources.has(key)) shared.sources.set(key, { running: new Set(), waiting: new Map() })
  return shared.sources.get(key)
}

function apply({ running, waiting }, { type, data }) {
  switch (type) {
    case "session.execution.started":
    // Not execution.started alone: the plugin context has no session.active, so a
    // session already running when the plugin loads is first seen at its next step.
    case "session.step.started":
      return running.add(data.sessionID)
    case "permission.asked":
      running.add(data.sessionID)
      return waiting.set(data.id, data.sessionID)
    // Not counted as running like a permission: a form can belong to an idle
    // session or to "global", which never reports an end of execution.
    case "form.created":
      return waiting.set(data.form.id, data.form.sessionID)
    case "permission.replied":
      return waiting.delete(data.requestID)
    case "form.replied":
    case "form.cancelled":
      return waiting.delete(data.id)
    // Not a default branch: a server that ignores the type filter sends every event.
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.deleted":
      running.delete(data.sessionID)
      for (const [id, sessionID] of waiting) if (sessionID === data.sessionID) waiting.delete(id)
  }
}

async function write(root, text) {
  const volumes = await readdir(root).catch(() => [])
  await Promise.allSettled(
    volumes.map(async (volume) => {
      // Not "w": that would create LEDS.LED on every mounted volume.
      const file = await open(join(root, volume, "LEDS.LED"), "r+")
      try {
        // Not a remembered last write: the SidePulse daemon and `echo` write this file too.
        if ((await file.readFile("utf8")) === text) return
        await file.truncate()
        await file.write(text, 0)
        await file.sync()
      } finally {
        await file.close()
      }
    }),
  )
}

// Not awaited by the event loop: a stalled volume would overflow the event stream.
function sync(root) {
  shared.queue = shared.queue.then(() => {
    const sources = [...shared.sources.values()]
    const state = sources.some((s) => s.waiting.size) ? "waiting" : sources.some((s) => s.running.size) ? "working" : "idle"
    return write(root, PROGRAMS[state])
  })
}

async function connect({ url, password }, state, root, signal) {
  // Not left to TCP: after sleep or a network change the socket stays open but
  // silent, and the remote's last state would stay on the LEDs.
  const stall = new AbortController()
  let timer
  const alive = () => {
    clearTimeout(timer)
    timer = setTimeout(() => stall.abort(new Error("no heartbeat")), STALL)
  }
  const get = async (path) => {
    const response = await fetch(new URL(path, url), {
      // Not btoa: it throws on a password outside Latin-1, and the server compares UTF-8 bytes.
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      signal: AbortSignal.any([signal, stall.signal]),
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
  }
  const json = async (path) => (await get(path)).json()
  const resync = async () => {
    // Not the active sessions' own lists: a form can belong to an idle session.
    // Not the session list's directories: asking about a location that is not loaded makes the server load it.
    const [active, locations] = await Promise.all([json("/api/session/active"), json("/api/debug/location")])
    const pending = await Promise.all(
      locations.flatMap(({ directory }) =>
        ["/api/form", "/api/permission/request"].map((path) =>
          json(`${path}?${new URLSearchParams({ "location[directory]": directory })}`),
        ),
      ),
    )
    state.running.clear()
    state.waiting.clear()
    for (const id of Object.keys(active.data)) state.running.add(id)
    for (const { data } of pending) for (const item of data) state.waiting.set(item.id, item.sessionID)
  }

  alive()
  try {
    const response = await get(`/api/event?${new URLSearchParams(TYPES.map((type) => ["types", type]))}`)
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of response.body) {
      alive()
      const lines = (buffer + decoder.decode(chunk, { stream: true })).split("\n")
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const event = JSON.parse(line.slice(5))
        // Not only at startup: events are not replayed, so every new connection starts from a snapshot.
        if (event.type === "server.connected") await resync()
        else apply(state, event)
        sync(root)
      }
    }
    throw new Error("event stream ended")
  } finally {
    clearTimeout(timer)
    // Not left to finish: a snapshot request that never answers would pile up one socket per retry.
    stall.abort()
  }
}

async function follow(server, root, signal) {
  const state = source(server.url)
  let logged
  while (!signal.aborted) {
    await connect(server, state, root, signal).catch((error) => {
      if (signal.aborted || error.message === logged) return
      console.error("[sidepulse]", server.url, (logged = error.message))
    })
    if (signal.aborted) return
    // Not kept while disconnected: an unreachable server's sessions would stay counted as running.
    state.running.clear()
    state.waiting.clear()
    sync(root)
    await sleep(RETRY, undefined, { signal }).catch(() => {})
  }
}

export default {
  id: "sidepulse",

  setup(ctx) {
    const root = ctx.options?.root ?? "/Volumes"
    const controller = new AbortController()
    shared.subscribers = (shared.subscribers ?? 0) + 1
    sync(root)
    ;(async () => {
      for await (const event of ctx.event.subscribe({ types: TYPES, signal: controller.signal })) {
        if (shared.seen.has(event.id)) continue
        shared.seen.add(event.id)
        if (shared.seen.size > 1000) shared.seen.delete(shared.seen.values().next().value)
        apply(source("local"), event)
        sync(root)
      }
    })().catch((error) => controller.signal.aborted || console.error("[sidepulse]", error))
    const servers = ctx.options?.servers ?? []
    for (const { url, password } of servers) {
      let remote = shared.remotes.get(url)
      // Not one connection per setup: every location would open its own stream to each server.
      if (!remote || remote.password !== password) {
        remote?.controller.abort()
        remote = { password, controller: new AbortController(), count: remote?.count ?? 0 }
        shared.remotes.set(url, remote)
        follow({ url, password }, root, remote.controller.signal)
      }
      remote.count++
    }
    return () => {
      controller.abort()
      // Not held until the last instance unloads: a server dropped from the options would stay counted.
      for (const { url } of servers) {
        const remote = shared.remotes.get(url)
        if (--remote.count) continue
        remote.controller.abort()
        shared.remotes.delete(url)
        shared.sources.delete(url)
      }
      // Not kept across a gap with no subscriber: events are not replayed, so a
      // session that ended meanwhile would stay counted as running forever.
      if (!--shared.subscribers) shared.sources.delete("local")
      sync(root)
    }
  },
}
