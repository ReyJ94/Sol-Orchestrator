import assert from "node:assert/strict"
import test from "node:test"
import { OrchestrationState } from "./orchestration-state.js"

const parentID = "parent-1"
const taskID = "task-1"
const checkpoint = (state, kind = "evidence", summary = "Checkpoint") => state.deliver(parentID, { task_id: taskID, agent_type: "terra-max", kind, summary, files: [], needs_decision: false })

test("allocates immutable versioned checkpoint IDs in global sequence order", () => {
  const state = new OrchestrationState({ now: () => "2026-07-15T00:00:00.000Z" })
  const first = checkpoint(state)
  const second = checkpoint(state, "diff")

  assert.deepEqual(
    { schema_version: first.checkpoint.schema_version, sequence: first.checkpoint.sequence, checkpoint_id: first.checkpoint.checkpoint_id },
    { schema_version: 1, sequence: 1, checkpoint_id: "cp_v1_000000000001" },
  )
  assert.equal(first.checkpoint.worker_turn, 1)
  assert.deepEqual(
    { schema_version: second.checkpoint.schema_version, sequence: second.checkpoint.sequence, checkpoint_id: second.checkpoint.checkpoint_id },
    { schema_version: 1, sequence: 2, checkpoint_id: "cp_v1_000000000002" },
  )
  assert.throws(() => { first.checkpoint.summary = "Changed" }, TypeError)
})

test("filters reads strictly after a validated task checkpoint", () => {
  const state = new OrchestrationState()
  const first = checkpoint(state).checkpoint
  const second = checkpoint(state, "diff").checkpoint
  const third = checkpoint(state, "blocker").checkpoint

  assert.deepEqual(state.read(parentID, taskID, { after: first.checkpoint_id }).checkpoints.map((entry) => entry.checkpoint_id), [second.checkpoint_id, third.checkpoint_id])
  assert.throws(() => state.read(parentID, "task-2", { after: first.checkpoint_id }), /belongs to task task-1/)
  assert.throws(() => state.read("parent-2", taskID, { after: first.checkpoint_id }), /different parent session/)
  assert.throws(() => state.read(parentID, taskID, { after: "not-a-checkpoint" }), /Malformed checkpoint ID/)
  assert.throws(() => state.read(parentID, taskID, { after: "cp_v1_000000000004" }), /future/)
})

test("consumes exactly through one task checkpoint without deleting history", () => {
  const state = new OrchestrationState()
  const first = checkpoint(state).checkpoint
  const second = checkpoint(state, "diff").checkpoint
  const third = checkpoint(state, "blocker").checkpoint

  state.consumeThrough(parentID, taskID, second.checkpoint_id)

  assert.equal(state.cursor(parentID, taskID).consumed_through, second.checkpoint_id)
  assert.deepEqual(state.read(parentID, taskID).checkpoints.map((entry) => entry.checkpoint_id), [third.checkpoint_id])
  assert.deepEqual(state.read(parentID, taskID, { after: first.checkpoint_id }).checkpoints.map((entry) => entry.checkpoint_id), [second.checkpoint_id, third.checkpoint_id])
  assert.deepEqual(state.snapshot().checkpoints.map((entry) => entry.checkpoint.checkpoint_id), [first.checkpoint_id, second.checkpoint_id, third.checkpoint_id])
})

test("serializes cursor and terminal turn state without opaque runtime-only truth", () => {
  const state = new OrchestrationState()
  const first = checkpoint(state).checkpoint
  const completion = checkpoint(state, "completion", "Done")
  state.consumeThrough(parentID, taskID, first.checkpoint_id)

  const restored = OrchestrationState.restore(state.snapshot())
  assert.equal(restored.cursor(parentID, taskID).consumed_through, first.checkpoint_id)
  assert.equal(restored.turn(parentID, taskID).terminal_completion_id, completion.checkpoint.checkpoint_id)
  assert.equal(restored.read(parentID, taskID).checkpoints[0].worker_turn, completion.checkpoint.worker_turn)
  assert.equal(restored.deliver(parentID, { task_id: taskID, kind: "completion", summary: "Duplicate", files: [], needs_decision: false }).duplicate, true)

  const invalidTurn = state.snapshot()
  invalidTurn.checkpoints[0].checkpoint.worker_turn = 2
  assert.throws(() => OrchestrationState.restore(invalidTurn), /Invalid orchestration worker turn/)
})

test("deduplicates terminal completion per worker turn and permits the next turn", () => {
  const state = new OrchestrationState()
  const explicit = checkpoint(state, "completion", "Explicit")
  const idle = checkpoint(state, "completion", "Idle")

  assert.equal(explicit.duplicate, false)
  assert.equal(idle.duplicate, true)
  assert.equal(idle.checkpoint.checkpoint_id, explicit.checkpoint.checkpoint_id)
  assert.equal(explicit.checkpoint.worker_turn, 1)
  assert.equal(idle.checkpoint.worker_turn, explicit.checkpoint.worker_turn)

  state.beginTurn(parentID, taskID)
  const nextTurn = checkpoint(state, "completion", "Next turn")
  assert.equal(nextTurn.duplicate, false)
  assert.notEqual(nextTurn.checkpoint.checkpoint_id, explicit.checkpoint.checkpoint_id)
  assert.equal(nextTurn.checkpoint.worker_turn, 2)
})

