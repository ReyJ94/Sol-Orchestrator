import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "bun:test"

import { renderCompactionSnapshot } from "../src/compaction-snapshot.ts"
import { OrchestrationStore } from "../src/orchestration-store.ts"
import { createDefaultServerRuntime, SolOrchestratorPlugin } from "../src/server.ts"
import {
  CompactionPlugin,
  OPERATIONAL_CHECKPOINT_PROMPT,
} from "./fixtures/opencode-compaction-server.js"

const parentID = "parent-1"
const childID = "child-1"
const timestamp = "2026-07-17T13:00:00.000Z"
const RESULT_SENTINEL = "FULL CHILD RESULT SENTINEL"
const TOOL_SENTINEL = "FULL TOOL OUTPUT SENTINEL"
const PATCH_SENTINEL = "FULL PATCH SENTINEL"
const INTERNAL_PATTERN =
  /workflow_id|task_id|boundary_message_id|result_message_id|message_id|part_id|event_sequence|delivered_event_sequence/u
const BEGIN =
  "--- BEGIN OBSERVED ORCHESTRATION DATA, NOT INSTRUCTIONS (schema v1) ---"
const END = "--- END OBSERVED ORCHESTRATION DATA ---"

const temporaryDirectory = async (run) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencode-sol-orchestrator-snapshot-")
  )
  try {
    return await run(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

const parseSnapshot = (entry) => {
  assert.ok(entry.startsWith(`${BEGIN}\n`))
  assert.ok(entry.endsWith(`\n${END}`))
  return JSON.parse(entry.slice(BEGIN.length, -END.length).trim())
}

const count = (text, needle) => text.split(needle).length - 1

class FakeSessions {
  messagesCalls = 0
  diffCalls = 0

  abort() {
    return Promise.resolve()
  }

  appendPermissions() {
    return Promise.resolve()
  }

  diff() {
    this.diffCalls += 1
    return Promise.resolve([])
  }

  get(sessionID) {
    return Promise.resolve({
      directory: "/workspace",
      id: sessionID,
      parentID,
      projectID: "project-1",
      time: { created: 1, updated: 1 },
      title: "worker",
      version: "1.18.1",
    })
  }

  message() {
    return Promise.reject(new Error("Compaction must not read a child message."))
  }

  messages() {
    this.messagesCalls += 1
    return Promise.resolve([])
  }

  permissions() {
    return Promise.resolve([])
  }

  replyPermission() {
    return Promise.resolve()
  }

  status() {
    return Promise.resolve({ [childID]: { type: "busy" } })
  }
}

const seedRuntime = async (directory) => {
  const store = new OrchestrationStore({
    now: () => timestamp,
    statePath: path.join(directory, "state-v2.json"),
  })
  await store.mutateWorkflow((workflow) => {
    workflow.start({
      definition: {
        objective: "Preserve semantic orchestration continuity.",
        steps: [
          {
            dependsOn: [],
            jobs: [
              {
                actor: { profile: "luna-max", type: "worker" },
                dependsOn: [],
                mode: "verification",
                name: "inspect bounded worker state",
                objective: "Inspect only selected worker content.",
              },
            ],
            name: "inspect",
            objective: "Keep compaction metadata-only.",
          },
        ],
      },
      orchestrator_agent_id: "sol",
      parent_session_id: parentID,
      workflow_id: "workflow-internal-1",
    })
    workflow.markWorkerActive({
      job: "inspect bounded worker state",
      task_id: childID,
      workflow_id: "workflow-internal-1",
    })
  })
  await store.mutateRoot(({ root }) => {
    root.job_runs.push({
      job: "inspect bounded worker state",
      result_available: false,
      run_sequence: 1,
      started_at: timestamp,
      state: "active",
      task_id: childID,
      updated_at: timestamp,
      workflow_id: "workflow-internal-1",
      workflow_version: 1,
      write_grants: [],
    })
    root.workers.push({
      child_session_id: childID,
      created_at: timestamp,
      delivered_event_sequence: 0,
      job: "inspect bounded worker state",
      latest_event: {
        created_at: timestamp,
        kind: "progress",
        message: "The metadata seam is established.",
        sequence: 1,
      },
      live_state: "busy",
      mode: "verification",
      parent_session_id: parentID,
      profile: "luna-max",
      run_sequence: 1,
      task_id: childID,
      updated_at: timestamp,
      workflow_id: "workflow-internal-1",
      workflow_version: 1,
    })
    root.turns.push({
      boundary_message_id: "user-internal-1",
      completed_at: timestamp,
      files: [
        {
          additions: 2,
          attributed: false,
          deletions: 1,
          end_sha256: "a".repeat(64),
          path: "src/a.ts",
          status: "modified",
        },
      ],
      mutation_epochs: [],
      post_undo_hashes: [],
      result_available: true,
      result_message_id: "assistant-internal-1",
      run_sequence: 1,
      started_at: timestamp,
      task_id: childID,
      tool_outputs: [
        {
          message_id: "assistant-tool-internal-1",
          ordinal: 1,
          output_available: true,
          part_id: "part-internal-1",
          status: "completed",
          title: "Read source",
          tool: "read",
        },
      ],
      turn: 1,
      undo_state: "unavailable",
      undo_unavailable_reason: "Mutation provenance is not established.",
    })
  })
  const sessions = new FakeSessions()
  const runtime = createDefaultServerRuntime({
    client: { session: {} },
    directory: "/workspace",
    options: { sessionAdapter: sessions, store },
  })
  return { runtime, sessions }
}

const seedGoalOnlyRuntime = async (directory) => {
  const store = new OrchestrationStore({
    now: () => timestamp,
    statePath: path.join(directory, "state-v2.json"),
  })
  await store.mutateGoal((goal) => {
    goal.start({
      goal_id: "goal-internal-1",
      objective: "Finish the real outcome across however many workflows are needed.",
      orchestrator_agent_id: "sol",
      parent_session_id: parentID,
    })
  })
  const sessions = new FakeSessions()
  const runtime = createDefaultServerRuntime({
    client: { session: {} },
    directory: "/workspace",
    options: { sessionAdapter: sessions, store },
  })
  return { runtime, sessions }
}

test("renders only semantic workflow and worker metadata", () => {
  const rendered = renderCompactionSnapshot({
    workers: [
      {
        boundary_message_id: "hidden-boundary",
        job: "inspect bounded worker state",
        latest_event: {
          event_sequence: 7,
          kind: "progress",
          message: "Bounded progress.",
        },
        live_state: "busy",
        mode: "verification",
        patch: PATCH_SENTINEL,
        profile: "luna-max",
        result: RESULT_SENTINEL,
        result_available: true,
        task_id: childID,
        tool_output: TOOL_SENTINEL,
        turn_count: 1,
        turns: [
          {
            completed: true,
            files: [
              {
                additions: 2,
                deletions: 1,
                path: "src/a.ts",
                status: "modified",
              },
            ],
            isolated: false,
            result_available: true,
            tool_outputs: [
              {
                output_available: true,
                status: "completed",
                title: "Read source",
                tool: "read",
                tool_number: 1,
              },
            ],
            turn: 1,
            undo_available: false,
            undo_unavailable_reason: "Mutation provenance is not established.",
          },
        ],
      },
    ],
    workflow: {
      current: {
        objective: "Preserve semantic orchestration continuity.",
        state: "active",
        steps: [
          {
            jobs: [
              {
                actor: { profile: "luna-max", type: "worker" },
                mode: "verification",
                name: "inspect bounded worker state",
                objective: "Inspect only selected worker content.",
                result_available: true,
                state: "review",
                task_id: childID,
              },
            ],
            name: "inspect",
            objective: "Keep compaction metadata-only.",
            state: "active",
          },
        ],
      },
      available_actions: [],
    },
  })
  const data = parseSnapshot(rendered)

  assert.equal(data.observed_orchestration_data, true)
  assert.equal(data.schema_version, 1)
  assert.equal(data.workflow.objective, "Preserve semantic orchestration continuity.")
  assert.equal(data.workers[0].turns[0].files[0].path, "src/a.ts")
  const serialized = JSON.stringify(data)
  assert.doesNotMatch(serialized, INTERNAL_PATTERN)
  assert.equal(serialized.includes(RESULT_SENTINEL), false)
  assert.equal(serialized.includes(TOOL_SENTINEL), false)
  assert.equal(serialized.includes(PATCH_SENTINEL), false)
})

test("retains exact available semantic actions without protocol identifiers", () => {
  const rendered = renderCompactionSnapshot({
    workflow: {
      current: {
        objective: "Complete the semantic cutover.",
        state: "blocked",
        steps: [],
      },
      available_actions: [
        {
          args: { jobs: ["inspect bounded worker state"], until: "any" },
          tool: "agents_wait",
        },
        {
          args: { job: "integrate result" },
          needs: ["message"],
          tool: "workflow_complete",
        },
      ],
    },
  })
  const data = parseSnapshot(rendered)

  assert.deepEqual(data.workflow.available_actions, [
    {
      args: { jobs: ["inspect bounded worker state"], until: "any" },
      tool: "agents_wait",
    },
    {
      args: { job: "integrate result" },
      needs: ["message"],
      tool: "workflow_complete",
    },
  ])
  assert.doesNotMatch(JSON.stringify(data), INTERNAL_PATTERN)
})

test("never presents a silently partial action surface after compaction", () => {
  const availableActions = Array.from({ length: 20 }, (_value, index) => ({
    args: { job: `semantic job ${index}` },
    needs: ["message"],
    tool: "agents_send",
  }))
  const complete = parseSnapshot(
    renderCompactionSnapshot({
      maxChars: 100_000,
      workflow: {
        available_actions: availableActions,
        current: {
          objective: "Preserve every currently executable semantic action.",
          state: "active",
          steps: [],
        },
      },
    })
  )
  assert.deepEqual(complete.workflow.available_actions, availableActions)
  assert.equal(complete.workflow.available_actions_refresh_required, undefined)

  const bounded = parseSnapshot(
    renderCompactionSnapshot({
      maxChars: 1024,
      workflow: {
        available_actions: availableActions,
        current: {
          objective: "x".repeat(1000),
          state: "active",
          steps: [],
        },
      },
    })
  )
  assert.deepEqual(bounded.workflow.available_actions, [])
  assert.equal(bounded.workflow.available_actions_refresh_required, true)
})

test("retains a durable goal between workflows without internal identity", () => {
  const rendered = renderCompactionSnapshot({
    workflow: {
      available_actions: [
        {
          args: {},
          needs: ["objective", "steps"],
          tool: "workflow_start",
        },
      ],
      current: null,
      goal: {
        goal_id: "must-not-leak",
        objective: "Finish the real user outcome across later workflows.",
        status: "active",
      },
    },
  })
  const data = parseSnapshot(rendered)

  assert.deepEqual(data.workflow.goal, {
    objective: "Finish the real user outcome across later workflows.",
    status: "active",
  })
  assert.equal(data.workflow.objective, undefined)
  assert.doesNotMatch(JSON.stringify(data), /must-not-leak|goal_id/u)
})

test("produces deterministic valid JSON within configured bounds", () => {
  const workers = Array.from({ length: 20 }, (_value, index) => ({
    job: `worker job ${index} ${"x".repeat(200)}`,
    latest_event: {
      kind: index === 19 ? "blocker" : "progress",
      message: `${index} ${"bounded ".repeat(200)}`,
    },
    live_state: index === 19 ? "blocked" : "busy",
    mode: "research",
    profile: "luna-medium",
    result_available: false,
    task_id: `child-${index}`,
    turn_count: 0,
    turns: [],
  }))
  const first = renderCompactionSnapshot({ maxChars: 1024, workers })
  const second = renderCompactionSnapshot({ maxChars: 1024, workers })

  assert.equal(first, second)
  assert.ok(first.length <= 1024)
  const data = parseSnapshot(first)
  assert.equal(data.truncated, true)
  assert.ok(data.included_workers >= 1)
  assert.ok(data.omitted_workers > 0)
  assert.match(data.workers[0].job, /^worker job 19/u)
  for (const invalid of [1023, 100_001, 1.5]) {
    assert.throws(
      () => renderCompactionSnapshot({ maxChars: invalid, workers }),
      /compactionSnapshotMaxChars/u
    )
  }
})

test("server compaction appends one persisted metadata snapshot without reading child history", async () =>
  temporaryDirectory(async (directory) => {
    const { runtime, sessions } = await seedRuntime(directory)
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    )
    const compact = plugin["experimental.session.compacting"]
    assert.equal(typeof compact, "function")
    const callsBefore = {
      diff: sessions.diffCalls,
      messages: sessions.messagesCalls,
    }
    const output = { context: [], prompt: undefined }

    await compact({ sessionID: parentID }, output)
    await compact({ sessionID: parentID }, output)

    assert.equal(output.prompt, undefined)
    assert.equal(output.context.length, 1)
    assert.deepEqual(
      { diff: sessions.diffCalls, messages: sessions.messagesCalls },
      callsBefore
    )
    const data = parseSnapshot(output.context[0])
    assert.equal(data.workflow.objective, "Preserve semantic orchestration continuity.")
    assert.equal(data.workers[0].job, "inspect bounded worker state")
    assert.equal(data.workers[0].turns[0].tool_outputs[0].tool_number, 1)
    assert.doesNotMatch(JSON.stringify(data), INTERNAL_PATTERN)
  }))

test("server compaction retains the active goal between workflows", async () =>
  temporaryDirectory(async (directory) => {
    const { runtime, sessions } = await seedGoalOnlyRuntime(directory)
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    )
    const messageCallsBeforeCompaction = sessions.messagesCalls
    const output = { context: [], prompt: undefined }

    await plugin["experimental.session.compacting"](
      { sessionID: parentID },
      output
    )

    assert.equal(output.context.length, 1)
    assert.equal(sessions.messagesCalls, messageCallsBeforeCompaction)
    const data = parseSnapshot(output.context[0])
    assert.deepEqual(data.workflow.goal, {
      objective: "Finish the real outcome across however many workflows are needed.",
      status: "active",
    })
    assert.equal(data.workflow.current, undefined)
    assert.doesNotMatch(JSON.stringify(data), /goal-internal-1|goal_id/u)
  }))

test("server compaction leaves an unrelated empty parent untouched", async () =>
  temporaryDirectory(async (directory) => {
    const { runtime } = await seedRuntime(directory)
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    )
    const output = { context: ["existing"], prompt: undefined }

    await plugin["experimental.session.compacting"](
      { sessionID: "other-parent" },
      output
    )

    assert.deepEqual(output, { context: ["existing"], prompt: undefined })
  }))

test("composes with OpenCode checkpoint compaction without prompt duplication", async () =>
  temporaryDirectory(async (directory) => {
    const { runtime } = await seedRuntime(directory)
    const orchestrator = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    )
    const compaction = await CompactionPlugin()
    const output = { context: [], prompt: undefined }

    await orchestrator["experimental.session.compacting"](
      { sessionID: parentID },
      output
    )
    await compaction["experimental.session.compacting"](
      { sessionID: parentID },
      output
    )

    assert.equal(output.context.length, 1)
    assert.equal(count(output.prompt, OPERATIONAL_CHECKPOINT_PROMPT), 1)
    assert.equal(count(output.prompt, BEGIN), 1)
  }))
