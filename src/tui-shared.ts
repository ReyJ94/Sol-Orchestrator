import type { PluginOptions } from "@opencode-ai/plugin/v1";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2";

import { OrchestrationStore } from "./orchestration-store.js";
import { parsePluginOptions } from "./plugin-options.js";
import {
  type AvailableAction,
  projectCanonicalWorkflowStatus,
  projectCurrentWorkflow,
  workflowStartAvailableAction,
} from "./workflow-projection.js";

export type TurnSummary = {
  readonly files: readonly {
    readonly additions: number;
    readonly deletions: number;
    readonly path: string;
    readonly status: string;
  }[];
  readonly isolated: boolean;
  readonly result_available: boolean;
  readonly turn: number;
  readonly undo_available: boolean;
};

export type JobSummary = {
  readonly actor: { readonly profile?: string; readonly type: string };
  readonly latest_event?: {
    readonly kind: string;
    readonly message?: string;
  } | null;
  readonly live_state?: string;
  readonly mode?: string;
  readonly name: string;
  readonly objective: string;
  readonly pending_write_permission?: {
    readonly paths: readonly string[];
    readonly tool: string;
  };
  readonly result_available: boolean;
  readonly state: string;
  readonly status_message?: string;
  readonly turns: readonly TurnSummary[];
  readonly writeFiles?: readonly string[];
  readonly write_grants?: readonly string[];
};

export type WorkerRuntimeSummary = Pick<
  JobSummary,
  | "latest_event"
  | "live_state"
  | "pending_write_permission"
  | "result_available"
  | "turns"
  | "write_grants"
>;
export type JobRuntimeSummary = Omit<
  JobSummary,
  | "actor"
  | "live_state"
  | "mode"
  | "name"
  | "objective"
  | "turns"
  | "write_grants"
> & { readonly worker?: WorkerRuntimeSummary };

export type StepSummary = {
  readonly dependsOn: readonly string[];
  readonly jobs: readonly {
    readonly actor: JobSummary["actor"];
    readonly dependsOn: readonly string[];
    readonly mode?: string;
    readonly name: string;
    readonly objective: string;
    readonly writeFiles?: readonly string[];
  }[];
  readonly name: string;
  readonly objective: string;
};

export type WorkflowSummary = {
  readonly available_actions: readonly AvailableAction[];
  readonly current: {
    readonly definition: {
      readonly objective: string;
      readonly steps: readonly StepSummary[];
    };
    readonly replacement_reason?: string;
    readonly runtime: {
      readonly jobs: Readonly<Record<string, JobRuntimeSummary>>;
      readonly state: string;
      readonly steps: Readonly<Record<string, { readonly state: string }>>;
    };
    readonly version: number;
    readonly versions: readonly {
      readonly replacement_reason?: string;
      readonly version: number;
    }[];
  } | null;
  readonly goal?: {
    readonly objective: string;
    readonly status: string;
    readonly status_message?: string;
  };
};

export const workflowDialogTitle = (summary: WorkflowSummary): string => {
  if (summary.goal === undefined) {
    return `Workflow · v${summary.current?.version ?? "?"} · ${summary.current?.runtime.state ?? "?"}`;
  }
  if (summary.current === null) {
    return `Goal · ${summary.goal.status} · between workflows`;
  }
  return `Goal · ${summary.goal.status} · Workflow v${summary.current.version} · ${summary.current.runtime.state}`;
};

export const workflowControlLabel = (summary: WorkflowSummary): string => {
  if (summary.goal === undefined) {
    return `Workflow ${summary.current?.runtime.state ?? "unavailable"}`;
  }
  if (summary.current === null) {
    return `Goal ${summary.goal.status} · between workflows`;
  }
  return `Goal ${summary.goal.status} · Workflow ${summary.current.runtime.state}`;
};

export type TuiDependencies = {
  readonly readWorkflow?: (
    parentSessionID: string,
    options: PluginOptions | undefined
  ) => Promise<WorkflowSummary | null>;
};

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

export const sessionTitle = (session: Session): string =>
  session.title || session.id;

export type ChildStatus = SessionStatus["type"] | undefined;

export const childState = (status: ChildStatus): string => {
  if (status === "busy") {
    return "● [active]";
  }
  if (status === "retry") {
    return "! [retry]";
  }
  return "○ [idle]";
};

export const childStatusRank = (status: ChildStatus): number => {
  if (status === "busy") {
    return 0;
  }
  if (status === "retry") {
    return 1;
  }
  return 2;
};

export const exactCall = (action: AvailableAction): string =>
  `${action.tool}(${JSON.stringify(action.args)})${
    action.needs === undefined ? "" : ` · needs: ${action.needs.join(", ")}`
  }`;

