import { open, readdir } from "node:fs/promises"
import { join } from "node:path"
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

// Not module scope: OpenCode runs setup once per location and a reload can
// leave an older copy listening, and every copy receives every event.
const shared = (globalThis.__opencodeSidepulse ??= {
  running: new Set(),
  waiting: new Map(),
  seen: new Set(),
  queue: Promise.resolve(),
})

function apply({ type, data }) {
  const { running, waiting } = shared
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
    default:
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
  shared.queue = shared.queue.then(() =>
    write(root, PROGRAMS[shared.waiting.size ? "waiting" : shared.running.size ? "working" : "idle"]),
  )
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
        apply(event)
        sync(root)
      }
    })().catch((error) => controller.signal.aborted || console.error("[sidepulse]", error))
    return () => {
      controller.abort()
      // Not kept across a gap with no subscriber: events are not replayed, so a
      // session that ended meanwhile would stay counted as running forever.
      if (--shared.subscribers) return
      shared.running.clear()
      shared.waiting.clear()
    }
  },
}
