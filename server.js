import { tool } from "@opencode-ai/plugin"
import { defaultAgents, mergeAgentDefinition } from "./agents.js"
import { compactionSnapshotMaxChars, isOrchestrationSnapshot, renderCompactionSnapshot } from "./compaction-snapshot.js"
import { KNOWN_AGENT_TYPES, profileLabelFor } from "./orchestration-state.js"
import { OrchestrationStore } from "./orchestration-store.js"

const AGENT_TYPES = KNOWN_AGENT_TYPES
const CHECKPOINT_KINDS = ["evidence", "red_evidence", "diff", "blocker", "acknowledgement", "completion"]
const agentTypeFromTitle = (title = "") => {
  const current = title.match(/\((Luna|Terra) (Medium|Max)\)$/i)
  return current ? `${current[1]}-${current[2]}`.toLowerCase() : title.match(/\(@([^ ]+) subagent\)/)?.[1]
}
const knownAgentType = (agentType) => AGENT_TYPES.includes(agentType) ? agentType : undefined
const modeFromSealedPrompt = (prompt) => typeof prompt === "string" ? prompt.match(/^Mode:\s*([^\r\n]+?)\s*$/mi)?.[1]?.trim().toLowerCase() ?? "unknown" : "unknown"
const taskIDFromOutput = (metadata) => [metadata?.sessionId, metadata?.sessionID, metadata?.session_id].find((value) => typeof value === "string" && value)
const result = (value) => JSON.stringify(value, null, 2)
function unwrap(response, operation) {
  if (response?.error) throw new Error(`${operation} failed: ${typeof response.error === "string" ? response.error : JSON.stringify(response.error)}`)
  return response && Object.hasOwn(response, "data") ? response.data : response
}
const textParts = (messages) => messages.filter((message) => message.info?.role === "assistant").flatMap((message) => message.parts.filter((part) => part.type === "text" && !part.ignored).map((part) => ({ message_id: message.info.id, text: part.text })))
function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    const onAbort = () => { clearTimeout(timeout); reject(new Error("The orchestration wait was interrupted.")) }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener("abort", onAbort, { once: true }); timeout.unref?.()
  })
}

