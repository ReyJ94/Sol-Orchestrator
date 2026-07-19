import { bundledWorkerProfiles } from "./agent-defaults.js";
import type { WorkerProfileDescriptor } from "./schema/common.js";
import type {
  RootSnapshot,
  WorkerBindingRecord,
  WorkerTurnRecord,
} from "./schema/orchestration.js";
import { isCoalescibleDeliveryState } from "./schema/orchestration.js";
import type { WorkflowRecord } from "./workflow-state.js";
import { WorkflowState } from "./workflow-state.js";

export type AvailableActionNeed =
  | "decision"
  | "message"
  | "objective"
  | "reason"
  | "steps";

export type AvailableAction = {
  readonly args: Readonly<Record<string, unknown>>;
  readonly needs?: readonly AvailableActionNeed[];
  readonly tool: string;
};

export type ProjectedTurn = ReturnType<typeof projectTurn>;
export type ProjectedWorker = ReturnType<typeof projectWorker>;
export type ProjectedWorkflow = ReturnType<typeof projectWorkflow>;
export type WorkflowStatusProjection = ReturnType<typeof projectWorkflowStatus>;

type TurnDetail = "all" | "latest" | "none";

export const workflowStartAvailableAction = Object.freeze({
  args: {},
  needs: ["objective", "steps"],
  tool: "workflow_start",
} satisfies AvailableAction);

export const goalStartAvailableAction = Object.freeze({
  args: {},
  needs: ["objective"],
  tool: "goal_start",
} satisfies AvailableAction);

export const workerTurnsFor = (
  root: RootSnapshot,
  worker: WorkerBindingRecord
): WorkerTurnRecord[] =>
  root.turns
    .filter(
      (turn) =>
        turn.task_id === worker.task_id &&
        turn.run_sequence === worker.run_sequence
    )
    .sort((left, right) => left.turn - right.turn);

export const projectLatestEvent = (
  event: WorkerBindingRecord["latest_event"]
): { readonly kind: string; readonly message?: string } | null => {
  if (event === null) {
    return null;
  }
  return event.kind === "result"
    ? { kind: "result" }
    : { kind: event.kind, message: event.message };
};

export const projectTurn = (turn: WorkerTurnRecord) => ({
  completed: turn.completed_at !== null,
  files: turn.files.map(({ additions, deletions, path, status }) => ({
    additions,
    deletions,
    path,
    status,
  })),
  isolated:
    turn.files.every((file) => file.attributed) &&
    turn.mutation_epochs.every(
      (epoch) => epoch.completed_at !== null && !epoch.overlap
    ),
  result_available: turn.result_available,
  tool_outputs: turn.tool_outputs.map((output) => ({
    output_available: output.output_available,
    status: output.status,
    title: output.title,
    tool: output.tool,
    tool_number: output.ordinal,
  })),
  turn: turn.turn,
  undo_available: turn.undo_state === "available",
  ...(turn.undo_state === "redo_available" ? { redo_available: true } : {}),
  ...(turn.undo_unavailable_reason === null
    ? {}
    : { undo_unavailable_reason: turn.undo_unavailable_reason }),
});

export const projectWorker = (
  root: RootSnapshot,
  worker: WorkerBindingRecord,
  detail: TurnDetail
) => {
  const turns = workerTurnsFor(root, worker);
  let visibleTurns: WorkerTurnRecord[] = [];
  if (detail === "all") {
    visibleTurns = turns;
  } else if (detail === "latest") {
    visibleTurns = turns.slice(-1);
  }
  const version = root.workflows.workflows
    .find((workflow) => workflow.workflow_id === worker.workflow_id)
    ?.versions.find(
      (candidate) => candidate.version === worker.workflow_version
    );
  const definitionJob = version?.definition.steps
    .flatMap((step) => step.jobs)
    .find((candidate) => candidate.name === worker.job);
  const run = root.job_runs.find(
    (candidate) =>
      candidate.workflow_id === worker.workflow_id &&
      candidate.workflow_version === worker.workflow_version &&
      candidate.job === worker.job &&
      candidate.run_sequence === worker.run_sequence
  );
  const pendingPermission = root.permissions.find(
    (permission) => permission.task_id === worker.task_id
  );
  return {
    diff_available: turns.some((turn) => turn.files.length > 0),
    job: worker.job,
    latest_event: projectLatestEvent(worker.latest_event),
    live_state: worker.live_state,
    mode: worker.mode,
    profile: worker.profile,
    result_available:
      turns.some((turn) => turn.result_available) ||
      worker.latest_event?.kind === "result",
    tool_output_available: turns.some((turn) =>
      turn.tool_outputs.some((output) => output.output_available)
    ),
    turn_count: turns.length,
    turns: visibleTurns.map(projectTurn),
    ...(definitionJob?.writeFiles === undefined
      ? {}
      : { writeFiles: definitionJob.writeFiles }),
    write_grants: run?.write_grants ?? [],
    ...(pendingPermission === undefined
      ? {}
      : {
          pending_write_permission: {
            paths: pendingPermission.requested_paths,
            tool: pendingPermission.tool,
          },
        }),
  };
};

