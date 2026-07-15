import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import { SolOrchestratorPlugin as createSolOrchestratorPlugin } from "./server.js"
import { OrchestrationStore } from "./orchestration-store.js"

const ephemeralStateDirectories = []
const SolOrchestratorPlugin = async (input, options = {}) => {
  if (options.statePath || options.store) return createSolOrchestratorPlugin(input, options)
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-sol-orchestrator-server-"))
  ephemeralStateDirectories.push(directory)
  return createSolOrchestratorPlugin(input, { ...options, statePath: path.join(directory, "state.json") })
}
after(async () => { await Promise.all(ephemeralStateDirectories.map((directory) => rm(directory, { recursive: true, force: true }))) })

test("registers all six orchestration tools", async () => {
  const plugin = await SolOrchestratorPlugin({ client: {}, directory: "/workspace" })
  assert.deepEqual(Object.keys(plugin.tool).sort(), ["agents_interrupt", "agents_list", "agents_read", "agents_send", "agents_wait", "report_to_parent"].sort())
  assert.equal(typeof plugin.event, "function")
})
test("adds model-less agent defaults without replacing user agents", async () => {
  const plugin = await SolOrchestratorPlugin({ client: {}, directory: "/workspace" })
  const config = { agent: { sol: { description: "user override" } } }
  await plugin.config(config)
  assert.equal(config.agent.sol.description, "user override")
  assert.deepEqual(Object.keys(config.agent).sort(), ["sol", "luna-medium", "luna-max", "terra-medium", "terra-max"].sort())
  assert.equal("model" in config.agent["luna-medium"], false)
  assert.equal("variant" in config.agent["luna-medium"], false)
})
test("can opt out of agent registration", async () => {
  const plugin = await SolOrchestratorPlugin({ client: {}, directory: "/workspace" }, { registerAgents: false })
  const config = {}
  await plugin.config(config)
  assert.deepEqual(config, {})
})
test("merges a model-only Sol override with defaults", async () => {
  const plugin = await SolOrchestratorPlugin({ client: {}, directory: "/workspace" })
  const config = { agent: { sol: { model: "provider/model" } } }
  await plugin.config(config)
  assert.equal(config.agent.sol.model, "provider/model")
  assert.equal(config.agent.sol.mode, "primary")
  assert.match(config.agent.sol.prompt, /Sol alone reconciles/)
  assert.deepEqual(config.agent.sol.permission.task, { "*": "deny", "luna-medium": "allow", "luna-max": "allow", "terra-medium": "allow", "terra-max": "allow" })
})
test("merges description and nested permission overrides with defaults", async () => {
  const plugin = await SolOrchestratorPlugin({ client: {}, directory: "/workspace" })
  const config = { agent: { sol: { description: "custom", permission: { task: { "luna-medium": "deny" } } } } }
  await plugin.config(config)
  assert.equal(config.agent.sol.description, "custom")
  assert.equal(config.agent.sol.mode, "primary")
  assert.equal(config.agent.sol.permission.task["luna-medium"], "deny")
  assert.equal(config.agent.sol.permission.task["terra-max"], "allow")
  assert.equal(config.agent.sol.permission.report_to_parent, "deny")
})
test("ships complete prompt requirements", async () => {
  const plugin = await SolOrchestratorPlugin({ client: {}, directory: "/workspace" })
  const config = {}
  await plugin.config(config)
  assert.match(config.agent["luna-medium"].prompt, /request the full brief/)
  assert.match(config.agent.sol.prompt, /Sol alone reconciles/)
})

test("aborting a parent wait never aborts a child session", async () => {
  let abortCalls = 0
  const child = { id: "child-1", parentID: "parent-1", title: "Worker (Terra Max)", directory: "/workspace" }
  const plugin = await SolOrchestratorPlugin({
    directory: "/workspace",
    client: {
      session: {
        children: async () => ({ data: [child] }),
        status: async () => ({ data: { "child-1": { type: "busy" } } }),
        abort: async () => {
          abortCalls += 1
          return { data: true }
        },
      },
    },
  })
  const controller = new AbortController()
  const waiting = plugin.tool.agents_wait.execute(
    { task_ids: ["child-1"], timeout_ms: 60_000 },
    { sessionID: "parent-1", directory: "/workspace", abort: controller.signal },
  )

  controller.abort()
  await assert.rejects(waiting, /orchestration wait was interrupted/)
  assert.equal(abortCalls, 0)
})

