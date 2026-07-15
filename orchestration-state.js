const CHECKPOINT_SCHEMA_VERSION = 1
export const STATE_SCHEMA_VERSION = 3
const LEGACY_STATE_SCHEMA_VERSION = 1
const PREVIOUS_STATE_SCHEMA_VERSION = 2
const CHECKPOINT_ID_PATTERN = /^cp_v1_(\d{12,})$/
const PROMPT_ID_PATTERN = /^pr_v1_(\d{12,})$/
const PROMPT_STAGES = ["admitted", "started", "acknowledged", "checkpointed", "completed"]
const STAGE_INDEX = new Map(PROMPT_STAGES.map((stage, index) => [stage, index]))
const CHECKPOINT_KINDS = new Set(["evidence", "red_evidence", "diff", "blocker", "acknowledgement", "completion"])
export const KNOWN_AGENT_TYPES = Object.freeze(["luna-medium", "luna-max", "terra-medium", "terra-max"])
const AGENT_PROFILE_LABELS = Object.freeze({ "luna-medium": "Luna Medium", "luna-max": "Luna Max", "terra-medium": "Terra Medium", "terra-max": "Terra Max", unknown: "Unknown" })
const WORKER_SOURCES = new Set(["task_hook", "legacy_recovery"])
const taskKey = (parentID, taskID) => `${parentID}\u0000${taskID}`
const clone = (value) => JSON.parse(JSON.stringify(value))
const freeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}
const requiredString = (value, label) => {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`)
  return value
}
const checkpointID = (sequence) => `cp_v1_${String(sequence).padStart(12, "0")}`
const promptID = (sequence) => `pr_v1_${String(sequence).padStart(12, "0")}`
const messageID = (id) => `msg_${id}`
const timestamp = (milliseconds) => new Date(milliseconds).toISOString()
const promptSequenceFromID = (id) => Number(id.match(PROMPT_ID_PATTERN)?.[1])
export const profileLabelFor = (agentType) => AGENT_PROFILE_LABELS[agentType] ?? "Unknown"
const normalizedAgentType = (agentType) => typeof agentType === "string" && KNOWN_AGENT_TYPES.includes(agentType.toLowerCase()) ? agentType.toLowerCase() : "unknown"
const normalizedMode = (mode) => typeof mode === "string" && mode.trim() ? mode.trim().toLowerCase() : "unknown"
export const PROMPT_TEXT_MAX_CHARS = 8_000
export const PROMPT_TEXT_TRUNCATION_MARKER = "\n[... prompt text truncated ...]"
const boundedPromptText = (value) => {
  const text = typeof value === "string" ? value : ""
  return text.length <= PROMPT_TEXT_MAX_CHARS ? text : `${text.slice(0, PROMPT_TEXT_MAX_CHARS - PROMPT_TEXT_TRUNCATION_MARKER.length)}${PROMPT_TEXT_TRUNCATION_MARKER}`
}
const validPromptText = (value) => typeof value === "string" && value.length <= PROMPT_TEXT_MAX_CHARS
const checkpointSummary = (checkpoint) => {
  if (typeof checkpoint.summary === "string" && checkpoint.summary.length > 0) return checkpoint.summary
  if (checkpoint.kind === "acknowledgement" && checkpoint.summary === undefined) return "Acknowledged."
  throw new Error("checkpoint.summary must be a non-empty string.")
}

// Options defaults are intentionally exported so hosts can tune deadline policy without changing protocol behavior.
export const DEFAULT_THRESHOLDS = Object.freeze({
  steeringUnacknowledgedMs: 60_000,
  firstCheckpointMs: 300_000,
  checkpointStaleMs: 900_000,
})

const thresholdsFor = (thresholds = {}) => {
  if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) throw new Error("thresholds must be an object.")
  const resolved = { ...DEFAULT_THRESHOLDS, ...thresholds }
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw new Error(`threshold ${name} must be a non-negative finite integer.`)
  }
  return freeze(resolved)
}

export class OrchestrationState {
  #now
  #thresholds
  #sequence = 0
  #promptSequence = 0
  #history = []
  #checkpointByID = new Map()
  #taskState = new Map()
  #reservations = new Map()
  #workers = new Map()

  constructor({ now = () => Date.now(), thresholds, snapshot } = {}) {
    this.#now = now
    this.#thresholds = thresholdsFor(thresholds)
    if (snapshot) this.#restore(snapshot)
  }

  static restore(snapshot, options = {}) {
    return new OrchestrationState({ ...options, snapshot })
  }

  registerTask(parentID, taskID) {
    requiredString(parentID, "parentID")
    requiredString(taskID, "taskID")
    const key = taskKey(parentID, taskID)
    let state = this.#taskState.get(key)
    if (!state) {
      state = {
        parent_id: parentID,
        task_id: taskID,
        consumed_checkpoint_id: null,
        consumed_sequence: 0,
        turn: 1,
        terminal_completion_id: null,
        unresolved_checkpoint_id: null,
        rebrief_required: false,
        prompt: this.#createPrompt({ synthetic: true }),
      }
      this.#taskState.set(key, state)
    }
    return state
  }

  registerWorker(metadata) {
    if (!metadata || typeof metadata !== "object") throw new Error("worker metadata must be an object.")
    const parentID = requiredString(metadata.parent_id, "worker parent_id")
    const taskID = requiredString(metadata.task_id, "worker task_id")
    const source = metadata.source
    if (!WORKER_SOURCES.has(source)) throw new Error("worker metadata source must be task_hook or legacy_recovery.")
    this.registerTask(parentID, taskID)
    const key = taskKey(parentID, taskID)
    const existing = this.#workers.get(key)
    if (existing?.source === "task_hook" && source === "legacy_recovery") return freeze(clone(existing))
    const instant = this.#instant()
    const worker = {
      task_id: taskID,
      parent_id: parentID,
      agent_type: normalizedAgentType(metadata.agent_type),
      profile_label: profileLabelFor(normalizedAgentType(metadata.agent_type)),
      description: typeof metadata.description === "string" ? metadata.description : "",
      mode: normalizedMode(metadata.mode),
      source,
      created_at: existing?.created_at ?? instant.timestamp,
      updated_at: instant.timestamp,
    }
    this.#workers.set(key, worker)
    return freeze(clone(worker))
  }

  worker(parentID, taskID) {
    requiredString(parentID, "parentID")
    requiredString(taskID, "taskID")
    const worker = this.#workers.get(taskKey(parentID, taskID))
    return worker ? freeze(clone(worker)) : undefined
  }

  workers(parentID) {
    requiredString(parentID, "parentID")
    return freeze([...this.#workers.values()].filter((worker) => worker.parent_id === parentID).map((worker) => freeze(clone(worker))))
  }

  beginTurn(parentID, taskID) {
    const state = this.registerTask(parentID, taskID)
    state.turn += 1
    state.terminal_completion_id = null
    return this.turn(parentID, taskID)
  }

  reservePrompt(parentID, taskID, text) {
    this.registerTask(parentID, taskID)
    const id = promptID(++this.#promptSequence)
    const reservation = freeze({ prompt_id: id, message_id: messageID(id), text: boundedPromptText(text) })
    this.#reservations.set(`${taskKey(parentID, taskID)}\u0000${id}`, reservation)
    return freeze({ prompt_id: reservation.prompt_id, message_id: reservation.message_id })
  }

  cancelPrompt(parentID, taskID, reservation) {
    requiredString(parentID, "parentID")
    requiredString(taskID, "taskID")
    if (!reservation || typeof reservation !== "object") throw new Error("prompt reservation must be an object.")
    const id = requiredString(reservation.prompt_id, "prompt_id")
    const key = `${taskKey(parentID, taskID)}\u0000${id}`
    const saved = this.#reservations.get(key)
    if (!saved || saved.message_id !== reservation.message_id) return false
    this.#reservations.delete(key)
    return true
  }

  admitPrompt(parentID, taskID, reservation) {
    const state = this.registerTask(parentID, taskID)
    if (!reservation || typeof reservation !== "object") throw new Error("prompt reservation must be an object.")
    const id = requiredString(reservation.prompt_id, "prompt_id")
    const key = `${taskKey(parentID, taskID)}\u0000${id}`
    const saved = this.#reservations.get(key)
    if (!saved || saved.message_id !== reservation.message_id) {
      if (state.prompt.prompt_id === id && state.prompt.message_id === reservation.message_id) return this.lifecycle(parentID, taskID)
      throw new Error(`Unknown prompt reservation: ${id}.`)
    }
    this.#reservations.delete(key)
    const instant = this.#instant()
    state.prompt = {
      prompt_id: saved.prompt_id,
      message_id: saved.message_id,
      prompt_stage: "admitted",
      synthetic: false,
      created_at: instant.timestamp,
      created_at_ms: instant.milliseconds,
      admitted_at: instant.timestamp,
      admitted_at_ms: instant.milliseconds,
      started_at: null,
      started_at_ms: null,
      acknowledged_at: null,
      acknowledged_at_ms: null,
      checkpointed_at: null,
      checkpointed_at_ms: null,
      completed_at: null,
      completed_at_ms: null,
      last_meaningful_checkpoint_at: null,
      last_meaningful_checkpoint_at_ms: null,
      text: saved.text,
    }
    state.unresolved_checkpoint_id = null
    state.rebrief_required = false
    this.beginTurn(parentID, taskID)
    return this.lifecycle(parentID, taskID)
  }

  admitReservedPromptByMessage(parentID, taskID, id) {
    requiredString(id, "message ID")
    const prefix = `${taskKey(parentID, taskID)}\u0000`
    const entry = [...this.#reservations.entries()].find(([key, reservation]) => key.startsWith(prefix) && reservation.message_id === id)
    if (!entry) return undefined
    const lifecycle = this.admitPrompt(parentID, taskID, entry[1])
    this.markPromptStarted(parentID, taskID, id)
    return this.lifecycle(parentID, taskID)
  }

  markPromptStarted(parentID, taskID, id) {
    const state = this.registerTask(parentID, taskID)
    if (state.prompt.message_id !== id) return this.lifecycle(parentID, taskID)
    this.#advance(state.prompt, "started")
    return this.lifecycle(parentID, taskID)
  }

  deliver(parentID, checkpoint) {
    requiredString(parentID, "parentID")
    if (!checkpoint || typeof checkpoint !== "object") throw new Error("checkpoint must be an object.")
    const taskID = requiredString(checkpoint.task_id, "checkpoint.task_id")
    if (!CHECKPOINT_KINDS.has(checkpoint.kind)) throw new Error("checkpoint.kind must be a supported checkpoint kind.")
    const summary = checkpointSummary(checkpoint)
    if (!Array.isArray(checkpoint.files) || checkpoint.files.some((file) => typeof file !== "string")) throw new Error("checkpoint.files must be an array of strings.")
    if (typeof checkpoint.needs_decision !== "boolean") throw new Error("checkpoint.needs_decision must be a boolean.")
    if (checkpoint.rebrief_required !== undefined && typeof checkpoint.rebrief_required !== "boolean") throw new Error("checkpoint.rebrief_required must be a boolean when provided.")
    if (checkpoint.created_at !== undefined && (typeof checkpoint.created_at !== "string" || !Number.isFinite(Date.parse(checkpoint.created_at)))) throw new Error("checkpoint.created_at must be a valid timestamp when provided.")
    const state = this.registerTask(parentID, taskID)
    const prompt = this.#checkpointPrompt(state, checkpoint)
    if (checkpoint.kind === "completion" && state.terminal_completion_id) {
      const prior = this.#checkpointByID.get(state.terminal_completion_id)
      return { duplicate: true, checkpoint: prior.checkpoint, cursor: this.cursor(parentID, taskID) }
    }

    if (checkpoint.kind === "acknowledgement") this.#advance(prompt, "acknowledged")
    else if (checkpoint.kind === "completion") this.#advance(prompt, "completed")
    else {
      this.#advance(prompt, "checkpointed")
      const instant = this.#instant()
      prompt.last_meaningful_checkpoint_at = instant.timestamp
      prompt.last_meaningful_checkpoint_at_ms = instant.milliseconds
    }

    const sequence = ++this.#sequence
    const delivered = freeze({
      ...clone(checkpoint),
      task_id: taskID,
      prompt_id: prompt.prompt_id,
      summary,
      created_at: checkpoint.created_at ?? this.#instant().timestamp,
      rebrief_required: checkpoint.rebrief_required === true,
      schema_version: CHECKPOINT_SCHEMA_VERSION,
      sequence,
      checkpoint_id: checkpointID(sequence),
      worker_turn: state.turn,
    })
    const record = { parent_id: parentID, task_id: taskID, checkpoint: delivered }
    this.#history.push(record)
    this.#checkpointByID.set(delivered.checkpoint_id, record)
    if (delivered.kind === "completion") state.terminal_completion_id = delivered.checkpoint_id
    if (delivered.kind === "completion" && !delivered.needs_decision) {
      state.unresolved_checkpoint_id = null
      state.rebrief_required = false
    } else if (delivered.kind === "blocker" || delivered.needs_decision) {
      state.unresolved_checkpoint_id = delivered.checkpoint_id
      if (delivered.rebrief_required) state.rebrief_required = true
    }
    return { duplicate: false, checkpoint: delivered, cursor: this.cursor(parentID, taskID) }
  }

  read(parentID, taskID, { after } = {}) {
    const afterSequence = after === undefined ? this.registerTask(parentID, taskID).consumed_sequence : this.#checkpointFor(parentID, taskID, after).checkpoint.sequence
    return { checkpoints: this.#history.filter((record) => record.parent_id === parentID && record.task_id === taskID && record.checkpoint.sequence > afterSequence).map((record) => record.checkpoint), cursor: this.cursor(parentID, taskID) }
  }

  consumeThrough(parentID, taskID, id) {
    const record = this.#checkpointFor(parentID, taskID, id)
    const state = this.registerTask(parentID, taskID)
    if (record.checkpoint.sequence < state.consumed_sequence) throw new Error(`Checkpoint ${id} is older than the current consumed cursor.`)
    state.consumed_sequence = record.checkpoint.sequence
    state.consumed_checkpoint_id = record.checkpoint.checkpoint_id
    return this.cursor(parentID, taskID)
  }

  unreadCount(parentID, taskID) {
    return this.read(parentID, taskID).checkpoints.length
  }

  checkpointsAfter(parentID, taskIDs, after) {
    requiredString(parentID, "parentID")
    if (!Array.isArray(taskIDs)) throw new Error("taskIDs must be an array.")
    const selected = new Set(taskIDs.map((taskID) => requiredString(taskID, "taskID")))
    const afterSequence = this.#checkpointForParent(parentID, after).checkpoint.sequence
    return this.#history.filter((record) => record.parent_id === parentID && selected.has(record.task_id) && record.checkpoint.sequence > afterSequence).map((record) => record.checkpoint)
  }

  cursor(parentID, taskID) {
    const state = this.registerTask(parentID, taskID)
    const latest = this.#latestCheckpoint(parentID, taskID)
    return freeze({ consumed_through: state.consumed_checkpoint_id, latest_checkpoint_id: latest?.checkpoint_id ?? null })
  }

  turn(parentID, taskID) {
    const state = this.registerTask(parentID, taskID)
    return freeze({ generation: state.turn, terminal_completion_id: state.terminal_completion_id })
  }

  lifecycle(parentID, taskID) {
    const prompt = this.registerTask(parentID, taskID).prompt
    const now = this.#instant().milliseconds
    const derived = this.#derivedState(prompt, now)
    return freeze({
      prompt_id: prompt.prompt_id,
      message_id: prompt.message_id,
      prompt_stage: prompt.prompt_stage,
      prompt_created_at: prompt.created_at,
      prompt_admitted_at: prompt.admitted_at,
      prompt_started_at: prompt.started_at,
      prompt_acknowledged_at: prompt.acknowledged_at,
      prompt_checkpointed_at: prompt.checkpointed_at,
      prompt_completed_at: prompt.completed_at,
      acknowledgement_deadline_at: derived.acknowledgement_deadline_at,
      first_checkpoint_deadline_at: derived.first_checkpoint_deadline_at,
      checkpoint_stale_deadline_at: derived.checkpoint_stale_deadline_at,
      checkpoint_age_ms: derived.checkpoint_age_ms,
      checkpoint_state: derived.checkpoint_state,
    })
  }

  captureInitialPrompt(parentID, taskID, text) {
    const state = this.registerTask(parentID, taskID)
    if (state.prompt.synthetic) state.prompt.text = boundedPromptText(text)
    return this.currentPrompt(parentID, taskID)
  }

  currentPrompt(parentID, taskID) {
    requiredString(parentID, "parentID")
    requiredString(taskID, "taskID")
    const state = this.#taskState.get(taskKey(parentID, taskID))
    return state ? freeze(clone(state.prompt)) : undefined
  }

  lastDecisiveCheckpoint(parentID, taskID) {
    requiredString(parentID, "parentID")
    requiredString(taskID, "taskID")
    for (let index = this.#history.length - 1; index >= 0; index -= 1) {
      const record = this.#history[index]
      if (record.parent_id === parentID && record.task_id === taskID && record.checkpoint.kind !== "acknowledgement") return freeze(clone(record.checkpoint))
    }
    return null
  }

  unresolvedCheckpoint(parentID, taskID) {
    requiredString(parentID, "parentID")
    requiredString(taskID, "taskID")
    const state = this.#taskState.get(taskKey(parentID, taskID))
    if (!state?.unresolved_checkpoint_id) return null
    return freeze(clone(this.#checkpointFor(parentID, taskID, state.unresolved_checkpoint_id).checkpoint))
  }

  rebriefRequired(parentID, taskID) {
    requiredString(parentID, "parentID")
    requiredString(taskID, "taskID")
    return this.#taskState.get(taskKey(parentID, taskID))?.rebrief_required === true
  }

  snapshot() {
    return clone({
      schema_version: STATE_SCHEMA_VERSION,
      sequence: this.#sequence,
      prompt_sequence: this.#promptSequence,
      checkpoints: this.#history.map((record) => ({ parent_id: record.parent_id, task_id: record.task_id, checkpoint: record.checkpoint })),
      tasks: [...this.#taskState.values()].map(({ parent_id, task_id, consumed_checkpoint_id, consumed_sequence, turn, terminal_completion_id, unresolved_checkpoint_id, rebrief_required, prompt }) => ({ parent_id, task_id, consumed_checkpoint_id, consumed_sequence, turn, terminal_completion_id, unresolved_checkpoint_id, rebrief_required, prompt })),
      reservations: [...this.#reservations.entries()].map(([key, reservation]) => {
        const [parent_id, task_id] = key.split("\u0000")
        return { parent_id, task_id, ...reservation }
      }),
      workers: [...this.#workers.values()].map((worker) => clone(worker)),
    })
  }

  #instant() {
    const current = this.#now()
    const milliseconds = typeof current === "number" ? current : current instanceof Date ? current.getTime() : Date.parse(current)
    if (!Number.isFinite(milliseconds)) throw new Error("now must return a valid timestamp.")
    return { milliseconds, timestamp: timestamp(milliseconds) }
  }

  #createPrompt({ synthetic }) {
    const instant = this.#instant(), id = promptID(++this.#promptSequence)
    return {
      prompt_id: id,
      message_id: synthetic ? null : messageID(id),
      prompt_stage: synthetic ? "started" : "admitted",
      synthetic,
      created_at: instant.timestamp,
      created_at_ms: instant.milliseconds,
      admitted_at: synthetic ? null : instant.timestamp,
      admitted_at_ms: synthetic ? null : instant.milliseconds,
      started_at: synthetic ? instant.timestamp : null,
      started_at_ms: synthetic ? instant.milliseconds : null,
      acknowledged_at: null,
      acknowledged_at_ms: null,
      checkpointed_at: null,
      checkpointed_at_ms: null,
      completed_at: null,
      completed_at_ms: null,
      last_meaningful_checkpoint_at: null,
      last_meaningful_checkpoint_at_ms: null,
      text: "",
    }
  }

  #advance(prompt, target) {
    if (STAGE_INDEX.get(target) <= STAGE_INDEX.get(prompt.prompt_stage)) return
    const instant = this.#instant()
    prompt.prompt_stage = target
    prompt[`${target}_at`] = instant.timestamp
    prompt[`${target}_at_ms`] = instant.milliseconds
  }

  #checkpointPrompt(state, checkpoint) {
    const current = state.prompt
    if (checkpoint.kind === "acknowledgement" && checkpoint.prompt_id === undefined) throw new Error("Acknowledgement requires the current prompt ID.")
    if (checkpoint.prompt_id !== undefined) {
      requiredString(checkpoint.prompt_id, "checkpoint.prompt_id")
      if (checkpoint.prompt_id !== current.prompt_id) throw new Error(`Prompt ${checkpoint.prompt_id} is not the current prompt ID ${current.prompt_id}.`)
    }
    return current
  }

  #derivedState(prompt, now) {
    const acknowledgementDeadline = !prompt.synthetic && prompt.admitted_at_ms !== null ? prompt.admitted_at_ms + this.#thresholds.steeringUnacknowledgedMs : null
    const firstCheckpointBase = prompt.synthetic ? prompt.started_at_ms : prompt.acknowledged_at_ms
    const firstCheckpointDeadline = firstCheckpointBase === null ? null : firstCheckpointBase + this.#thresholds.firstCheckpointMs
    const checkpointStaleDeadline = prompt.last_meaningful_checkpoint_at_ms === null ? null : prompt.last_meaningful_checkpoint_at_ms + this.#thresholds.checkpointStaleMs
    let checkpointState
    if (prompt.prompt_stage === "completed") checkpointState = "healthy"
    else if (prompt.prompt_stage === "checkpointed") checkpointState = now > checkpointStaleDeadline ? "checkpoint_stale" : "healthy"
    else if (prompt.synthetic) checkpointState = now > firstCheckpointDeadline ? "checkpoint_stale" : "awaiting_first_checkpoint"
    else if (prompt.prompt_stage === "acknowledged") checkpointState = now > firstCheckpointDeadline ? "checkpoint_stale" : "awaiting_first_checkpoint"
    else checkpointState = now > acknowledgementDeadline ? "steering_unacknowledged" : "healthy"
    return {
      acknowledgement_deadline_at: acknowledgementDeadline === null ? null : timestamp(acknowledgementDeadline),
      first_checkpoint_deadline_at: firstCheckpointDeadline === null ? null : timestamp(firstCheckpointDeadline),
      checkpoint_stale_deadline_at: checkpointStaleDeadline === null ? null : timestamp(checkpointStaleDeadline),
      checkpoint_age_ms: prompt.last_meaningful_checkpoint_at_ms === null ? null : Math.max(0, now - prompt.last_meaningful_checkpoint_at_ms),
      checkpoint_state: checkpointState,
    }
  }

  #latestCheckpoint(parentID, taskID) {
    for (let index = this.#history.length - 1; index >= 0; index -= 1) {
      const record = this.#history[index]
      if (record.parent_id === parentID && record.task_id === taskID) return record.checkpoint
    }
    return undefined
  }

  #checkpointFor(parentID, taskID, id) {
    const record = this.#checkpointForParent(parentID, id)
    if (record.task_id !== taskID) throw new Error(`Checkpoint ${id} belongs to task ${record.task_id}, not ${taskID}.`)
    return record
  }

  #checkpointForParent(parentID, id) {
    requiredString(parentID, "parentID")
    requiredString(id, "checkpoint ID")
    const match = id.match(CHECKPOINT_ID_PATTERN)
    if (!match || checkpointID(Number(match[1])) !== id) throw new Error(`Malformed checkpoint ID: ${id}.`)
    const sequence = Number(match[1])
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`Malformed checkpoint ID: ${id}.`)
    if (sequence > this.#sequence) throw new Error(`Checkpoint ${id} is in the future.`)
    const record = this.#checkpointByID.get(id)
    if (!record) throw new Error(`Unknown checkpoint ID: ${id}.`)
    if (record.parent_id !== parentID) throw new Error(`Checkpoint ${id} belongs to a different parent session.`)
    return record
  }

  #restore(snapshot) {
    if (!snapshot || ![LEGACY_STATE_SCHEMA_VERSION, PREVIOUS_STATE_SCHEMA_VERSION, STATE_SCHEMA_VERSION].includes(snapshot.schema_version) || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || !Array.isArray(snapshot.checkpoints) || !Array.isArray(snapshot.tasks)) throw new Error("Invalid orchestration state snapshot.")
    const sourceSchemaVersion = snapshot.schema_version
    if (snapshot.prompt_sequence !== undefined && (!Number.isSafeInteger(snapshot.prompt_sequence) || snapshot.prompt_sequence < 0)) throw new Error("Invalid orchestration prompt sequence.")
    if (snapshot.reservations !== undefined && !Array.isArray(snapshot.reservations)) throw new Error("Invalid orchestration prompt reservations.")
    if (snapshot.workers !== undefined && !Array.isArray(snapshot.workers)) throw new Error("Invalid orchestration worker metadata.")
    const taskKeys = new Set()
    let maximumPromptSequence = 0
    for (const task of snapshot.tasks) {
      if (!task || !Number.isSafeInteger(task.turn) || task.turn < 1 || !Number.isSafeInteger(task.consumed_sequence) || task.consumed_sequence < 0) throw new Error("Invalid orchestration task snapshot.")
      const key = taskKey(requiredString(task.parent_id, "snapshot parent_id"), requiredString(task.task_id, "snapshot task_id"))
      if (taskKeys.has(key)) throw new Error("Duplicate orchestration task snapshot.")
      taskKeys.add(key)
      const state = this.registerTask(task.parent_id, task.task_id)
      state.consumed_checkpoint_id = task.consumed_checkpoint_id ?? null
      state.consumed_sequence = task.consumed_sequence
      state.turn = task.turn
      state.terminal_completion_id = task.terminal_completion_id ?? null
      if (sourceSchemaVersion >= STATE_SCHEMA_VERSION) {
        if (!Object.hasOwn(task, "unresolved_checkpoint_id") || !Object.hasOwn(task, "rebrief_required") || (task.unresolved_checkpoint_id !== null && typeof task.unresolved_checkpoint_id !== "string") || typeof task.rebrief_required !== "boolean") throw new Error("Invalid orchestration unresolved checkpoint state.")
        state.unresolved_checkpoint_id = task.unresolved_checkpoint_id
        state.rebrief_required = task.rebrief_required
      }
      if (task.prompt !== undefined) {
        state.prompt = this.#restoredPrompt(task.prompt, sourceSchemaVersion)
        maximumPromptSequence = Math.max(maximumPromptSequence, promptSequenceFromID(state.prompt.prompt_id))
      }
    }
    for (const [index, source] of snapshot.checkpoints.entries()) {
      if (!source || source.parent_id !== requiredString(source.parent_id, "snapshot parent_id") || source.task_id !== requiredString(source.task_id, "snapshot task_id") || !source.checkpoint) throw new Error("Invalid orchestration checkpoint snapshot.")
      const restoredCheckpoint = clone(source.checkpoint)
      if (sourceSchemaVersion < STATE_SCHEMA_VERSION) restoredCheckpoint.rebrief_required = false
      if (restoredCheckpoint.kind === "acknowledgement" && restoredCheckpoint.summary === undefined) restoredCheckpoint.summary = "Acknowledged."
      const checkpoint = freeze(restoredCheckpoint)
      const expectedSequence = index + 1
      if (checkpoint.schema_version !== CHECKPOINT_SCHEMA_VERSION || checkpoint.sequence !== expectedSequence || checkpoint.checkpoint_id !== checkpointID(expectedSequence)) throw new Error("Invalid orchestration checkpoint sequence.")
      if (!CHECKPOINT_KINDS.has(checkpoint.kind) || checkpoint.task_id !== source.task_id || !PROMPT_ID_PATTERN.test(requiredString(checkpoint.prompt_id, "checkpoint prompt_id")) || promptID(promptSequenceFromID(checkpoint.prompt_id)) !== checkpoint.prompt_id || typeof checkpoint.summary !== "string" || !Array.isArray(checkpoint.files) || typeof checkpoint.needs_decision !== "boolean" || typeof checkpoint.rebrief_required !== "boolean" || typeof checkpoint.created_at !== "string" || !Number.isFinite(Date.parse(checkpoint.created_at))) throw new Error("Invalid orchestration checkpoint snapshot.")
      const state = this.#taskState.get(taskKey(source.parent_id, source.task_id))
      if (!state) throw new Error("Checkpoint snapshot has no task state.")
      if (!Number.isSafeInteger(checkpoint.worker_turn) || checkpoint.worker_turn < 1 || checkpoint.worker_turn > state.turn) throw new Error("Invalid orchestration worker turn.")
      const record = { parent_id: source.parent_id, task_id: source.task_id, checkpoint }
      this.#history.push(record)
      this.#checkpointByID.set(checkpoint.checkpoint_id, record)
      maximumPromptSequence = Math.max(maximumPromptSequence, promptSequenceFromID(checkpoint.prompt_id))
    }
    if (snapshot.sequence !== this.#history.length) throw new Error("Invalid orchestration state sequence.")
    this.#sequence = snapshot.sequence
    for (const reservation of snapshot.reservations ?? []) {
      if (!reservation || !taskKeys.has(taskKey(requiredString(reservation.parent_id, "reservation parent_id"), requiredString(reservation.task_id, "reservation task_id"))) || !PROMPT_ID_PATTERN.test(requiredString(reservation.prompt_id, "reservation prompt_id")) || promptID(promptSequenceFromID(reservation.prompt_id)) !== reservation.prompt_id || reservation.message_id !== messageID(reservation.prompt_id)) throw new Error("Invalid orchestration prompt reservation.")
      const text = sourceSchemaVersion >= STATE_SCHEMA_VERSION ? reservation.text : ""
      if (!validPromptText(text)) throw new Error("Invalid orchestration prompt text.")
      const key = `${taskKey(reservation.parent_id, reservation.task_id)}\u0000${reservation.prompt_id}`
      if (this.#reservations.has(key)) throw new Error("Duplicate orchestration prompt reservation.")
      this.#reservations.set(key, freeze({ prompt_id: reservation.prompt_id, message_id: reservation.message_id, text }))
      maximumPromptSequence = Math.max(maximumPromptSequence, promptSequenceFromID(reservation.prompt_id))
    }
    for (const worker of snapshot.workers ?? []) {
      if (!worker || !taskKeys.has(taskKey(requiredString(worker.parent_id, "worker parent_id"), requiredString(worker.task_id, "worker task_id"))) || !WORKER_SOURCES.has(worker.source) || normalizedAgentType(worker.agent_type) !== worker.agent_type || worker.profile_label !== profileLabelFor(worker.agent_type) || typeof worker.description !== "string" || normalizedMode(worker.mode) !== worker.mode || typeof worker.created_at !== "string" || typeof worker.updated_at !== "string" || !Number.isFinite(Date.parse(worker.created_at)) || !Number.isFinite(Date.parse(worker.updated_at)) || Date.parse(worker.updated_at) < Date.parse(worker.created_at)) throw new Error("Invalid orchestration worker metadata.")
      const key = taskKey(worker.parent_id, worker.task_id)
      if (this.#workers.has(key)) throw new Error("Duplicate orchestration worker metadata.")
      this.#workers.set(key, clone(worker))
    }
    if ((snapshot.prompt_sequence ?? 0) < maximumPromptSequence) throw new Error("Invalid orchestration prompt sequence.")
    this.#promptSequence = Math.max(this.#promptSequence, snapshot.prompt_sequence ?? 0)
    for (const state of this.#taskState.values()) {
      if (state.consumed_checkpoint_id) {
        const record = this.#checkpointFor(state.parent_id, state.task_id, state.consumed_checkpoint_id)
        if (record.checkpoint.sequence !== state.consumed_sequence) throw new Error("Invalid consumed cursor snapshot.")
      } else if (state.consumed_sequence !== 0) throw new Error("Invalid consumed cursor snapshot.")
      if (state.terminal_completion_id) {
        const record = this.#checkpointFor(state.parent_id, state.task_id, state.terminal_completion_id)
        if (record.checkpoint.kind !== "completion" || record.checkpoint.worker_turn !== state.turn) throw new Error("Invalid terminal completion snapshot.")
      }
      if (state.unresolved_checkpoint_id) {
        const record = this.#checkpointFor(state.parent_id, state.task_id, state.unresolved_checkpoint_id)
        if (record.checkpoint.kind !== "blocker" && !record.checkpoint.needs_decision) throw new Error("Invalid orchestration unresolved checkpoint state.")
      }
      if (state.rebrief_required && !state.unresolved_checkpoint_id) throw new Error("Invalid orchestration rebrief state.")
      if (state.rebrief_required && !this.#history.some((record) => record.parent_id === state.parent_id && record.task_id === state.task_id && record.checkpoint.rebrief_required)) throw new Error("Invalid orchestration rebrief state.")
    }
  }

  #restoredPrompt(prompt, sourceSchemaVersion) {
    if (!prompt || typeof prompt !== "object" || !PROMPT_STAGES.includes(prompt.prompt_stage) || !PROMPT_ID_PATTERN.test(requiredString(prompt.prompt_id, "snapshot prompt_id")) || promptID(promptSequenceFromID(prompt.prompt_id)) !== prompt.prompt_id) throw new Error("Invalid orchestration prompt snapshot.")
    if (typeof prompt.synthetic !== "boolean") throw new Error("Invalid orchestration prompt lifecycle.")
    const text = sourceSchemaVersion >= STATE_SCHEMA_VERSION ? prompt.text : ""
    if (!validPromptText(text)) throw new Error("Invalid orchestration prompt text.")
    const synthetic = prompt.synthetic === true
    if ((synthetic && prompt.message_id !== null) || (!synthetic && prompt.message_id !== messageID(prompt.prompt_id))) throw new Error("Invalid orchestration prompt message ID.")
    for (const field of ["created", "admitted", "started", "acknowledged", "checkpointed", "completed", "last_meaningful_checkpoint"]) {
      const milliseconds = prompt[`${field}_at_ms`], value = prompt[`${field}_at`]
      if ((milliseconds === null) !== (value === null) || (milliseconds !== null && (!Number.isFinite(milliseconds) || typeof value !== "string" || Date.parse(value) !== milliseconds))) throw new Error("Invalid orchestration prompt timestamp.")
    }
    const stage = STAGE_INDEX.get(prompt.prompt_stage)
    const stageField = PROMPT_STAGES[stage]
    if (prompt.created_at_ms === null || prompt[`${stageField}_at_ms`] === null || (synthetic && (stage < STAGE_INDEX.get("started") || prompt.admitted_at_ms !== null || prompt.started_at_ms === null)) || (!synthetic && (prompt.admitted_at_ms === null || stage < STAGE_INDEX.get("admitted"))) || (prompt.prompt_stage === "checkpointed" && prompt.last_meaningful_checkpoint_at_ms === null) || (stage < STAGE_INDEX.get("checkpointed") && prompt.last_meaningful_checkpoint_at_ms !== null) || (prompt.last_meaningful_checkpoint_at_ms !== null && prompt.checkpointed_at_ms === null)) throw new Error("Invalid orchestration prompt lifecycle.")
    for (const later of PROMPT_STAGES.slice(stage + 1)) if (prompt[`${later}_at_ms`] !== null) throw new Error("Invalid orchestration prompt lifecycle.")
    let previous = -Infinity
    for (const field of ["created", "admitted", "started", "acknowledged", "checkpointed", "last_meaningful_checkpoint", "completed"]) {
      const current = prompt[`${field}_at_ms`]
      if (current !== null && current < previous) throw new Error("Invalid orchestration prompt lifecycle.")
      if (current !== null) previous = current
    }
    return { ...clone(prompt), text }
  }
}
