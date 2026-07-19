import { goalToolNames, workflowToolNames } from "./agent-defaults.js";
import type {
  OpenCodePermissionRule,
  OpenCodeSession,
} from "./opencode-session.js";
import type { RootSnapshot } from "./schema/orchestration.js";
import { WorkflowJobSchema } from "./schema/workflow.js";
import { workflowJob } from "./workflow-graph.js";
import type { WorkflowState } from "./workflow-state.js";
import type { WorkflowWorkerLauncher } from "./workflow-tools.js";

type LaunchInput = Parameters<WorkflowWorkerLauncher["launch"]>[0];

type LauncherStore = {
  mutateRoot<Value>(
    mutation: (state: { root: RootSnapshot; workflow: WorkflowState }) => Value
  ): Promise<Value>;
  readWorkflow<Value>(
    reader: (state: WorkflowState) => Value
  ): Promise<Awaited<Value>>;
};

type LauncherSessions = {
  abort(sessionID: string): Promise<void>;
  appendPermissions(
    sessionID: string,
    rules: OpenCodePermissionRule[]
  ): Promise<unknown>;
  createChild(input: {
    parentID: string;
    title: string;
  }): Promise<OpenCodeSession>;
  promptAsync(input: {
    agent: string;
    messageID: string;
    sessionID: string;
    text: string;
  }): Promise<void>;
  remove(sessionID: string): Promise<void>;
};

type WorkerLauncherOptions = {
  readonly create_message_id: () => string;
  readonly now?: () => string;
  readonly sessions: LauncherSessions;
};

const workerPrompt = (input: LaunchInput): string => {
  const job = input.definition_job;
  return [
    "This authored semantic job is your binding execution contract.",
    `Job: ${job.name}`,
    `Mode: ${job.mode}`,
    job.objective,
    ...(job.writeFiles === undefined
      ? []
      : [
          `Write scope (reads remain unrestricted): ${JSON.stringify(
            job.writeFiles
          )}`,
        ]),
  ].join("\n\n");
};

export const managedWorkerPermissionRules: readonly OpenCodePermissionRule[] = [
  { action: "deny", pattern: "*", permission: "agents_*" },
  { action: "deny", pattern: "*", permission: "doom_loop" },
  ...goalToolNames.map((permission) => ({
    action: "deny" as const,
    pattern: "*",
    permission,
  })),
  { action: "allow", pattern: "*", permission: "report_to_parent" },
  { action: "deny", pattern: "*", permission: "task" },
  { action: "deny", pattern: "*", permission: "todowrite" },
  ...workflowToolNames.map((permission) => ({
    action: "deny" as const,
    pattern: "*",
    permission,
  })),
];

const permissionRules = (input: LaunchInput): OpenCodePermissionRule[] => {
  const writeFiles = input.definition_job.writeFiles;
  return writeFiles === undefined
    ? [
        ...managedWorkerPermissionRules,
        { action: "allow", pattern: "*", permission: "edit" },
      ]
    : [
        ...managedWorkerPermissionRules,
        { action: "ask", pattern: "*", permission: "edit" },
        ...writeFiles.map((pattern) => ({
          action: "allow" as const,
          pattern,
          permission: "edit",
        })),
      ];
};

export class WorkerLauncher implements WorkflowWorkerLauncher {
  readonly #createMessageID: () => string;
  readonly #now: () => string;
  readonly #sessions: LauncherSessions;
  readonly #store: LauncherStore;