test("only explicit agents_interrupt invokes child session abort", async () => {
  let abortCalls = 0
  const child = { id: "child-1", parentID: "parent-1", title: "Worker (Terra Max)", directory: "/workspace" }
  const plugin = await SolOrchestratorPlugin({
    directory: "/workspace",
    client: {
      session: {
        get: async () => ({ data: child }),
        abort: async () => {
          abortCalls += 1
          return { data: true }
        },
      },
    },
  })

  const response = JSON.parse(
    await plugin.tool.agents_interrupt.execute(
      { task_id: "child-1", reason: "Explicit test interruption" },
      { sessionID: "parent-1", directory: "/workspace" },
    ),
  )

  assert.equal(abortCalls, 1)
  assert.deepEqual(response, { task_id: "child-1", interrupted: true })
})

test("a cancelled parent context never propagates abort to a steered child", async () => {
  let abortCalls = 0
  let promptCalls = 0
  const child = { id: "child-1", parentID: "parent-1", title: "Worker (Terra Max)", directory: "/workspace" }
  const plugin = await SolOrchestratorPlugin({
    directory: "/workspace",
    client: {
      session: {
        get: async () => ({ data: child }),
        promptAsync: async () => {
          promptCalls += 1
          return { data: true }
        },
        abort: async () => {
          abortCalls += 1
          return { data: true }
        },
      },
    },
  })
  const controller = new AbortController()
  controller.abort()

  const response = JSON.parse(
    await plugin.tool.agents_send.execute(
      { task_id: "child-1", message: "Continue independently." },
      { sessionID: "parent-1", directory: "/workspace", abort: controller.signal },
    ),
  )

  assert.equal(promptCalls, 1)
  assert.equal(abortCalls, 0)
  assert.equal(response.accepted, true)
})

const worker = { id: "child-1", parentID: "parent-1", title: "Worker (Terra Max)", directory: "/workspace" }
const workerTwo = { id: "child-2", parentID: "parent-1", title: "Worker (Terra Max)", directory: "/workspace" }
const workerClient = (overrides = {}) => ({
  session: {
    get: async () => ({ data: worker }),
    messages: async () => ({ data: [] }),
    children: async () => ({ data: [worker] }),
    status: async () => ({ data: { "child-1": { type: "busy" } } }),
    promptAsync: async () => ({ data: true }),
    ...overrides,
  },
})
const parentContext = { sessionID: "parent-1", directory: "/workspace" }
const childContext = { sessionID: "child-1", directory: "/workspace", agent: "terra-max" }
const report = async (plugin, kind, summary = kind, context = childContext, promptID) => JSON.parse(await plugin.tool.report_to_parent.execute({ kind, summary, ...(promptID ? { prompt_id: promptID } : {}) }, context))

test("exposes additive checkpoint cursor arguments and preserves legacy consume behavior", async () => {
  const plugin = await SolOrchestratorPlugin({ client: workerClient(), directory: "/workspace" })
  assert.equal(plugin.tool.agents_read.args.after?.safeParse("cp_v1_000000000001").success ?? false, true)
  assert.equal(plugin.tool.agents_read.args.consume_through?.safeParse("cp_v1_000000000001").success ?? false, true)
  assert.equal(plugin.tool.agents_wait.args.after?.safeParse("cp_v1_000000000001").success ?? false, true)

  const first = await report(plugin, "evidence", "First")
  const second = await report(plugin, "diff", "Second")
  const third = await report(plugin, "blocker", "Third")
  const initial = JSON.parse(await plugin.tool.agents_read.execute({ task_id: "child-1", consume_through: second.checkpoint_id }, parentContext))
  assert.deepEqual(initial.checkpoints.map((entry) => entry.checkpoint_id), [first.checkpoint_id, second.checkpoint_id, third.checkpoint_id])
  assert.equal(initial.cursor.consumed_through, second.checkpoint_id)

  const unread = JSON.parse(await plugin.tool.agents_read.execute({ task_id: "child-1" }, parentContext))
  assert.deepEqual(unread.checkpoints.map((entry) => entry.checkpoint_id), [third.checkpoint_id])
  const legacyConsumed = JSON.parse(await plugin.tool.agents_read.execute({ task_id: "child-1", consume_checkpoints: true }, parentContext))
  assert.deepEqual(legacyConsumed.checkpoints.map((entry) => entry.checkpoint_id), [third.checkpoint_id])
  assert.equal(legacyConsumed.cursor.consumed_through, third.checkpoint_id)

  await assert.rejects(
    plugin.tool.agents_read.execute({ task_id: "child-1", consume_checkpoints: true, consume_through: first.checkpoint_id }, parentContext),
    /either consume_checkpoints or consume_through/,
  )
})

