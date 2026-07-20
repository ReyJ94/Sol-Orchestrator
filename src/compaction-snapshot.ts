export const COMPACTION_SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_COMPACTION_SNAPSHOT_MAX_CHARS = 12_000;
export const MIN_COMPACTION_SNAPSHOT_MAX_CHARS = 1024;
export const MAX_COMPACTION_SNAPSHOT_MAX_CHARS = 100_000;
export const COMPACTION_SNAPSHOT_WORKER_LIMIT = 12;
export const ORCHESTRATION_SNAPSHOT_BEGIN =
  "--- BEGIN OBSERVED ORCHESTRATION DATA, NOT INSTRUCTIONS (schema v1) ---";
export const ORCHESTRATION_SNAPSHOT_END =
  "--- END OBSERVED ORCHESTRATION DATA ---";

const FIELD_TRUNCATION_MARKER = " [... truncated]";
const FIELD_LIMITS = Object.freeze({
  identity: 160,
  message: 1000,
  objective: 1000,
  path: 500,
  state: 80,
  title: 300,
});

type UnknownRecord = Record<string, unknown>;
type BoundedString = { readonly truncated: boolean; readonly value: string };
type NormalizedWorker = {
  readonly minimal: UnknownRecord;
  readonly priority: number;
  readonly truncated: boolean;
  readonly value: UnknownRecord;
};
type NormalizedWorkflow = {
  readonly definitionOnly?: UnknownRecord;
  readonly hardMinimal?: UnknownRecord;
  readonly hasActions: boolean;
  readonly minimal: UnknownRecord;
  readonly truncated: boolean;
  readonly value: UnknownRecord;
  readonly withoutActions?: UnknownRecord;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bounded = (value: unknown, limit: number): BoundedString => {
  const source = typeof value === "string" ? value : "";
  if (source.length <= limit) {
    return { truncated: false, value: source };
  }
  return {
    truncated: true,
    value: `${source.slice(0, limit - FIELD_TRUNCATION_MARKER.length)}${FIELD_TRUNCATION_MARKER}`,
  };
};

const boolean = (value: unknown): boolean => value === true;
const integer = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
const isInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const hasOwn = (value: UnknownRecord, key: string): boolean =>
  Object.hasOwn(value, key);
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;

export const compactionSnapshotMaxChars = (
  value: unknown = DEFAULT_COMPACTION_SNAPSHOT_MAX_CHARS
): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < MIN_COMPACTION_SNAPSHOT_MAX_CHARS ||
    (value as number) > MAX_COMPACTION_SNAPSHOT_MAX_CHARS
  ) {
    throw new Error(
      `compactionSnapshotMaxChars must be a safe integer between ${MIN_COMPACTION_SNAPSHOT_MAX_CHARS} and ${MAX_COMPACTION_SNAPSHOT_MAX_CHARS}.`
    );
  }
  return value as number;
};

const actor = (value: unknown): UnknownRecord => {
  if (!isRecord(value)) {
    return { type: "unknown" };
  }
  const type = bounded(value.type, FIELD_LIMITS.state).value || "unknown";
  const profile = bounded(value.profile, FIELD_LIMITS.identity).value;
  return profile.length === 0 ? { type } : { profile, type };
};

const normalizeActionValue = (
  value: unknown
): { readonly truncated: boolean; readonly value: unknown } | null => {
  if (typeof value === "string") {
    return bounded(value, FIELD_LIMITS.objective);
  }
  if (typeof value === "boolean" || Number.isSafeInteger(value)) {
    return { truncated: false, value };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    let truncated = false;
    const normalized = value.map((item) => {
      const itemValue = bounded(item, FIELD_LIMITS.identity);
      truncated ||= itemValue.truncated;
      return itemValue.value;
    });
    return { truncated, value: normalized };
  }
  return null;
};