  constructor(store: LauncherStore, options: WorkerLauncherOptions) {
    this.#store = store;
    this.#sessions = options.sessions;
    this.#createMessageID = options.create_message_id;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async launch(input: LaunchInput): Promise<void> {
    const definitionJob = WorkflowJobSchema.parse(input.definition_job);
    if (
      definitionJob.actor.type !== "worker" ||
      definitionJob.mode === undefined
    ) {
      throw new Error("Only a worker job can launch a managed worker.");
    }
    await this.#assertReady(input);
    const child = await this.#sessions.createChild({
      parentID: input.parent_session_id,
      title: `${definitionJob.name} (@${definitionJob.actor.profile} subagent)`,
    });
    let bound = false;
    try {
      await this.#sessions.appendPermissions(child.id, permissionRules(input));
      await this.#bind(input, child.id);
      bound = true;
      await this.#sessions.promptAsync({
        agent: definitionJob.actor.profile,
        messageID: this.#createMessageID(),
        sessionID: child.id,
        text: workerPrompt(input),
      });
    } catch (error) {
      if (bound) {
        await this.#blockFailedPrompt(input, child.id);
        await this.#sessions.abort(child.id).catch(() => undefined);
      } else {
        await this.#sessions.remove(child.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async #assertReady(input: LaunchInput): Promise<void> {
    await this.#store.readWorkflow((state) => {
      const record = state
        .snapshot()
        .workflows.find(
          (candidate) => candidate.workflow_id === input.workflow_id
        );
      const version = record?.versions.find(
        (candidate) => candidate.version === input.workflow_version
      );
      if (
        record === undefined ||
        !record.current ||
        record.current_version !== input.workflow_version ||
        record.parent_session_id !== input.parent_session_id ||
        version?.job_states[input.definition_job.name]?.state !== "ready"
      ) {
        throw new Error("The worker job is not ready in the current workflow.");
      }
      const selected = workflowJob(
        version.definition,
        input.definition_job.name
      );
      if (
        selected.step.name !== input.step ||
        JSON.stringify(selected.job) !== JSON.stringify(input.definition_job)
      ) {
        throw new Error(
          "The managed worker definition does not match durable workflow state."
        );
      }
    });
  }

  async #bind(input: LaunchInput, childSessionID: string): Promise<void> {
    const now = this.#now();
    await this.#store.mutateRoot(({ root, workflow }) => {
      workflow.markWorkerActive({
        job: input.definition_job.name,
        task_id: childSessionID,
        workflow_id: input.workflow_id,
      });
      const record = workflow
        .snapshot()
        .workflows.find(
          (candidate) => candidate.workflow_id === input.workflow_id
        );
      const version = record?.versions.find(
        (candidate) => candidate.version === input.workflow_version
      );
      const runtime = version?.job_states[input.definition_job.name];
      if (runtime === undefined) {
        throw new Error("Bound worker runtime is unavailable.");
      }
      root.job_runs.push({
        job: input.definition_job.name,
        result_available: false,
        run_sequence: runtime.run_sequence,
        started_at: now,
        state: "active",
        task_id: childSessionID,
        updated_at: now,
        workflow_id: input.workflow_id,
        workflow_version: input.workflow_version,
        write_grants: [],
      });
      root.workers.push({
        child_session_id: childSessionID,
        created_at: now,
        delivered_event_sequence: 0,
        job: input.definition_job.name,
        latest_event: null,
        live_state: "starting",
        mode: input.definition_job.mode,
        parent_session_id: input.parent_session_id,
        profile: input.definition_job.actor.profile,
        run_sequence: runtime.run_sequence,
        task_id: childSessionID,
        updated_at: now,
        workflow_id: input.workflow_id,
        workflow_version: input.workflow_version,
      });
    });
  }

  async #blockFailedPrompt(
    input: LaunchInput,
    childSessionID: string
  ): Promise<void> {
    const now = this.#now();
    await this.#store.mutateRoot(({ root, workflow }) => {
      const worker = root.workers.find(
        (candidate) => candidate.task_id === childSessionID
      );
      const run = root.job_runs.find(
        (candidate) => candidate.task_id === childSessionID
      );
      if (worker === undefined || run === undefined) {
        throw new Error("Failed worker launch binding disappeared.");
      }
      const message =
        "OpenCode created the managed child but rejected its initial prompt. Retry the unchanged job or replace the workflow.";
      workflow.blockJob({
        job: input.definition_job.name,
        message,
        workflow_id: input.workflow_id,
      });
      run.state = "blocked";
      run.updated_at = now;
      worker.latest_event = {
        created_at: now,
        kind: "blocker",
        message,
        sequence: 1,
      };
      worker.live_state = "blocked";
      worker.updated_at = now;
    });
  }
}