test("agents_wait with after does not re-wake for the checkpoint used as its cursor", async () => {
  const plugin = await SolOrchestratorPlugin({ client: workerClient(), directory: "/workspace" })
  const delivered = await report(plugin, "evidence")

  const waited = JSON.parse(await plugin.tool.agents_wait.execute({ task_ids: ["child-1"], after: delivered.checkpoint_id, timeout_ms: 0 }, parentContext))
  assert.equal(waited.timed_out, true)
  assert.deepEqual(waited.checkpoints, [])
  assert.equal(waited.cursors["child-1"].latest_checkpoint_id, delivered.checkpoint_id)
})

test("agents_wait treats after as a parent-mailbox cursor across selected workers", async () => {
  const otherParentWorker = { id: "child-3", parentID: "parent-2", title: "Worker (Terra Max)", directory: "/workspace" }
  const sessions = new Map([[worker.id, worker], [workerTwo.id, workerTwo], [otherParentWorker.id, otherParentWorker]])
  const plugin = await SolOrchestratorPlugin({
    client: {
      session: {
        get: async ({ path }) => ({ data: sessions.get(path.id) }),
        messages: async () => ({ data: [] }),
        children: async ({ path }) => ({ data: path.id === "parent-1" ? [worker, workerTwo] : [otherParentWorker] }),
        status: async () => ({ data: { [worker.id]: { type: "busy" }, [workerTwo.id]: { type: "busy" }, [otherParentWorker.id]: { type: "busy" } } }),
      },
    },
    directory: "/workspace",
  })
  const first = await report(plugin, "evidence", "First", childContext)
  const second = await report(plugin, "diff", "Second", { sessionID: workerTwo.id, directory: "/workspace", agent: "terra-max" })

  const waited = JSON.parse(await plugin.tool.agents_wait.execute({ task_ids: [worker.id, workerTwo.id], after: first.checkpoint_id, timeout_ms: 0 }, parentContext))
  assert.equal(waited.timed_out, false)
  assert.deepEqual(waited.checkpoints.map((entry) => entry.checkpoint_id), [second.checkpoint_id])

  const otherParent = await report(plugin, "evidence", "Other parent", { sessionID: otherParentWorker.id, directory: "/workspace", agent: "terra-max" })
  await assert.rejects(
    plugin.tool.agents_wait.execute({ task_ids: [worker.id], after: otherParent.checkpoint_id, timeout_ms: 0 }, parentContext),
    /different parent session/,
  )
})

test("an explicit completion and subsequent idle event produce one terminal checkpoint", async () => {
  const plugin = await SolOrchestratorPlugin({ client: workerClient({ messages: async () => ({ data: [{ info: { role: "assistant", id: "message-1" }, parts: [{ type: "text", text: "Idle result" }] }] }) }), directory: "/workspace" })
  const explicit = await report(plugin, "completion", "Explicit result")
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "child-1" } } })

  const read = JSON.parse(await plugin.tool.agents_read.execute({ task_id: "child-1" }, parentContext))
  assert.deepEqual(read.checkpoints.filter((entry) => entry.kind === "completion").map((entry) => entry.checkpoint_id), [explicit.checkpoint_id])
})

test("an idle completion suppresses a duplicate explicit completion and reports its authority", async () => {
  const plugin = await SolOrchestratorPlugin({ client: workerClient({ messages: async () => ({ data: [{ info: { role: "assistant", id: "message-1" }, parts: [{ type: "text", text: "Idle result" }] }] }) }), directory: "/workspace" })
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "child-1" } } })
  const idleRead = JSON.parse(await plugin.tool.agents_read.execute({ task_id: "child-1" }, parentContext))
  const idleCheckpoint = idleRead.checkpoints.find((entry) => entry.kind === "completion")
  const explicit = await report(plugin, "completion", "Late explicit result")

  assert.equal(explicit.delivered, true)
  assert.equal(explicit.duplicate, true)
  assert.equal(explicit.checkpoint_id, idleCheckpoint.checkpoint_id)
  assert.equal(explicit.cursor.consumed_through, null)
  const finalRead = JSON.parse(await plugin.tool.agents_read.execute({ task_id: "child-1" }, parentContext))
  assert.equal(finalRead.checkpoints.filter((entry) => entry.kind === "completion").length, 1)
})

