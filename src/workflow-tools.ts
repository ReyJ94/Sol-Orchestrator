import { randomUUID } from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bundledWorkerProfiles } from "./agent-defaults.js";
import type { GoalState } from "./goal-state.js";
import type {
  WorkerProfile,
  WorkerProfileDescriptor,
} from "./schema/common.js";
import type { RootSnapshot } from "./schema/orchestration.js";
import {
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowJob,
  WorkflowStepSchema,
} from "./schema/workflow.js";
import { normalizeWorkflowDefinition, workflowJob } from "./workflow-graph.js";
import { projectWorkflowStatus } from "./workflow-projection.js";
import type {
  WorkflowRecord,
  WorkflowState,
  WorkflowVersionRecord,
} from "./workflow-state.js";

const MessageSchema = z.string().trim().min(1).max(4000);
const SemanticSelectorSchema = z.string().trim().min(1).max(512);

const WorkflowStartInputSchema = z
  .object({
    objective: z.string().trim().min(1).max(4000),
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict();

const WorkflowStatusInputSchema = z.object({}).strict();

const WorkflowCompleteInputSchema = z
  .object({
    job: SemanticSelectorSchema.optional(),
    message: MessageSchema,
  })
  .strict();

const WorkflowDelegateInputSchema = z
  .object({ job: SemanticSelectorSchema.optional() })
  .strict();

const WorkflowReplaceInputSchema = z
  .object({
    reason: MessageSchema,
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict();

const WorkflowRetryInputSchema = z
  .object({
    job: SemanticSelectorSchema.optional(),
    reason: MessageSchema,
  })
  .strict();

type WorkerJob = WorkflowJob & {
  readonly actor: {
    readonly profile: WorkerProfile;
    readonly type: "worker";
  };
  readonly mode: "research" | "implementation" | "verification";
};

export type WorkflowWorkerLauncher = {
  launch(input: {
    readonly definition_job: WorkerJob;
    readonly parent_session_id: string;
    readonly step: string;
    readonly workflow_id: string;
    readonly workflow_version: number;
  }): Promise<void>;
};

type WorkflowStore = {
  mutateRoot<Value>(
    mutation: (state: {
      goal: GoalState;
      root: RootSnapshot;
      workflow: WorkflowState;
    }) => Value
  ): Promise<Value>;
  mutateWorkflow<Value>(
    mutation: (state: WorkflowState) => Value
  ): Promise<Value>;
  readWorkflow<Value>(
    reader: (state: WorkflowState) => Value
  ): Promise<Awaited<Value>>;
  readRoot(): Promise<RootSnapshot>;
};

type WorkflowToolContext = {
  readonly agent: string;
  readonly parent_session_id: string;
};

type WorkflowToolServiceOptions = {
  readonly available_workers?: () => readonly WorkerProfileDescriptor[];
  readonly create_id?: () => string;
  readonly refresh_workers?: (parent_session_id: string) => Promise<void>;
  readonly store: WorkflowStore;
  readonly workers: WorkflowWorkerLauncher;
};

const currentVersion = (record: WorkflowRecord): WorkflowVersionRecord => {
  const version = record.versions.find(
    (candidate) => candidate.version === record.current_version
  );
  if (version === undefined) {
    throw new Error("Current workflow version is unavailable.");
  }
  return version;
};

const exactCalls = (
  toolName: string,
  candidates: readonly string[],
  field?: "message" | "reason"
): string =>
  candidates
    .map(
      (job) =>
        `${toolName}({ job: ${JSON.stringify(job)}${
          field === undefined ? "" : `, ${field}: "<${field}>"`
        } })`
    )
    .join("; ");

const selectSemanticJob = (
  operation: string,
  selector: string | undefined,
  candidates: readonly string[],
  field?: "message" | "reason"
): string => {
  if (selector !== undefined) {
    if (!candidates.includes(selector)) {
      throw new Error(
        `${operation} cannot target ${selector}. Valid calls: ${exactCalls(
          operation,
          candidates,
          field
        )}`
      );
    }
    return selector;
  }
  if (candidates.length !== 1) {
    throw new Error(
      `${operation} requires job because ${candidates.length} targets are valid. Valid calls: ${exactCalls(
        operation,
        candidates,
        field
      )}`
    );
  }
  const selected = candidates[0];
  if (selected === undefined) {
    throw new Error(`${operation} has no valid target.`);
  }
  return selected;
};

export class WorkflowToolService {
  readonly #availableWorkers: () => readonly WorkerProfileDescriptor[];
  readonly #createID: () => string;
  readonly #refreshWorkers?: (parent_session_id: string) => Promise<void>;
  readonly #store: WorkflowStore;
  readonly #workers: WorkflowWorkerLauncher;

  constructor(options: WorkflowToolServiceOptions) {
    this.#availableWorkers =
      options.available_workers ?? (() => bundledWorkerProfiles);
    this.#createID = options.create_id ?? randomUUID;
    this.#refreshWorkers = options.refresh_workers;
    this.#store = options.store;
    this.#workers = options.workers;
  }

  async start(input: unknown, context: unknown) {
    const parsedContext = this.#context(context);
    const parsed = WorkflowStartInputSchema.parse(input);
    const definition = normalizeWorkflowDefinition(parsed);
    this.#assertAvailableProfiles(definition);
    await this.#store.mutateRoot(({ goal, workflow }) => {
      const currentGoal = goal.currentFor(
        parsedContext.parent_session_id,
        parsedContext.agent
      );
      workflow.start({
        definition,
        ...(currentGoal === undefined ? {} : { goal_id: currentGoal.goal_id }),
        orchestrator_agent_id: parsedContext.agent,
        parent_session_id: parsedContext.parent_session_id,
        workflow_id: this.#createID(),
      });
    });
    return await this.status({}, parsedContext);
  }

  async status(input: unknown, context: unknown) {
    WorkflowStatusInputSchema.parse(input);
    const parsedContext = this.#context(context);
    await this.#refreshWorkers?.(parsedContext.parent_session_id);
    return projectWorkflowStatus(
      await this.#store.readRoot(),
      parsedContext,
      this.#availableWorkers()
    );
  }

  async complete(input: unknown, context: unknown) {
    const parsedContext = this.#context(context);
    const parsed = WorkflowCompleteInputSchema.parse(input);
    await this.#store.mutateWorkflow((state) => {
      const current = this.#current(state, parsedContext);
      const version = currentVersion(current);
      const candidates = version.definition.steps.flatMap((step) =>
        step.jobs
          .filter((job) => {
            const runtime = version.job_states[job.name];
            return (
              (job.actor.type === "orchestrator" &&
                runtime?.state === "active") ||
              (job.actor.type === "worker" && runtime?.state === "review")
            );
          })
          .map((job) => job.name)
      );
      const job = selectSemanticJob(
        "workflow_complete",
        parsed.job,
        candidates,
        "message"
      );
      state.completeJob({
        job,
        message: parsed.message,
        workflow_id: current.workflow_id,
      });
    });
    return await this.status({}, parsedContext);
  }

  async delegate(input: unknown, context: unknown) {
    const parsedContext = this.#context(context);
    const parsed = WorkflowDelegateInputSchema.parse(input);
    const launch = await this.#store.readWorkflow((state) => {
      const current = this.#current(state, parsedContext);
      const version = currentVersion(current);
      const candidates = version.definition.steps.flatMap((step) =>
        step.jobs
          .filter(
            (job) =>
              job.actor.type === "worker" &&
              version.job_states[job.name]?.state === "ready"
          )
          .map((job) => job.name)
      );
      const jobName = selectSemanticJob(
        "workflow_delegate",
        parsed.job,
        candidates
      );
      const selected = workflowJob(version.definition, jobName);
      if (
        selected.job.actor.type !== "worker" ||
        selected.job.mode === undefined
      ) {
        throw new Error(`Job ${jobName} is not a worker job.`);
      }
      this.#assertAvailableProfiles({
        objective: version.definition.objective,
        steps: [selected.step],
      });
      return {
        definition_job: selected.job as WorkerJob,
        parent_session_id: current.parent_session_id,
        step: selected.step.name,
        workflow_id: current.workflow_id,
        workflow_version: current.current_version,
      };
    });
    await this.#workers.launch(launch);
    return await this.status({}, parsedContext);
  }

  async replace(input: unknown, context: unknown) {
    const parsedContext = this.#context(context);
    const parsed = WorkflowReplaceInputSchema.parse(input);
    await this.#store.mutateWorkflow((state) => {
      const current = this.#current(state, parsedContext);
      const definition: WorkflowDefinition = WorkflowDefinitionSchema.parse({
        objective: currentVersion(current).definition.objective,
        steps: parsed.steps,
      });
      this.#assertAvailableProfiles(definition);
      state.replace({
        reason: parsed.reason,
        steps: definition.steps,
        workflow_id: current.workflow_id,
      });
    });
    return await this.status({}, parsedContext);
  }

  async retry(input: unknown, context: unknown) {
    const parsedContext = this.#context(context);
    const parsed = WorkflowRetryInputSchema.parse(input);
    await this.#store.mutateWorkflow((state) => {
      const current = this.#current(state, parsedContext);
      const version = currentVersion(current);
      const candidates = Object.entries(version.job_states)
        .filter(
          ([, runtime]) =>
            runtime.state === "review" || runtime.state === "blocked"
        )
        .map(([name]) => name);
      const job = selectSemanticJob(
        "workflow_retry",
        parsed.job,
        candidates,
        "reason"
      );
      state.retryJob({
        job,
        reason: parsed.reason,
        workflow_id: current.workflow_id,
      });
    });
    return await this.status({}, parsedContext);
  }

  #context(input: unknown): WorkflowToolContext {
    return z
      .object({
        agent: z.string().trim().min(1),
        parent_session_id: z.string().trim().min(1),
      })
      .strip()
      .parse(input);
  }

  #assertAvailableProfiles(definition: WorkflowDefinition): void {
    const available = this.#availableWorkers();
    const names = new Set(available.map((worker) => worker.profile));
    const unavailable = [
      ...new Set(
        definition.steps.flatMap((step) =>
          step.jobs.flatMap((job) =>
            job.actor.type === "worker" && !names.has(job.actor.profile)
              ? [job.actor.profile]
              : []
          )
        )
      ),
    ].sort();
    if (unavailable.length === 0) {
      return;
    }
    throw new Error(
      `Unavailable worker profile${unavailable.length === 1 ? "" : "s"} ${unavailable.map((profile) => JSON.stringify(profile)).join(", ")}. Available profiles: ${available.map((worker) => JSON.stringify(worker.profile)).join(", ") || "none"}. Call workflow_status({}) for routing descriptions.`
    );
  }

  #current(state: WorkflowState, context: WorkflowToolContext): WorkflowRecord {
    const current = state.currentFor(context.parent_session_id, context.agent);
    if (current === undefined) {
      throw new Error(
        "No unfinished workflow is current. Call workflow_status({}) and then workflow_start({ objective, steps })."
      );
    }
    return current;
  }
}