export const defaultWorkflowSummary = async (
  parentID: string,
  options: PluginOptions | undefined
): Promise<WorkflowSummary | null> => {
  const parsed = parsePluginOptions(options);
  const store = new OrchestrationStore({ statePath: parsed.statePath });
  try {
    const root = await store.readRoot();
    const record =
      root.workflows.workflows
        .filter((candidate) => candidate.parent_session_id === parentID)
        .toSorted((left, right) => right.current_version - left.current_version)
        .find((candidate) => candidate.current) ??
      root.workflows.workflows
        .filter((candidate) => candidate.parent_session_id === parentID)
        .at(-1);
    const goal = root.goals.goals.find(
      (candidate) =>
        candidate.parent_session_id === parentID &&
        (candidate.status === "active" || candidate.status === "blocked")
    );
    if (record === undefined && goal === undefined) {
      return null;
    }
    if (record === undefined && goal !== undefined) {
      const projection = projectCanonicalWorkflowStatus(root, {
        agent: goal.orchestrator_agent_id,
        parent_session_id: parentID,
      });
      return {
        available_actions: projection.available_actions,
        goal: {
          objective: goal.objective,
          status: goal.status,
          ...(goal.status_message === null
            ? {}
            : { status_message: goal.status_message }),
        },
        current: null,
      };
    }
    if (record === undefined) {
      return null;
    }
    const current = projectCurrentWorkflow(root, record, "all");
    const status = record.current
      ? projectCanonicalWorkflowStatus(root, {
          agent: record.orchestrator_agent_id,
          parent_session_id: parentID,
        })
      : undefined;
    const associatedGoal = root.goals.goals.find(
      (candidate) => candidate.goal_id === record.goal_id
    );
    return {
      available_actions: status?.available_actions ?? [],
      current,
      ...(associatedGoal === undefined
        ? {}
        : {
            goal: {
              objective: associatedGoal.objective,
              status: associatedGoal.status,
              ...(associatedGoal.status_message === null
                ? {}
                : { status_message: associatedGoal.status_message }),
            },
          }),
    };
  } catch (error) {
    return {
      available_actions: [],
      current: {
        definition: {
          objective: `Workflow state unavailable: ${errorMessage(error)}`,
          steps: [],
        },
        runtime: { jobs: {}, state: "degraded", steps: {} },
        version: 0,
        versions: [],
      },
    };
  }
};

const actorLabel = (actor: JobSummary["actor"]): string =>
  actor.type === "orchestrator" ? "Sol" : (actor.profile ?? "worker");

const jobDescription = (
  job: JobRuntimeSummary,
  actor: JobSummary["actor"],
  mode: string | undefined
): string =>
  [
    actorLabel(actor),
    mode,
    job.worker?.live_state,
    job.result_available || job.worker?.result_available
      ? "result available"
      : undefined,
    job.worker?.latest_event?.message,
    job.status_message,
    job.worker?.pending_write_permission
      ? `permission: ${job.worker.pending_write_permission.tool} ${job.worker.pending_write_permission.paths.join(", ")}`
      : undefined,
    job.worker?.write_grants && job.worker.write_grants.length > 0
      ? `grants: ${job.worker.write_grants.join(", ")}`
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");

const dependencyDescription = (dependencies: readonly string[]): string =>
  `depends on: ${dependencies.length === 0 ? "none" : dependencies.join(", ")}`;

export const workflowStartHint = `No durable goal or workflow · Actionable work creates one through ${exactCall(workflowStartAvailableAction)}; /goal <objective> starts one explicitly`;

export const workflowOptions = (summary: WorkflowSummary) => [
  ...(summary.goal === undefined
    ? []
    : [
        {
          description: summary.goal.status_message ?? summary.goal.objective,
          title: `Goal · ${summary.goal.status}`,
          value: "goal",
        },
      ]),
  ...(summary.current === null
    ? []
    : summary.current.definition.steps.flatMap((step) => {
        const stepRuntime = summary.current?.runtime.steps[step.name];
        return [
          {
            description: `${step.objective} · ${dependencyDescription(step.dependsOn)}`,
            title: `Step · ${step.name} · ${stepRuntime?.state ?? "unavailable"}`,
            value: `step:${step.name}`,
          },
          ...step.jobs.flatMap((job) => [
            {
              description: `${jobDescription(
                summary.current?.runtime.jobs[job.name] ?? {
                  result_available: false,
                  state: "unavailable",
                },
                job.actor,
                job.mode
              )} · ${dependencyDescription(job.dependsOn)}`,
              title: `  Job · ${job.name} · ${summary.current?.runtime.jobs[job.name]?.state ?? "unavailable"}`,
              value: `job:${job.name}`,
            },
            ...(
              summary.current?.runtime.jobs[job.name]?.worker?.turns ?? []
            ).flatMap((turn) =>
              turn.files.length === 0
                ? [
                    {
                      description: `turn ${turn.turn} · ${turn.isolated ? "isolated" : "shared"} · ${turn.undo_available ? "undo available" : "undo unavailable"}`,
                      title: `    Turn ${turn.turn}`,
                      value: `turn:${job.name}:${turn.turn}`,
                    },
                  ]
                : turn.files.map((file) => ({
                    description: `turn ${turn.turn} · ${file.status}`,
                    title: `    ${file.path} · +${file.additions} -${file.deletions} · ${turn.isolated ? "isolated" : "shared"} · ${turn.undo_available ? "undo" : "no undo"}`,
                    value: `turn:${job.name}:${turn.turn}:${file.path}`,
                  }))
            ),
          ]),
        ];
      })),
  ...(summary.current?.versions ?? [])
    .filter((version) => version.replacement_reason !== undefined)
    .map((version) => ({
      description: "Recorded replacement of the current workflow definition",
      title: `Replacement · v${version.version} · ${version.replacement_reason}`,
      value: `replacement:${version.version}`,
    })),
  ...summary.available_actions.map((action, index) => ({
    description: "Currently available semantic action",
    title: `Available · ${exactCall(action)}`,
    value: `available:${index}`,
  })),
];