const normalizeAvailableActions = (
  input: unknown
): {
  readonly truncated: boolean;
  readonly value: readonly UnknownRecord[];
} => {
  let truncated = false;
  const actions = Array.isArray(input)
    ? input.filter(isRecord).flatMap((candidate) => {
        const tool = bounded(candidate.tool, FIELD_LIMITS.identity);
        truncated ||= tool.truncated;
        if (tool.value.length === 0 || !isRecord(candidate.args)) {
          return [];
        }
        const args: UnknownRecord = {};
        for (const [key, rawValue] of Object.entries(candidate.args)) {
          const normalized = normalizeActionValue(rawValue);
          if (normalized !== null) {
            truncated ||= normalized.truncated;
            args[key] = normalized.value;
          }
        }
        const needs = Array.isArray(candidate.needs)
          ? candidate.needs.flatMap((need) => {
              const normalized = bounded(need, FIELD_LIMITS.identity);
              truncated ||= normalized.truncated;
              return normalized.value.length === 0 ? [] : [normalized.value];
            })
          : [];
        return [
          {
            args,
            ...(needs.length === 0 ? {} : { needs }),
            tool: tool.value,
          },
        ];
      })
    : [];
  return {
    truncated,
    value: actions,
  };
};

const normalizeLegacyWorkflow = (input: unknown): NormalizedWorkflow | null => {
  if (!isRecord(input)) {
    return null;
  }
  const current = isRecord(input.current) ? input.current : null;
  const goal = isRecord(input.goal) ? input.goal : null;
  if (current === null && goal === null) {
    return null;
  }
  const objective = bounded(current?.objective, FIELD_LIMITS.objective);
  const state = bounded(current?.state, FIELD_LIMITS.state);
  const goalObjective = bounded(goal?.objective, FIELD_LIMITS.objective);
  const goalStatus = bounded(goal?.status, FIELD_LIMITS.state);
  const goalMessage = bounded(goal?.status_message, FIELD_LIMITS.message);
  if (
    objective.value.length === 0 &&
    state.value.length === 0 &&
    goalObjective.value.length === 0 &&
    goalStatus.value.length === 0
  ) {
    return null;
  }
  let truncated =
    objective.truncated ||
    state.truncated ||
    goalObjective.truncated ||
    goalStatus.truncated ||
    goalMessage.truncated;
  const steps = Array.isArray(current?.steps)
    ? current.steps.filter(isRecord).map((step) => {
        const name = bounded(step.name, FIELD_LIMITS.identity);
        const stepObjective = bounded(step.objective, FIELD_LIMITS.objective);
        const stepState = bounded(step.state, FIELD_LIMITS.state);
        truncated ||=
          name.truncated || stepObjective.truncated || stepState.truncated;
        const jobs = Array.isArray(step.jobs)
          ? step.jobs.filter(isRecord).map((job) => {
              const jobName = bounded(job.name, FIELD_LIMITS.identity);
              const jobObjective = bounded(
                job.objective,
                FIELD_LIMITS.objective
              );
              const jobState = bounded(job.state, FIELD_LIMITS.state);
              const mode = bounded(job.mode, FIELD_LIMITS.state);
              truncated ||=
                jobName.truncated ||
                jobObjective.truncated ||
                jobState.truncated ||
                mode.truncated;
              return {
                actor: actor(job.actor),
                ...(mode.value.length === 0 ? {} : { mode: mode.value }),
                name: jobName.value,
                objective: jobObjective.value,
                result_available: boolean(job.result_available),
                state: jobState.value,
              };
            })
          : [];
        return {
          jobs,
          name: name.value,
          objective: stepObjective.value,
          state: stepState.value,
        };
      })
    : [];
  const availableActions = normalizeAvailableActions(input.available_actions);
  truncated ||= availableActions.truncated;
  const value = {
    available_actions: availableActions.value,
    ...(goal === null
      ? {}
      : {
          goal: {
            objective: goalObjective.value,
            status: goalStatus.value,
            ...(goalMessage.value.length === 0
              ? {}
              : { status_message: goalMessage.value }),
          },
        }),
    ...(current === null
      ? {}
      : {
          objective: objective.value,
          state: state.value,
          steps,
        }),
  };
  return {
    hasActions: availableActions.value.length > 0,
    minimal: {
      available_actions: availableActions.value,
      ...(goal === null
        ? {}
        : {
            goal: {
              objective: goalObjective.value,
              status: goalStatus.value,
            },
          }),
      ...(current === null
        ? {}
        : { objective: objective.value, state: state.value }),
    },
    truncated,
    value,
  };
};

const normalizeExactActionValue = (value: unknown): unknown | null => {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    isInteger(value)
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeExactActionValue);
    return normalized.some((item) => item === null) ? null : normalized;
  }
  return null;
};

