import type {
  JobState,
  StepState,
  WorkflowDefinition,
  WorkflowStateValue,
} from "./schema/workflow.js";
import {
  normalizeWorkflowDefinition,
  prerequisiteJobNames,
  semanticJobSignatures,
  topologicalJobNames,
  workflowJob,
  workflowStep,
} from "./workflow-graph.js";

type Clock = () => string;

export type WorkflowJobRuntime = {
  readonly completion_message?: string;
  readonly latest_message?: string;
  readonly result_available: boolean;
  readonly retry_reason?: string;
  readonly run_sequence: number;
  readonly state: JobState;
  readonly task_id?: string;
  readonly updated_at: string;
};

export type WorkflowVersionRecord = {
  readonly created_at: string;
  readonly definition: WorkflowDefinition;
  readonly job_states: Readonly<Record<string, WorkflowJobRuntime>>;
  readonly replacement_reason?: string;
  readonly version: number;
};

export type WorkflowRecord = {
  readonly current: boolean;
  readonly current_version: number;
  readonly goal_id?: string;
  readonly orchestrator_agent_id: string;
  readonly parent_session_id: string;
  readonly versions: readonly WorkflowVersionRecord[];
  readonly workflow_id: string;
};

export type WorkflowSnapshot = {
  readonly workflows: readonly WorkflowRecord[];
};

type WorkflowStateOptions = {
  readonly now?: Clock;
};

const clone = <Value>(value: Value): Value => structuredClone(value);

const initialJobStates = (
  definition: WorkflowDefinition,
  now: string
): Record<string, WorkflowJobRuntime> =>
  Object.fromEntries(
    definition.steps.flatMap((step) =>
      step.jobs.map((job) => [
        job.name,
        {
          result_available: false,
          run_sequence: 0,
          state: "pending" as const,
          updated_at: now,
        },
      ])
    )
  );

export class WorkflowState {
  readonly #now: Clock;
  readonly #workflows: WorkflowRecord[];

  constructor(
    options: WorkflowStateOptions = {},
    snapshot: WorkflowSnapshot = { workflows: [] }
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#workflows = clone([...snapshot.workflows]);
  }

  static restore(
    snapshot: WorkflowSnapshot,
    options: WorkflowStateOptions = {}
  ): WorkflowState {
    return new WorkflowState(options, snapshot);
  }

  snapshot(): WorkflowSnapshot {
    return clone({ workflows: this.#workflows });
  }

  start(input: {
    readonly definition: WorkflowDefinition;
    readonly goal_id?: string;
    readonly orchestrator_agent_id: string;
    readonly parent_session_id: string;
    readonly workflow_id: string;
  }): WorkflowRecord {
    if (
      this.#workflows.some(
        (candidate) =>
          candidate.current &&
          candidate.parent_session_id === input.parent_session_id
      )
    ) {
      throw new Error(
        "An unfinished workflow is already current for this parent session."
      );
    }
    if (
      this.#workflows.some(
        (candidate) => candidate.workflow_id === input.workflow_id
      )
    ) {
      throw new Error(`Workflow identity ${input.workflow_id} already exists.`);
    }
    const definition = normalizeWorkflowDefinition(input.definition);
    const createdAt = this.#now();
    const record: WorkflowRecord = {
      current: true,
      current_version: 1,
      ...(input.goal_id === undefined ? {} : { goal_id: input.goal_id }),
      orchestrator_agent_id: input.orchestrator_agent_id,
      parent_session_id: input.parent_session_id,
      versions: [
        {
          created_at: createdAt,
          definition,
          job_states: initialJobStates(definition, createdAt),
          version: 1,
        },
      ],
      workflow_id: input.workflow_id,
    };
    this.#workflows.push(record);
    this.#advance(record);
    return clone(record);
  }