const action = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  needs?: readonly AvailableActionNeed[]
): AvailableAction => ({
  args,
  ...(needs === undefined ? {} : { needs }),
  tool,
});

type ProjectedJob = ProjectedWorkflow["steps"][number]["jobs"][number];
type LifecycleAction = {
  readonly action: AvailableAction;
  readonly job: string;
};

const compareActions = (
  left: AvailableAction,
  right: AvailableAction
): number =>
  left.tool.localeCompare(right.tool) ||
  JSON.stringify(left.args).localeCompare(JSON.stringify(right.args)) ||
  JSON.stringify(left.needs ?? []).localeCompare(
    JSON.stringify(right.needs ?? [])
  );

const canonicalActions = (
  actions: readonly AvailableAction[]
): AvailableAction[] => {
  const unique = new Map<string, AvailableAction>();
  for (const candidate of actions) {
    unique.set(JSON.stringify(candidate), candidate);
  }
  return [...unique.values()].sort(compareActions);
};

const lifecycleActions = (
  workflow: Pick<ProjectedWorkflow, "steps">
): LifecycleAction[] => {
  const jobs = workflow.steps.flatMap((step) => step.jobs);
  const completable = jobs.filter(
    (job) =>
      (job.actor.type === "orchestrator" && job.state === "active") ||
      (job.actor.type === "worker" && job.state === "review")
  );
  const recoverable = jobs.filter(
    (job) => job.state === "review" || job.state === "blocked"
  );
  return [
    ...completable.map(
      (job) =>
        ({
          action: action(
            "workflow_complete",
            completable.length === 1 ? {} : { job: job.name },
            ["message"]
          ),
          job: job.name,
        }) satisfies LifecycleAction
    ),
    ...recoverable.map(
      (job) =>
        ({
          action: action(
            "workflow_retry",
            recoverable.length === 1 ? {} : { job: job.name },
            ["reason"]
          ),
          job: job.name,
        }) satisfies LifecycleAction
    ),
  ];
};

const waitAvailable = (job: ProjectedJob): boolean =>
  job.pending_write_permission === undefined &&
  ["busy", "preempting", "starting"].includes(job.live_state ?? "");

const inspectionActions = (
  job: ProjectedJob,
  jobName: string
): AvailableAction[] =>
  job.turns.flatMap((turn) => [
    ...(turn.result_available
      ? [
          action("agents_inspect", {
            job: jobName,
            turn: turn.turn,
            type: "result",
          }),
        ]
      : []),
    ...turn.files.map((file) =>
      action("agents_inspect", {
        file: file.path,
        job: jobName,
        turn: turn.turn,
        type: "diff",
      })
    ),
    ...turn.tool_outputs
      .filter((output) => output.output_available)
      .map((output) =>
        action("agents_inspect", {
          job: jobName,
          tool: output.tool_number,
          turn: turn.turn,
          type: "tool_output",
        })
      ),
  ]);