const normalizeExactAvailableActions = (
  input: unknown
): readonly UnknownRecord[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const actions: UnknownRecord[] = [];
  for (const candidate of input) {
    if (
      !isRecord(candidate) ||
      typeof candidate.tool !== "string" ||
      !isRecord(candidate.args)
    ) {
      continue;
    }
    const args: UnknownRecord = {};
    let valid = true;
    for (const [key, value] of Object.entries(candidate.args)) {
      const normalized = normalizeExactActionValue(value);
      if (normalized === null) {
        valid = false;
        break;
      }
      args[key] = normalized;
    }
    const needs = hasOwn(candidate, "needs")
      ? strings(candidate.needs)
      : undefined;
    if (!valid || (hasOwn(candidate, "needs") && needs === null)) {
      continue;
    }
    actions.push({
      args,
      ...(needs === undefined ? {} : { needs }),
      tool: candidate.tool,
    });
  }
  return actions;
};

const normalizeDefinitionActor = (input: unknown): UnknownRecord | null => {
  if (!isRecord(input) || typeof input.type !== "string") {
    return null;
  }
  if (input.type === "orchestrator") {
    return { type: "orchestrator" };
  }
  if (input.type === "worker" && typeof input.profile === "string") {
    return { profile: input.profile, type: "worker" };
  }
  return null;
};

const normalizeDefinitionJob = (input: unknown): UnknownRecord | null => {
  if (!isRecord(input)) {
    return null;
  }
  const actor = normalizeDefinitionActor(input.actor);
  const dependsOn = strings(input.dependsOn);
  if (
    actor === null ||
    dependsOn === null ||
    typeof input.name !== "string" ||
    typeof input.objective !== "string"
  ) {
    return null;
  }
  if (actor.type === "orchestrator") {
    return {
      actor,
      dependsOn,
      name: input.name,
      objective: input.objective,
    };
  }
  if (typeof input.mode !== "string") {
    return null;
  }
  const writeFiles = hasOwn(input, "writeFiles")
    ? strings(input.writeFiles)
    : undefined;
  if (writeFiles === null) {
    return null;
  }
  return {
    actor,
    dependsOn,
    mode: input.mode,
    name: input.name,
    objective: input.objective,
    ...(writeFiles === undefined ? {} : { writeFiles }),
  };
};

const normalizeDefinition = (input: unknown): UnknownRecord | null => {
  if (
    !isRecord(input) ||
    typeof input.objective !== "string" ||
    !Array.isArray(input.steps)
  ) {
    return null;
  }
  const steps: UnknownRecord[] = [];
  for (const step of input.steps) {
    if (!isRecord(step)) {
      return null;
    }
    const dependsOn = strings(step.dependsOn);
    if (
      dependsOn === null ||
      typeof step.name !== "string" ||
      typeof step.objective !== "string" ||
      !Array.isArray(step.jobs)
    ) {
      return null;
    }
    const jobs: UnknownRecord[] = [];
    for (const job of step.jobs) {
      const normalized = normalizeDefinitionJob(job);
      if (normalized === null) {
        return null;
      }
      jobs.push(normalized);
    }
    steps.push({
      dependsOn,
      jobs,
      name: step.name,
      objective: step.objective,
    });
  }
  return { objective: input.objective, steps };
};

const normalizeCanonicalLatestEvent = (
  input: unknown
): UnknownRecord | null => {
  if (input === null) {
    return null;
  }
  if (!isRecord(input) || typeof input.kind !== "string") {
    return null;
  }
  if (hasOwn(input, "message") && typeof input.message !== "string") {
    return null;
  }
  return {
    kind: input.kind,
    ...(typeof input.message === "string" ? { message: input.message } : {}),
  };
};

const normalizeCanonicalFile = (input: unknown): UnknownRecord | null => {
  if (!isRecord(input)) {
    return null;
  }
  if (!(isInteger(input.additions) && isInteger(input.deletions))) {
    return null;
  }
  if (typeof input.path !== "string" || typeof input.status !== "string") {
    return null;
  }
  return {
    additions: input.additions,
    deletions: input.deletions,
    path: input.path,
    status: input.status,
  };
};

