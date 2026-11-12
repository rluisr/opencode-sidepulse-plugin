import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index.js"

const COMPLETE = /^#00E5FF 320ms cosine\n$/
const ROLL = /^off 320ms cosine\n0:#00E5FF 760ms pulse 0ms; .* 7:#00E5FF 760ms pulse 665ms\nrepeat\n$/
const AMBER = /^off\n#FF3A00 1\.6s pulse\nrepeat\n$/

const root = await mkdtemp(join(tmpdir(), "sidepulse-"))
const led = join(root, "SidePulse", "LEDS.LED")
await mkdir(join(root, "SidePulse"))
await mkdir(join(root, "Other"))
await writeFile(led, "#ffffff\n".repeat(60))

const pending = []
let wake
async function* stream() {
  for (;;) {
    while (pending.length) yield pending.shift()
    await new Promise((resolve) => (wake = resolve))
  }
}

let count = 0
function emit(type, data, id = `evt_${count++}`) {
  pending.push({ id, type, data })
  wake?.()
}

async function shows(pattern, when) {
  for (let i = 0; i < 100; i++) {
    if (pattern.test(await readFile(led, "utf8"))) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`${when}: LEDS.LED is ${JSON.stringify(await readFile(led, "utf8"))}`)
}

const cleanup = plugin.setup({ options: { root }, event: { subscribe: stream } })
await shows(COMPLETE, "no active session")

emit("session.execution.started", { sessionID: "ses_a" }, "evt_start")
await shows(ROLL, "a session is running")

emit("form.created", { form: { id: "frm_1", sessionID: "ses_a" } })
await shows(AMBER, "a question is pending")

emit("form.replied", { id: "frm_1", sessionID: "ses_a" })
await shows(ROLL, "the question was answered")

emit("permission.asked", { id: "per_1", sessionID: "ses_a" })
await shows(AMBER, "a permission is pending")

emit("session.execution.interrupted", { sessionID: "ses_a", reason: "user" })
await shows(COMPLETE, "the session was interrupted while waiting")

emit("session.execution.started", { sessionID: "ses_a" }, "evt_start")
emit("form.created", { form: { id: "frm_0", sessionID: "ses_b" } })
await shows(AMBER, "an idle session has a pending form")
emit("form.replied", { id: "frm_0", sessionID: "ses_b" })
await shows(COMPLETE, "an event delivered twice is applied once")

await writeFile(led, "#ff0000\n")
emit("session.deleted", { sessionID: "ses_c" })
await shows(COMPLETE, "another writer's program is replaced on the next event")

emit("session.step.started", { sessionID: "ses_d" })
await shows(ROLL, "a session that was running before the plugin loaded takes a step")
emit("session.execution.succeeded", { sessionID: "ses_d" })
await shows(COMPLETE, "the last session finished")

emit("permission.asked", { id: "per_3", sessionID: "ses_f" })
await shows(AMBER, "a session first seen through its permission request")
emit("permission.replied", { sessionID: "ses_f", requestID: "per_3" })
await shows(ROLL, "the approved tool is still running")
emit("session.execution.succeeded", { sessionID: "ses_f" })
await shows(COMPLETE, "that session finished")

emit("form.created", { form: { id: "frm_2", sessionID: "global" } })
await shows(AMBER, "a form that belongs to no session is pending")
emit("form.cancelled", { id: "frm_2", sessionID: "global" })
await shows(COMPLETE, "a form alone does not count as a running session")

emit("session.execution.started", { sessionID: "ses_e" })
await shows(ROLL, "a session is running at unload")
cleanup()
plugin.setup({ options: { root }, event: { subscribe: stream } })()
await shows(COMPLETE, "a session that ended while the plugin was unloaded is not counted")

assert.equal(existsSync(join(root, "Other", "LEDS.LED")), false, "only volumes that already have LEDS.LED are written")
console.log("ok")
