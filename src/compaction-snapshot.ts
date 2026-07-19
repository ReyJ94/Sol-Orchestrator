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
  readonly hasActions: boolean;
  readonly minimal: UnknownRecord;
  readonly truncated: boolean;
  readonly value: UnknownRecord;
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

const normalizeWorkflow = (input: unknown): NormalizedWorkflow | null => {
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
  let selected = normalized.slice(0, COMPACTION_SNAPSHOT_WORKER_LIMIT);
  const render = (minimal: boolean): string => {
    let workflowProjection: unknown = null;
    if (workflow !== null) {
      workflowProjection = minimal ? workflow.minimal : workflow.value;
    }
    return encode({
      omittedWorkers: totalWorkers - selected.length,
      truncated:
        minimal ||
        totalWorkers > selected.length ||
        selected.some((worker) => worker.truncated) ||
        workflow?.truncated === true,
      workers: selected.map((worker) =>
        minimal ? worker.minimal : worker.value
      ),
      workflow: workflowProjection,
    });
  };

  while (selected.length > 1 && render(false).length > limit) {
    selected = selected.slice(0, -1);
  }
  const full = render(false);
  if (full.length <= limit) {
    return full;
  }
  while (selected.length > 1 && render(true).length > limit) {
    selected = selected.slice(0, -1);
  }
  const minimal = render(true);
  if (minimal.length <= limit) {
    return minimal;
  }
  return encode({
    omittedWorkers: Math.max(0, totalWorkers - (selected.length > 0 ? 1 : 0)),
    truncated: true,
    workers:
      selected.length === 0
        ? []
        : [
            {
              job: selected[0]?.minimal.job ?? "unknown",
              live_state: selected[0]?.minimal.live_state ?? "unknown",
            },
          ],
    workflow:
      workflow === null
        ? null
        : {
            ...workflow.minimal,
            available_actions: [],
            ...(workflow.hasActions
              ? { available_actions_refresh_required: true }
              : {}),
          },
  });
};

export const isOrchestrationSnapshot = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith(`${ORCHESTRATION_SNAPSHOT_BEGIN}\n`) &&
  value.endsWith(`\n${ORCHESTRATION_SNAPSHOT_END}`);