const normalizeCanonicalTurn = (input: unknown): UnknownRecord | null => {
  if (!isRecord(input)) {
    return null;
  }
  if (!Array.isArray(input.files)) {
    return null;
  }
  if (!Array.isArray(input.tool_outputs)) {
    return null;
  }
  if (
    typeof input.completed !== "boolean" ||
    typeof input.isolated !== "boolean" ||
    typeof input.result_available !== "boolean" ||
    typeof input.undo_available !== "boolean" ||
    !isInteger(input.turn)
  ) {
    return null;
  }
  const files: UnknownRecord[] = [];
  for (const file of input.files) {
    const normalized = normalizeCanonicalFile(file);
    if (normalized === null) {
      return null;
    }
    files.push(normalized);
  }
  const toolOutputs: UnknownRecord[] = [];
  for (const output of input.tool_outputs) {
    if (
      !isRecord(output) ||
      typeof output.output_available !== "boolean" ||
      typeof output.status !== "string" ||
      typeof output.title !== "string" ||
      typeof output.tool !== "string" ||
      !isInteger(output.tool_number)
    ) {
      return null;
    }
    toolOutputs.push({
      output_available: output.output_available,
      status: output.status,
      title: output.title,
      tool: output.tool,
      tool_number: output.tool_number,
    });
  }
  if (
    (hasOwn(input, "redo_available") &&
      typeof input.redo_available !== "boolean") ||
    (hasOwn(input, "undo_unavailable_reason") &&
      typeof input.undo_unavailable_reason !== "string")
  ) {
    return null;
  }
  return {
    completed: input.completed,
    files,
    isolated: input.isolated,
    result_available: input.result_available,
    tool_outputs: toolOutputs,
    turn: input.turn,
    undo_available: input.undo_available,
    ...(input.redo_available === true ? { redo_available: true } : {}),
    ...(typeof input.undo_unavailable_reason === "string"
      ? { undo_unavailable_reason: input.undo_unavailable_reason }
      : {}),
  };
};

const normalizeCanonicalWorkerRuntime = (
  input: unknown
): UnknownRecord | null => {
  if (!isRecord(input)) {
    return null;
  }
  if (!Array.isArray(input.turns)) {
    return null;
  }
  const latestEvent = normalizeCanonicalLatestEvent(input.latest_event);
  const writeGrants = strings(input.write_grants);
  if (
    (latestEvent === null && input.latest_event !== null) ||
    writeGrants === null ||
    typeof input.diff_available !== "boolean" ||
    typeof input.live_state !== "string" ||
    typeof input.result_available !== "boolean" ||
    typeof input.tool_output_available !== "boolean" ||
    !isInteger(input.turn_count)
  ) {
    return null;
  }
  const turns: UnknownRecord[] = [];
  for (const turn of input.turns) {
    const normalized = normalizeCanonicalTurn(turn);
    if (normalized === null) {
      return null;
    }
    turns.push(normalized);
  }
  let pendingWritePermission: UnknownRecord | undefined;
  if (hasOwn(input, "pending_write_permission")) {
    if (!isRecord(input.pending_write_permission)) {
      return null;
    }
    const paths = strings(input.pending_write_permission.paths);
    if (
      paths === null ||
      typeof input.pending_write_permission.tool !== "string"
    ) {
      return null;
    }
    pendingWritePermission = {
      paths,
      tool: input.pending_write_permission.tool,
    };
  }
  return {
    diff_available: input.diff_available,
    latest_event: latestEvent,
    live_state: input.live_state,
    ...(pendingWritePermission === undefined
      ? {}
      : { pending_write_permission: pendingWritePermission }),
    result_available: input.result_available,
    tool_output_available: input.tool_output_available,
    turn_count: input.turn_count,
    turns,
    write_grants: writeGrants,
  };
};

const normalizeCanonicalRuntimeJob = (input: unknown): UnknownRecord | null => {
  if (!isRecord(input)) {
    return null;
  }
  if (
    typeof input.result_available !== "boolean" ||
    typeof input.state !== "string" ||
    (hasOwn(input, "status_message") &&
      typeof input.status_message !== "string")
  ) {
    return null;
  }
  let worker: UnknownRecord | undefined;
  if (hasOwn(input, "worker")) {
    const normalizedWorker = normalizeCanonicalWorkerRuntime(input.worker);
    if (normalizedWorker === null) {
      return null;
    }
    worker = normalizedWorker;
  }
  return {
    result_available: input.result_available,
    state: input.state,
    ...(typeof input.status_message === "string"
      ? { status_message: input.status_message }
      : {}),
    ...(worker === undefined ? {} : { worker }),
  };
};

const normalizeCanonicalRuntimeStep = (input: unknown): UnknownRecord | null =>
  isRecord(input) && typeof input.state === "string"
    ? { state: input.state }
    : null;

