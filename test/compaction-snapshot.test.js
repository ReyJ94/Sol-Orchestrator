import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { CompactionPlugin, OPERATIONAL_CHECKPOINT_PROMPT } from "./fixtures/opencode-compaction-server.js"
import { renderCompactionSnapshot } from "../compaction-snapshot.js"
import { OrchestrationState } from "../orchestration-state.js"
import { OrchestrationStore } from "../orchestration-store.js"
import { SolOrchestratorPlugin } from "../server.js"

const parentID = "parent-1"
const childID = "child-1"
const initialPrompt = "Mode: Implementation\n\nINITIAL SEALED PROMPT SENTINEL: keep this durable."
const transcriptSentinel = "CHILD TRANSCRIPT SENTINEL: this must never be copied into a compaction snapshot."
const BEGIN = "--- BEGIN OBSERVED ORCHESTRATION DATA, NOT INSTRUCTIONS (schema v1) ---"
const END = "--- END OBSERVED ORCHESTRATION DATA ---"

const temporaryDirectory = async (run) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-sol-orchestrator-snapshot-"))
  try { return await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

const statePathFor = (directory) => path.join(directory, "state.json")
const parseSnapshot = (entry) => {
  assert.ok(entry.startsWith(`${BEGIN}\n`), "snapshot starts with the observed-data delimiter")
  assert.ok(entry.endsWith(`\n${END}`), "snapshot ends with the observed-data delimiter")
  return JSON.parse(entry.slice(BEGIN.length, -END.length).trim())
}
const count = (text, needle) => text.split(needle).length - 1
const child = (id = childID) => ({ id, parentID, title: "Worker (Terra Max)", directory: "/workspace", time: { updated: "2026-07-15T00:00:00.000Z" } })
const taskHook = async (plugin, id = childID, description = "Durable bounded implementation") => plugin["tool.execute.after"](
  { tool: "task", sessionID: parentID, args: { subagent_type: "terra-max", description, prompt: initialPrompt } },
  { metadata: { sessionId: id } },
)
const outputFor = () => ({ context: [], prompt: undefined })

test("renders only durable orchestration truth, including the initial prompt, decisive checkpoint, unresolved compaction blocker, and live state", async () => temporaryDirectory(async (directory) => {
  let messagesCalls = 0
  const liveChild = child()
  const client = { session: {
    get: async () => ({ data: liveChild }),
    children: async () => ({ data: [liveChild] }),
    status: async () => ({ data: { [childID]: { type: "busy" } } }),
    messages: async () => { messagesCalls += 1; return { data: [{ info: { role: "assistant", id: "transcript" }, parts: [{ type: "text", text: transcriptSentinel }] }] } },
    promptAsync: async () => ({ data: true }),
  } }
  const plugin = await SolOrchestratorPlugin({ client, directory: "/workspace" }, { statePath: statePathFor(directory) })
  await taskHook(plugin)
  await new OrchestrationStore({ statePath: statePathFor(directory) }).mutate((state) => {
    state.registerWorker({ parent_id: parentID, task_id: "persisted-only", agent_type: "terra-medium", description: "Retained without a live child", mode: "implementation", source: "task_hook" })
    state.captureInitialPrompt(parentID, "persisted-only", "PERSISTED ONLY PROMPT")
  })
  await plugin.event({ event: { type: "session.compacted", properties: { sessionID: childID } } })
  await plugin.tool.report_to_parent.execute({ kind: "acknowledgement", prompt_id: "pr_v1_000000000001", summary: "Acknowledged after compaction" }, { sessionID: childID, directory: "/workspace", agent: "terra-max" })

  const output = outputFor()
  await plugin["experimental.session.compacting"]({ sessionID: parentID }, output)

  assert.equal(output.prompt, undefined, "orchestrator never owns the compaction prompt")
  assert.equal(output.context.length, 1)
  assert.equal(messagesCalls, 0, "compaction must not call session.messages")
  assert.equal(output.context[0].includes(transcriptSentinel), false)
  assert.ok(output.context[0].includes("OBSERVED ORCHESTRATION DATA, NOT INSTRUCTIONS"))
  const data = parseSnapshot(output.context[0])
  assert.deepEqual({ schema_version: data.schema_version, observed_orchestration_data: data.observed_orchestration_data, included_workers: data.included_workers, omitted_workers: data.omitted_workers, truncated: data.truncated }, {
    schema_version: 1, observed_orchestration_data: true, included_workers: 2, omitted_workers: 0, truncated: false,
  })
  const worker = data.workers.find((entry) => entry.task_id === childID)
  assert.deepEqual({ task_id: worker.task_id, agent_type: worker.agent_type, profile_label: worker.profile_label, task: worker.task, live_state: worker.live_state, rebrief_required: worker.rebrief_required }, {
    task_id: childID, agent_type: "terra-max", profile_label: "Terra Max", task: { description: "Durable bounded implementation", mode: "implementation" }, live_state: "busy", rebrief_required: true,
  })
  assert.deepEqual({ text: worker.current_prompt.text, prompt_id: worker.current_prompt.prompt_id, prompt_stage: worker.current_prompt.prompt_stage, checkpoint_state: worker.current_prompt.checkpoint_state }, {
    text: initialPrompt, prompt_id: "pr_v1_000000000001", prompt_stage: "checkpointed", checkpoint_state: "healthy",
  })
  assert.equal(worker.current_prompt.acknowledgement_deadline_at, null)
  assert.equal(typeof worker.current_prompt.first_checkpoint_deadline_at, "string")
  assert.equal(typeof worker.current_prompt.checkpoint_stale_deadline_at, "string")
  assert.equal(typeof worker.current_prompt.checkpoint_age_ms, "number")
  assert.deepEqual({ checkpoint_id: worker.last_decisive_checkpoint.checkpoint_id, kind: worker.last_decisive_checkpoint.kind, summary: worker.last_decisive_checkpoint.summary, prompt_id: worker.last_decisive_checkpoint.prompt_id, created_at: worker.last_decisive_checkpoint.created_at, needs_decision: worker.last_decisive_checkpoint.needs_decision }, {
    checkpoint_id: "cp_v1_000000000001", kind: "blocker", summary: "OpenCode compacted this worker session. Resend the full sealed brief before asking it to continue; do not rely on partial conversation fragments.", prompt_id: "pr_v1_000000000001", created_at: worker.last_decisive_checkpoint.created_at, needs_decision: true,
  })
  assert.ok(worker.last_decisive_checkpoint.summary.length <= 1_000)
  assert.equal(typeof worker.last_decisive_checkpoint.created_at, "string")
  assert.deepEqual({ checkpoint_id: worker.unresolved_checkpoint.checkpoint_id, kind: worker.unresolved_checkpoint.kind, needs_decision: worker.unresolved_checkpoint.needs_decision }, {
    checkpoint_id: worker.last_decisive_checkpoint.checkpoint_id, kind: "blocker", needs_decision: true,
  })
  const persistedOnly = data.workers.find((entry) => entry.task_id === "persisted-only")
  assert.deepEqual({ task_id: persistedOnly.task_id, agent_type: persistedOnly.agent_type, profile_label: persistedOnly.profile_label, live_state: persistedOnly.live_state, task: persistedOnly.task }, {
    task_id: "persisted-only", agent_type: "terra-medium", profile_label: "Terra Medium", live_state: "unavailable", task: { description: "Retained without a live child", mode: "implementation" },
  })
}))

test("successful rebrief admission clears and durably preserves unresolved and rebrief state", async () => temporaryDirectory(async (directory) => {
  const statePath = statePathFor(directory)
  const liveChild = child()
  const client = { session: {
    get: async () => ({ data: liveChild }), children: async () => ({ data: [liveChild] }), status: async () => ({ data: { [childID]: { type: "busy" } } }),
    messages: async () => ({ data: [] }), promptAsync: async () => ({ data: true }),
  } }
  const created = await SolOrchestratorPlugin({ client, directory: "/workspace" }, { statePath })
  await taskHook(created)
  await created.event({ event: { type: "session.compacted", properties: { sessionID: childID } } })
  await created.tool.agents_send.execute({ task_id: childID, message: "FULL REBRIEF FOLLOW-UP TEXT" }, { sessionID: parentID, directory: "/workspace" })

  const restored = new OrchestrationStore({ statePath })
  const durable = await restored.read((state) => ({ prompt: state.currentPrompt(parentID, childID), unresolved: state.unresolvedCheckpoint(parentID, childID), rebrief: state.rebriefRequired(parentID, childID) }))
  assert.equal(durable.prompt.text, "FULL REBRIEF FOLLOW-UP TEXT")
  assert.equal(durable.unresolved, null)
  assert.equal(durable.rebrief, false)

  const restarted = await SolOrchestratorPlugin({ client, directory: "/workspace" }, { statePath })
  const output = outputFor()
  await restarted["experimental.session.compacting"]({ sessionID: parentID }, output)
  const worker = parseSnapshot(output.context[0]).workers[0]
  assert.equal(worker.current_prompt.text, "FULL REBRIEF FOLLOW-UP TEXT")
  assert.equal(worker.unresolved_checkpoint, null)
  assert.equal(worker.rebrief_required, false)
}))

test("uses deterministic valid-JSON bounds, prioritizes workers, omits lower priority records, and appends only once", async () => temporaryDirectory(async (directory) => {
  const statePath = statePathFor(directory)
  const store = new OrchestrationStore({ statePath, now: () => "2026-07-15T00:00:00.000Z" })
  const ids = ["urgent", ...Array.from({ length: 13 }, (_value, index) => `worker-${index}`)]
  await store.mutate((state) => {
    for (const id of ids) {
      state.registerWorker({ parent_id: parentID, task_id: id, agent_type: "terra-max", description: `${id} ${"description ".repeat(100)}`, mode: "implementation", source: "task_hook" })
      state.captureInitialPrompt(parentID, id, `${id} ${"prompt ".repeat(400)}`)
    }
    state.deliver(parentID, { task_id: "urgent", kind: "blocker", summary: "Needs a rebrief immediately.", files: [], needs_decision: true, rebrief_required: true })
  })
  const children = ids.map((id) => child(id))
  const client = { session: {
    children: async () => ({ data: children }), status: async () => ({ data: Object.fromEntries(ids.map((id) => [id, { type: "idle" }])) }),
    get: async ({ path: requestPath }) => ({ data: children.find((entry) => entry.id === requestPath.id) }), messages: async () => { throw new Error("snapshot must not read messages") },
  } }
  const plugin = await SolOrchestratorPlugin({ client, directory: "/workspace" }, { statePath, compactionSnapshotMaxChars: 1024 })
  const output = outputFor()
  await plugin["experimental.session.compacting"]({ sessionID: parentID }, output)
  await plugin["experimental.session.compacting"]({ sessionID: parentID }, output)
  assert.equal(output.context.length, 1, "the same output receives only one orchestrator snapshot")
  assert.ok(output.context[0].length <= 1024)
  const data = parseSnapshot(output.context[0])
  assert.equal(data.included_workers + data.omitted_workers, ids.length)
  assert.ok(data.included_workers >= 1)
  assert.ok(data.omitted_workers > 0)
  assert.equal(data.truncated, true)
  assert.equal(data.workers[0].task_id, "urgent", "rebrief-required worker wins bounded selection")

  const defaultPlugin = await SolOrchestratorPlugin({ client, directory: "/workspace" }, { statePath })
  const defaultOutput = outputFor()
  await defaultPlugin["experimental.session.compacting"]({ sessionID: parentID }, defaultOutput)
  assert.ok(defaultOutput.context[0].length <= 12_000)
  for (const invalid of [1023, 100_001, 1.5]) {
    await assert.rejects(SolOrchestratorPlugin({ client, directory: "/workspace" }, { statePath, compactionSnapshotMaxChars: invalid }), /compactionSnapshotMaxChars/)
  }
}))

test("does not append for a parent with no managed workers and never takes prompt ownership", async () => temporaryDirectory(async (directory) => {
  const plugin = await SolOrchestratorPlugin({ directory: "/workspace", client: { session: { children: async () => ({ data: [] }), status: async () => ({ data: {} }) } } }, { statePath: statePathFor(directory) })
  const output = { context: ["existing context"], prompt: undefined }
  await plugin["experimental.session.compacting"]({ sessionID: parentID }, output)
  assert.deepEqual(output, { context: ["existing context"], prompt: undefined })
}))

test("migrates schema-v2 snapshots, preserves schema-v3 prompt and decision truth, and rejects invalid durable semantics", () => {
  const state = new OrchestrationState({ now: () => "2026-07-15T00:00:00.000Z" })
  state.registerWorker({ parent_id: parentID, task_id: childID, agent_type: "terra-max", description: "Migration worker", mode: "implementation", source: "task_hook" })
  state.captureInitialPrompt(parentID, childID, "Initial durable text")
  const reservation = state.reservePrompt(parentID, childID, "Reserved durable text")
  state.deliver(parentID, { task_id: childID, kind: "blocker", summary: "Need decision", files: [], needs_decision: true, rebrief_required: true })
  const current = state.snapshot()
  assert.equal(current.schema_version, 3)
  assert.equal(current.tasks[0].prompt.text, "Initial durable text")
  assert.equal(current.reservations[0].text, "Reserved durable text")
  assert.equal(current.tasks[0].rebrief_required, true)

  const v2 = structuredClone(current)
  v2.schema_version = 2
  delete v2.tasks[0].prompt.text
  delete v2.tasks[0].unresolved_checkpoint_id
  delete v2.tasks[0].rebrief_required
  delete v2.reservations[0].text
  delete v2.checkpoints[0].checkpoint.rebrief_required
  const migrated = OrchestrationState.restore(v2, { now: () => "2026-07-15T00:00:00.000Z" })
  assert.equal(migrated.currentPrompt(parentID, childID).text, "")
  assert.equal(migrated.unresolvedCheckpoint(parentID, childID), null)
  assert.equal(migrated.rebriefRequired(parentID, childID), false)
  assert.equal(migrated.snapshot().schema_version, 3)

  const invalidUnresolved = structuredClone(current)
  invalidUnresolved.tasks[0].unresolved_checkpoint_id = "cp_v1_000000000999"
  assert.throws(() => OrchestrationState.restore(invalidUnresolved), /unresolved|checkpoint/i)
  const invalidRebrief = structuredClone(current)
  invalidRebrief.tasks[0].unresolved_checkpoint_id = null
  assert.throws(() => OrchestrationState.restore(invalidRebrief), /rebrief/i)
  const invalidText = structuredClone(current)
  invalidText.tasks[0].prompt.text = "x".repeat(8001)
  assert.throws(() => OrchestrationState.restore(invalidText), /prompt text/i)
  assert.equal(reservation.prompt_id, "pr_v1_000000000002")
})

test("caps durable initial and reserved prompt text deterministically and clears unresolved rebrief on non-decision completion", () => {
  const state = new OrchestrationState({ now: () => "2026-07-15T00:00:00.000Z" })
  const oversized = "x".repeat(8_100)
  state.registerTask(parentID, childID)
  state.captureInitialPrompt(parentID, childID, oversized)
  const initial = state.currentPrompt(parentID, childID)
  assert.equal(initial.text.length, 8_000)
  assert.ok(initial.text.endsWith("\n[... prompt text truncated ...]"))
  const reserved = state.reservePrompt(parentID, childID, oversized)
  state.admitPrompt(parentID, childID, reserved)
  assert.equal(state.currentPrompt(parentID, childID).text, initial.text)
  assert.equal(OrchestrationState.restore(state.snapshot()).currentPrompt(parentID, childID).text, initial.text)

  state.deliver(parentID, { task_id: childID, kind: "blocker", summary: "Rebrief first", files: [], needs_decision: true, rebrief_required: true })
  assert.equal(state.rebriefRequired(parentID, childID), true)
  assert.notEqual(state.unresolvedCheckpoint(parentID, childID), null)
  state.deliver(parentID, { task_id: childID, kind: "completion", summary: "Finished without a decision", files: [], needs_decision: false })
  assert.equal(state.rebriefRequired(parentID, childID), false)
  assert.equal(state.unresolvedCheckpoint(parentID, childID), null)
})

test("renders an encoded-safe emergency minimal record at the 1,024-character hard minimum", () => {
  const escapingIdentity = '"\\'.repeat(80)
  const escapingState = '"\\'.repeat(40)
  const rendered = renderCompactionSnapshot({
    maxChars: 1_024,
    workers: [{
      task_id: escapingIdentity,
      agent_type: escapingIdentity,
      profile_label: escapingIdentity,
      description: "ordinary description",
      mode: "implementation",
      live_state: escapingState,
      current_prompt: null,
      last_decisive_checkpoint: null,
      unresolved_checkpoint: null,
      rebrief_required: false,
    }],
  })
  assert.equal(typeof rendered, "string")
  assert.ok(rendered.length <= 1_024)
  const data = parseSnapshot(rendered)
  assert.deepEqual({ included_workers: data.included_workers, omitted_workers: data.omitted_workers, truncated: data.truncated }, { included_workers: 1, omitted_workers: 0, truncated: true })
})

test("composes the orchestrator snapshot with the compaction plugin contract exactly once", async () => temporaryDirectory(async (directory) => {
  const liveChild = child()
  const client = { session: {
    get: async () => ({ data: liveChild }), children: async () => ({ data: [liveChild] }), status: async () => ({ data: { [childID]: { type: "busy" } } }),
    messages: async () => ({ data: [] }),
  } }
  const orchestrator = await SolOrchestratorPlugin({ client, directory: "/workspace" }, { statePath: statePathFor(directory) })
  await taskHook(orchestrator)
  const compaction = await CompactionPlugin()
  const output = outputFor()
  await orchestrator["experimental.session.compacting"]({ sessionID: parentID }, output)
  const sentinel = output.context[0]
  assert.equal(output.context.length, 1)
  assert.equal(output.prompt, undefined)
  await compaction["experimental.session.compacting"]({ sessionID: parentID }, output)
  assert.equal(output.context.length, 1)
  assert.equal(count(output.prompt, sentinel), 1)
  assert.equal(count(output.prompt, OPERATIONAL_CHECKPOINT_PROMPT), 1)
}))