const recoveryActions = (
  root: RootSnapshot,
  job: ProjectedJob,
  worker: WorkerBindingRecord,
  pendingDelivery: boolean,
  pendingPermission: boolean
): AvailableAction[] => {
  const turns = workerTurnsFor(root, worker).filter(
    (turn) => turn.completed_at !== null
  );
  const firstTurn = turns[0];
  const latestTurn = turns.at(-1);
  const undoAllowed =
    job.state === "review" &&
    job.live_state === "review" &&
    !pendingDelivery &&
    !pendingPermission;
  return [
    ...(undoAllowed && firstTurn?.undo_state === "available"
      ? [action("agents_undo", { job: job.name }, ["reason"])]
      : []),
    ...(undoAllowed &&
    firstTurn !== latestTurn &&
    latestTurn?.undo_state === "available"
      ? [
          action("agents_undo", { job: job.name, scope: "latest_turn" }, [
            "reason",
          ]),
        ]
      : []),
    ...(job.live_state === "blocked" &&
    turns.some((turn) => turn.undo_state === "redo_available")
      ? [action("agents_redo", { job: job.name })]
      : []),
  ];
};

const workerControlActions = (
  root: RootSnapshot,
  job: ProjectedJob,
  worker: WorkerBindingRecord | undefined,
  options: { readonly includeStatus: boolean; readonly includeWait: boolean }
): AvailableAction[] => {
  if (worker === undefined) {
    return [];
  }
  const delivery = root.deliveries.find(
    (candidate) => candidate.task_id === worker.task_id
  );
  const pendingDelivery = delivery !== undefined;
  const pendingPermission = job.pending_write_permission !== undefined;
  const controls = inspectionActions(job, job.name);

  if (options.includeStatus) {
    controls.push(action("agents_status", { job: job.name }));
  }
  if (pendingPermission) {
    controls.push(action("agents_permission", { job: job.name }, ["decision"]));
  }
  if (
    job.state === "active" &&
    !pendingPermission &&
    (delivery === undefined || isCoalescibleDeliveryState(delivery.state))
  ) {
    controls.push(action("agents_send", { job: job.name }, ["message"]));
  }
  if (job.state !== "completed" && job.live_state !== "interrupted") {
    controls.push(action("agents_interrupt", { job: job.name }));
  }
  if (options.includeWait && waitAvailable(job)) {
    controls.push(action("agents_wait", { jobs: [job.name], until: "any" }));
  }
  return [
    ...controls,
    ...recoveryActions(root, job, worker, pendingDelivery, pendingPermission),
  ];
};

const projectedJob = (
  workflow: ProjectedWorkflow,
  jobName: string
): ProjectedJob | undefined =>
  workflow.steps
    .flatMap((step) => step.jobs)
    .find((job) => job.name === jobName);

export const availableActionsForWorkflow = (
  root: RootSnapshot,
  record: WorkflowRecord,
  workflow: ProjectedWorkflow
): AvailableAction[] => {
  const jobs = workflow.steps.flatMap((step) => step.jobs);
  const version = record.versions.find(
    (candidate) => candidate.version === record.current_version
  );
  const workerForJob = (jobName: string): WorkerBindingRecord | undefined => {
    const taskID = version?.job_states[jobName]?.task_id;
    return taskID === undefined
      ? undefined
      : root.workers.find((candidate) => candidate.task_id === taskID);
  };
  const waitingJobs = jobs
    .filter((job) => workerForJob(job.name) !== undefined && waitAvailable(job))
    .map((job) => job.name)
    .sort();
  return canonicalActions([
    ...lifecycleActions(workflow).map((entry) => entry.action),
    ...jobs.flatMap((job) =>
      workerControlActions(root, job, workerForJob(job.name), {
        includeStatus: true,
        includeWait: false,
      })
    ),
    ...(waitingJobs.length === 0
      ? []
      : [
          action("agents_wait", {
            jobs: waitingJobs,
            until: "any",
          }),
        ]),
    action("workflow_replace", {}, ["reason", "steps"]),
  ]);
};

export const availableActionsForWorker = (
  root: RootSnapshot,
  worker: WorkerBindingRecord,
  detail: TurnDetail = "all"
): AvailableAction[] => {
  const record = root.workflows.workflows.find(
    (candidate) => candidate.workflow_id === worker.workflow_id
  );
  if (record === undefined) {
    return [];
  }
  const workflow = projectWorkflow(root, record, detail);
  const job = projectedJob(workflow, worker.job);
  if (job === undefined) {
    return [];
  }
  return canonicalActions([
    ...lifecycleActions(workflow)
      .filter((entry) => entry.job === worker.job)
      .map((entry) => entry.action),
    ...workerControlActions(root, job, worker, {
      includeStatus: false,
      includeWait: true,
    }),
  ]);
};