const normalizeCanonicalRuntime = (input: unknown): UnknownRecord | null => {
  if (!isRecord(input)) {
    return null;
  }
  if (!(isRecord(input.jobs) && isRecord(input.steps))) {
    return null;
  }
  if (typeof input.state !== "string") {
    return null;
  }
  const jobs: UnknownRecord = {};
  for (const [name, job] of Object.entries(input.jobs)) {
    const normalized = normalizeCanonicalRuntimeJob(job);
    if (normalized === null) {
      return null;
    }
    jobs[name] = normalized;
  }
  const steps: UnknownRecord = {};
  for (const [name, step] of Object.entries(input.steps)) {
    const normalized = normalizeCanonicalRuntimeStep(step);
    if (normalized === null) {
      return null;
    }
    steps[name] = normalized;
  }
  return { jobs, state: input.state, steps };
};

const normalizeCanonicalGoal = (input: unknown): UnknownRecord | null => {
  if (input === null || input === undefined) {
    return null;
  }
  if (
    !isRecord(input) ||
    typeof input.objective !== "string" ||
    typeof input.status !== "string" ||
    (hasOwn(input, "status_message") &&
      typeof input.status_message !== "string")
  ) {
    return null;
  }
  let liveness: UnknownRecord | undefined;
  if (hasOwn(input, "liveness")) {
    if (
      !isRecord(input.liveness) ||
      typeof input.liveness.message !== "string" ||
      typeof input.liveness.state !== "string"
    ) {
      return null;
    }
    liveness = {
      message: input.liveness.message,
      state: input.liveness.state,
    };
  }
  return {
    objective: input.objective,
    status: input.status,
    ...(typeof input.status_message === "string"
      ? { status_message: input.status_message }
      : {}),
    ...(liveness === undefined ? {} : { liveness }),
  };
};

const workflowStatusRefreshAction = (): UnknownRecord => ({
  args: {},
  tool: "workflow_status",
});

const compactCanonicalGoal = (
  goal: UnknownRecord | null
): UnknownRecord | null => {
  if (goal === null) {
    return null;
  }
  const objective = bounded(goal.objective, FIELD_LIMITS.objective);
  const status = bounded(goal.status, FIELD_LIMITS.state);
  const statusMessage = bounded(goal.status_message, FIELD_LIMITS.message);
  const liveness = isRecord(goal.liveness)
    ? {
        message: bounded(goal.liveness.message, FIELD_LIMITS.message).value,
        state: bounded(goal.liveness.state, FIELD_LIMITS.state).value,
      }
    : undefined;
  return {
    objective: objective.value,
    status: status.value,
    ...(statusMessage.value.length === 0
      ? {}
      : { status_message: statusMessage.value }),
    ...(liveness === undefined ? {} : { liveness }),
  };
};

const compactCanonicalRuntime = (runtime: UnknownRecord): UnknownRecord => {
  const jobs: UnknownRecord = {};
  for (const [name, rawJob] of Object.entries(runtime.jobs as UnknownRecord)) {
    if (!isRecord(rawJob)) {
      continue;
    }
    const state = bounded(rawJob.state, FIELD_LIMITS.state);
    const message = bounded(rawJob.status_message, FIELD_LIMITS.message);
    const worker = isRecord(rawJob.worker)
      ? {
          latest_event: normalizeLatestEvent(rawJob.worker.latest_event).value,
          live_state: bounded(rawJob.worker.live_state, FIELD_LIMITS.state)
            .value,
        }
      : undefined;
    jobs[bounded(name, FIELD_LIMITS.identity).value] = {
      result_available: boolean(rawJob.result_available),
      state: state.value,
      ...(message.value.length === 0 ? {} : { status_message: message.value }),
      ...(worker === undefined ? {} : { worker }),
    };
  }
  const steps: UnknownRecord = {};
  for (const [name, rawStep] of Object.entries(
    runtime.steps as UnknownRecord
  )) {
    if (!isRecord(rawStep)) {
      continue;
    }
    steps[bounded(name, FIELD_LIMITS.identity).value] = {
      state: bounded(rawStep.state, FIELD_LIMITS.state).value,
    };
  }
  return {
    jobs,
    state: bounded(runtime.state, FIELD_LIMITS.state).value,
    steps,
  };
};

