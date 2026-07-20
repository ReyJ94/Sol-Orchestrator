import { z } from "zod";

import {
  ExternalIdSchema,
  TimestampSchema,
  WorkerProfileSchema,
} from "./common.js";
import {
  JobStateSchema,
  WorkerModeSchema,
  WorkflowDefinitionSchema,
} from "./workflow.js";

const MAX_MESSAGE_LENGTH = 8000;
const MAX_PATH_LENGTH = 4096;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:\//u;
const PositiveSafeIntegerSchema = z
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const NonnegativeSafeIntegerSchema = z
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const MessageSchema = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);
const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RepositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((value) => !value.startsWith("/"), {
    message: "Persisted paths must be repository-relative.",
  })
  .refine((value) => !WINDOWS_ABSOLUTE_PATH_PATTERN.test(value), {
    message: "Persisted paths must not use absolute drive paths.",
  })
  .refine((value) => !value.includes("\\"), {
    message: "Persisted paths must use POSIX separators.",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: "Persisted paths must not traverse with '..'.",
  });

const uniqueArray = <Output>(
  schema: z.ZodType<Output>,
  identity: (value: Output) => string,
  label: string
) =>
  z.array(schema).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = identity(value);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate ${label} ${key}.`,
          path: [index],
        });
      }
      seen.add(key);
    }
  });

const UniquePathArraySchema = uniqueArray(
  RepositoryPathSchema,
  (value) => value,
  "path"
);

const WorkflowJobRuntimeSchema = z
  .object({
    completion_message: MessageSchema.max(4000).optional(),
    latest_message: MessageSchema.optional(),
    result_available: z.boolean(),
    retry_reason: MessageSchema.max(4000).optional(),
    run_sequence: NonnegativeSafeIntegerSchema,
    state: JobStateSchema,
    task_id: ExternalIdSchema.optional(),
    updated_at: TimestampSchema,
  })
  .strict();

export const WorkflowVersionRecordSchema = z
  .object({
    created_at: TimestampSchema,
    definition: WorkflowDefinitionSchema,
    job_states: z.record(z.string().trim().min(1), WorkflowJobRuntimeSchema),
    replacement_reason: MessageSchema.max(4000).optional(),
    version: PositiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const expected = new Set(
      record.definition.steps.flatMap((step) =>
        step.jobs.map((job) => job.name)
      )
    );
    const actual = new Set(Object.keys(record.job_states));
    for (const name of expected) {
      if (!actual.has(name)) {
        context.addIssue({
          code: "custom",
          message: `Missing job state for ${name}.`,
          path: ["job_states"],
        });
      }
    }
    for (const name of actual) {
      if (!expected.has(name)) {
        context.addIssue({
          code: "custom",
          message: `Unexpected job state for ${name}.`,
          path: ["job_states", name],
        });
      }
    }
  });

export const WorkflowRecordSchema = z
  .object({
    current: z.boolean(),
    current_version: PositiveSafeIntegerSchema,
    goal_id: ExternalIdSchema.optional(),
    orchestrator_agent_id: ExternalIdSchema,
    parent_session_id: ExternalIdSchema,
    versions: z.array(WorkflowVersionRecordSchema).min(1),
    workflow_id: ExternalIdSchema,
  })
  .strict()
  .superRefine((record, context) => {
    for (const [index, version] of record.versions.entries()) {
      if (version.version !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Workflow versions must be contiguous from version 1.",
          path: ["versions", index, "version"],
        });
      }
      const prior = record.versions[index - 1];
      if (
        prior !== undefined &&
        Date.parse(version.created_at) < Date.parse(prior.created_at)
      ) {
        context.addIssue({
          code: "custom",
          message: "Workflow version timestamps must be monotonic.",
          path: ["versions", index, "created_at"],
        });
      }
    }
    if (
      record.current_version !== record.versions.length ||
      record.versions.at(-1)?.version !== record.current_version
    ) {
      context.addIssue({
        code: "custom",
        message: "Workflow current version must select the latest version.",
        path: ["current_version"],
      });
    }
  });

export const GoalStatusSchema = z.enum(["active", "blocked", "completed"]);

export const GoalContinuationSchema = z
  .object({
    assistant_message_id: ExternalIdSchema,
    failure_message: MessageSchema.max(4000).optional(),
    prompt_message_id: ExternalIdSchema,
    state: z.enum(["reserved", "submitted", "failed"]),
    updated_at: TimestampSchema,
  })
  .strict()
  .superRefine((continuation, context) => {
    if (
      (continuation.state === "failed") !==
      (continuation.failure_message !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a failed goal continuation carries a failure message.",
        path: ["failure_message"],
      });
    }
  });

export const GoalRecordSchema = z
  .object({
    continuation: GoalContinuationSchema.nullable(),
    created_at: TimestampSchema,
    goal_id: ExternalIdSchema,
    objective: MessageSchema,
    orchestrator_agent_id: ExternalIdSchema,
    parent_session_id: ExternalIdSchema,
    status: GoalStatusSchema,
    status_message: MessageSchema.max(4000).nullable(),
    updated_at: TimestampSchema,
  })
  .strict()
  .superRefine((goal, context) => {
    if (Date.parse(goal.updated_at) < Date.parse(goal.created_at)) {
      context.addIssue({
        code: "custom",
        message: "Goal updated_at must not precede created_at.",
        path: ["updated_at"],
      });
    }
  });

export const GoalSnapshotSchema = z
  .object({
    goals: uniqueArray(
      GoalRecordSchema,
      (goal) => goal.goal_id,
      "goal identity"
    ),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const currentOwners = new Set<string>();
    for (const [index, goal] of snapshot.goals.entries()) {
      if (goal.status !== "active" && goal.status !== "blocked") {
        continue;
      }
      const owner = `${goal.parent_session_id}:${goal.orchestrator_agent_id}`;
      if (currentOwners.has(owner)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate current goal for ${owner}.`,
          path: ["goals", index, "status"],
        });
      }
      currentOwners.add(owner);
    }
  });