test("a failed send keeps the existing terminal turn, while a successful send opens one new terminal turn", async () => {
  let shouldFail = true
  const plugin = await SolOrchestratorPlugin({
    client: workerClient({
      messages: async () => ({ data: [{ info: { role: "assistant", id: "message-1" }, parts: [{ type: "text", text: "Idle result" }] }] }),
      promptAsync: async () => {
        if (shouldFail) throw new Error("prompt rejected")
        return { data: true }
      },
    }),
    directory: "/workspace",
  })

  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "child-1" } } })
  await assert.rejects(plugin.tool.agents_send.execute({ task_id: "child-1", message: "This fails" }, parentContext), /prompt rejected/)
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "child-1" } } })
  let read = JSON.parse(await plugin.tool.agents_read.execute({ task_id: "child-1" }, parentContext))
  assert.equal(read.checkpoints.filter((entry) => entry.kind === "completion").length, 1)

  shouldFail = false
  await plugin.tool.agents_send.execute({ task_id: "child-1", message: "This succeeds" }, parentContext)
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "child-1" } } })
  read = JSON.parse(await plugin.tool.agents_read.execute({ task_id: "child-1" }, parentContext))
  const completions = read.checkpoints.filter((entry) => entry.kind === "completion")
  assert.equal(completions.length, 2)
  assert.equal(completions[0].worker_turn, 1)
  assert.equal(completions[1].worker_turn, 2)
  assert.notEqual(completions[0].checkpoint_id, completions[1].checkpoint_id)
})

test("agents_send reserves a prompt ID and message ID, prefixes the request, and admits only a successful request", async () => {
  let request
  const plugin = await SolOrchestratorPlugin({
    client: workerClient({ promptAsync: async (value) => { request = value; return { data: true } } }),
    directory: "/workspace",
  })

  const response = JSON.parse(await plugin.tool.agents_send.execute({ task_id: worker.id, message: "Check the focused test." }, parentContext))
  assert.deepEqual(response, {
    task_id: worker.id,
    agent_type: "terra-max",
    accepted: true,
    prompt_id: "pr_v1_000000000002",
    message_id: "msg_pr_v1_000000000002",
    prompt_stage: "admitted",
  })
  assert.equal(request.body.messageID, response.message_id)
  assert.match(request.body.parts[0].text, /^\[Sol prompt pr_v1_000000000002\]/)
  assert.match(request.body.parts[0].text, /report_to_parent\(kind: "acknowledgement", prompt_id: "pr_v1_000000000002"\)/)
  assert.match(request.body.parts[0].text, /Check the focused test\./)
})

test("a failed agents_send reserves but does not replace the current prompt or worker turn", async () => {
  let fail = true
  const plugin = await SolOrchestratorPlugin({
    client: workerClient({ promptAsync: async () => { if (fail) throw new Error("prompt rejected"); return { data: true } } }),
    directory: "/workspace",
  })

  await assert.rejects(plugin.tool.agents_send.execute({ task_id: worker.id, message: "Fails" }, parentContext), /prompt rejected/)
  let listed = JSON.parse(await plugin.tool.agents_list.execute({}, parentContext)).workers[0]
  assert.equal(listed.prompt_id, "pr_v1_000000000001")
  assert.equal(listed.prompt_stage, "started")
  assert.equal(listed.worker_turn, 1)

  fail = false
  const accepted = JSON.parse(await plugin.tool.agents_send.execute({ task_id: worker.id, message: "Succeeds" }, parentContext))
  assert.equal(accepted.prompt_id, "pr_v1_000000000003")
  listed = JSON.parse(await plugin.tool.agents_list.execute({}, parentContext)).workers[0]
  assert.equal(listed.worker_turn, 2)
})