const normalizeCanonicalWorkflow = (
  input: UnknownRecord,
  current: UnknownRecord
): NormalizedWorkflow | null => {
  const definition = normalizeDefinition(current.definition);
  const runtime = normalizeCanonicalRuntime(current.runtime);
  if (definition === null || runtime === null || !isInteger(current.version)) {
    return null;
  }
  if (
    hasOwn(current, "replacement_reason") &&
    typeof current.replacement_reason !== "string"
  ) {
    return null;
  }
  const goal = normalizeCanonicalGoal(input.goal);
  const availableActions = normalizeExactAvailableActions(
    input.available_actions
  );
  const currentValue = {
    definition,
    runtime,
    version: current.version,
    ...(typeof current.replacement_reason === "string"
      ? { replacement_reason: current.replacement_reason }
      : {}),
  };
  const refresh = workflowStatusRefreshAction();
  const withoutActions = {
    available_actions: [],
    ...(availableActions.length === 0
      ? {}
      : { available_actions_refresh_required: refresh }),
    ...(goal === null ? {} : { goal }),
    current: currentValue,
  };
  const definitionOnly = {
    available_actions: [],
    ...(availableActions.length === 0
      ? {}
      : { available_actions_refresh_required: workflowStatusRefreshAction() }),
    current: currentValue,
  };
  const fallback = {
    available_actions: [],
    ...(availableActions.length === 0
      ? {}
      : { available_actions_refresh_required: refresh }),
    current: {
      runtime: compactCanonicalRuntime(runtime),
      version: current.version,
    },
    definition_refresh_required: refresh,
    ...(goal === null ? {} : { goal: compactCanonicalGoal(goal) }),
  };
  const hardMinimal = {
    available_actions: [],
    ...(availableActions.length === 0
      ? {}
      : { available_actions_refresh_required: workflowStatusRefreshAction() }),
    current: {
      runtime: { state: bounded(runtime.state, FIELD_LIMITS.state).value },
      version: current.version,
    },
    definition_refresh_required: workflowStatusRefreshAction(),
  };
  return {
    definitionOnly,
    hardMinimal,
    hasActions: availableActions.length > 0,
    minimal: fallback,
    truncated: false,
    value: {
      available_actions: availableActions,
      ...(goal === null ? {} : { goal }),
      current: currentValue,
    },
    withoutActions,
  };
};

const normalizeWorkflow = (input: unknown): NormalizedWorkflow | null => {
  if (!isRecord(input)) {
    return null;
  }
  const current = isRecord(input.current) ? input.current : null;
  if (current !== null && hasOwn(current, "definition")) {
    return normalizeCanonicalWorkflow(input, current);
  }
  return normalizeLegacyWorkflow(input);
};

const normalizeLatestEvent = (
  input: unknown
): { readonly truncated: boolean; readonly value: UnknownRecord | null } => {
  if (!isRecord(input)) {
    return { truncated: false, value: null };
  }
  const kind = bounded(input.kind, FIELD_LIMITS.state);
  const message = bounded(input.message, FIELD_LIMITS.message);
  return {
    truncated: kind.truncated || message.truncated,
    value: {
      kind: kind.value,
      ...(message.value.length === 0 ? {} : { message: message.value }),
    },
  };
};

const normalizeFile = (
  input: UnknownRecord
): { readonly truncated: boolean; readonly value: UnknownRecord } => {
  const filePath = bounded(input.path, FIELD_LIMITS.path);
  const status = bounded(input.status, FIELD_LIMITS.state);
  return {
    truncated: filePath.truncated || status.truncated,
    value: {
      additions: integer(input.additions),
      deletions: integer(input.deletions),
      path: filePath.value,
      status: status.value,
    },
  };
};

const normalizeTool = (
  input: UnknownRecord
): { readonly truncated: boolean; readonly value: UnknownRecord } => {
  const name = bounded(input.tool, FIELD_LIMITS.identity);
  const title = bounded(input.title, FIELD_LIMITS.title);
  const status = bounded(input.status, FIELD_LIMITS.state);
  return {
    truncated: name.truncated || title.truncated || status.truncated,
    value: {
      output_available: boolean(input.output_available),
      status: status.value,
      title: title.value,
      tool: name.value,
      tool_number: integer(input.tool_number),
    },
  };
};