export const projectWorkflow = (
  root: RootSnapshot,
  record: WorkflowRecord,
  detail: TurnDetail = "latest"
) => {
  const workflow = WorkflowState.restore(root.workflows);
  const version = record.versions.find(
    (candidate) => candidate.version === record.current_version
  );
  if (version === undefined) {
    throw new Error("Current workflow version is unavailable.");
  }
  const steps = version.definition.steps.map((step) => ({
    jobs: step.jobs.map((job) => {
      const runtime = version.job_states[job.name];
      if (runtime === undefined) {
        throw new Error(`Runtime for job ${job.name} is unavailable.`);
      }
      const worker =
        runtime.task_id === undefined
          ? undefined
          : root.workers.find(
              (candidate) => candidate.task_id === runtime.task_id
            );
      return {
        actor: job.actor,
        ...(job.mode === undefined ? {} : { mode: job.mode }),
        name: job.name,
        objective: job.objective,
        result_available: runtime.result_available,
        state: runtime.state,
        ...(runtime.latest_message === undefined
          ? {}
          : { status_message: runtime.latest_message }),
        turns: [],
        ...(job.writeFiles === undefined ? {} : { writeFiles: job.writeFiles }),
        ...(worker === undefined ? {} : projectWorker(root, worker, detail)),
      };
    }),
    name: step.name,
    objective: step.objective,
    state: workflow.stepState({
      step: step.name,
      workflow_id: record.workflow_id,
    }),
  }));
  return {
    objective: version.definition.objective,
    state: workflow.workflowState(record.workflow_id),
    steps,
  };
};

export const projectWorkflowSummary = (
  root: RootSnapshot,
  record: WorkflowRecord,
  detail: TurnDetail = "latest"
) => {
  const workflow = projectWorkflow(root, record, detail);
  return {
    ...workflow,
    available_actions: record.current
      ? availableActionsForWorkflow(root, record, workflow)
      : [],
    version: record.current_version,
  };
};

export const projectWorkflowStatus = (
  root: RootSnapshot,
  context: {
    readonly agent: string;
    readonly parent_session_id: string;
  },
  availableWorkers: readonly WorkerProfileDescriptor[] = bundledWorkerProfiles
) => {
  const goal = root.goals.goals.find(
    (record) =>
      record.parent_session_id === context.parent_session_id &&
      record.orchestrator_agent_id === context.agent &&
      (record.status === "active" || record.status === "blocked")
  );
  const current = root.workflows.workflows.find(
    (record) =>
      record.current &&
      record.parent_session_id === context.parent_session_id &&
      record.orchestrator_agent_id === context.agent
  );
  const projectedGoal =
    goal === undefined
      ? null
      : {
          objective: goal.objective,
          status: goal.status,
          ...(goal.status_message === null
            ? {}
            : { status_message: goal.status_message }),
          ...(goal.continuation?.state === "failed"
            ? {
                liveness: {
                  message: goal.continuation.failure_message,
                  state: "failed" as const,
                },
              }
            : {}),
        };
  let goalActions: AvailableAction[];
  if (goal === undefined) {
    goalActions = current === undefined ? [goalStartAvailableAction] : [];
  } else if (goal.status === "blocked") {
    goalActions = [action("goal_resume", {}, ["message"])];
  } else {
    goalActions = [
      action("goal_block", {}, ["message"]),
      ...(current === undefined
        ? [action("goal_complete", {}, ["message"])]
        : []),
    ];
  }
  if (current === undefined) {
    return {
      available_workers: availableWorkers,
      available_actions: canonicalActions([
        ...goalActions,
        ...(goal?.status === "blocked" ? [] : [workflowStartAvailableAction]),
      ]),
      current: null,
      goal: projectedGoal,
      routing_guidance:
        "Choose the least expensive worker profile that safely fits one bounded authored job.",
    };
  }
  const workflow = projectWorkflow(root, current);
  return {
    available_workers: availableWorkers,
    available_actions: canonicalActions([
      ...(goal?.status === "blocked"
        ? []
        : availableActionsForWorkflow(root, current, workflow)),
      ...goalActions,
    ]),
    current: workflow,
    goal: projectedGoal,
    routing_guidance:
      "Choose the least expensive worker profile that safely fits one bounded authored job.",
  };
};