test("a matching child user message starts an admitted prompt without accepting other sessions or message IDs", async () => {
  const plugin = await SolOrchestratorPlugin({ client: workerClient(), directory: "/workspace" })
  const sent = JSON.parse(await plugin.tool.agents_send.execute({ task_id: worker.id, message: "Start me" }, parentContext))

  await plugin.event({ event: { type: "message.updated", properties: { sessionID: "other-child", info: { id: sent.message_id, role: "user" } } } })
  await plugin.event({ event: { type: "message.updated", properties: { sessionID: worker.id, info: { id: "msg_other", role: "user" } } } })
  let listed = JSON.parse(await plugin.tool.agents_list.execute({}, parentContext)).workers[0]
  assert.equal(listed.prompt_stage, "admitted")

  await plugin.event({ event: { type: "message.updated", properties: { sessionID: worker.id, info: { id: sent.message_id, role: "user" } } } })
  listed = JSON.parse(await plugin.tool.agents_list.execute({}, parentContext)).workers[0]
  assert.equal(listed.prompt_stage, "started")
})

test("acknowledgement requires the current prompt, evidence checkpoints it, and completion cannot regress", async () => {
  const plugin = await SolOrchestratorPlugin({ client: workerClient(), directory: "/workspace" })
  const sent = JSON.parse(await plugin.tool.agents_send.execute({ task_id: worker.id, message: "Do work" }, parentContext))

  await assert.rejects(plugin.tool.report_to_parent.execute({ kind: "acknowledgement", summary: "Stale", prompt_id: "pr_v1_000000000001" }, childContext), /current prompt ID/)
  const acknowledgement = await report(plugin, "acknowledgement", "Accepted", childContext, sent.prompt_id)
  assert.equal(acknowledgement.delivered, true)
  let listed = JSON.parse(await plugin.tool.agents_list.execute({}, parentContext)).workers[0]
  assert.equal(listed.prompt_stage, "acknowledged")

  const evidence = await report(plugin, "evidence", "Observed")
  assert.equal(evidence.prompt_id, sent.prompt_id)
  listed = JSON.parse(await plugin.tool.agents_list.execute({}, parentContext)).workers[0]
  assert.equal(listed.prompt_stage, "checkpointed")
  await report(plugin, "completion", "Done")
  await plugin.event({ event: { type: "message.updated", properties: { sessionID: worker.id, info: { id: sent.message_id, role: "user" } } } })
  listed = JSON.parse(await plugin.tool.agents_list.execute({}, parentContext)).workers[0]
  assert.equal(listed.prompt_stage, "completed")
})

test("legacy reports without prompt_id own the current synthetic prompt and agents_interrupt completes the admitted prompt", async () => {
  let abortCalls = 0
  const plugin = await SolOrchestratorPlugin({
    client: workerClient({ abort: async () => { abortCalls += 1; return { data: true } } }),
    directory: "/workspace",
  })

  const legacy = await report(plugin, "evidence", "Legacy worker")
  assert.equal(legacy.prompt_id, "pr_v1_000000000001")
  const sent = JSON.parse(await plugin.tool.agents_send.execute({ task_id: worker.id, message: "Interrupt me" }, parentContext))
  await plugin.tool.agents_interrupt.execute({ task_id: worker.id }, parentContext)
  const listed = JSON.parse(await plugin.tool.agents_list.execute({}, parentContext)).workers[0]
  assert.equal(abortCalls, 1)
  assert.equal(listed.prompt_id, sent.prompt_id)
  assert.equal(listed.prompt_stage, "completed")
})

test("ships follow-up acknowledgement instructions and Sol lifecycle guidance", async () => {
  const plugin = await SolOrchestratorPlugin({ client: {}, directory: "/workspace" })
  const config = {}
  await plugin.config(config)
  for (const agentType of ["luna-medium", "luna-max", "terra-medium", "terra-max"]) {
    assert.match(config.agent[agentType].prompt, /acknowledgement/)
    assert.match(config.agent[agentType].prompt, /prompt_id/)
  }
  assert.match(config.agent.sol.prompt, /steering_unacknowledged/)
  assert.match(config.agent.sol.prompt, /awaiting_first_checkpoint/)
  assert.match(config.agent.sol.prompt, /checkpoint_stale/)
})