  currentFor(
    parentSessionID: string,
    orchestratorAgentID: string
  ): WorkflowRecord | undefined {
    const record = this.#workflows.find(
      (candidate) =>
        candidate.current &&
        candidate.parent_session_id === parentSessionID &&
        candidate.orchestrator_agent_id === orchestratorAgentID
    );
    return record === undefined ? undefined : clone(record);
  }

  attachGoal(input: {
    readonly goal_id: string;
    readonly workflow_id: string;
  }): WorkflowRecord {
    const record = this.#record(input.workflow_id);
    if (!record.current) {
      throw new Error("A completed workflow cannot be attached to a goal.");
    }
    if (record.goal_id !== undefined && record.goal_id !== input.goal_id) {
      throw new Error(
        "The current workflow is already attached to another goal."
      );
    }
    (record as { goal_id?: string }).goal_id = input.goal_id;
    return clone(record);
  }

  removeGoalWorkflows(goalID: string): string[] {
    const associated = this.#workflows.filter(
      (workflow) => workflow.goal_id === goalID
    );
    const workflowIDs = associated.map((workflow) => workflow.workflow_id);
    for (let index = this.#workflows.length - 1; index >= 0; index -= 1) {
      if (this.#workflows[index]?.goal_id === goalID) {
        this.#workflows.splice(index, 1);
      }
    }
    return workflowIDs;
  }

  jobState(input: {
    readonly job: string;
    readonly workflow_id: string;
  }): WorkflowJobRuntime | undefined {
    const runtime = this.#version(this.#record(input.workflow_id)).job_states[
      input.job
    ];
    return runtime === undefined ? undefined : clone(runtime);
  }

  stepState(input: {
    readonly step: string;
    readonly workflow_id: string;
  }): StepState {
    const record = this.#record(input.workflow_id);
    const version = this.#version(record);
    const step = workflowStep(version.definition, input.step);
    const states = step.jobs.map((job) => this.#jobRuntime(version, job.name));
    if (states.every((runtime) => runtime.state === "completed")) {
      return "completed";
    }
    if (states.some((runtime) => runtime.state === "blocked")) {
      return "blocked";
    }
    if (
      step.dependsOn.some(
        (dependency) =>
          this.stepState({
            step: dependency,
            workflow_id: input.workflow_id,
          }) !== "completed"
      ) ||
      states.every((runtime) => runtime.state === "pending")
    ) {
      return "pending";
    }
    return "active";
  }

  workflowState(workflowID: string): WorkflowStateValue {
    const record = this.#record(workflowID);
    const definition = this.#version(record).definition;
    const states = definition.steps.map((step) =>
      this.stepState({ step: step.name, workflow_id: workflowID })
    );
    if (states.every((state) => state === "completed")) {
      return "completed";
    }
    if (states.some((state) => state === "blocked")) {
      return "blocked";
    }
    return "active";
  }

  completeJob(input: {
    readonly job: string;
    readonly message: string;
    readonly workflow_id: string;
  }): void {
    const message = input.message.trim();
    if (message.length === 0 || message.length > 4000) {
      throw new Error("Completion message must contain 1..4000 characters.");
    }
    const record = this.#record(input.workflow_id);
    const version = this.#version(record);
    const { job } = workflowJob(version.definition, input.job);
    const runtime = this.#jobRuntime(version, input.job);
    const completable =
      (job.actor.type === "orchestrator" && runtime.state === "active") ||
      (job.actor.type === "worker" && runtime.state === "review");
    if (!completable) {
      throw new Error(
        `Job ${input.job} is not an active Sol obligation or worker review.`
      );
    }
    this.#setJobRuntime(version, input.job, {
      ...runtime,
      completion_message: message,
      state: "completed",
      updated_at: this.#now(),
    });
    this.#advance(record);
  }

  markWorkerActive(input: {
    readonly job: string;
    readonly task_id: string;
    readonly workflow_id: string;
  }): void {
    const record = this.#record(input.workflow_id);
    const version = this.#version(record);
    const { job } = workflowJob(version.definition, input.job);
    const runtime = this.#jobRuntime(version, input.job);
    if (job.actor.type !== "worker" || runtime.state !== "ready") {
      throw new Error(`Worker job ${input.job} is not ready.`);
    }
    this.#setJobRuntime(version, input.job, {
      ...runtime,
      result_available: false,
      run_sequence: runtime.run_sequence + 1,
      state: "active",
      task_id: input.task_id,
      updated_at: this.#now(),
    });
  }

  markWorkerReview(input: {
    readonly job: string;
    readonly result_available: boolean;
    readonly workflow_id: string;
  }): void {
    const record = this.#record(input.workflow_id);
    const version = this.#version(record);
    const { job } = workflowJob(version.definition, input.job);
    const runtime = this.#jobRuntime(version, input.job);
    if (job.actor.type !== "worker" || runtime.state !== "active") {
      throw new Error(`Worker job ${input.job} is not active.`);
    }
    this.#setJobRuntime(version, input.job, {
      ...runtime,
      result_available: input.result_available,
      state: "review",
      updated_at: this.#now(),
    });
  }

  blockJob(input: {
    readonly job: string;
    readonly message: string;
    readonly workflow_id: string;
  }): void {
    const record = this.#record(input.workflow_id);
    const version = this.#version(record);
    const runtime = this.#jobRuntime(version, input.job);
    if (
      runtime.state !== "active" &&
      runtime.state !== "ready" &&
      runtime.state !== "review"
    ) {
      throw new Error(
        `Job ${input.job} cannot be blocked from ${runtime.state}.`
      );
    }
    this.#setJobRuntime(version, input.job, {
      ...runtime,
      latest_message: input.message.trim(),
      state: "blocked",
      updated_at: this.#now(),
    });
  }

  retryJob(input: {
    readonly job: string;
    readonly reason: string;
    readonly workflow_id: string;
  }): void {
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 4000) {
      throw new Error("Retry reason must contain 1..4000 characters.");
    }
    const record = this.#record(input.workflow_id);
    const version = this.#version(record);
    const runtime = this.#jobRuntime(version, input.job);
    if (runtime.state !== "review" && runtime.state !== "blocked") {
      throw new Error("Only a worker review or blocked job can be retried.");
    }
    this.#setJobRuntime(version, input.job, {
      result_available: false,
      retry_reason: reason,
      run_sequence: runtime.run_sequence,
      state: "pending",
      updated_at: this.#now(),
    });
    this.#advance(record);
  }

  restoreWorkerReview(input: {
    readonly job: string;
    readonly task_id: string;
    readonly workflow_id: string;
  }): void {
    const record = this.#record(input.workflow_id);
    const version = this.#version(record);
    const { job } = workflowJob(version.definition, input.job);
    const runtime = this.#jobRuntime(version, input.job);
    if (
      job.actor.type !== "worker" ||
      runtime.state !== "blocked" ||
      runtime.task_id !== input.task_id ||
      !runtime.result_available
    ) {
      throw new Error(`Worker job ${input.job} cannot restore review.`);
    }
    this.#setJobRuntime(version, input.job, {
      ...runtime,
      state: "review",
      updated_at: this.#now(),
    });
  }

  replace(input: {
    readonly objective?: string;
    readonly reason: string;
    readonly steps: WorkflowDefinition["steps"];
    readonly workflow_id: string;
  }): void {
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 4000) {
      throw new Error("Replacement reason must contain 1..4000 characters.");
    }
    const record = this.#record(input.workflow_id);
    if (!record.current) {
      throw new Error("A completed workflow cannot be replaced.");
    }
    const previous = this.#version(record);
    const definition = normalizeWorkflowDefinition({
      objective: input.objective ?? previous.definition.objective,
      steps: input.steps,
    });
    const now = this.#now();
    this.#assertActiveWorkersReplaceable(previous, definition);

    const nextVersion: WorkflowVersionRecord = {
      created_at: now,
      definition,
      job_states: this.#replacementJobStates(previous, definition, now),
      replacement_reason: reason,
      version: record.current_version + 1,
    };
    (record.versions as WorkflowVersionRecord[]).push(nextVersion);
    (record as { current_version: number }).current_version =
      nextVersion.version;
    this.#advance(record);
  }

  #record(workflowID: string): WorkflowRecord {
    const record = this.#workflows.find(
      (candidate) => candidate.workflow_id === workflowID
    );
    if (record === undefined) {
      throw new Error(`Unknown workflow ${workflowID}.`);
    }
    return record;
  }

  #version(record: WorkflowRecord): WorkflowVersionRecord {
    const version = record.versions.find(
      (candidate) => candidate.version === record.current_version
    );
    if (version === undefined) {
      throw new Error(`Workflow ${record.workflow_id} has no current version.`);
    }
    return version;
  }

  #jobRuntime(
    version: WorkflowVersionRecord,
    jobName: string
  ): WorkflowJobRuntime {
    const runtime = version.job_states[jobName];
    if (runtime === undefined) {
      throw new Error(`Unknown job runtime ${jobName}.`);
    }
    return runtime;
  }

  #setJobRuntime(
    version: WorkflowVersionRecord,
    jobName: string,
    runtime: WorkflowJobRuntime
  ): void {
    (version.job_states as Record<string, WorkflowJobRuntime>)[jobName] =
      runtime;
  }

  #assertActiveWorkersReplaceable(
    previous: WorkflowVersionRecord,
    definition: WorkflowDefinition
  ): void {
    const previousSignatures = semanticJobSignatures(previous.definition);
    const nextSignatures = semanticJobSignatures(definition);
    for (const step of previous.definition.steps) {
      for (const job of step.jobs) {
        const runtime = this.#jobRuntime(previous, job.name);
        if (
          job.actor.type === "worker" &&
          runtime.state === "active" &&
          previousSignatures.get(job.name) !== nextSignatures.get(job.name)
        ) {
          throw new Error(
            `Active worker job ${job.name} must be interrupted before removal, movement, or semantic change.`
          );
        }
      }
    }
  }

  #replacementJobStates(
    previous: WorkflowVersionRecord,
    definition: WorkflowDefinition,
    now: string
  ): Record<string, WorkflowJobRuntime> {
    const states = initialJobStates(definition, now);
    const previousSignatures = semanticJobSignatures(previous.definition);
    const nextSignatures = semanticJobSignatures(definition);
    const identical = new Map<string, boolean>();
    const retained = new Set<string>();
    for (const jobName of topologicalJobNames(definition)) {
      const oldRuntime = previous.job_states[jobName];
      const prerequisites = [...prerequisiteJobNames(definition, jobName)];
      const definitionMatches =
        oldRuntime !== undefined &&
        previousSignatures.get(jobName) === nextSignatures.get(jobName) &&
        prerequisites.every((dependency) => identical.get(dependency) === true);
      identical.set(jobName, definitionMatches);
      if (
        oldRuntime !== undefined &&
        definitionMatches &&
        this.#runtimeCanCarry(previous, oldRuntime, prerequisites, retained)
      ) {
        states[jobName] = clone(oldRuntime);
        retained.add(jobName);
      }
    }
    return states;
  }

  #runtimeCanCarry(
    previous: WorkflowVersionRecord,
    runtime: WorkflowJobRuntime,
    prerequisites: readonly string[],
    retained: ReadonlySet<string>
  ): boolean {
    if (runtime.state === "completed") {
      return prerequisites.every(
        (dependency) =>
          retained.has(dependency) &&
          previous.job_states[dependency]?.state === "completed"
      );
    }
    return (
      runtime.state === "active" ||
      runtime.state === "review" ||
      runtime.state === "blocked"
    );
  }

  #advance(record: WorkflowRecord): void {
    const version = this.#version(record);
    while (this.#activateReadyJobs(record, version)) {
      // Continue until scheduling reaches a fixed point.
    }

    if (this.workflowState(record.workflow_id) === "completed") {
      (record as { current: boolean }).current = false;
    }
  }

  #activateReadyJobs(
    record: WorkflowRecord,
    version: WorkflowVersionRecord
  ): boolean {
    let changed = false;
    for (const step of version.definition.steps) {
      const stepReady = step.dependsOn.every(
        (dependency) =>
          this.stepState({
            step: dependency,
            workflow_id: record.workflow_id,
          }) === "completed"
      );
      if (!stepReady) {
        continue;
      }
      for (const job of step.jobs) {
        const runtime = this.#jobRuntime(version, job.name);
        const dependenciesComplete = job.dependsOn.every(
          (dependency) =>
            this.#jobRuntime(version, dependency).state === "completed"
        );
        if (runtime.state !== "pending" || !dependenciesComplete) {
          continue;
        }
        this.#setJobRuntime(version, job.name, {
          ...runtime,
          run_sequence:
            job.actor.type === "orchestrator"
              ? runtime.run_sequence + 1
              : runtime.run_sequence,
          state: job.actor.type === "orchestrator" ? "active" : "ready",
          updated_at: this.#now(),
        });
        changed = true;
      }
    }
    return changed;
  }
}
