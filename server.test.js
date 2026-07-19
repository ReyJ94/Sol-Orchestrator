import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "bun:test"

import {
  createDefaultServerRuntime,
  SolOrchestratorPlugin,
} from "./src/server.ts"
import { OrchestrationStore } from "./src/orchestration-store.ts"
import { parseRootSnapshot } from "./src/schema/orchestration.ts"
import { WorkflowDefinitionSchema } from "./src/schema/workflow.ts"

const WORKFLOW_TOOLS = [
  "workflow_complete",
  "workflow_delegate",
  "workflow_replace",
  "workflow_retry",
  "workflow_start",
  "workflow_status",
]
const GOAL_TOOLS = [
  "goal_block",
  "goal_complete",
  "goal_resume",
  "goal_start",
]
const WORKER_CONTROLS = [
  "agents_inspect",
  "agents_interrupt",
  "agents_permission",
  "agents_redo",
  "agents_send",
  "agents_status",
  "agents_undo",
  "agents_wait",
  "report_to_parent",
]
const LEGACY_TOOLS = [
  "agents_help",
  "agents_list",
  "agents_read",
  "workflow_amend",
  "workflow_complete_job",
  "workflow_continue",
  "workflow_define",
  "workflow_help",
  "workflow_override",
  "workflow_prepare_worker",
  "workflow_record_approval",
  "workflow_scan",
  "workflow_show",
  "workflow_update_job",
]
const INTERNAL_HEADER_PATTERN =
  /Workflow-Lease|Workflow-ID|Workflow-Version|Node-ID|Job-ID|Allowed-Files|Allowed-Tools|prompt_id|message_id|lease_id/u

const sessionAdapter = {
  abort: async () => {},
  appendPermissions: async () => {},
  diff: async () => [],
  get: async (sessionID) => ({
    directory: "/workspace",
    id: sessionID,
    projectID: "project-1",
    time: { created: 1, updated: 1 },
    title: "session",
    version: "1.18.1",
  }),
  message: async () => {
    throw new Error("No message fixture configured.")
  },
  messages: async () => [],
  permissions: async () => [],
  replyPermission: async () => {},
  status: async () => ({}),
}

const withPlugin = async (run) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencode-sol-orchestrator-entrypoint-")
  )
  try {
    const store = new OrchestrationStore({
      statePath: path.join(directory, "state-v2.json"),
    })
    const runtime = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: { sessionAdapter, store },
    })
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    )
    return await run(plugin)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

test("registers exactly the goal, workflow, and managed-worker tools", () =>
  withPlugin(async (plugin) => {
    assert.deepEqual(
      Object.keys(plugin.tool).sort(),
      [...GOAL_TOOLS, ...WORKFLOW_TOOLS, ...WORKER_CONTROLS].sort()
    )
    for (const legacy of LEGACY_TOOLS) {
      assert.equal(plugin.tool[legacy], undefined)
    }
    assert.equal(typeof plugin.event, "function")
  }))

test("generates exact Sol/worker authority without stale protocol prompts", () =>
  withPlugin(async (plugin) => {
    const config = {}
    await plugin.config(config)

    assert.deepEqual(
      Object.keys(config.agent).sort(),
      ["luna-max", "luna-medium", "sol", "terra-max", "terra-medium"]
    )
    for (const name of WORKFLOW_TOOLS) {
      assert.equal(config.agent.sol.permission[name], "allow")
      for (const worker of [
        "luna-medium",
        "luna-max",
        "terra-medium",
        "terra-max",
      ]) {
        assert.equal(config.agent[worker].permission[name], "deny")
      }
    }
    for (const legacy of LEGACY_TOOLS) {
      assert.equal(config.agent.sol.permission[legacy], undefined)
    }
    assert.doesNotMatch(config.agent.sol.prompt, INTERNAL_HEADER_PATTERN)
    assert.match(config.agent.sol.prompt, /workflow_status\(\{\}\)/u)
    assert.match(config.agent.sol.prompt, /available_actions/u)
    assert.doesNotMatch(config.agent.sol.prompt, /next_actions/u)
    assert.match(config.agent.sol.prompt, /needs/u)
    assert.match(config.agent.sol.prompt, /agents_inspect/u)
    for (const worker of [
      "luna-medium",
      "luna-max",
      "terra-medium",
      "terra-max",
    ]) {
      assert.equal(config.agent[worker].permission.edit, "ask")
      assert.doesNotMatch(config.agent[worker].prompt, INTERNAL_HEADER_PATTERN)
      assert.match(
        config.agent[worker].prompt,
        /report_to_parent\(\{ kind: "progress", message \}\)/u
      )
    }
  }))

test("rejects the old graph shape without aliases", () => {
  const parsed = WorkflowDefinitionSchema.safeParse({
    objective: "Legacy graph",
    path: "direct",
    nodes: [
      {
        activation: "automatic",
        id: "legacy-node",
        jobs: [],
      },
    ],
  })

  assert.equal(parsed.success, false)
})

test("rejects the old persisted root without migration", () => {
  assert.throws(
    () =>
      parseRootSnapshot({
        schema_version: 4,
        checkpoints: [],
        prompt_reservations: [],
        workers: [],
      }),
    /Invalid input|expected|unrecognized|schema_version/u
  )
})

test("ships no unused custom tool-error correction owner", async () => {
  await assert.rejects(
    stat(new URL("./src/tool-error-feedback.ts", import.meta.url)),
    { code: "ENOENT" }
  )
})

test("documents truthful available actions without placeholder arguments", async () => {
  const readme = await readFile(new URL("./README.md", import.meta.url), "utf8")
  assert.match(readme, /available_actions/u)
  assert.doesNotMatch(readme, /next_actions/u)
  assert.match(
    readme,
    /"args": \{\},\s*"needs": \["objective", "steps"\],\s*"tool": "workflow_start"/u
  )
  assert.doesNotMatch(readme, /"objective":"<concrete objective>"/u)
})