test("task hook persists structured worker metadata across plugin restart and ignores changed titles for routing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-sol-orchestrator-server-"))
  const statePath = path.join(directory, "state.json")
  try {
    const created = await SolOrchestratorPlugin({ client: {}, directory: "/workspace" }, { statePath })
    await created["tool.execute.after"](
      { tool: "task", sessionID: "parent-1", callID: "call-1", args: { subagent_type: "terra-max", description: "Bounded implementation", prompt: "Mode: Implementation\n\nDo the bounded task." } },
      { title: "untrusted task title", output: "", metadata: { sessionId: "child-1" } },
    )
    const child = { id: "child-1", parentID: "parent-1", title: "renamed and unparseable", directory: "/workspace" }
    let requestedAgent
    const restarted = await SolOrchestratorPlugin({
      directory: "/workspace",
      client: { session: {
        get: async () => ({ data: child }), children: async () => ({ data: [child] }), status: async () => ({ data: { "child-1": { type: "busy" } } }),
        promptAsync: async ({ body }) => { requestedAgent = body.agent; return { data: true } }, messages: async () => ({ data: [] }),
      } },
    }, { statePath })
    const listed = JSON.parse(await restarted.tool.agents_list.execute({}, parentContext)).workers[0]
    assert.deepEqual({ agent_type: listed.agent_type, profile_label: listed.profile_label }, { agent_type: "terra-max", profile_label: "Terra Max" })
    await restarted.tool.agents_send.execute({ task_id: "child-1", message: "Continue." }, parentContext)
    assert.equal(requestedAgent, "terra-max")
    const metadata = await new OrchestrationStore({ statePath }).read((state) => state.worker("parent-1", "child-1"))
    assert.deepEqual(metadata, {
      task_id: "child-1", parent_id: "parent-1", agent_type: "terra-max", profile_label: "Terra Max", description: "Bounded implementation", mode: "implementation", source: "task_hook",
      created_at: metadata.created_at, updated_at: metadata.updated_at,
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("legacy title recovery is used only when no structured metadata exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-sol-orchestrator-server-"))
  const statePath = path.join(directory, "state.json")
  try {
    const child = { id: "child-1", parentID: "parent-1", title: "Worker (Terra Max)", directory: "/workspace" }
    const plugin = await SolOrchestratorPlugin({ directory: "/workspace", client: { session: {
      get: async () => ({ data: child }), children: async () => ({ data: [child] }), status: async () => ({ data: { "child-1": { type: "busy" } } }), messages: async () => ({ data: [] }),
    } } }, { statePath })
    assert.equal(JSON.parse(await plugin.tool.agents_list.execute({}, parentContext)).workers[0].agent_type, "terra-max")
    const recovered = await new OrchestrationStore({ statePath }).read((state) => state.worker("parent-1", "child-1"))
    assert.equal(recovered.source, "legacy_recovery")
    assert.equal(recovered.description, "")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("a matching message.updated event admits and starts a persisted reservation after plugin restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-sol-orchestrator-server-"))
  const statePath = path.join(directory, "state.json")
  try {
    const seed = new OrchestrationStore({ statePath })
    const reservation = await seed.mutate((state) => {
      state.registerWorker({ parent_id: "parent-1", task_id: "child-1", agent_type: "terra-max", description: "Restart delivery", mode: "implementation", source: "task_hook" })
      return state.reservePrompt("parent-1", "child-1")
    })
    const child = { id: "child-1", parentID: "parent-1", title: "renamed", directory: "/workspace" }
    const restarted = await SolOrchestratorPlugin({ directory: "/workspace", client: { session: {
      get: async () => ({ data: child }), children: async () => ({ data: [child] }), status: async () => ({ data: { "child-1": { type: "busy" } } }), messages: async () => ({ data: [] }),
    } } }, { statePath })
    await restarted.event({ event: { type: "message.updated", properties: { sessionID: "child-1", info: { id: reservation.message_id, role: "user" } } } })
    const listed = JSON.parse(await restarted.tool.agents_list.execute({}, parentContext)).workers[0]
    assert.deepEqual({ prompt_id: listed.prompt_id, prompt_stage: listed.prompt_stage, worker_turn: listed.worker_turn }, { prompt_id: reservation.prompt_id, prompt_stage: "started", worker_turn: 2 })
    assert.equal(await new OrchestrationStore({ statePath }).read((state) => state.snapshot().reservations.length), 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