const toolResult = (value: unknown): string => JSON.stringify(value, null, 2);

const toolContext = (context: { agent: string; sessionID: string }) => ({
  agent: context.agent,
  parent_session_id: context.sessionID,
});

export const createWorkflowToolDefinitions = (
  service: WorkflowToolService
) => ({
  workflow_complete: tool({
    args: WorkflowCompleteInputSchema.shape,
    description:
      "Complete one active Sol job or accept one worker job in review using its authored semantic name when selection is ambiguous.",
    async execute(args, context) {
      return toolResult(await service.complete(args, toolContext(context)));
    },
  }),
  workflow_delegate: tool({
    args: WorkflowDelegateInputSchema.shape,
    description:
      "Atomically launch one authored ready worker through a native OpenCode child session and return refreshed workflow state.",
    async execute(args, context) {
      return toolResult(await service.delegate(args, toolContext(context)));
    },
  }),
  workflow_replace: tool({
    args: WorkflowReplaceInputSchema.shape,
    description:
      "Replace the complete unfinished step/job hierarchy after reality changes, creating exactly one new internal specification version.",
    async execute(args, context) {
      return toolResult(await service.replace(args, toolContext(context)));
    },
  }),
  workflow_retry: tool({
    args: WorkflowRetryInputSchema.shape,
    description:
      "Retry one unchanged worker review or blocked job without changing workflow topology.",
    async execute(args, context) {
      return toolResult(await service.retry(args, toolContext(context)));
    },
  }),
  workflow_start: tool({
    args: WorkflowStartInputSchema.shape,
    description:
      "Atomically start one complete orchestrator-authored step/job hierarchy for the current parent session.",
    async execute(args, context) {
      return toolResult(await service.start(args, toolContext(context)));
    },
  }),
  workflow_status: tool({
    args: WorkflowStatusInputSchema.shape,
    description:
      "Show the current semantic workflow projection, available worker profiles, and every currently available semantic action without internal IDs or worker content bodies.",
    async execute(args, context) {
      return toolResult(await service.status(args, toolContext(context)));
    },
  }),
});