const normalizeTurn = (
  input: UnknownRecord
): { readonly truncated: boolean; readonly value: UnknownRecord } => {
  let truncated = false;
  const files = Array.isArray(input.files)
    ? input.files.filter(isRecord).map((file) => {
        const normalized = normalizeFile(file);
        truncated ||= normalized.truncated;
        return normalized.value;
      })
    : [];
  const tools = Array.isArray(input.tool_outputs)
    ? input.tool_outputs.filter(isRecord).map((output) => {
        const normalized = normalizeTool(output);
        truncated ||= normalized.truncated;
        return normalized.value;
      })
    : [];
  const reason = bounded(input.undo_unavailable_reason, FIELD_LIMITS.message);
  truncated ||= reason.truncated;
  return {
    truncated,
    value: {
      completed: boolean(input.completed),
      files,
      isolated: boolean(input.isolated),
      result_available: boolean(input.result_available),
      tool_outputs: tools,
      turn: integer(input.turn),
      undo_available: boolean(input.undo_available),
      ...(reason.value.length === 0
        ? {}
        : { undo_unavailable_reason: reason.value }),
    },
  };
};

const workerPriority = (
  liveState: string,
  event: UnknownRecord | null
): number => {
  if (liveState === "blocked" || event?.kind === "blocker") {
    return 4;
  }
  if (liveState === "interrupted") {
    return 3;
  }
  if (liveState === "review" || event?.kind === "result") {
    return 2;
  }
  return liveState === "busy" || liveState === "preempting" ? 1 : 0;
};

const normalizeWorker = (input: UnknownRecord): NormalizedWorker => {
  const job = bounded(input.job, FIELD_LIMITS.objective);
  const profile = bounded(input.profile, FIELD_LIMITS.identity);
  const mode = bounded(input.mode, FIELD_LIMITS.state);
  const liveState = bounded(input.live_state, FIELD_LIMITS.state);
  const event = normalizeLatestEvent(input.latest_event);
  let truncated =
    job.truncated ||
    profile.truncated ||
    mode.truncated ||
    liveState.truncated ||
    event.truncated;
  const turns = Array.isArray(input.turns)
    ? input.turns.filter(isRecord).map((turn) => {
        const normalized = normalizeTurn(turn);
        truncated ||= normalized.truncated;
        return normalized.value;
      })
    : [];
  const value = {
    diff_available: boolean(input.diff_available),
    job: job.value,
    latest_event: event.value,
    live_state: liveState.value,
    mode: mode.value,
    profile: profile.value,
    result_available: boolean(input.result_available),
    tool_output_available: boolean(input.tool_output_available),
    turn_count: integer(input.turn_count),
    turns,
  };
  return {
    minimal: {
      job: job.value,
      latest_event: event.value,
      live_state: liveState.value,
      result_available: value.result_available,
      turn_count: value.turn_count,
    },
    priority: workerPriority(liveState.value, event.value),
    truncated,
    value,
  };
};

const encode = (input: {
  readonly omittedWorkers: number;
  readonly truncated: boolean;
  readonly workers: readonly unknown[];
  readonly workflow: unknown;
}): string =>
  `${ORCHESTRATION_SNAPSHOT_BEGIN}\n${JSON.stringify({
    included_workers: input.workers.length,
    observed_orchestration_data: true,
    omitted_workers: input.omittedWorkers,
    schema_version: COMPACTION_SNAPSHOT_SCHEMA_VERSION,
    truncated: input.truncated,
    workers: input.workers,
    workflow: input.workflow,
  })}\n${ORCHESTRATION_SNAPSHOT_END}`;

const renderSelection = (input: {
  readonly minimalWorkers: boolean;
  readonly omittedWorkers: number;
  readonly reduced: boolean;
  readonly selected: readonly NormalizedWorker[];
  readonly workflow: NormalizedWorkflow | null;
  readonly workflowProjection: unknown;
}): string =>
  encode({
    omittedWorkers: input.omittedWorkers,
    truncated:
      input.reduced ||
      input.omittedWorkers > 0 ||
      input.selected.some((worker) => worker.truncated) ||
      input.workflow?.truncated === true,
    workers: input.selected.map((worker) =>
      input.minimalWorkers ? worker.minimal : worker.value
    ),
    workflow: input.workflowProjection,
  });

const selectWorkersWithinLimit = (
  workers: readonly NormalizedWorker[],
  minimumWorkers: number,
  limit: number,
  render: (selected: readonly NormalizedWorker[]) => string
): NormalizedWorker[] => {
  let selected = [...workers];
  while (selected.length > minimumWorkers && render(selected).length > limit) {
    selected = selected.slice(0, -1);
  }
  return selected;
};