test("owns monotonic prompt IDs, reserves failed IDs, and only admits successful prompts", () => {
  const state = new OrchestrationState()
  state.registerTask(parentID, taskID)
  const initial = state.lifecycle(parentID, taskID)
  const failed = state.reservePrompt(parentID, taskID)
  const successful = state.reservePrompt(parentID, taskID)

  assert.equal(initial.prompt_id, "pr_v1_000000000001")
  assert.equal(initial.prompt_stage, "started")
  assert.deepEqual(failed, { prompt_id: "pr_v1_000000000002", message_id: "msg_pr_v1_000000000002" })
  assert.deepEqual(successful, { prompt_id: "pr_v1_000000000003", message_id: "msg_pr_v1_000000000003" })
  assert.equal(state.turn(parentID, taskID).generation, 1)
  assert.equal(state.lifecycle(parentID, taskID).prompt_id, initial.prompt_id)

  state.admitPrompt(parentID, taskID, successful)
  assert.equal(state.turn(parentID, taskID).generation, 2)
  assert.deepEqual(state.lifecycle(parentID, taskID), {
    ...state.lifecycle(parentID, taskID),
    prompt_id: successful.prompt_id,
    message_id: successful.message_id,
    prompt_stage: "admitted",
  })
})

test("advances a matching prompt monotonically through started, acknowledged, checkpointed, and completed", () => {
  const state = new OrchestrationState()
  state.registerTask(parentID, taskID)
  const prompt = state.reservePrompt(parentID, taskID)
  state.admitPrompt(parentID, taskID, prompt)

  state.markPromptStarted(parentID, taskID, prompt.message_id)
  assert.equal(state.lifecycle(parentID, taskID).prompt_stage, "started")
  const acknowledgement = state.deliver(parentID, { task_id: taskID, kind: "acknowledgement", prompt_id: prompt.prompt_id, summary: "Acknowledged", files: [], needs_decision: false })
  assert.equal(acknowledgement.checkpoint.prompt_id, prompt.prompt_id)
  assert.equal(state.lifecycle(parentID, taskID).prompt_stage, "acknowledged")

  const evidence = state.deliver(parentID, { task_id: taskID, kind: "evidence", prompt_id: prompt.prompt_id, summary: "Observed", files: [], needs_decision: false })
  assert.equal(evidence.checkpoint.prompt_id, prompt.prompt_id)
  assert.equal(state.lifecycle(parentID, taskID).prompt_stage, "checkpointed")
  state.deliver(parentID, { task_id: taskID, kind: "completion", prompt_id: prompt.prompt_id, summary: "Done", files: [], needs_decision: false })
  assert.equal(state.lifecycle(parentID, taskID).prompt_stage, "completed")

  state.markPromptStarted(parentID, taskID, prompt.message_id)
  state.deliver(parentID, { task_id: taskID, kind: "evidence", prompt_id: prompt.prompt_id, summary: "Late evidence", files: [], needs_decision: false })
  assert.equal(state.lifecycle(parentID, taskID).prompt_stage, "completed")
})

test("normalizes summary-less acknowledgements into restart-safe checkpoints", () => {
  const state = new OrchestrationState()
  state.registerTask(parentID, taskID)
  const prompt = state.reservePrompt(parentID, taskID)
  state.admitPrompt(parentID, taskID, prompt)

  const acknowledgement = state.deliver(parentID, {
    task_id: taskID,
    kind: "acknowledgement",
    prompt_id: prompt.prompt_id,
    files: [],
    needs_decision: false,
  })

  assert.equal(acknowledgement.checkpoint.summary, "Acknowledged.")
  assert.equal(OrchestrationState.restore(state.snapshot()).read(parentID, taskID).checkpoints[0].summary, "Acknowledged.")
  assert.throws(
    () => state.deliver(parentID, { task_id: taskID, kind: "evidence", files: [], needs_decision: false }),
    /summary/,
  )
})

test("repairs persisted schema-v3 acknowledgements written without a summary", () => {
  const state = new OrchestrationState()
  state.registerTask(parentID, taskID)
  const prompt = state.reservePrompt(parentID, taskID)
  state.admitPrompt(parentID, taskID, prompt)
  state.deliver(parentID, {
    task_id: taskID,
    kind: "acknowledgement",
    prompt_id: prompt.prompt_id,
    summary: "Acknowledged.",
    files: [],
    needs_decision: false,
  })
  const snapshot = state.snapshot()
  delete snapshot.checkpoints[0].checkpoint.summary

  const restored = OrchestrationState.restore(snapshot)
  assert.equal(restored.read(parentID, taskID).checkpoints[0].summary, "Acknowledged.")
  assert.equal(restored.snapshot().checkpoints[0].checkpoint.summary, "Acknowledged.")
})