export const SolOrchestratorPlugin = async ({ client, directory }, options = {}) => {
  const snapshotMaxChars = compactionSnapshotMaxChars(options.compactionSnapshotMaxChars)
  const store = options.store ?? new OrchestrationStore({ statePath: options.statePath, env: options.env, home: options.home, fs: options.fs, now: options.now, sleep: options.sleep, thresholds: options.thresholds, lockTimeoutMs: options.lockTimeoutMs, lockRetryMs: options.lockRetryMs, staleLockMs: options.staleLockMs })
  await store.initialize()
  const deliver = async (parentID, checkpoint) => store.mutate((protocol) => protocol.deliver(parentID, checkpoint))
  const ensureTask = async (parentID, taskID) => store.mutate((protocol) => protocol.registerTask(parentID, taskID))
  const storedWorker = async (parentID, taskID) => store.read((protocol) => protocol.worker(parentID, taskID))
  async function sessionGet(taskID, cwd) { const session = unwrap(await client.session.get({ path: { id: taskID }, query: { directory: cwd ?? directory } }), "session.get"); if (!session) throw new Error(`Unknown worker session: ${taskID}`); return session }
  async function recoverWorker(taskID, cwd, knownSession) {
    const session = knownSession ?? await sessionGet(taskID, cwd)
    if (!session.parentID) return undefined
    const stored = await storedWorker(session.parentID, taskID)
    if (stored) return { ...stored, directory: cwd ?? session.directory ?? directory }
    const agentType = knownAgentType(agentTypeFromTitle(session.title))
    if (!agentType) return undefined
    const worker = await store.mutate((protocol) => protocol.registerWorker({ parent_id: session.parentID, task_id: taskID, agent_type: agentType, description: "", mode: "unknown", source: "legacy_recovery" }))
    return { ...worker, directory: cwd ?? session.directory ?? directory }
  }
  async function ownedWorker(parentID, taskID, cwd) {
    const session = await sessionGet(taskID, cwd)
    if (session.parentID !== parentID) throw new Error(`Session ${taskID} is not a child of the current parent session.`)
    const worker = await recoverWorker(taskID, cwd, session)
    if (!worker) await ensureTask(parentID, taskID)
    return { session, worker }
  }
  const statusMap = async (cwd) => unwrap(await client.session.status({ query: { directory: cwd ?? directory } }), "session.status") ?? {}
  const childSessions = async (parentID, cwd) => unwrap(await client.session.children({ path: { id: parentID }, query: { directory: cwd ?? directory } }), "session.children") ?? []
  const sessionMessages = async (taskID, cwd) => unwrap(await client.session.messages({ path: { id: taskID }, query: { directory: cwd ?? directory } }), "session.messages") ?? []
  async function snapshot(parentID, cwd) {
    const [children, statuses] = await Promise.all([childSessions(parentID, cwd), statusMap(cwd)])
    const workers = await Promise.all(children.map(async (session) => {
      const worker = await recoverWorker(session.id, cwd, session)
      if (!worker) await ensureTask(parentID, session.id)
      return { session, worker }
    }))
    return store.read((protocol) => workers.map(({ session, worker }) => ({
      task_id: session.id,
      title: session.title,
      agent_type: worker?.agent_type ?? "unknown",
      profile_label: worker?.profile_label ?? "Unknown",
      state: statuses[session.id]?.type ?? "idle",
      checkpoint_count: protocol.unreadCount(parentID, session.id),
      updated_at: session.time?.updated,
      worker_turn: protocol.turn(parentID, session.id).generation,
      ...protocol.lifecycle(parentID, session.id),
    })))
  }
  async function compactionWorkers(parentID, cwd) {
    const [initialWorkers, childrenResult, statusesResult] = await Promise.all([
      store.read((protocol) => protocol.workers(parentID)),
      childSessions(parentID, cwd).catch(() => []),
      statusMap(cwd).catch(() => ({})),
    ])
    const children = Array.isArray(childrenResult) ? childrenResult.filter((session) => typeof session?.id === "string" && session.id) : []
    const statuses = statusesResult && typeof statusesResult === "object" ? statusesResult : {}
    const knownTaskIDs = new Set(initialWorkers.map((worker) => worker.task_id))
    for (const session of children) {
      if (knownTaskIDs.has(session.id)) continue
      const recovered = await recoverWorker(session.id, cwd, session)
      if (recovered) knownTaskIDs.add(session.id)
    }
    const durableWorkers = await store.read((protocol) => protocol.workers(parentID))
    const durableByTaskID = new Map(durableWorkers.map((worker) => [worker.task_id, worker]))
    const sessionByTaskID = new Map(children.map((session) => [session.id, session]))
    const taskIDs = new Set([...durableByTaskID.keys(), ...sessionByTaskID.keys()])
    return store.read((protocol) => [...taskIDs].map((taskID) => {
      const worker = durableByTaskID.get(taskID)
      const session = sessionByTaskID.get(taskID)
      const prompt = protocol.currentPrompt(parentID, taskID)
      const lifecycle = prompt ? protocol.lifecycle(parentID, taskID) : null
      return {
        task_id: taskID,
        agent_type: worker?.agent_type ?? "unknown",
        profile_label: worker?.profile_label ?? "Unknown",
        description: worker?.description ?? "",
        mode: worker?.mode ?? "unknown",
        live_state: session ? typeof statuses[taskID]?.type === "string" ? statuses[taskID].type : "unknown" : "unavailable",
        updated_at: worker?.updated_at ?? session?.time?.updated ?? null,
        current_prompt: prompt ? {
          text: prompt.text,
          prompt_id: prompt.prompt_id,
          prompt_stage: prompt.prompt_stage,
          created_at: prompt.created_at,
          admitted_at: prompt.admitted_at,
          started_at: prompt.started_at,
          acknowledged_at: prompt.acknowledged_at,
          checkpointed_at: prompt.checkpointed_at,
          completed_at: prompt.completed_at,
          checkpoint_state: lifecycle.checkpoint_state,
          checkpoint_age_ms: lifecycle.checkpoint_age_ms,
          acknowledgement_deadline_at: lifecycle.acknowledgement_deadline_at,
          first_checkpoint_deadline_at: lifecycle.first_checkpoint_deadline_at,
          checkpoint_stale_deadline_at: lifecycle.checkpoint_stale_deadline_at,
        } : null,
        last_decisive_checkpoint: protocol.lastDecisiveCheckpoint(parentID, taskID),
        unresolved_checkpoint: protocol.unresolvedCheckpoint(parentID, taskID),
        rebrief_required: protocol.rebriefRequired(parentID, taskID),
      }
    }))
  }
  const tools = {
    agents_send: tool({ description: "Privately send steering, correction, a full post-compaction rebrief, or a bounded follow-up to an existing child worker without waiting. The worker keeps its original profile; agent_type is only a legacy recovery hint and cannot switch a known worker to another profile.", args: { task_id: tool.schema.string().min(1), message: tool.schema.string().min(1), agent_type: tool.schema.enum(AGENT_TYPES).optional() }, async execute(args, context) {
      const child = await ownedWorker(context.sessionID, args.task_id, context.directory)
      let worker = child.worker
      if (!worker && args.agent_type) worker = await store.mutate((protocol) => protocol.registerWorker({ parent_id: context.sessionID, task_id: args.task_id, agent_type: args.agent_type, description: "", mode: "unknown", source: "legacy_recovery" }))
      const existingAgent = knownAgentType(worker?.agent_type)
      if (args.agent_type && existingAgent && args.agent_type !== existingAgent) throw new Error(`Worker ${args.task_id} uses ${existingAgent}; a follow-up cannot switch it to ${args.agent_type}.`)
      if (worker?.source === "task_hook" && !existingAgent) throw new Error("The worker profile recorded by the task hook is unknown and cannot be overridden by a follow-up.")
      const agentType = existingAgent ?? args.agent_type
      if (!agentType) throw new Error("The worker profile is unknown; provide agent_type only to recover a legacy child.")
      context.metadata?.({ title: `Steering ${profileLabelFor(agentType)}` })
      const prompt = await store.mutate((protocol) => protocol.reservePrompt(context.sessionID, args.task_id, args.message))
      const text = `[Sol prompt ${prompt.prompt_id}] Acknowledge immediately via report_to_parent(kind: "acknowledgement", prompt_id: "${prompt.prompt_id}") before bounded work continues.\n\n${args.message}`
      try {
        unwrap(await client.session.promptAsync({ path: { id: args.task_id }, query: { directory: context.directory }, body: { agent: agentType, messageID: prompt.message_id, parts: [{ type: "text", text }] } }), "session.promptAsync")
      } catch (error) {
        await store.mutate((protocol) => protocol.cancelPrompt(context.sessionID, args.task_id, prompt))
        throw error
      }
      const admitted = await store.mutate((protocol) => protocol.admitPrompt(context.sessionID, args.task_id, prompt))
      return result({ task_id: args.task_id, agent_type: agentType, accepted: true, prompt_id: admitted.prompt_id, message_id: admitted.message_id, prompt_stage: admitted.prompt_stage })
    } }),
    agents_list: tool({ description: "List this parent session's managed child workers, profile labels, live states, and unread checkpoint counts.", args: {}, async execute(_args, context) { context.metadata?.({ title: "Checking workers" }); return result({ workers: await snapshot(context.sessionID, context.directory) }) } }),
    agents_read: tool({ description: "Read a managed child worker's assistant messages and checkpoint mailbox. Optionally read strictly after or consume through a checkpoint ID.", args: { task_id: tool.schema.string().min(1), consume_checkpoints: tool.schema.boolean().optional(), after: tool.schema.string().min(1).optional(), consume_through: tool.schema.string().min(1).optional() }, async execute(args, context) {
      if (args.consume_checkpoints && args.consume_through) throw new Error("Specify either consume_checkpoints or consume_through, not both.")
      const child = await ownedWorker(context.sessionID, args.task_id, context.directory)
      context.metadata?.({ title: `Reviewing ${child.worker?.profile_label ?? "worker"}` })
      const read = await store.read((protocol) => protocol.read(context.sessionID, args.task_id, { after: args.after }))
      const cursor = args.consume_through ? await store.mutate((protocol) => protocol.consumeThrough(context.sessionID, args.task_id, args.consume_through)) : args.consume_checkpoints && read.checkpoints.length ? await store.mutate((protocol) => protocol.consumeThrough(context.sessionID, args.task_id, read.checkpoints.at(-1).checkpoint_id)) : read.cursor
      return result({ task_id: args.task_id, agent_type: child.worker?.agent_type ?? "unknown", messages: textParts(await sessionMessages(args.task_id, context.directory)), checkpoints: read.checkpoints, cursor })
    } }),
    agents_wait: tool({ description: "Wait until any or all selected workers become idle, fail, or post an eligible checkpoint. Use only when no independent parent work remains.", args: { task_ids: tool.schema.array(tool.schema.string().min(1)).optional(), until: tool.schema.enum(["any", "all"]).optional(), timeout_ms: tool.schema.number().int().min(0).max(60000).optional(), after: tool.schema.string().min(1).optional() }, async execute(args, context) {
      context.metadata?.({ title: "Waiting for workers" }); const timeout = args.timeout_ms ?? 30000, until = args.until ?? "any", started = Date.now()
      while (true) {
        const workersNow = await snapshot(context.sessionID, context.directory), selected = args.task_ids?.length ? workersNow.filter((worker) => args.task_ids.includes(worker.task_id)) : workersNow
        if (args.task_ids?.length && selected.length !== args.task_ids.length) throw new Error("At least one requested task_id is not owned by the current parent session.")
        const mailbox = await store.read((protocol) => ({
          checkpoints: args.after ? protocol.checkpointsAfter(context.sessionID, selected.map((worker) => worker.task_id), args.after) : selected.flatMap((worker) => protocol.read(context.sessionID, worker.task_id).checkpoints),
          cursors: Object.fromEntries(selected.map((worker) => [worker.task_id, protocol.cursor(context.sessionID, worker.task_id)])),
        }))
        const conditionMet = mailbox.checkpoints.length > 0 || (selected.length > 0 && (until === "all" ? selected.every((worker) => worker.state === "idle") : selected.some((worker) => worker.state === "idle")))
        if (conditionMet || Date.now() - started >= timeout) return result({ timed_out: !conditionMet, workers: selected, checkpoints: mailbox.checkpoints, cursors: mailbox.cursors })
        await sleep(200, context.abort)
      }
    } }),
    agents_interrupt: tool({ description: "Interrupt one selected child worker owned by this parent session.", args: { task_id: tool.schema.string().min(1), reason: tool.schema.string().min(1).optional() }, async execute(args, context) { const child = await ownedWorker(context.sessionID, args.task_id, context.directory); context.metadata?.({ title: `Stopping ${child.worker?.profile_label ?? "worker"}` }); unwrap(await client.session.abort({ path: { id: args.task_id }, query: { directory: context.directory } }), "session.abort"); await deliver(context.sessionID, { task_id: args.task_id, kind: "completion", summary: args.reason ? `Interrupted by Sol: ${args.reason}` : "Interrupted by Sol.", files: [], needs_decision: false }); return result({ task_id: args.task_id, interrupted: true }) } }),
    report_to_parent: tool({ description: "Send a concise private event-driven checkpoint to Sol at acknowledgement, evidence, diff, blocker, completion, or decision boundaries; do not use it for periodic narration.", args: { kind: tool.schema.enum(CHECKPOINT_KINDS), prompt_id: tool.schema.string().min(1).optional(), summary: tool.schema.string().min(1).max(4000), files: tool.schema.array(tool.schema.string()).optional(), needs_decision: tool.schema.boolean().optional() }, async execute(args, context) { const session = await sessionGet(context.sessionID, context.directory); if (!session.parentID) throw new Error("report_to_parent is available only inside a child session."); const worker = await recoverWorker(context.sessionID, context.directory, session); if (!worker) await ensureTask(session.parentID, context.sessionID); context.metadata?.({ title: "Updating Sol" }); const delivery = await deliver(session.parentID, { task_id: context.sessionID, agent_type: knownAgentType(worker?.agent_type) ?? context.agent, kind: args.kind, prompt_id: args.prompt_id, summary: args.summary, files: args.files ?? [], needs_decision: args.needs_decision ?? false }); return result({ delivered: true, parent_session_id: session.parentID, duplicate: delivery.duplicate, checkpoint_id: delivery.checkpoint.checkpoint_id, prompt_id: delivery.checkpoint.prompt_id, cursor: delivery.cursor }) } }),
  }
  return {
    tool: tools,
    async config(config) { if (options.registerAgents === false) return; const defaults = await defaultAgents(); config.agent ??= {}; for (const [name, agent] of Object.entries(defaults)) config.agent[name] = mergeAgentDefinition(agent, config.agent[name]) },
    async "tool.execute.after"(input, output) {
      if (input.tool !== "task") return
      const taskID = taskIDFromOutput(output.metadata)
      if (!taskID) return
      await store.mutate((protocol) => {
        protocol.registerWorker({
          parent_id: input.sessionID,
          task_id: taskID,
          agent_type: input.args?.subagent_type,
          description: typeof input.args?.description === "string" ? input.args.description : "",
          mode: modeFromSealedPrompt(input.args?.prompt),
          source: "task_hook",
        })
        protocol.captureInitialPrompt(input.sessionID, taskID, input.args?.prompt)
      })
    },
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const taskID = event.properties.sessionID ?? event.properties.info?.sessionID
        const message = event.properties.info
        if (!taskID || message?.role !== "user") return
        const worker = await recoverWorker(taskID)
        if (!worker) return
        await store.mutate((protocol) => protocol.admitReservedPromptByMessage(worker.parent_id, taskID, message.id) ?? protocol.markPromptStarted(worker.parent_id, taskID, message.id))
        return
      }
      if (event.type !== "session.compacted" && event.type !== "session.idle") return
      const taskID = event.properties.sessionID
      if (event.type === "session.compacted") {
        const worker = await recoverWorker(taskID)
        if (!worker) return
        await deliver(worker.parent_id, { task_id: taskID, agent_type: worker.agent_type, kind: "blocker", summary: "OpenCode compacted this worker session. Resend the full sealed brief before asking it to continue; do not rely on partial conversation fragments.", files: [], needs_decision: true, rebrief_required: true })
        return
      }
      const worker = await recoverWorker(taskID)
      if (!worker) return
      try {
        const assistantText = textParts(await sessionMessages(taskID, worker.directory)).at(-1)?.text ?? "Worker completed without a text result."
        await deliver(worker.parent_id, { task_id: taskID, agent_type: worker.agent_type, kind: "completion", summary: assistantText, files: [], needs_decision: false })
      } catch (error) {
        await deliver(worker.parent_id, { task_id: taskID, agent_type: worker.agent_type, kind: "blocker", summary: `Could not read the completed worker result: ${error instanceof Error ? error.message : String(error)}`, files: [], needs_decision: true })
      }
    },
    async "experimental.session.compacting"(input, output) {
      if (!input?.sessionID || !Array.isArray(output?.context) || output.context.some(isOrchestrationSnapshot)) return
      const rendered = renderCompactionSnapshot({ workers: await compactionWorkers(input.sessionID, input.directory), maxChars: snapshotMaxChars })
      if (rendered) output.context.push(rendered)
    },
  }
}
export default { id: "opencode-sol-orchestrator.server", server: SolOrchestratorPlugin }