const firstFittingProjection = (
  projections: readonly (UnknownRecord | undefined)[],
  limit: number,
  render: (projection: UnknownRecord) => string
): string | undefined => {
  for (const projection of projections) {
    if (projection === undefined) {
      continue;
    }
    const rendered = render(projection);
    if (rendered.length <= limit) {
      return rendered;
    }
  }
  return;
};

const renderHardFallback = (input: {
  readonly selected: readonly NormalizedWorker[];
  readonly totalWorkers: number;
  readonly workflow: NormalizedWorkflow | null;
}): string =>
  encode({
    omittedWorkers: Math.max(
      0,
      input.totalWorkers - (input.selected.length > 0 ? 1 : 0)
    ),
    truncated: true,
    workers:
      input.selected.length === 0
        ? []
        : [
            {
              job: bounded(
                input.selected[0]?.minimal.job,
                FIELD_LIMITS.identity
              ).value,
              live_state: bounded(
                input.selected[0]?.minimal.live_state,
                FIELD_LIMITS.state
              ).value,
            },
          ],
    workflow:
      input.workflow === null
        ? null
        : (input.workflow.hardMinimal ?? {
            available_actions: [],
            ...(input.workflow.hasActions
              ? { available_actions_refresh_required: true }
              : {}),
          }),
  });

export const renderCompactionSnapshot = (
  input: {
    readonly maxChars?: unknown;
    readonly workers?: readonly unknown[];
    readonly workflow?: unknown;
  } = {}
): string | null => {
  const limit = compactionSnapshotMaxChars(input.maxChars);
  const workflow = normalizeWorkflow(input.workflow);
  const normalized = (input.workers ?? [])
    .filter(
      (worker): worker is UnknownRecord =>
        isRecord(worker) &&
        typeof worker.job === "string" &&
        worker.job.length > 0
    )
    .map(normalizeWorker)
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        String(left.value.job).localeCompare(String(right.value.job))
    );
  if (workflow === null && normalized.length === 0) {
    return null;
  }
  const totalWorkers = normalized.length;
  const initial = normalized.slice(0, COMPACTION_SNAPSHOT_WORKER_LIMIT);
  const minimumWorkers = workflow?.hardMinimal === undefined ? 1 : 0;
  const fullProjection = workflow?.value ?? null;
  let selected = selectWorkersWithinLimit(
    initial,
    minimumWorkers,
    limit,
    (candidate) =>
      renderSelection({
        minimalWorkers: false,
        omittedWorkers: totalWorkers - candidate.length,
        reduced: false,
        selected: candidate,
        workflow,
        workflowProjection: fullProjection,
      })
  );
  const full = renderSelection({
    minimalWorkers: false,
    omittedWorkers: totalWorkers - selected.length,
    reduced: false,
    selected,
    workflow,
    workflowProjection: fullProjection,
  });
  if (full.length <= limit) {
    return full;
  }
  const alternative = firstFittingProjection(
    [workflow?.withoutActions, workflow?.definitionOnly],
    limit,
    (workflowProjection) =>
      renderSelection({
        minimalWorkers: false,
        omittedWorkers: totalWorkers - selected.length,
        reduced: true,
        selected,
        workflow,
        workflowProjection,
      })
  );
  if (alternative !== undefined) {
    return alternative;
  }
  const minimalProjection = workflow?.minimal ?? null;
  selected = selectWorkersWithinLimit(
    selected,
    minimumWorkers,
    limit,
    (candidate) =>
      renderSelection({
        minimalWorkers: true,
        omittedWorkers: totalWorkers - candidate.length,
        reduced: true,
        selected: candidate,
        workflow,
        workflowProjection: minimalProjection,
      })
  );
  const minimal = renderSelection({
    minimalWorkers: true,
    omittedWorkers: totalWorkers - selected.length,
    reduced: true,
    selected,
    workflow,
    workflowProjection: minimalProjection,
  });
  if (minimal.length <= limit) {
    return minimal;
  }
  return renderHardFallback({
    selected,
    totalWorkers,
    workflow,
  });
};

export const isOrchestrationSnapshot = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith(`${ORCHESTRATION_SNAPSHOT_BEGIN}\n`) &&
  value.endsWith(`\n${ORCHESTRATION_SNAPSHOT_END}`);