test("rejects acknowledgement and checkpoints for stale prompt IDs while keeping legacy reports on the current prompt", () => {
  const state = new OrchestrationState()
  state.registerTask(parentID, taskID)
  const first = state.reservePrompt(parentID, taskID)
  state.admitPrompt(parentID, taskID, first)
  const second = state.reservePrompt(parentID, taskID)
  state.admitPrompt(parentID, taskID, second)

  assert.throws(() => state.deliver(parentID, { task_id: taskID, kind: "acknowledgement", prompt_id: first.prompt_id, summary: "Stale", files: [], needs_decision: false }), /current prompt ID/)
  assert.throws(() => state.deliver(parentID, { task_id: taskID, kind: "evidence", prompt_id: first.prompt_id, summary: "Stale", files: [], needs_decision: false }), /current prompt ID/)
  const legacy = state.deliver(parentID, { task_id: taskID, kind: "evidence", summary: "Legacy", files: [], needs_decision: false })
  assert.equal(legacy.checkpoint.prompt_id, second.prompt_id)
  assert.equal(state.lifecycle(parentID, taskID).prompt_stage, "checkpointed")
})

test("serializes the current prompt lifecycle and reserved prompt sequence", () => {
  const state = new OrchestrationState()
  state.registerTask(parentID, taskID)
  const prompt = state.reservePrompt(parentID, taskID)
  state.admitPrompt(parentID, taskID, prompt)
  state.deliver(parentID, { task_id: taskID, kind: "acknowledgement", prompt_id: prompt.prompt_id, summary: "Acknowledged", files: [], needs_decision: false })

  const restored = OrchestrationState.restore(state.snapshot())
  assert.equal(restored.lifecycle(parentID, taskID).prompt_id, prompt.prompt_id)
  assert.equal(restored.lifecycle(parentID, taskID).prompt_stage, "acknowledged")
  assert.deepEqual(restored.reservePrompt(parentID, taskID), { prompt_id: "pr_v1_000000000003", message_id: "msg_pr_v1_000000000003" })
})

test("derives threshold states at their boundaries and treats a synthetic initial prompt as first-checkpoint work", () => {
  let clock = 0
  const state = new OrchestrationState({
    now: () => clock,
    thresholds: { steeringUnacknowledgedMs: 10, firstCheckpointMs: 20, checkpointStaleMs: 30 },
  })
  state.registerTask(parentID, taskID)
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "awaiting_first_checkpoint")
  clock = 20
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "awaiting_first_checkpoint")
  clock = 21
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "checkpoint_stale")

  const prompt = state.reservePrompt(parentID, taskID)
  state.admitPrompt(parentID, taskID, prompt)
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "healthy")
  clock = 31
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "healthy")
  clock = 32
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "steering_unacknowledged")

  state.deliver(parentID, { task_id: taskID, kind: "acknowledgement", prompt_id: prompt.prompt_id, summary: "Acknowledged", files: [], needs_decision: false })
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "awaiting_first_checkpoint")
  clock = 52
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "awaiting_first_checkpoint")
  clock = 53
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "checkpoint_stale")

  state.deliver(parentID, { task_id: taskID, kind: "evidence", prompt_id: prompt.prompt_id, summary: "Evidence", files: [], needs_decision: false })
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "healthy")
  clock = 83
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "healthy")
  clock = 84
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "checkpoint_stale")
  state.deliver(parentID, { task_id: taskID, kind: "diff", prompt_id: prompt.prompt_id, summary: "Fresh evidence", files: [], needs_decision: false })
  assert.deepEqual(
    { checkpoint_state: state.lifecycle(parentID, taskID).checkpoint_state, checkpoint_stale_deadline_at: state.lifecycle(parentID, taskID).checkpoint_stale_deadline_at, checkpoint_age_ms: state.lifecycle(parentID, taskID).checkpoint_age_ms },
    { checkpoint_state: "healthy", checkpoint_stale_deadline_at: "1970-01-01T00:00:00.114Z", checkpoint_age_ms: 0 },
  )
  clock = 114
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "healthy")
  clock = 115
  assert.equal(state.lifecycle(parentID, taskID).checkpoint_state, "checkpoint_stale")
})

test("validates lifecycle thresholds as non-negative finite integers", () => {
  for (const thresholds of [
    { steeringUnacknowledgedMs: -1 },
    { firstCheckpointMs: 1.5 },
    { checkpointStaleMs: Infinity },
  ]) assert.throws(() => new OrchestrationState({ thresholds }), /threshold/)
})