export const WorkflowSnapshotSchema = z
  .object({
    workflows: uniqueArray(
      WorkflowRecordSchema,
      (record) => record.workflow_id,
      "workflow identity"
    ),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const currentParents = new Set<string>();
    for (const [index, workflow] of snapshot.workflows.entries()) {
      if (!workflow.current) {
        continue;
      }
      if (currentParents.has(workflow.parent_session_id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate current workflow for parent session ${workflow.parent_session_id}.`,
          path: ["workflows", index, "current"],
        });
      }
      currentParents.add(workflow.parent_session_id);
    }
  });

export const JobRunStateSchema = z.enum([
  "active",
  "review",
  "blocked",
  "accepted",
  "rejected",
  "interrupted",
]);

export const JobRunRecordSchema = z
  .object({
    job: z.string().trim().min(1).max(512),
    result_available: z.boolean(),
    run_sequence: PositiveSafeIntegerSchema,
    started_at: TimestampSchema,
    state: JobRunStateSchema,
    task_id: ExternalIdSchema.optional(),
    updated_at: TimestampSchema,
    workflow_id: ExternalIdSchema,
    workflow_version: PositiveSafeIntegerSchema,
    write_grants: UniquePathArraySchema,
  })
  .strict()
  .refine(
    (record) => Date.parse(record.updated_at) >= Date.parse(record.started_at),
    {
      message: "Job run updated_at must not precede started_at.",
      path: ["updated_at"],
    }
  );

export const WorkerLiveStateSchema = z.enum([
  "starting",
  "busy",
  "retrying",
  "idle",
  "preempting",
  "review",
  "blocked",
  "interrupted",
]);

const WorkerEventBaseSchema = z.object({
  created_at: TimestampSchema,
  sequence: PositiveSafeIntegerSchema,
});

export const WorkerLatestEventSchema = z.discriminatedUnion("kind", [
  WorkerEventBaseSchema.extend({
    kind: z.literal("progress"),
    message: MessageSchema,
  }).strict(),
  WorkerEventBaseSchema.extend({
    kind: z.literal("blocker"),
    message: MessageSchema,
  }).strict(),
  WorkerEventBaseSchema.extend({
    kind: z.literal("interrupted"),
    message: MessageSchema,
  }).strict(),
  WorkerEventBaseSchema.extend({
    kind: z.literal("result"),
    result_message_id: ExternalIdSchema,
  }).strict(),
]);

export const WorkerBindingRecordSchema = z
  .object({
    child_session_id: ExternalIdSchema,
    created_at: TimestampSchema,
    delivered_event_sequence: NonnegativeSafeIntegerSchema,
    job: z.string().trim().min(1).max(512),
    latest_event: WorkerLatestEventSchema.nullable(),
    live_state: WorkerLiveStateSchema,
    mode: WorkerModeSchema,
    parent_session_id: ExternalIdSchema,
    profile: WorkerProfileSchema,
    run_sequence: PositiveSafeIntegerSchema,
    task_id: ExternalIdSchema,
    updated_at: TimestampSchema,
    workflow_id: ExternalIdSchema,
    workflow_version: PositiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (Date.parse(record.updated_at) < Date.parse(record.created_at)) {
      context.addIssue({
        code: "custom",
        message: "Worker binding updated_at must not precede created_at.",
        path: ["updated_at"],
      });
    }
    if (
      record.latest_event === null
        ? record.delivered_event_sequence !== 0
        : record.delivered_event_sequence > record.latest_event.sequence
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Worker delivered event watermark must not exceed its latest event sequence.",
        path: ["delivered_event_sequence"],
      });
    }
    if (
      record.latest_event !== null &&
      Date.parse(record.latest_event.created_at) > Date.parse(record.updated_at)
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker latest event must not postdate binding updated_at.",
        path: ["latest_event", "created_at"],
      });
    }
  });

const COALESCIBLE_DELIVERY_STATES = [
  "pending_preemption",
  "waiting_tool_boundary",
  "interrupting",
] as const;

export const DeliveryStateSchema = z.enum([
  ...COALESCIBLE_DELIVERY_STATES,
  "dispatched",
  "started",
  "completed",
]);

export const PendingDeliveryRecordSchema = z
  .object({
    child_user_message_id: ExternalIdSchema.nullable(),
    created_at: TimestampSchema,
    delivery_id: ExternalIdSchema,
    message: MessageSchema,
    state: DeliveryStateSchema,
    task_id: ExternalIdSchema,
    updated_at: TimestampSchema,
  })
  .strict()
  .refine(
    (record) => Date.parse(record.updated_at) >= Date.parse(record.created_at),
    {
      message: "Delivery updated_at must not precede created_at.",
      path: ["updated_at"],
    }
  );

export const PendingPermissionRecordSchema = z
  .object({
    created_at: TimestampSchema,
    permission: z.literal("edit"),
    request_id: ExternalIdSchema,
    requested_paths: UniquePathArraySchema.min(1),
    task_id: ExternalIdSchema,
    tool: z.string().trim().min(1).max(512),
  })
  .strict();

export const WorkerTurnFileSchema = z
  .object({
    additions: NonnegativeSafeIntegerSchema,
    attributed: z.boolean(),
    deletions: NonnegativeSafeIntegerSchema,
    end_sha256: ContentHashSchema.nullable(),
    path: RepositoryPathSchema,
    status: z.enum(["added", "modified", "deleted"]),
  })
  .strict()
  .refine(
    (file) =>
      file.status === "deleted"
        ? file.end_sha256 === null
        : file.end_sha256 !== null,
    {
      message: "Turn file end hash must match its final presence state.",
      path: ["end_sha256"],
    }
  );

export const WorkerToolOutputSchema = z
  .object({
    message_id: ExternalIdSchema,
    ordinal: PositiveSafeIntegerSchema,
    output_available: z.boolean(),
    part_id: ExternalIdSchema,
    status: z.enum(["pending", "running", "completed", "error"]),
    title: z.string().max(1000),
    tool: z.string().trim().min(1).max(512),
  })
  .strict();

export const PathHashSchema = z
  .object({
    path: RepositoryPathSchema,
    sha256: ContentHashSchema.nullable(),
  })
  .strict();

export const WorkerMutationEpochSchema = z
  .object({
    call_id: ExternalIdSchema,
    completed_at: TimestampSchema.nullable(),
    overlap: z.boolean(),
    paths: UniquePathArraySchema,
    source: z.enum(["shell", "structured"]),
    started_at: TimestampSchema,
    tool: z.string().trim().min(1).max(512),
  })
  .strict()
  .superRefine((epoch, context) => {
    if (
      epoch.completed_at !== null &&
      Date.parse(epoch.completed_at) < Date.parse(epoch.started_at)
    ) {
      context.addIssue({
        code: "custom",
        message: "Mutation epoch completion must not precede its start.",
        path: ["completed_at"],
      });
    }
    if (epoch.completed_at === null && epoch.paths.length > 0) {
      context.addIssue({
        code: "custom",
        message: "An active mutation epoch cannot claim completed paths.",
        path: ["paths"],
      });
    }
  });

export const UndoStateSchema = z.enum([
  "unavailable",
  "available",
  "redo_available",
  "redo_unavailable",
]);

export const WorkerTurnRecordSchema = z
  .object({
    boundary_message_id: ExternalIdSchema,
    completed_at: TimestampSchema.nullable(),
    files: uniqueArray(WorkerTurnFileSchema, (file) => file.path, "turn path"),
    mutation_epochs: uniqueArray(
      WorkerMutationEpochSchema,
      (epoch) => epoch.call_id,
      "mutation call"
    ),
    post_undo_hashes: uniqueArray(
      PathHashSchema,
      (record) => record.path,
      "post-undo path"
    ),
    result_available: z.boolean(),
    result_message_id: ExternalIdSchema.nullable(),
    run_sequence: PositiveSafeIntegerSchema,
    started_at: TimestampSchema,
    task_id: ExternalIdSchema,
    tool_outputs: uniqueArray(
      WorkerToolOutputSchema,
      (output) => String(output.ordinal),
      "tool output ordinal"
    ),
    turn: PositiveSafeIntegerSchema,
    undo_state: UndoStateSchema,
    undo_unavailable_reason: MessageSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.completed_at !== null &&
      Date.parse(record.completed_at) < Date.parse(record.started_at)
    ) {
      context.addIssue({
        code: "custom",
        message: "Turn completed_at must not precede started_at.",
        path: ["completed_at"],
      });
    }
    if (record.result_available !== (record.result_message_id !== null)) {
      context.addIssue({
        code: "custom",
        message: "Turn result availability must match its internal reference.",
        path: ["result_available"],
      });
    }
    const unavailable =
      record.undo_state === "unavailable" ||
      record.undo_state === "redo_unavailable";
    if (unavailable !== (record.undo_unavailable_reason !== null)) {
      context.addIssue({
        code: "custom",
        message: "Unavailable undo or redo state requires one reason only.",
        path: ["undo_unavailable_reason"],
      });
    }
  });

export const RootSnapshotSchema = z
  .object({
    deliveries: uniqueArray(
      PendingDeliveryRecordSchema,
      (delivery) => delivery.task_id,
      "pending delivery for task"
    ),
    job_runs: uniqueArray(
      JobRunRecordSchema,
      (run) =>
        `${run.workflow_id}:${run.workflow_version}:${run.job}:${run.run_sequence}`,
      "job run"
    ),
    goals: GoalSnapshotSchema.default({ goals: [] }),
    permissions: uniqueArray(
      PendingPermissionRecordSchema,
      (permission) => permission.task_id,
      "pending permission for task"
    ),
    schema_version: z.literal(1),
    turns: uniqueArray(
      WorkerTurnRecordSchema,
      (turn) => `${turn.task_id}:${turn.turn}`,
      "worker turn"
    ),
    workers: uniqueArray(
      WorkerBindingRecordSchema,
      (worker) => worker.task_id,
      "worker task binding"
    ).superRefine((workers, context) => {
      const sessions = new Set<string>();
      for (const [index, worker] of workers.entries()) {
        if (sessions.has(worker.child_session_id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate worker child session ${worker.child_session_id}.`,
            path: [index, "child_session_id"],
          });
        }
        sessions.add(worker.child_session_id);
      }
    }),
    workflows: WorkflowSnapshotSchema,
  })
  .strict()
  .superRefine((root, context) => {
    const goals = new Map(root.goals.goals.map((goal) => [goal.goal_id, goal]));
    for (const [index, workflow] of root.workflows.workflows.entries()) {
      if (workflow.goal_id === undefined) {
        continue;
      }
      const goal = goals.get(workflow.goal_id);
      if (
        goal === undefined ||
        goal.parent_session_id !== workflow.parent_session_id ||
        goal.orchestrator_agent_id !== workflow.orchestrator_agent_id
      ) {
        context.addIssue({
          code: "custom",
          message: `Workflow ${workflow.workflow_id} has no matching goal owner.`,
          path: ["workflows", "workflows", index, "goal_id"],
        });
      }
    }
  })
  .superRefine((root, context) => {
    const workflows = new Map(
      root.workflows.workflows.map((workflow) => [
        workflow.workflow_id,
        workflow,
      ])
    );
    const runs = new Map<string, (typeof root.job_runs)[number]>();

    for (const [index, run] of root.job_runs.entries()) {
      const workflow = workflows.get(run.workflow_id);
      const version = workflow?.versions.find(
        (candidate) => candidate.version === run.workflow_version
      );
      const job = version?.definition.steps
        .flatMap((step) => step.jobs)
        .find((candidate) => candidate.name === run.job);
      if (
        workflow === undefined ||
        version === undefined ||
        job === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: `Orphan job run ${run.workflow_id}:${run.workflow_version}:${run.job}:${run.run_sequence}.`,
          path: ["job_runs", index],
        });
      }
      runs.set(
        `${run.workflow_id}:${run.workflow_version}:${run.job}:${run.run_sequence}`,
        run
      );
    }

    const workers = new Map<string, (typeof root.workers)[number]>();
    for (const [index, worker] of root.workers.entries()) {
      const run = runs.get(
        `${worker.workflow_id}:${worker.workflow_version}:${worker.job}:${worker.run_sequence}`
      );
      const workflow = workflows.get(worker.workflow_id);
      const version = workflow?.versions.find(
        (candidate) => candidate.version === worker.workflow_version
      );
      const job = version?.definition.steps
        .flatMap((step) => step.jobs)
        .find((candidate) => candidate.name === worker.job);
      const matches =
        run?.task_id === worker.task_id &&
        workflow?.parent_session_id === worker.parent_session_id &&
        job?.actor.type === "worker" &&
        job.actor.profile === worker.profile &&
        job.mode === worker.mode;
      if (!matches) {
        context.addIssue({
          code: "custom",
          message: `Worker ${worker.task_id} has no matching workflow job run.`,
          path: ["workers", index],
        });
      }
      workers.set(worker.task_id, worker);
    }

    for (const [index, delivery] of root.deliveries.entries()) {
      if (!workers.has(delivery.task_id)) {
        context.addIssue({
          code: "custom",
          message: `Orphan pending delivery ${delivery.delivery_id}.`,
          path: ["deliveries", index],
        });
      }
    }
    for (const [index, permission] of root.permissions.entries()) {
      if (!workers.has(permission.task_id)) {
        context.addIssue({
          code: "custom",
          message: `Orphan pending permission ${permission.request_id}.`,
          path: ["permissions", index],
        });
      }
    }
    for (const [index, turn] of root.turns.entries()) {
      const worker = workers.get(turn.task_id);
      if (worker === undefined || worker.run_sequence !== turn.run_sequence) {
        context.addIssue({
          code: "custom",
          message: `Worker turn ${turn.task_id}:${turn.turn} has no matching worker run.`,
          path: ["turns", index],
        });
      }
    }
  });

export type JobRunRecord = z.infer<typeof JobRunRecordSchema>;
export type GoalRecord = z.infer<typeof GoalRecordSchema>;
export type GoalSnapshot = z.infer<typeof GoalSnapshotSchema>;
export type PendingDeliveryRecord = z.infer<typeof PendingDeliveryRecordSchema>;
export const isCoalescibleDeliveryState = (
  state: PendingDeliveryRecord["state"]
): boolean =>
  COALESCIBLE_DELIVERY_STATES.some((candidate) => candidate === state);
export type PendingPermissionRecord = z.infer<
  typeof PendingPermissionRecordSchema
>;
export type RootSnapshot = z.infer<typeof RootSnapshotSchema>;
export type WorkerBindingRecord = z.infer<typeof WorkerBindingRecordSchema>;
export type WorkerTurnRecord = z.infer<typeof WorkerTurnRecordSchema>;
export const emptyRootSnapshot = (): RootSnapshot => ({
  deliveries: [],
  goals: { goals: [] },
  job_runs: [],
  permissions: [],
  schema_version: 1,
  turns: [],
  workers: [],
  workflows: { workflows: [] },
});

export const parseRootSnapshot = (input: unknown): RootSnapshot =>
  RootSnapshotSchema.parse(input);
