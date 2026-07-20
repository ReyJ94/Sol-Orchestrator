import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import { z } from "zod";

import type {
  OpenCodeFileDiff,
  OpenCodeMessageRecord,
  OpenCodePermissionRequest,
  OpenCodeSession,
  OpenCodeSessionStatus,
} from "./opencode-session.js";
import { OrchestrationStore } from "./orchestration-store.js";
import type { WorkflowDefinition } from "./schema/workflow.js";
import {
  createDefaultServerRuntime,
  SolOrchestratorPlugin,
  withPersistenceWarning,
} from "./server.js";
import { managedWorkerPermissionRules } from "./worker-launcher.js";

const timestamp = "2026-07-17T12:00:00.000Z";
const directories: string[] = [];
const INTERNAL_OUTPUT_PATTERN =
  /workflow_id|run_sequence|message_id|event_id|task_id|child_session_id|lease|checkpoint|result_body/u;
const INTERRUPT_INTERNAL_PATTERN =
  /workflow_id|run_sequence|event_id|message_id|task_id|child_session_id/u;
const INVALID_INSPECT_PATTERN = /file|result/u;
const WAIT_INTERNAL_PATTERN =
  /event_sequence|delivered_event_sequence|message_id|workflow_id|task_id|child_session_id/u;
const REDACTED_INTERNAL_PATTERN =
  /workflow_id|run_sequence|boundary_message_id|result_message_id|event_sequence/u;
const PENDING_SEND_PATTERN =
  /delivery.*cannot accept.*agents_status.*agents_wait/u;
const PERMISSION_FEEDBACK_PATTERN = /feedback.*deny/u;
const MULTIPLE_PERMISSION_PATTERN = /pending.*agents_interrupt/u;
const OPENCODE_MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u;
const ALREADY_CLEARED_PATTERN = /already.*cleared|cleared.*already/i;
const ALREADY_PERSISTED_PATTERN = /already persisted/i;
const GOAL_STATUS_PATTERN = /durable goal.*status|goal.*workflow status/i;
const WORKFLOW_STATUS_FIRST_PATTERN = /workflow_status\(\{\}\).*first/is;
const WORKFLOW_REQUIRED_PATTERN = /read-only orientation.*workflow_start/is;
const WORKFLOW_BINDING_PATTERN =
  /binding execution contract.*active orchestrator-owned job/is;
const AUTOMATIC_GRAPH_LAUNCH_PATTERN = /harness.*automatically.*dependencies/is;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

const definition = {
  objective: "Exercise the worker lifecycle through the plugin.",
  steps: [
    {
      dependsOn: [],
      jobs: [
        {
          actor: { profile: "terra-medium" as const, type: "worker" as const },
          dependsOn: [],
          mode: "implementation" as const,
          name: "implement worker lifecycle",
          objective: "Implement only the bounded worker lifecycle.",
        },
      ],
      name: "worker lifecycle",
      objective: "Replace checkpoint protocol with bounded worker events.",
    },
  ],
};

const scopedDefinition: WorkflowDefinition = {
  ...definition,
  steps: definition.steps.map((step) => ({
    ...step,
    jobs: step.jobs.map((job) => ({ ...job, writeFiles: ["src/**"] })),
  })),
};

const sessionRecord = (id: string, parentID = "parent-1") => ({
  directory: "/workspace",
  id,
  parentID,
  permission: [],
  projectID: "project-1",
  time: { created: 1, updated: 1 },
  title: "implement worker lifecycle (@terra-medium subagent)",
  version: "1.18.1",
});

class FakeSessions {
  readonly aborts: string[] = [];
  abortFailure: Error | undefined;
  readonly appended: Array<{ rules: unknown[]; sessionID: string }> = [];
  readonly diffRecords = new Map<string, OpenCodeFileDiff[]>();
  readonly messageRecords = new Map<string, OpenCodeMessageRecord[]>();
  readonly sessionRecords = new Map<string, ReturnType<typeof sessionRecord>>([
    ["child-1", sessionRecord("child-1")],
  ]);
  readonly prompts: Array<{
    agent: string;
    directory?: string;
    messageID: string;
    sessionID: string;
    text: string;
  }> = [];
  promptAttempts = 0;
  promptGate: Promise<void> | undefined;
  readonly revertCalls: Array<{ messageID: string; sessionID: string }> = [];
  readonly permissionReplies: Array<{
    feedback?: string;
    reply: "once" | "reject";
    requestID: string;
  }> = [];
  readonly permissionOperations: Array<
    | { rules: unknown[]; sessionID: string; type: "append" }
    | {
        feedback?: string;
        reply: "once" | "reject";
        requestID: string;
        type: "reply";
      }
  > = [];
  permissionListCalls = 0;
  permissionReplyFailure: Error | undefined;
  permissionRequests: OpenCodePermissionRequest[] = [];
  promptFailure: Error | undefined;
  statuses: Record<string, OpenCodeSessionStatus> = {
    "child-1": { type: "busy" },
  };
  statusCalls = 0;
  statusGate: Promise<void> | undefined;
  created = 0;
  readonly removed: string[] = [];

  abort(sessionID: string): Promise<void> {
    this.aborts.push(sessionID);
    if (this.abortFailure !== undefined) {
      return Promise.reject(this.abortFailure);
    }
    return Promise.resolve();
  }

  appendPermissions(sessionID: string, rules: unknown[]): Promise<void> {
    this.appended.push({ rules, sessionID });
    this.permissionOperations.push({ rules, sessionID, type: "append" });
    return Promise.resolve();
  }

  createChild(input: {
    parentID: string;
    title: string;
  }): Promise<ReturnType<typeof sessionRecord>> {
    this.created += 1;
    const id = this.created === 1 ? "child-1" : `created-child-${this.created}`;
    const child = { ...sessionRecord(id, input.parentID), title: input.title };
    this.sessionRecords.set(id, child);
    return Promise.resolve(child);
  }

  diff(_sessionID: string, messageID?: string): Promise<OpenCodeFileDiff[]> {
    return Promise.resolve(this.diffRecords.get(messageID ?? "") ?? []);
  }

  get(sessionID: string): Promise<ReturnType<typeof sessionRecord>> {
    const session = this.sessionRecords.get(sessionID);
    if (session === undefined) {
      return Promise.reject(new Error(`Unknown session ${sessionID}.`));
    }
    return Promise.resolve(session);
  }

  message(
    sessionID: string,
    messageID: string
  ): Promise<OpenCodeMessageRecord> {
    const message = this.messageRecords
      .get(sessionID)
      ?.find((candidate) => candidate.info.id === messageID);
    return message === undefined
      ? Promise.reject(new Error(`Unknown message ${messageID}.`))
      : Promise.resolve(message);
  }

  messages(sessionID: string): Promise<OpenCodeMessageRecord[]> {
    return Promise.resolve(this.messageRecords.get(sessionID) ?? []);
  }

  permissions(): Promise<OpenCodePermissionRequest[]> {
    this.permissionListCalls += 1;
    return Promise.resolve(structuredClone(this.permissionRequests));
  }

  async promptAsync(input: {
    agent: string;
    directory?: string;
    messageID: string;
    sessionID: string;
    text: string;
  }): Promise<void> {
    this.promptAttempts += 1;
    await this.promptGate;
    if (this.promptFailure !== undefined) {
      throw this.promptFailure;
    }
    this.prompts.push(input);
    const messages = this.messageRecords.get(input.sessionID) ?? [];
    if (!messages.some((message) => message.info.id === input.messageID)) {
      messages.push({
        info: {
          agent: input.agent,
          id: input.messageID,
          role: "user",
          sessionID: input.sessionID,
          time: { created: 3 },
        },
        parts: [
          {
            id: `${input.messageID}-part`,
            messageID: input.messageID,
            sessionID: input.sessionID,
            text: input.text,
            type: "text",
          },
        ],
      });
      this.messageRecords.set(input.sessionID, messages);
    }
    this.statuses[input.sessionID] = { type: "busy" };
    await Promise.resolve();
  }

  async replyPermission(input: {
    feedback?: string;
    reply: "once" | "reject";
    requestID: string;
  }): Promise<void> {
    if (this.permissionReplyFailure !== undefined) {
      throw this.permissionReplyFailure;
    }
    this.permissionReplies.push(input);
    this.permissionOperations.push({ ...input, type: "reply" });
    const request = this.permissionRequests.find(
      (candidate) => candidate.id === input.requestID
    );
    this.permissionRequests = this.permissionRequests.filter(
      (candidate) =>
        candidate.id !== input.requestID &&
        !(
          input.reply === "reject" &&
          request !== undefined &&
          candidate.sessionID === request.sessionID
        )
    );
    await Promise.resolve();
  }

  remove(sessionID: string): Promise<void> {
    this.removed.push(sessionID);
    this.sessionRecords.delete(sessionID);
    return Promise.resolve();
  }

  revert(input: {
    messageID: string;
    sessionID: string;
  }): Promise<OpenCodeSession> {
    this.revertCalls.push(input);
    const session = this.sessionRecords.get(input.sessionID);
    if (session === undefined) {
      return Promise.reject(new Error(`Unknown session ${input.sessionID}.`));
    }
    return Promise.resolve({
      ...session,
      revert: { messageID: input.messageID, snapshot: "snapshot-1" },
    });
  }

  async status(): Promise<Record<string, OpenCodeSessionStatus>> {
    this.statusCalls += 1;
    await this.statusGate;
    return this.statuses;
  }

  unrevert(sessionID: string): Promise<OpenCodeSession> {
    const session = this.sessionRecords.get(sessionID);
    return session === undefined
      ? Promise.reject(new Error(`Unknown session ${sessionID}.`))
      : Promise.resolve(session);
  }
}

const context = (sessionID: string, agent: string): ToolContext => ({
  abort: new AbortController().signal,
  agent,
  ask: async () => undefined,
  directory: "/workspace",
  messageID: "message-parent-1",
  metadata: () => undefined,
  sessionID,
  worktree: "/workspace",
});

const settlePluginRecovery = async (
  plugin: Awaited<ReturnType<typeof SolOrchestratorPlugin>>
): Promise<void> => {
  await plugin["tool.execute.before"]?.(
    {
      callID: "recovery-barrier",
      sessionID: "parent-1",
      tool: "workflow_status",
    },
    { args: {} }
  );
};

const backgroundInjection = (
  taskID: string,
  state: "completed" | "error",
  body: string
) => {
  const tag = state === "completed" ? "task_result" : "task_error";
  return [
    `<task id="${taskID}" state="${state}">`,
    `<summary>Background task ${state}: managed worker</summary>`,
    `<${tag}>`,
    body,
    `</${tag}>`,
    "</task>",
  ].join("\n");
};

const chatOutput = (text: string, synthetic = true) => ({
  message: {
    id: "parent-user-injection-1",
    role: "user" as const,
    sessionID: "parent-1",
  },
  parts: [
    {
      id: "parent-part-injection-1",
      messageID: "parent-user-injection-1",
      sessionID: "parent-1",
      synthetic,
      text,
      type: "text" as const,
    },
  ],
});

const editPermission = (
  id: string,
  paths: string[],
  callID = `${id}-call`,
  messageID = `${id}-assistant`
): OpenCodePermissionRequest => ({
  always: ["*"],
  id,
  metadata: {},
  patterns: paths,
  permission: "edit",
  sessionID: "child-1",
  tool: { callID, messageID },
});

const permissionToolMessage = (
  request: OpenCodePermissionRequest,
  toolName = "write"
): OpenCodeMessageRecord => {
  const tool = request.tool;
  if (tool === undefined) {
    throw new Error("A structured-write permission fixture requires a tool.");
  }
  return {
    info: {
      finish: "tool-calls",
      id: tool.messageID,
      parentID: `${request.id}-user`,
      role: "assistant",
      sessionID: request.sessionID,
      time: { created: 1 },
    },
    parts: [
      {
        callID: tool.callID,
        id: `${tool.callID}-part`,
        messageID: tool.messageID,
        sessionID: request.sessionID,
        state: {
          input: {},
          metadata: {},
          status: "running",
          time: { start: 1 },
        },
        tool: toolName,
        type: "tool",
      },
    ],
  };
};

const setupBoundWorker = async (
  options: {
    bindWorker?: boolean;
    definitionInput?: WorkflowDefinition;
    fingerprint?: (directory: string) => Promise<Map<string, string | null>>;
    preserveLaunchPrompt?: boolean;
    readFile?: (file: string) => Promise<Uint8Array | string>;
    sessions?: FakeSessions;
    withGoal?: boolean;
  } = {}
) => {
  const definitionInput = options.definitionInput ?? definition;
  const directory = await mkdtemp(path.join(os.tmpdir(), "sol-server-task6-"));
  directories.push(directory);
  const store = new OrchestrationStore({
    now: () => timestamp,
    statePath: path.join(directory, "state-v2.json"),
  });
  await store.mutateRoot(({ goal, workflow }) => {
    const goalID = options.withGoal === true ? "goal-1" : undefined;
    if (goalID !== undefined) {
      goal.start({
        goal_id: goalID,
        objective: "Complete a user goal across multiple workflows.",
        orchestrator_agent_id: "sol",
        parent_session_id: "parent-1",
      });
      workflow.start({
        definition: {
          objective: "Complete the first bounded workflow.",
          steps: [
            {
              dependsOn: [],
              jobs: [
                {
                  actor: { type: "orchestrator" },
                  dependsOn: [],
                  name: "finish first",
                  objective: "Finish the first workflow.",
                },
              ],
              name: "first",
              objective: "First workflow.",
            },
          ],
        },
        goal_id: goalID,
        orchestrator_agent_id: "sol",
        parent_session_id: "parent-1",
        workflow_id: "workflow-0",
      });
      workflow.completeJob({
        job: "finish first",
        message: "First workflow complete.",
        workflow_id: "workflow-0",
      });
    }
    workflow.start({
      definition: definitionInput,
      ...(goalID === undefined ? {} : { goal_id: goalID }),
      orchestrator_agent_id: "sol",
      parent_session_id: "parent-1",
      workflow_id: "workflow-1",
    });
  });
  const sessions = options.sessions ?? new FakeSessions();
  const runtime = createDefaultServerRuntime({
    client: { session: {} },
    directory: "/workspace",
    options: {
      create_id: () => "internal-id",
      ...(options.fingerprint === undefined
        ? {}
        : { fingerprint: options.fingerprint }),
      now: () => timestamp,
      ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
      sessionAdapter: sessions,
      store,
    },
  });
  if (options.bindWorker ?? true) {
    await runtime.workflowService.status(
      {},
      { agent: "sol", parent_session_id: "parent-1" }
    );
    if (options.preserveLaunchPrompt !== true) {
      sessions.prompts.splice(0);
      sessions.promptAttempts = 0;
    }
  }
  return { runtime, sessions, store };
};

const workflowJobState = async (store: OrchestrationStore) =>
  await store.readWorkflow((workflow) =>
    workflow.jobState({
      job: "implement worker lifecycle",
      workflow_id: "workflow-1",
    })
  );

const parentAssistant = (
  id: string,
  input: {
    error?: Record<string, unknown>;
    finish?: string;
  } = {}
): OpenCodeMessageRecord => ({
  info: {
    agent: "sol",
    ...(input.error === undefined ? {} : { error: input.error }),
    finish: input.finish ?? "stop",
    id,
    parentID: "parent-user-1",
    role: "assistant",
    sessionID: "parent-1",
    time: { completed: 2, created: 1 },
  },
  parts: [
    {
      id: `${id}-part`,
      messageID: id,
      sessionID: "parent-1",
      text: "I am stopping this ordinary turn before the goal is complete.",
      type: "text",
    },
  ],
});

const messageUpdated = (message: OpenCodeMessageRecord) => ({
  properties: { info: message.info },
  type: "message.updated",
});

const setupGoalSession = async (sessions = new FakeSessions()) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sol-server-goal-"));
  directories.push(directory);
  const store = new OrchestrationStore({
    now: () => timestamp,
    statePath: path.join(directory, "state-v2.json"),
  });
  await store.mutateGoal((goal) => {
    goal.start({
      goal_id: "goal-1",
      objective: "Deliver the complete user outcome across needed workflows.",
      orchestrator_agent_id: "sol",
      parent_session_id: "parent-1",
    });
  });
  sessions.sessionRecords.set("parent-1", sessionRecord("parent-1", "root"));
  sessions.statuses["parent-1"] = { type: "idle" };
  const runtime = createDefaultServerRuntime({
    client: { session: {} },
    directory: "/workspace",
    options: {
      create_id: () => "internal-id",
      now: () => timestamp,
      sessionAdapter: sessions,
      store,
    },
  });
  const plugin = await SolOrchestratorPlugin(
    { client: { session: {} }, directory: "/workspace" },
    { runtime }
  );
  return { plugin, runtime, sessions, store };
};

describe("Task 6 server lifecycle", () => {
  test("initializes an empty root without calling instance session APIs", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sol-server-empty-")
    );
    directories.push(directory);
    const store = new OrchestrationStore({
      statePath: path.join(directory, "state-v2.json"),
    });
    const sessions = new FakeSessions();
    const runtime = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: { sessionAdapter: sessions, store },
    });

    await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );

    expect(sessions.permissionListCalls).toBe(0);
  });

  test("discovers configured OpenCode subagent profiles without owning their models", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sol-server-profiles-")
    );
    directories.push(directory);
    const store = new OrchestrationStore({
      statePath: path.join(directory, "state-v2.json"),
    });
    const sessions = new FakeSessions();
    const runtime = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: { sessionAdapter: sessions, store },
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const config: Record<string, unknown> = {
      agent: {
        "local-verifier": {
          description: "Cheap local verification profile",
          mode: "subagent",
          model: "local/inexpensive-model",
          variant: "careful",
        },
      },
    };

    await plugin.config?.(config);

    expect(runtime.availableWorkerProfiles()).toContainEqual({
      description: "Cheap local verification profile",
      profile: "local-verifier",
    });
    expect(
      (config.agent as Record<string, Record<string, unknown>>)[
        "local-verifier"
      ]
    ).toMatchObject({
      model: "local/inexpensive-model",
      variant: "careful",
    });
    expect(
      (config.agent as Record<string, Record<string, unknown>>).sol
    ).not.toHaveProperty("model");
    expect(
      (
        await runtime.workflowService.status(
          {},
          {
            agent: "sol",
            parent_session_id: "parent-1",
          }
        )
      ).available_workers
    ).toContainEqual({
      description: "Cheap local verification profile",
      profile: "local-verifier",
    });
  });

  test("config recovery automatically launches persisted ready workers once", async () => {
    const { runtime, sessions } = await setupBoundWorker({ bindWorker: false });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );

    await plugin.config?.({});
    await plugin.config?.({});
    await settlePluginRecovery(plugin);

    expect(await workflowJobState(runtime.store)).toMatchObject({
      state: "active",
      task_id: "child-1",
    });
    expect(sessions.prompts).toHaveLength(1);
  });

  test("returns plugin hooks before non-empty restart reconciliation calls OpenCode", async () => {
    const { runtime, sessions } = await setupBoundWorker();
    let releaseStatus: (() => void) | undefined;
    sessions.statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    sessions.statusCalls = 0;

    const plugin = SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );

    expect(plugin.tool.workflow_status).toBeDefined();
    expect(sessions.statusCalls).toBe(0);

    releaseStatus?.();
    await settlePluginRecovery(plugin);

    expect(sessions.statusCalls).toBeGreaterThan(0);
  });

  test("composes the five workflow tools and installs bound worker permissions through the validated adapter seam", async () => {
    const { runtime, sessions } = await setupBoundWorker();

    expect(Object.keys(runtime.workflowTools).sort()).toEqual([
      "workflow_complete",
      "workflow_replace",
      "workflow_retry",
      "workflow_start",
      "workflow_status",
    ]);
    expect(sessions.appended).toEqual([
      {
        rules: [
          ...managedWorkerPermissionRules,
          { action: "allow", pattern: "*", permission: "edit" },
        ],
        sessionID: "child-1",
      },
    ]);
  });

  test("registers user-only goal stop and clears every associated workflow only after worker abort", async () => {
    const { runtime, sessions, store } = await setupBoundWorker({
      withGoal: true,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const config: Record<string, unknown> = {};
    await plugin.config?.(config);
    expect(config).toMatchObject({
      command: {
        "goal-stop": {
          description: expect.any(String),
          template: expect.any(String),
        },
      },
    });
    expect(plugin.tool.goal_stop).toBeUndefined();
    const before = plugin["command.execute.before"];
    if (before === undefined) {
      throw new Error("The user-only goal command hook must be registered.");
    }
    const output = { parts: [{ text: "configured template", type: "text" }] };

    await before(
      { arguments: "", command: "goal-stop", sessionID: "parent-1" },
      output
    );

    expect(sessions.aborts).toEqual(["child-1"]);
    expect(output.parts).toEqual([
      {
        text: expect.stringMatching(ALREADY_CLEARED_PATTERN),
        type: "text",
      },
    ]);
    const root = await store.readRoot();
    expect(root.goals.goals).toEqual([]);
    expect(root.workflows.workflows).toEqual([]);
    expect(root.job_runs).toEqual([]);
    expect(root.workers).toEqual([]);
    expect(root.turns).toEqual([]);
    expect(root.deliveries).toEqual([]);
    expect(root.permissions).toEqual([]);
  });

  test("starts a durable goal directly from the explicit user command before Sol runs", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sol-goal-command-")
    );
    directories.push(directory);
    const store = new OrchestrationStore({
      now: () => timestamp,
      statePath: path.join(directory, "state-v2.json"),
    });
    const sessions = new FakeSessions();
    const runtime = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "goal-from-command",
        now: () => timestamp,
        sessionAdapter: sessions,
        store,
      },
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["command.execute.before"];
    if (before === undefined) {
      throw new Error("The explicit goal command hook must be registered.");
    }
    const output = { parts: [{ text: "raw objective", type: "text" }] };

    await before(
      {
        arguments: "Deliver the complete multi-workflow outcome",
        command: "goal",
        sessionID: "parent-1",
      },
      output
    );

    expect((await store.readRoot()).goals.goals).toEqual([
      expect.objectContaining({
        goal_id: "goal-from-command",
        objective: "Deliver the complete multi-workflow outcome",
        status: "active",
      }),
    ]);
    expect(output.parts).toEqual([
      {
        text: expect.stringMatching(ALREADY_PERSISTED_PATTERN),
        type: "text",
      },
    ]);
    const absentOutput = {
      parts: [{ text: "configured template", type: "text" }],
    };
    await before(
      { arguments: "   ", command: "goal", sessionID: "parent-2" },
      absentOutput
    );
    expect(absentOutput.parts[0]?.text).toMatch(GOAL_STATUS_PATTERN);
    expect(absentOutput.parts[0]?.text).toContain("No durable goal");

    const activeOutput = {
      parts: [{ text: "configured template", type: "text" }],
    };
    await before(
      { arguments: "", command: "goal", sessionID: "parent-1" },
      activeOutput
    );
    expect(activeOutput.parts[0]?.text).toMatch(GOAL_STATUS_PATTERN);
    expect(activeOutput.parts[0]?.text).toContain(
      "Deliver the complete multi-workflow outcome"
    );
    expect(JSON.stringify(activeOutput)).not.toContain("goal-from-command");
  });

  test("keeps the complete goal scope when an associated worker cannot be aborted", async () => {
    const sessions = new FakeSessions();
    sessions.abortFailure = new Error("Native abort failed.");
    const { runtime, store } = await setupBoundWorker({
      sessions,
      withGoal: true,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["command.execute.before"];
    if (before === undefined) {
      throw new Error("The user-only goal command hook must be registered.");
    }

    await expect(
      before(
        { arguments: "", command: "goal-stop", sessionID: "parent-1" },
        { parts: [{ text: "configured template", type: "text" }] }
      )
    ).rejects.toThrow("Native abort failed.");

    const root = await store.readRoot();
    expect(root.goals.goals).toHaveLength(1);
    expect(
      root.workflows.workflows.map((workflow) => workflow.workflow_id)
    ).toEqual(["workflow-0", "workflow-1"]);
    expect(root.workers).toHaveLength(1);
  });

  test("registers an exact report_to_parent schema with no completion, files, evidence, or correlation fields", async () => {
    const { runtime } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const report = plugin.tool.report_to_parent;
    if (report === undefined) {
      throw new Error("report_to_parent must be registered.");
    }
    const schema = z.object(report.args).strict();

    expect(
      schema.parse({ kind: "progress", message: "Focused RED exists." })
    ).toEqual({
      kind: "progress",
      message: "Focused RED exists.",
    });
    expect(
      schema.parse({ kind: "blocker", message: "Owner decision needed." })
    ).toEqual({
      kind: "blocker",
      message: "Owner decision needed.",
    });
    for (const invalid of [
      { kind: "completion", message: "Done." },
      { files: ["src/server.ts"], kind: "progress", message: "Working." },
      { kind: "progress", message: "Working.", prompt_id: "prompt-1" },
      { evidence: [], kind: "progress", message: "Working." },
      { kind: "progress", message: "Working.", needs_decision: false },
    ]) {
      expect(() => schema.parse(invalid)).toThrow();
    }
  });

  test("keeps progress active and returns no internal correlation or result content", async () => {
    const { runtime, store } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const report = plugin.tool.report_to_parent;
    if (report === undefined) {
      throw new Error("report_to_parent must be registered.");
    }

    const output = String(
      await report.execute(
        {
          kind: "progress",
          message: "The lifecycle owner now has a complete RED set.",
        },
        context("child-1", "terra-medium")
      )
    );

    expect(JSON.parse(output)).toEqual({
      accepted: true,
      kind: "progress",
      terminal: false,
    });
    expect(output).not.toMatch(INTERNAL_OUTPUT_PATTERN);
    expect((await workflowJobState(store))?.state).toBe("active");
  });

  test("blocks on a blocker report and aborts only after tool.execute.after returns", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const deferred: Array<() => void | Promise<void>> = [];
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      {
        defer: (operation) => deferred.push(operation),
        runtime,
      }
    );
    const report = plugin.tool.report_to_parent;
    const after = plugin["tool.execute.after"];
    if (report === undefined || after === undefined) {
      throw new Error("Task 6 report and after-hook must be registered.");
    }

    await report.execute(
      { kind: "blocker", message: "The runtime contract changed." },
      context("child-1", "terra-medium")
    );
    await after(
      {
        args: { kind: "blocker", message: "The runtime contract changed." },
        callID: "report-call-1",
        sessionID: "child-1",
        tool: "report_to_parent",
      },
      { metadata: {}, output: "accepted", title: "Report" }
    );

    expect((await workflowJobState(store))?.state).toBe("blocked");
    expect(sessions.aborts).toEqual([]);
    expect(deferred).toHaveLength(1);
    await deferred[0]?.();
    expect(sessions.aborts).toEqual(["child-1"]);
  });

  test("moves a completed assistant message to review once even when OpenCode repeats the event", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const event = plugin.event;
    if (event === undefined) {
      throw new Error("The lifecycle event hook must be registered.");
    }
    sessions.messageRecords.set("child-1", [
      {
        info: {
          id: "worker-user-1",
          role: "user",
          sessionID: "child-1",
          time: { created: 1 },
        },
        parts: [],
      },
      {
        info: {
          finish: "stop",
          id: "assistant-final-1",
          parentID: "worker-user-1",
          role: "assistant",
          sessionID: "child-1",
          time: { completed: 2, created: 1 },
        },
        parts: [
          {
            id: "part-final-1",
            messageID: "assistant-final-1",
            sessionID: "child-1",
            text: "identical final result text",
            type: "text",
          },
        ],
      },
    ]);
    const finalEvent = {
      properties: {
        info: {
          finish: "stop",
          id: "assistant-final-1",
          role: "assistant" as const,
          sessionID: "child-1",
          text: "identical final result text",
          time: { completed: 2, created: 1 },
        },
      },
      type: "message.updated" as const,
    };

    await event({ event: finalEvent });
    await event({ event: finalEvent });

    expect((await workflowJobState(store))?.state).toBe("review");
    const root = await store.readRoot();
    expect(root.job_runs[0]).toMatchObject({
      result_available: true,
      state: "review",
    });
    expect(root.workers[0]?.latest_event).toMatchObject({
      kind: "result",
      result_message_id: "assistant-final-1",
      sequence: 1,
    });
    expect(root.turns).toHaveLength(1);
    expect(root.turns[0]).toMatchObject({
      boundary_message_id: "worker-user-1",
      result_available: true,
      result_message_id: "assistant-final-1",
      turn: 1,
    });
    expect(JSON.stringify(root)).not.toContain("identical final result text");
  });

  test("does not treat intermediate tool-call, stop-with-tool, or summary messages as final results", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const event = plugin.event;
    if (event === undefined) {
      throw new Error("The lifecycle event hook must be registered.");
    }
    sessions.messageRecords.set("child-1", [
      {
        info: {
          finish: "stop",
          id: "assistant-stop-with-tool",
          role: "assistant",
          sessionID: "child-1",
          time: { completed: 4, created: 3 },
        },
        parts: [
          {
            id: "part-tool-1",
            messageID: "assistant-stop-with-tool",
            metadata: { providerExecuted: false },
            sessionID: "child-1",
            type: "tool",
          },
        ],
      },
    ]);
    const assistantEvent = (input: {
      finish: string;
      id: string;
      summary?: boolean;
    }) => ({
      properties: {
        info: {
          finish: input.finish,
          id: input.id,
          role: "assistant" as const,
          sessionID: "child-1",
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          time: { completed: 2, created: 1 },
        },
      },
      type: "message.updated" as const,
    });

    await event({
      event: assistantEvent({
        finish: "tool-calls",
        id: "assistant-tool-call",
      }),
    });
    await event({
      event: assistantEvent({
        finish: "stop",
        id: "assistant-stop-with-tool",
      }),
    });
    await event({
      event: assistantEvent({
        finish: "stop",
        id: "assistant-summary",
        summary: true,
      }),
    });

    expect((await workflowJobState(store))?.state).toBe("active");
    expect((await store.readRoot()).workers[0]?.latest_event).toBeNull();
  });

  test("agents_interrupt aborts the owned child and durably blocks the job", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const interrupt = plugin.tool.agents_interrupt;
    if (interrupt === undefined) {
      throw new Error("agents_interrupt must be registered.");
    }

    const output = String(
      await interrupt.execute(
        {
          job: "implement worker lifecycle",
          reason: "The owning decision changed.",
        },
        context("parent-1", "sol")
      )
    );

    expect(JSON.parse(output)).toEqual({
      interrupted: true,
      job: "implement worker lifecycle",
    });
    expect(sessions.aborts).toEqual(["child-1"]);
    expect((await workflowJobState(store))?.state).toBe("blocked");
    expect(output).not.toMatch(INTERRUPT_INTERNAL_PATTERN);
  });

  test("preserves a completed worker result when final history races permanent interrupt", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    sessions.statuses = { "child-1": { type: "idle" } };
    sessions.messageRecords.set("child-1", [
      {
        info: {
          id: "worker-user-before-interrupt",
          role: "user",
          sessionID: "child-1",
          time: { created: 1 },
        },
        parts: [],
      },
      {
        info: {
          finish: "stop",
          id: "worker-final-before-interrupt",
          parentID: "worker-user-before-interrupt",
          role: "assistant",
          sessionID: "child-1",
          time: { completed: 3, created: 2 },
        },
        parts: [
          {
            id: "worker-final-before-interrupt-part",
            messageID: "worker-final-before-interrupt",
            sessionID: "child-1",
            text: "Useful completed result.",
            type: "text",
          },
        ],
      },
    ]);
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const interrupt = plugin.tool.agents_interrupt;
    if (interrupt === undefined) {
      throw new Error("agents_interrupt must be registered.");
    }

    const output = JSON.parse(
      String(
        await interrupt.execute(
          {
            job: "implement worker lifecycle",
            reason: "Stop only if work is still running.",
          },
          context("parent-1", "sol")
        )
      )
    );

    expect(output).toEqual({
      completed: true,
      interrupted: false,
      job: "implement worker lifecycle",
    });
    expect(sessions.aborts).toEqual([]);
    expect((await workflowJobState(store))?.state).toBe("review");
    expect((await store.readRoot()).workers[0]?.latest_event).toMatchObject({
      kind: "result",
      result_message_id: "worker-final-before-interrupt",
    });
  });

  test("wakes an idle goal parent when a worker final becomes reviewable", async () => {
    const { runtime, sessions, store } = await setupBoundWorker({
      withGoal: true,
    });
    sessions.sessionRecords.set("parent-1", sessionRecord("parent-1", "root"));
    sessions.statuses["parent-1"] = { type: "idle" };
    const parent = parentAssistant("msg_parent_before_worker_final");
    sessions.messageRecords.set("parent-1", [parent]);
    sessions.messageRecords.set("child-1", [
      {
        info: {
          id: "worker-user-final-wake",
          role: "user",
          sessionID: "child-1",
          time: { created: 1 },
        },
        parts: [],
      },
      {
        info: {
          finish: "stop",
          id: "worker-final-wake",
          parentID: "worker-user-final-wake",
          role: "assistant",
          sessionID: "child-1",
          time: { completed: 3, created: 2 },
        },
        parts: [
          {
            id: "worker-final-wake-part",
            messageID: "worker-final-wake",
            sessionID: "child-1",
            text: "Bounded final result.",
            type: "text",
          },
        ],
      },
    ]);
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );

    await plugin.event?.({
      event: {
        properties: {
          info: {
            finish: "stop",
            id: "worker-final-wake",
            parentID: "worker-user-final-wake",
            role: "assistant",
            sessionID: "child-1",
            time: { completed: 3, created: 2 },
          },
        },
        type: "message.updated",
      },
    });

    expect((await workflowJobState(store))?.state).toBe("review");
    expect(sessions.promptAttempts).toBe(1);
    expect(sessions.prompts[0]?.sessionID).toBe("parent-1");
  });

  test("reconciles an idle bound child with one completed assistant message after restart", async () => {
    const { sessions, store } = await setupBoundWorker();
    sessions.statuses = { "child-1": { type: "idle" } };
    sessions.messageRecords.set("child-1", [
      {
        info: {
          id: "worker-user-1",
          role: "user",
          sessionID: "child-1",
        },
        parts: [],
      },
      {
        info: {
          finish: "stop",
          id: "assistant-final-restart",
          role: "assistant",
          sessionID: "child-1",
          time: { completed: 2, created: 1 },
        },
        parts: [
          {
            id: "part-final-restart",
            messageID: "assistant-final-restart",
            sessionID: "child-1",
            text: "Full result remains only in child history.",
            type: "text",
          },
        ],
      },
    ]);
    const restarted = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "new-internal-id",
        now: () => timestamp,
        sessionAdapter: sessions,
        store,
      },
    });

    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime: restarted }
    );
    await settlePluginRecovery(plugin);

    expect((await workflowJobState(store))?.state).toBe("review");
    expect(JSON.stringify(await store.readRoot())).not.toContain(
      "Full result remains only in child history."
    );
  });

  test("adds persistence warnings only to object-shaped JSON tool output", () => {
    const warning = {
      durable: false as const,
      reason: "write_failed" as const,
      state_path: "/tmp/state-v2.json",
      status: "degraded" as const,
    };
    expect(
      JSON.parse(withPersistenceWarning('{"accepted":true}', warning))
    ).toEqual({ accepted: true, persistence_warning: warning });
    expect(withPersistenceWarning("plain text", warning)).toBe("plain text");
  });
});

describe("binding workflow enforcement", () => {
  const solWorkDefinition: WorkflowDefinition = {
    objective: "Perform one bounded Sol-owned change.",
    steps: [
      {
        dependsOn: [],
        jobs: [
          {
            actor: { type: "orchestrator" },
            dependsOn: [],
            name: "make bounded change",
            objective: "Make the authored bounded change.",
          },
        ],
        name: "change",
        objective: "Complete the bounded change.",
      },
    ],
  };

  test("allows read-only orientation but rejects structured mutation before a workflow exists", async () => {
    const { plugin } = await setupGoalSession();
    const before = plugin["tool.execute.before"];
    if (before === undefined) {
      throw new Error("Workflow enforcement hook must be registered.");
    }

    await expect(
      before(
        { callID: "orientation-read", sessionID: "parent-1", tool: "read" },
        { args: { filePath: "src/server.ts" } }
      )
    ).resolves.toBeUndefined();
    await expect(
      before(
        { callID: "premature-edit", sessionID: "parent-1", tool: "edit" },
        { args: { filePath: "src/server.ts" } }
      )
    ).rejects.toThrow(WORKFLOW_REQUIRED_PATTERN);
  });

  test("binds consequential execution without imprisoning read-only reasoning", async () => {
    const { runtime } = await setupBoundWorker({ bindWorker: false });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["tool.execute.before"];
    if (before === undefined) {
      throw new Error("Workflow enforcement hook must be registered.");
    }

    await expect(
      before(
        { callID: "free-read", sessionID: "parent-1", tool: "read" },
        { args: { filePath: "src/server.ts" } }
      )
    ).resolves.toBeUndefined();
    await expect(
      before(
        { callID: "unowned-edit", sessionID: "parent-1", tool: "edit" },
        { args: { filePath: "src/server.ts" } }
      )
    ).rejects.toThrow(WORKFLOW_BINDING_PATTERN);
    await expect(
      before(
        {
          callID: "replace-contract",
          sessionID: "parent-1",
          tool: "workflow_replace",
        },
        { args: { reason: "Evidence changed the hierarchy.", steps: [] } }
      )
    ).resolves.toBeUndefined();
  });

  test("allows substantive parent tools through an active Sol-owned job", async () => {
    const { runtime } = await setupBoundWorker({
      bindWorker: false,
      definitionInput: solWorkDefinition,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["tool.execute.before"];
    if (before === undefined) {
      throw new Error("Workflow enforcement hook must be registered.");
    }

    await expect(
      before(
        { callID: "owned-edit", sessionID: "parent-1", tool: "edit" },
        { args: { filePath: "src/server.ts" } }
      )
    ).resolves.toBeUndefined();
  });

  test("rejects native task bypass after a workflow is created", async () => {
    const { runtime } = await setupBoundWorker({
      bindWorker: false,
      definitionInput: solWorkDefinition,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["tool.execute.before"];
    if (before === undefined) {
      throw new Error("Workflow enforcement hook must be registered.");
    }

    await expect(
      before(
        { callID: "native-task", sessionID: "parent-1", tool: "task" },
        { args: { subagent_type: "luna-medium" } }
      )
    ).rejects.toThrow(AUTOMATIC_GRAPH_LAUNCH_PATTERN);
  });
});

describe("native active-goal continuation", () => {
  test("continues one normal terminal Sol message exactly once across duplicate native events", async () => {
    const { plugin, sessions } = await setupGoalSession();
    const assistant = parentAssistant("msg_parent_final_1");
    sessions.messageRecords.set("parent-1", [assistant]);

    await plugin.event?.({ event: messageUpdated(assistant) });
    await plugin.event?.({ event: messageUpdated(assistant) });
    await plugin.event?.({
      event: { properties: { sessionID: "parent-1" }, type: "session.idle" },
    });
    await plugin.event?.({
      event: {
        properties: { sessionID: "parent-1", status: { type: "idle" } },
        type: "session.status",
      },
    });

    expect(sessions.promptAttempts).toBe(1);
    expect(sessions.prompts).toHaveLength(1);
    expect(sessions.prompts[0]).toMatchObject({
      agent: "sol",
      sessionID: "parent-1",
    });
    expect(sessions.prompts[0]?.text).toMatch(WORKFLOW_STATUS_FIRST_PATTERN);
    expect(sessions.prompts[0]?.text).toContain(
      "Deliver the complete user outcome across needed workflows."
    );
  });

  test("coalesces concurrently delivered terminal callbacks before prompt submission", async () => {
    const { plugin, sessions } = await setupGoalSession();
    const assistant = parentAssistant("msg_parent_concurrent");
    sessions.messageRecords.set("parent-1", [assistant]);
    let releasePrompt: (() => void) | undefined;
    sessions.promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });

    const callbacks = Promise.all([
      plugin.event?.({ event: messageUpdated(assistant) }),
      plugin.event?.({ event: messageUpdated(assistant) }),
      plugin.event?.({ event: messageUpdated(assistant) }),
    ]);
    for (
      let attempt = 0;
      attempt < 100 && sessions.promptAttempts === 0;
      attempt += 1
    ) {
      await sleep(5);
    }
    releasePrompt?.();
    await callbacks;

    expect(sessions.promptAttempts).toBe(1);
  });

  test("appends at the terminal assistant boundary even while native status still says busy", async () => {
    const { plugin, sessions } = await setupGoalSession();
    const assistant = parentAssistant("msg_parent_final_2");
    sessions.messageRecords.set("parent-1", [assistant]);
    sessions.statuses["parent-1"] = { type: "busy" };

    await plugin.event?.({ event: messageUpdated(assistant) });
    expect(sessions.promptAttempts).toBe(1);

    sessions.statuses["parent-1"] = { type: "idle" };
    await plugin.event?.({
      event: { properties: { sessionID: "parent-1" }, type: "session.idle" },
    });
    expect(sessions.promptAttempts).toBe(1);
  });

  test.each([
    { error: { name: "MessageAbortedError" }, finish: "stop" },
    { error: { name: "ProviderError" }, finish: "stop" },
    { finish: "content-filter" },
  ])("does not fight terminal error or user abort %#", async (terminal) => {
    const { plugin, sessions } = await setupGoalSession();
    const assistant = parentAssistant("msg_parent_terminal_error", terminal);
    sessions.messageRecords.set("parent-1", [assistant]);

    await plugin.event?.({ event: messageUpdated(assistant) });
    await plugin.event?.({
      event: { properties: { sessionID: "parent-1" }, type: "session.idle" },
    });

    expect(sessions.promptAttempts).toBe(0);
  });

  test("records one failed prompt submission and never retries the same assistant", async () => {
    const sessions = new FakeSessions();
    sessions.promptFailure = new Error("Native prompt failed.");
    const { plugin, store } = await setupGoalSession(sessions);
    const assistant = parentAssistant("msg_parent_final_failed");
    sessions.messageRecords.set("parent-1", [assistant]);

    await plugin.event?.({ event: messageUpdated(assistant) });
    await plugin.event?.({
      event: { properties: { sessionID: "parent-1" }, type: "session.idle" },
    });

    expect(sessions.promptAttempts).toBe(1);
    expect((await store.readRoot()).goals.goals[0]?.continuation).toMatchObject(
      {
        assistant_message_id: "msg_parent_final_failed",
        state: "failed",
      }
    );
  });

  test("keeps Sol live while an associated worker remains active", async () => {
    const { runtime, sessions } = await setupBoundWorker({ withGoal: true });
    sessions.sessionRecords.set("parent-1", sessionRecord("parent-1", "root"));
    sessions.statuses["parent-1"] = { type: "idle" };
    const assistant = parentAssistant("msg_parent_with_worker");
    sessions.messageRecords.set("parent-1", [assistant]);
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );

    await plugin.event?.({ event: messageUpdated(assistant) });

    expect(sessions.promptAttempts).toBe(1);
    expect(sessions.statuses["child-1"]?.type).toBe("busy");
  });

  test("restores one reserved continuation after plugin restart without duplicating an accepted prompt", async () => {
    const sessions = new FakeSessions();
    const { store } = await setupGoalSession(sessions);
    const assistant = parentAssistant("msg_restart_assistant");
    sessions.messageRecords.set("parent-1", [assistant]);
    await store.mutateGoal((goal) => {
      goal.reserveContinuation({
        assistant_message_id: "msg_restart_assistant",
        goal_id: "goal-1",
        prompt_message_id: "msg_019f00000000restart0000000",
      });
    });
    const runtime = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "restart-id",
        now: () => timestamp,
        sessionAdapter: sessions,
        store,
      },
    });

    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    await settlePluginRecovery(plugin);
    expect(sessions.promptAttempts).toBe(1);
    expect(sessions.prompts[0]?.messageID).toBe(
      "msg_019f00000000restart0000000"
    );

    const restarted = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "second-restart-id",
        now: () => timestamp,
        sessionAdapter: sessions,
        store,
      },
    });
    const restartedPlugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime: restarted }
    );
    await settlePluginRecovery(restartedPlugin);
    expect(sessions.promptAttempts).toBe(1);
  });

  test("lets a blocked goal finish the current Sol turn without continuation", async () => {
    const { plugin, sessions } = await setupGoalSession();
    const block = plugin.tool.goal_block;
    if (block === undefined) {
      throw new Error("goal_block must be registered for Sol.");
    }
    await block.execute(
      { message: "A user decision is required." },
      context("parent-1", "sol")
    );
    const assistant = parentAssistant("msg_blocked_final");
    sessions.messageRecords.set("parent-1", [assistant]);

    await plugin.event?.({ event: messageUpdated(assistant) });
    await plugin.event?.({
      event: { properties: { sessionID: "parent-1" }, type: "session.idle" },
    });

    expect(sessions.promptAttempts).toBe(0);
  });

  test("wakes an idle goal parent once when a worker reports meaningful progress", async () => {
    const { runtime, sessions } = await setupBoundWorker({ withGoal: true });
    sessions.sessionRecords.set("parent-1", sessionRecord("parent-1", "root"));
    sessions.statuses["parent-1"] = { type: "idle" };
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const assistant = parentAssistant("msg_parent_before_progress");
    sessions.messageRecords.set("parent-1", [assistant]);
    const report = plugin.tool.report_to_parent;
    if (report === undefined) {
      throw new Error("report_to_parent must be registered.");
    }

    await report.execute(
      { kind: "progress", message: "The worker found a contract conflict." },
      context("child-1", "terra-medium")
    );

    expect(sessions.promptAttempts).toBe(1);
    expect(sessions.prompts[0]?.sessionID).toBe("parent-1");
  });

  test("does not append a worker-progress wake while Sol is genuinely busy", async () => {
    const { runtime, sessions } = await setupBoundWorker({ withGoal: true });
    sessions.sessionRecords.set("parent-1", sessionRecord("parent-1", "root"));
    sessions.statuses["parent-1"] = { type: "busy" };
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const assistant = parentAssistant("msg_parent_before_busy_progress");
    sessions.messageRecords.set("parent-1", [assistant]);
    const report = plugin.tool.report_to_parent;
    if (report === undefined) {
      throw new Error("report_to_parent must be registered.");
    }

    await report.execute(
      { kind: "progress", message: "The worker found a contract conflict." },
      context("child-1", "terra-medium")
    );

    expect(sessions.promptAttempts).toBe(0);
  });

  test("never continues or mutates another parent session's goal", async () => {
    const { plugin, sessions, store } = await setupGoalSession();
    await store.mutateGoal((goal) => {
      goal.start({
        goal_id: "goal-2",
        objective: "A separate user's goal.",
        orchestrator_agent_id: "sol",
        parent_session_id: "parent-2",
      });
    });
    sessions.sessionRecords.set("parent-2", sessionRecord("parent-2", "root"));
    sessions.statuses["parent-2"] = { type: "idle" };
    const assistant = parentAssistant("msg_parent_isolated");
    sessions.messageRecords.set("parent-1", [assistant]);

    await plugin.event?.({ event: messageUpdated(assistant) });

    expect(sessions.prompts.map((prompt) => prompt.sessionID)).toEqual([
      "parent-1",
    ]);
    const roots = await store.readRoot();
    expect(
      roots.goals.goals.find((goal) => goal.goal_id === "goal-2")?.continuation
    ).toBeNull();
  });
});

describe("Task 7 pull-based worker controls", () => {
  test("projects native provider retries as status without inventing a worker message", async () => {
    const { runtime, store } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );

    await plugin.event?.({
      event: {
        properties: {
          sessionID: "child-1",
          status: {
            attempt: 2,
            message: "Provider request failed and will be retried.",
            next: Date.parse("2026-07-17T12:00:05.000Z"),
            type: "retry",
          },
        },
        type: "session.status",
      },
    });

    const worker = (await store.readRoot()).workers[0];
    expect(worker).toMatchObject({
      latest_event: null,
      live_state: "retrying",
    });
  });
  test("registers exact status, inspect, and wait schemas without cursors or transcript arguments", async () => {
    const { runtime } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const status = plugin.tool.agents_status;
    const inspect = plugin.tool.agents_inspect;
    const wait = plugin.tool.agents_wait;
    if (status === undefined || inspect === undefined || wait === undefined) {
      throw new Error("Task 7 worker controls must be registered.");
    }

    const statusSchema = z.object(status.args).strict();
    const inspectSchema = z.object(inspect.args).strict();
    const waitSchema = z.object(wait.args).strict();
    expect(statusSchema.parse({})).toEqual({});
    expect(statusSchema.parse({ job: "implement worker lifecycle" })).toEqual({
      job: "implement worker lifecycle",
    });
    expect(
      inspectSchema.parse({ job: "implement worker lifecycle", type: "result" })
    ).toEqual({ job: "implement worker lifecycle", type: "result" });
    expect(
      waitSchema.parse({
        jobs: ["implement worker lifecycle"],
        timeout_ms: 30_000,
        until: "all",
      })
    ).toEqual({
      jobs: ["implement worker lifecycle"],
      timeout_ms: 30_000,
      until: "all",
    });
    for (const invalid of [
      { after: "cursor", jobs: ["implement worker lifecycle"] },
      { consume_through: "cursor", jobs: ["implement worker lifecycle"] },
      { timeout_ms: 0 },
      { timeout_ms: 120_001 },
    ]) {
      expect(() => waitSchema.parse(invalid)).toThrow();
    }
    expect(() =>
      inspectSchema.parse({
        job: "implement worker lifecycle",
        transcript: true,
        type: "result",
      })
    ).toThrow();
    expect(() =>
      inspectSchema.parse({
        job: "implement worker lifecycle",
        limit: 12_000,
        type: "result",
      })
    ).toThrow();
    expect(() =>
      inspectSchema.parse({
        job: "implement worker lifecycle",
        offset: 1,
        type: "result",
      })
    ).toThrow();
  });

  test("serves metadata by default and makes selected content searchable through agents_inspect metadata", async () => {
    const { runtime, sessions } = await setupBoundWorker();
    const resultSentinel = "SELECTED RESULT BODY SENTINEL";
    const toolSentinel = "SELECTED TOOL BODY SENTINEL";
    sessions.messageRecords.set("child-1", [
      {
        info: {
          id: "user-turn-1",
          role: "user",
          sessionID: "child-1",
          time: { created: 1 },
        },
        parts: [],
      },
      {
        info: {
          finish: "tool-calls",
          id: "assistant-tool-1",
          parentID: "user-turn-1",
          role: "assistant",
          sessionID: "child-1",
          time: { completed: 2, created: 1 },
        },
        parts: [
          {
            callID: "call-internal-1",
            id: "part-tool-1",
            messageID: "assistant-tool-1",
            sessionID: "child-1",
            state: {
              input: {},
              metadata: {},
              output: toolSentinel,
              status: "completed",
              time: { end: 2, start: 1 },
              title: "Inspect source",
            },
            tool: "read",
            type: "tool",
          },
        ],
      },
      {
        info: {
          finish: "stop",
          id: "assistant-final-1",
          parentID: "user-turn-1",
          role: "assistant",
          sessionID: "child-1",
          time: { completed: 3, created: 2 },
        },
        parts: [
          {
            id: "part-result-1",
            messageID: "assistant-final-1",
            sessionID: "child-1",
            text: resultSentinel,
            type: "text",
          },
        ],
      },
    ]);
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const status = plugin.tool.agents_status;
    const inspect = plugin.tool.agents_inspect;
    if (status === undefined || inspect === undefined) {
      throw new Error("Task 7 worker controls must be registered.");
    }

    const metadata = String(
      await status.execute(
        { job: "implement worker lifecycle" },
        context("parent-1", "sol")
      )
    );
    expect(metadata).not.toContain(resultSentinel);
    expect(metadata).not.toContain(toolSentinel);
    expect(metadata).not.toMatch(INTERNAL_OUTPUT_PATTERN);
    expect(JSON.parse(metadata).worker).toMatchObject({
      job: "implement worker lifecycle",
      turn_count: 1,
    });

    const selected = String(
      await inspect.execute(
        { job: "implement worker lifecycle", type: "result" },
        context("parent-1", "sol")
      )
    );
    const selectedMetadata = JSON.parse(selected);
    expect(selectedMetadata).toMatchObject({
      artifact: {
        bytes: Buffer.byteLength(resultSentinel),
        file: "result.md",
      },
      turn: 1,
      type: "result",
    });
    expect(selected).not.toContain(resultSentinel);
    expect(await readFile(selectedMetadata.artifact.path, "utf8")).toBe(
      resultSentinel
    );
    await expect(
      inspect.execute(
        {
          file: "src/a.ts",
          job: "implement worker lifecycle",
          type: "result",
        },
        context("parent-1", "sol")
      )
    ).rejects.toThrow(INVALID_INSPECT_PATTERN);
  });

  test("agents_wait exposes bounded new events and keeps its watermark internal", async () => {
    const { runtime } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const report = plugin.tool.report_to_parent;
    const wait = plugin.tool.agents_wait;
    if (report === undefined || wait === undefined) {
      throw new Error("Task 7 wait and report controls must be registered.");
    }
    await report.execute(
      { kind: "progress", message: "One bounded wait event." },
      context("child-1", "terra-medium")
    );

    const output = String(
      await wait.execute(
        {
          jobs: ["implement worker lifecycle"],
          timeout_ms: 5,
          until: "any",
        },
        context("parent-1", "sol")
      )
    );
    expect(JSON.parse(output)).toMatchObject({
      timed_out: false,
      workers: [
        {
          latest_event: {
            kind: "progress",
            message: "One bounded wait event.",
          },
          job: "implement worker lifecycle",
        },
      ],
    });
    expect(output).not.toMatch(WAIT_INTERNAL_PATTERN);
  });
});

describe("Task 9 preemptive worker steering", () => {
  test("registers exact agents_send arguments and dispatches an actually idle worker once", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const send = plugin.tool.agents_send;
    if (send === undefined) {
      throw new Error("Task 9 agents_send must be registered.");
    }
    const schema = z.object(send.args).strict();
    expect(
      schema.parse({
        job: "implement worker lifecycle",
        message: "Use the corrected seam.",
      })
    ).toEqual({
      job: "implement worker lifecycle",
      message: "Use the corrected seam.",
    });
    for (const invalid of [
      {
        agent_type: "terra-medium",
        job: "implement worker lifecycle",
        message: "No.",
      },
      { after: "turn", job: "implement worker lifecycle", message: "No." },
      { job: "implement worker lifecycle", message: "" },
    ]) {
      expect(() => schema.parse(invalid)).toThrow();
    }

    sessions.statuses = { "child-1": { type: "idle" } };
    const output = String(
      await send.execute(
        {
          job: "implement worker lifecycle",
          message: "Use the corrected seam.",
        },
        context("parent-1", "sol")
      )
    );

    expect(JSON.parse(output)).toEqual({
      accepted: true,
      delivery: "sent",
      job: "implement worker lifecycle",
    });
    expect(sessions.aborts).toEqual([]);
    expect(sessions.prompts).toHaveLength(1);
    expect(sessions.prompts[0]).toMatchObject({
      agent: "terra-medium",
      sessionID: "child-1",
      text: "Use the corrected seam.",
    });
    expect(sessions.prompts[0]?.messageID).toMatch(OPENCODE_MESSAGE_ID_PATTERN);
    const expectedTimePrefix = `msg_${(
      (BigInt(Date.parse(timestamp)) * 0x1000n + 2n) %
      0x1000000000000n
    )
      .toString(16)
      .padStart(12, "0")}`;
    expect(sessions.prompts[0]?.messageID).toStartWith(expectedTimePrefix);
    const root = await store.readRoot();
    expect(root.deliveries[0]).toMatchObject({
      child_user_message_id: sessions.prompts[0]?.messageID,
      message: "Use the corrected seam.",
      state: "dispatched",
      task_id: "child-1",
    });
    expect(root.job_runs).toHaveLength(1);
    expect(root.job_runs[0]?.run_sequence).toBe(1);
    await expect(
      send.execute(
        {
          job: "implement worker lifecycle",
          message: "This cannot join the already dispatched prompt.",
        },
        context("parent-1", "sol")
      )
    ).rejects.toThrow(PENDING_SEND_PATTERN);
    expect(sessions.prompts).toHaveLength(1);
    expect((await store.readRoot()).deliveries[0]?.message).toBe(
      "Use the corrected seam."
    );
  });

  test("blocks instead of stranding a delivery when OpenCode rejects prompt submission", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    sessions.statuses = { "child-1": { type: "idle" } };
    sessions.promptFailure = new Error("Prompt transport rejected.");
    const send = plugin.tool.agents_send;
    if (send === undefined) {
      throw new Error("Task 15.4 agents_send must be registered.");
    }

    await expect(
      send.execute(
        {
          job: "implement worker lifecycle",
          message: "Use the corrected seam.",
        },
        context("parent-1", "sol")
      )
    ).rejects.toThrow("Prompt transport rejected.");

    const root = await store.readRoot();
    expect(root.deliveries).toEqual([]);
    expect(root.workers[0]).toMatchObject({
      latest_event: {
        kind: "blocker",
        message:
          "Managed worker steering could not be submitted to OpenCode. Retry the unchanged job or replace the workflow.",
      },
      live_state: "blocked",
    });
    expect(await workflowJobState(store)).toMatchObject({ state: "blocked" });
  });

  test("preempts busy reasoning and coalesces later steering into the one prompt before dispatch", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const deferred: Array<() => void | Promise<void>> = [];
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { defer: (operation) => deferred.push(operation), runtime }
    );
    const send = plugin.tool.agents_send;
    const event = plugin.event;
    if (send === undefined || event === undefined) {
      throw new Error("Task 9 steering hooks must be registered.");
    }
    await settlePluginRecovery(plugin);

    expect(
      JSON.parse(
        String(
          await send.execute(
            {
              job: "implement worker lifecycle",
              message: "First steering message.",
            },
            context("parent-1", "sol")
          )
        )
      )
    ).toEqual({
      accepted: true,
      delivery: "preempting",
      job: "implement worker lifecycle",
    });
    expect(
      JSON.parse(
        String(
          await send.execute(
            {
              job: "implement worker lifecycle",
              message: "Also return the installed-version caveat.",
            },
            context("parent-1", "sol")
          )
        )
      )
    ).toEqual({
      accepted: true,
      delivery: "preempting",
      job: "implement worker lifecycle",
    });
    expect((await store.readRoot()).deliveries).toEqual([
      expect.objectContaining({
        delivery_id: "internal-id",
        message:
          "First steering message.\n\n--- Additional priority steering received before dispatch; later instruction takes precedence on conflict ---\nAlso return the installed-version caveat.",
        state: "interrupting",
      }),
    ]);
    expect(sessions.aborts).toEqual([]);
    expect(sessions.prompts).toEqual([]);
    expect(deferred).toHaveLength(1);

    await deferred[0]?.();
    expect(sessions.aborts).toEqual(["child-1"]);
    sessions.statuses = { "child-1": { type: "idle" } };
    await event({
      event: { properties: { sessionID: "child-1" }, type: "session.idle" },
    });
    expect(sessions.prompts).toEqual([]);
    const cancelled = {
      info: {
        error: { name: "AbortError" },
        id: "assistant-busy-cancelled",
        role: "assistant" as const,
        sessionID: "child-1",
        time: { completed: 2, created: 1 },
      },
      parts: [],
    };
    sessions.messageRecords.set("child-1", [cancelled]);
    await event({
      event: {
        properties: { info: cancelled.info },
        type: "message.updated",
      },
    });
    expect(sessions.prompts).toHaveLength(1);
    expect(sessions.prompts[0]?.text).toBe(
      "First steering message.\n\n--- Additional priority steering received before dispatch; later instruction takes precedence on conflict ---\nAlso return the installed-version caveat."
    );
  });

  test("uses actual OpenCode status instead of stale durable idle state", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const deferred: Array<() => void | Promise<void>> = [];
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { defer: (operation) => deferred.push(operation), runtime }
    );
    const send = plugin.tool.agents_send;
    if (send === undefined) {
      throw new Error("Task 9 agents_send must be registered.");
    }
    await store.mutateRoot(({ root }) => {
      const worker = root.workers[0];
      if (worker !== undefined) {
        worker.live_state = "idle";
      }
    });
    sessions.statuses = { "child-1": { type: "busy" } };

    const output = String(
      await send.execute(
        { job: "implement worker lifecycle", message: "Trust live status." },
        context("parent-1", "sol")
      )
    );

    expect(JSON.parse(output)).toEqual({
      accepted: true,
      delivery: "preempting",
      job: "implement worker lifecycle",
    });
    expect(sessions.prompts).toEqual([]);
    expect(deferred).toHaveLength(1);
  });

  test("waits through an active tool and dispatches native steering inside its completed boundary", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const deferred: Array<() => void | Promise<void>> = [];
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { defer: (operation) => deferred.push(operation), runtime }
    );
    const before = plugin["tool.execute.before"];
    const after = plugin["tool.execute.after"];
    const send = plugin.tool.agents_send;
    if (before === undefined || after === undefined || send === undefined) {
      throw new Error("Task 9 tool-boundary hooks must be registered.");
    }
    await before(
      { callID: "active-read-1", sessionID: "child-1", tool: "read" },
      { args: { filePath: "src/server.ts" } }
    );

    const output = String(
      await send.execute(
        {
          job: "implement worker lifecycle",
          message: "Steer after this read.",
        },
        context("parent-1", "sol")
      )
    );
    expect(JSON.parse(output)).toEqual({
      accepted: true,
      delivery: "pending_boundary",
      job: "implement worker lifecycle",
    });
    expect((await store.readRoot()).deliveries[0]?.state).toBe(
      "waiting_tool_boundary"
    );
    expect(
      JSON.parse(
        String(
          await send.execute(
            {
              job: "implement worker lifecycle",
              message: "Also preserve the completed tool evidence.",
            },
            context("parent-1", "sol")
          )
        )
      )
    ).toEqual({
      accepted: true,
      delivery: "pending_boundary",
      job: "implement worker lifecycle",
    });
    expect(sessions.aborts).toEqual([]);
    expect(deferred).toEqual([]);

    await after(
      {
        args: { filePath: "src/server.ts" },
        callID: "active-read-1",
        sessionID: "child-1",
        tool: "read",
      },
      { metadata: {}, output: "read complete", title: "Read" }
    );
    expect(sessions.aborts).toEqual([]);
    expect(deferred).toEqual([]);
    expect(sessions.prompts).toHaveLength(1);
    expect(sessions.prompts[0]?.text).toBe(
      "Steer after this read.\n\n--- Additional priority steering received before dispatch; later instruction takes precedence on conflict ---\nAlso preserve the completed tool evidence."
    );
    expect((await store.readRoot()).deliveries[0]?.state).toBe("dispatched");
  });

  test("uses the completed after-hook boundary even while OpenCode history still reports the tool running", async () => {
    const { runtime, sessions } = await setupBoundWorker();
    const deferred: Array<() => void | Promise<void>> = [];
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { defer: (operation) => deferred.push(operation), runtime }
    );
    const before = plugin["tool.execute.before"];
    const after = plugin["tool.execute.after"];
    const send = plugin.tool.agents_send;
    if (before === undefined || after === undefined || send === undefined) {
      throw new Error("Task 9 tool-boundary hooks must be registered.");
    }
    sessions.messageRecords.set("child-1", [
      {
        info: {
          finish: "tool-calls",
          id: "assistant-stale-running-1",
          role: "assistant",
          sessionID: "child-1",
          time: { created: 1 },
        },
        parts: [
          {
            callID: "stale-running-call-1",
            id: "stale-running-part-1",
            messageID: "assistant-stale-running-1",
            sessionID: "child-1",
            state: {
              input: {},
              metadata: {},
              status: "running",
              time: { start: 1 },
            },
            tool: "read",
            type: "tool",
          },
        ],
      },
    ]);
    await before(
      {
        callID: "stale-running-call-1",
        sessionID: "child-1",
        tool: "read",
      },
      { args: { filePath: "src/server.ts" } }
    );
    await send.execute(
      {
        job: "implement worker lifecycle",
        message: "Abort after this exact boundary.",
      },
      context("parent-1", "sol")
    );

    await after(
      {
        args: { filePath: "src/server.ts" },
        callID: "stale-running-call-1",
        sessionID: "child-1",
        tool: "read",
      },
      { metadata: {}, output: "read complete", title: "Read" }
    );
    expect(sessions.aborts).toEqual([]);
    expect(deferred).toEqual([]);
    expect(sessions.prompts).toHaveLength(1);
    expect(sessions.prompts[0]?.text).toBe("Abort after this exact boundary.");
  });

  test("does not treat one completed parallel tool as the boundary of another running tool", async () => {
    const { runtime, sessions } = await setupBoundWorker();
    const deferred: Array<() => void | Promise<void>> = [];
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { defer: (operation) => deferred.push(operation), runtime }
    );
    const after = plugin["tool.execute.after"];
    const send = plugin.tool.agents_send;
    if (after === undefined || send === undefined) {
      throw new Error("Task 9 tool-boundary hooks must be registered.");
    }
    const parallelMessage: OpenCodeMessageRecord = {
      info: {
        finish: "tool-calls",
        id: "assistant-parallel-tools-1",
        role: "assistant",
        sessionID: "child-1",
        time: { created: 1 },
      },
      parts: ["parallel-call-1", "parallel-call-2"].map((callID) => ({
        callID,
        id: `${callID}-part`,
        messageID: "assistant-parallel-tools-1",
        sessionID: "child-1",
        state: {
          input: {},
          metadata: {},
          status: "running" as const,
          time: { start: 1 },
        },
        tool: "read",
        type: "tool" as const,
      })),
    };
    sessions.messageRecords.set("child-1", [parallelMessage]);
    await send.execute(
      {
        job: "implement worker lifecycle",
        message: "Wait for both tool boundaries.",
      },
      context("parent-1", "sol")
    );

    await after(
      {
        args: { filePath: "src/one.ts" },
        callID: "parallel-call-1",
        sessionID: "child-1",
        tool: "read",
      },
      { metadata: {}, output: "first complete", title: "Read" }
    );
    expect(deferred).toEqual([]);
    const first = parallelMessage.parts[0];
    if (first?.type !== "tool") {
      throw new Error("The first parallel tool part is unavailable.");
    }
    first.state = {
      input: {},
      metadata: {},
      output: "first complete",
      status: "completed",
      time: { end: 2, start: 1 },
      title: "Read",
    };
    await after(
      {
        args: { filePath: "src/two.ts" },
        callID: "parallel-call-2",
        sessionID: "child-1",
        tool: "read",
      },
      { metadata: {}, output: "second complete", title: "Read" }
    );
    expect(deferred).toEqual([]);
    expect(sessions.aborts).toEqual([]);
    expect(sessions.prompts).toHaveLength(1);
    expect(sessions.prompts[0]?.text).toBe("Wait for both tool boundaries.");
  });

  test("suppresses only the superseded turn error, then completes the correlated steering turn once", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const deferred: Array<() => void | Promise<void>> = [];
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { defer: (operation) => deferred.push(operation), runtime }
    );
    const event = plugin.event;
    const send = plugin.tool.agents_send;
    if (event === undefined || send === undefined) {
      throw new Error("Task 9 steering lifecycle must be registered.");
    }
    await settlePluginRecovery(plugin);
    await send.execute(
      {
        job: "implement worker lifecycle",
        message: "Continue with the corrected seam.",
      },
      context("parent-1", "sol")
    );
    sessions.messageRecords.set("child-1", [
      {
        info: {
          id: "initial-user-1",
          role: "user",
          sessionID: "child-1",
          time: { created: 1 },
        },
        parts: [],
      },
    ]);
    sessions.statuses = { "child-1": { type: "idle" } };
    await event({
      event: { properties: { sessionID: "child-1" }, type: "session.idle" },
    });
    expect(sessions.prompts).toEqual([]);

    const cancelled = {
      info: {
        error: { name: "AbortError" },
        id: "assistant-cancelled-1",
        parentID: "initial-user-1",
        role: "assistant" as const,
        sessionID: "child-1",
        time: { completed: 2, created: 1 },
      },
      parts: [],
    };
    sessions.messageRecords.get("child-1")?.push(cancelled);
    await event({
      event: {
        properties: {
          info: {
            error: { name: "AbortError" },
            id: "assistant-cancelled-1",
            parentID: "initial-user-1",
            role: "assistant",
            sessionID: "child-1",
            time: { completed: 2, created: 1 },
          },
        },
        type: "message.updated",
      },
    });
    expect((await workflowJobState(store))?.state).toBe("active");
    expect((await store.readRoot()).deliveries).toHaveLength(1);

    const prompt = sessions.prompts[0];
    if (prompt === undefined) {
      throw new Error(
        "The steering prompt must dispatch after the superseded error is durable."
      );
    }
    await event({
      event: {
        properties: {
          info: {
            id: prompt.messageID,
            role: "user",
            sessionID: "child-1",
            time: { created: 3 },
          },
        },
        type: "message.updated",
      },
    });
    sessions.messageRecords.get("child-1")?.push({
      info: {
        finish: "stop",
        id: "assistant-steered-final-1",
        parentID: prompt.messageID,
        role: "assistant",
        sessionID: "child-1",
        time: { completed: 5, created: 4 },
      },
      parts: [
        {
          id: "assistant-steered-final-part-1",
          messageID: "assistant-steered-final-1",
          sessionID: "child-1",
          text: "Corrected final result remains pull-only.",
          type: "text",
        },
      ],
    });
    const finalEvent = {
      properties: {
        info: {
          finish: "stop",
          id: "assistant-steered-final-1",
          parentID: prompt.messageID,
          role: "assistant" as const,
          sessionID: "child-1",
          time: { completed: 5, created: 4 },
        },
      },
      type: "message.updated" as const,
    };
    await event({ event: finalEvent });
    await event({ event: finalEvent });

    expect((await workflowJobState(store))?.state).toBe("review");
    const root = await store.readRoot();
    expect(root.deliveries[0]?.state).toBe("completed");
    expect(root.job_runs).toHaveLength(1);
    expect(root.job_runs[0]?.run_sequence).toBe(1);
    expect(sessions.prompts).toHaveLength(1);
    const redact = plugin["chat.message"];
    if (redact === undefined) {
      throw new Error("Task 9 cancellation redaction must be registered.");
    }
    const lateCancellation = chatOutput(
      backgroundInjection(
        "child-1",
        "error",
        "Late native background cancellation"
      )
    );
    await redact({ sessionID: "parent-1" }, lateCancellation);
    expect(lateCancellation.parts[0]?.text).toContain(
      "Managed worker steering continues"
    );
    expect(lateCancellation.parts[0]?.text).not.toContain(
      "Late native background cancellation"
    );
    expect((await store.readRoot()).deliveries).toEqual([]);
  });

  test("restart reconciliation resumes each durable crash state without duplicate prompt submission", async () => {
    const first = await setupBoundWorker();
    await first.store.mutateRoot(({ root }) => {
      const worker = root.workers[0];
      if (worker !== undefined) {
        worker.live_state = "preempting";
      }
      root.deliveries.push({
        child_user_message_id: null,
        created_at: timestamp,
        delivery_id: "restart-pending-1",
        message: "Resume pending steering.",
        state: "pending_preemption",
        task_id: "child-1",
        updated_at: timestamp,
      });
    });
    first.sessions.statuses = { "child-1": { type: "idle" } };
    const firstRestart = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "restart-user-1",
        now: () => timestamp,
        sessionAdapter: first.sessions,
        store: first.store,
      },
    });
    const firstPlugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime: firstRestart }
    );
    await settlePluginRecovery(firstPlugin);
    expect(first.sessions.prompts).toHaveLength(1);

    const secondRestart = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "must-not-be-used",
        now: () => timestamp,
        sessionAdapter: first.sessions,
        store: first.store,
      },
    });
    const secondPlugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime: secondRestart }
    );
    await settlePluginRecovery(secondPlugin);
    expect(first.sessions.prompts).toHaveLength(1);
    expect((await first.store.readRoot()).deliveries[0]?.state).toBe("started");

    const waiting = await setupBoundWorker();
    await waiting.store.mutateRoot(({ root }) => {
      const worker = root.workers[0];
      if (worker !== undefined) {
        worker.live_state = "preempting";
      }
      root.deliveries.push({
        child_user_message_id: null,
        created_at: timestamp,
        delivery_id: "restart-waiting-1",
        message: "Wait for the running tool.",
        state: "waiting_tool_boundary",
        task_id: "child-1",
        updated_at: timestamp,
      });
    });
    waiting.sessions.messageRecords.set("child-1", [
      {
        info: {
          finish: "tool-calls",
          id: "assistant-running-tool-1",
          role: "assistant",
          sessionID: "child-1",
          time: { created: 1 },
        },
        parts: [
          {
            callID: "running-tool-1",
            id: "running-tool-part-1",
            messageID: "assistant-running-tool-1",
            sessionID: "child-1",
            state: {
              input: {},
              metadata: {},
              status: "running",
              time: { start: 1 },
            },
            tool: "read",
            type: "tool",
          },
        ],
      },
    ]);
    const waitingDeferred: Array<() => void | Promise<void>> = [];
    const waitingRestart = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "waiting-user-1",
        defer: (operation) => waitingDeferred.push(operation),
        now: () => timestamp,
        sessionAdapter: waiting.sessions,
        store: waiting.store,
      },
    });
    const waitingPlugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime: waitingRestart }
    );
    await settlePluginRecovery(waitingPlugin);
    expect(waiting.sessions.aborts).toEqual([]);
    expect(waiting.sessions.prompts).toEqual([]);
    expect(waitingDeferred).toEqual([]);
    expect((await waiting.store.readRoot()).deliveries[0]?.state).toBe(
      "waiting_tool_boundary"
    );

    const dispatched = await setupBoundWorker();
    await dispatched.store.mutateRoot(({ root }) => {
      const worker = root.workers[0];
      if (worker !== undefined) {
        worker.live_state = "preempting";
      }
      root.deliveries.push({
        child_user_message_id: "restart-dispatched-user-1",
        created_at: timestamp,
        delivery_id: "restart-dispatched-1",
        message: "Retry only the unmaterialized fixed message.",
        state: "dispatched",
        task_id: "child-1",
        updated_at: timestamp,
      });
    });
    dispatched.sessions.statuses = { "child-1": { type: "idle" } };
    const dispatchedRestart = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "must-not-replace-fixed-message",
        now: () => timestamp,
        sessionAdapter: dispatched.sessions,
        store: dispatched.store,
      },
    });
    const dispatchedPlugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime: dispatchedRestart }
    );
    await settlePluginRecovery(dispatchedPlugin);
    expect(dispatched.sessions.prompts).toEqual([
      {
        agent: "terra-medium",
        directory: "/workspace",
        messageID: "restart-dispatched-user-1",
        sessionID: "child-1",
        text: "Retry only the unmaterialized fixed message.",
      },
    ]);

    const started = await setupBoundWorker();
    await started.store.mutateRoot(({ root }) => {
      const worker = root.workers[0];
      if (worker !== undefined) {
        worker.live_state = "busy";
      }
      root.deliveries.push({
        child_user_message_id: "restart-started-user-1",
        created_at: timestamp,
        delivery_id: "restart-started-1",
        message: "Complete this materialized steering turn.",
        state: "started",
        task_id: "child-1",
        updated_at: timestamp,
      });
    });
    started.sessions.statuses = { "child-1": { type: "idle" } };
    started.sessions.messageRecords.set("child-1", [
      {
        info: {
          id: "restart-started-user-1",
          role: "user",
          sessionID: "child-1",
          time: { created: 1 },
        },
        parts: [],
      },
      {
        info: {
          finish: "stop",
          id: "restart-started-final-1",
          parentID: "restart-started-user-1",
          role: "assistant",
          sessionID: "child-1",
          time: { completed: 2, created: 1 },
        },
        parts: [
          {
            id: "restart-started-final-part-1",
            messageID: "restart-started-final-1",
            sessionID: "child-1",
            text: "Recovered final remains pull-only.",
            type: "text",
          },
        ],
      },
    ]);
    const startedRestart = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "must-not-dispatch-after-final",
        now: () => timestamp,
        sessionAdapter: started.sessions,
        store: started.store,
      },
    });
    const startedPlugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime: startedRestart }
    );
    await settlePluginRecovery(startedPlugin);
    expect((await workflowJobState(started.store))?.state).toBe("review");
    expect((await started.store.readRoot()).deliveries[0]?.state).toBe(
      "completed"
    );
    expect(started.sessions.prompts).toEqual([]);
  });

  test("permanent interrupt wins over pending steering and cannot later dispatch", async () => {
    const { runtime, sessions, store } = await setupBoundWorker();
    const deferred: Array<() => void | Promise<void>> = [];
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { defer: (operation) => deferred.push(operation), runtime }
    );
    const interrupt = plugin.tool.agents_interrupt;
    const send = plugin.tool.agents_send;
    if (interrupt === undefined || send === undefined) {
      throw new Error("Task 9 worker controls must be registered.");
    }
    await send.execute(
      {
        job: "implement worker lifecycle",
        message: "This delivery will be cancelled.",
      },
      context("parent-1", "sol")
    );
    await interrupt.execute(
      {
        job: "implement worker lifecycle",
        reason: "Permanently stop this job.",
      },
      context("parent-1", "sol")
    );
    expect(sessions.aborts).toEqual(["child-1"]);
    expect((await store.readRoot()).deliveries).toEqual([]);
    expect((await store.readRoot()).workers[0]?.live_state).toBe("interrupted");
    await deferred[0]?.();
    expect(sessions.aborts).toEqual(["child-1"]);
    expect(sessions.prompts).toEqual([]);
  });
});

describe("Task 10 optional structured-write decisions", () => {
  test("holds an out-of-scope apply_patch before execution until Sol denies it", async () => {
    const emptyScopeDefinition: WorkflowDefinition = {
      ...definition,
      steps: definition.steps.map((step) => ({
        ...step,
        jobs: step.jobs.map((job) => ({ ...job, writeFiles: [] })),
      })),
    };
    const { runtime, sessions, store } = await setupBoundWorker({
      definitionInput: emptyScopeDefinition,
      fingerprint: () => Promise.resolve(new Map()),
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["tool.execute.before"];
    const permission = plugin.tool.agents_permission;
    if (before === undefined || permission === undefined) {
      throw new Error(
        "Structured-write permission controls must be registered."
      );
    }

    const execution = before(
      {
        callID: "preflight-apply-patch",
        sessionID: "child-1",
        tool: "apply_patch",
      },
      {
        args: {
          patchText: [
            "*** Begin Patch",
            "*** Add File: docs/outside.md",
            "+must not be written",
            "*** End Patch",
          ].join("\n"),
        },
      }
    ).then(
      () => "resolved" as const,
      (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    );

    expect(
      await Promise.race([execution, sleep(250).then(() => "pending" as const)])
    ).toBe("pending");
    expect((await store.readRoot()).permissions).toMatchObject([
      {
        requested_paths: ["docs/outside.md"],
        task_id: "child-1",
        tool: "apply_patch",
      },
    ]);
    expect(sessions.permissionReplies).toEqual([]);

    await permission.execute(
      {
        decision: "deny",
        feedback: "Live preflight denial.",
        job: "implement worker lifecycle",
      },
      context("parent-1", "sol")
    );

    expect(await execution).toContain("Live preflight denial.");
    expect((await store.readRoot()).permissions).toEqual([]);
    expect(sessions.permissionReplies).toEqual([]);
  });

  test("releases one preflight-approved call and answers only its correlated native permission", async () => {
    const emptyScopeDefinition: WorkflowDefinition = {
      ...definition,
      steps: definition.steps.map((step) => ({
        ...step,
        jobs: step.jobs.map((job) => ({ ...job, writeFiles: [] })),
      })),
    };
    const { runtime, sessions, store } = await setupBoundWorker({
      definitionInput: emptyScopeDefinition,
      fingerprint: () => Promise.resolve(new Map()),
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["tool.execute.before"];
    const event = plugin.event;
    const permission = plugin.tool.agents_permission;
    if (
      before === undefined ||
      event === undefined ||
      permission === undefined
    ) {
      throw new Error(
        "Structured-write permission controls must be registered."
      );
    }

    const execution = before(
      {
        callID: "preflight-allow-once",
        sessionID: "child-1",
        tool: "write",
      },
      { args: { content: "allowed once", filePath: "docs/once.md" } }
    );
    await sleep(250);
    expect((await store.readRoot()).permissions).toMatchObject([
      {
        requested_paths: ["docs/once.md"],
        task_id: "child-1",
        tool: "write",
      },
    ]);

    await permission.execute(
      { decision: "allow_once", job: "implement worker lifecycle" },
      context("parent-1", "sol")
    );
    await execution;
    expect(sessions.permissionReplies).toEqual([]);

    const native = editPermission(
      "native-after-preflight",
      ["docs/once.md"],
      "preflight-allow-once"
    );
    sessions.permissionRequests = [native];
    await event({
      event: { properties: native, type: "permission.asked" },
    });

    expect(sessions.permissionReplies).toEqual([
      { reply: "once", requestID: "native-after-preflight" },
    ]);
    expect((await store.readRoot()).permissions).toEqual([]);
  });

  test("lets unscoped and in-scope structured writes cross preflight immediately", async () => {
    for (const item of [
      {
        args: { content: "unscoped", filePath: "anywhere.txt" },
        definitionInput: definition,
        tool: "write",
      },
      {
        args: {
          filePath: "/workspace/src/in-scope.ts",
          newString: "next",
          oldString: "previous",
        },
        definitionInput: scopedDefinition,
        tool: "edit",
      },
    ]) {
      const { runtime, store } = await setupBoundWorker({
        definitionInput: item.definitionInput,
        fingerprint: () => Promise.resolve(new Map()),
      });
      const plugin = await SolOrchestratorPlugin(
        { client: { session: {} }, directory: "/workspace" },
        { runtime }
      );
      const before = plugin["tool.execute.before"];
      if (before === undefined) {
        throw new Error("Structured-write preflight hook must be registered.");
      }

      await before(
        {
          callID: `preflight-${item.tool}`,
          sessionID: "child-1",
          tool: item.tool,
        },
        { args: item.args }
      );

      expect((await store.readRoot()).permissions).toEqual([]);
    }
  });

  test("rejects malformed and concurrent structured preflights before execution", async () => {
    const emptyScopeDefinition: WorkflowDefinition = {
      ...definition,
      steps: definition.steps.map((step) => ({
        ...step,
        jobs: step.jobs.map((job) => ({ ...job, writeFiles: [] })),
      })),
    };
    const { runtime, store } = await setupBoundWorker({
      definitionInput: emptyScopeDefinition,
      fingerprint: () => Promise.resolve(new Map()),
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["tool.execute.before"];
    const permission = plugin.tool.agents_permission;
    if (before === undefined || permission === undefined) {
      throw new Error(
        "Structured-write permission controls must be registered."
      );
    }

    await expect(
      before(
        {
          callID: "malformed-preflight",
          sessionID: "child-1",
          tool: "apply_patch",
        },
        { args: { patchText: "*** Begin Patch\n*** End Patch" } }
      )
    ).rejects.toThrow("contains no file headers");

    const first = before(
      {
        callID: "first-preflight",
        sessionID: "child-1",
        tool: "write",
      },
      { args: { content: "first", filePath: "docs/first.md" } }
    );
    await sleep(250);
    await expect(
      before(
        {
          callID: "second-preflight",
          sessionID: "child-1",
          tool: "write",
        },
        { args: { content: "second", filePath: "docs/second.md" } }
      )
    ).rejects.toThrow("already has a pending structured-write permission");

    await permission.execute(
      { decision: "deny", job: "implement worker lifecycle" },
      context("parent-1", "sol")
    );
    await expect(first).rejects.toThrow("denied by Sol");
    expect((await store.readRoot()).permissions).toEqual([]);
  });

  test("persists a preflight allow_for_job grant before releasing the call", async () => {
    const emptyScopeDefinition: WorkflowDefinition = {
      ...definition,
      steps: definition.steps.map((step) => ({
        ...step,
        jobs: step.jobs.map((job) => ({ ...job, writeFiles: [] })),
      })),
    };
    const { runtime, sessions, store } = await setupBoundWorker({
      definitionInput: emptyScopeDefinition,
      fingerprint: () => Promise.resolve(new Map()),
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["tool.execute.before"];
    const permission = plugin.tool.agents_permission;
    if (before === undefined || permission === undefined) {
      throw new Error(
        "Structured-write permission controls must be registered."
      );
    }

    const execution = before(
      {
        callID: "preflight-allow-for-job",
        sessionID: "child-1",
        tool: "write",
      },
      { args: { content: "grant", filePath: "docs/granted.md" } }
    );
    await sleep(250);
    await permission.execute(
      { decision: "allow_for_job", job: "implement worker lifecycle" },
      context("parent-1", "sol")
    );
    await execution;

    expect((await store.readRoot()).job_runs[0]?.write_grants).toEqual([
      "docs/granted.md",
    ]);
    expect(sessions.appended.at(-1)).toEqual({
      rules: [
        {
          action: "allow",
          pattern: "docs/granted.md",
          permission: "edit",
        },
      ],
      sessionID: "child-1",
    });
    expect((await store.readRoot()).permissions).toEqual([]);
  });

  test("interrupt rejects and clears a pending structured preflight", async () => {
    const emptyScopeDefinition: WorkflowDefinition = {
      ...definition,
      steps: definition.steps.map((step) => ({
        ...step,
        jobs: step.jobs.map((job) => ({ ...job, writeFiles: [] })),
      })),
    };
    const { runtime, sessions, store } = await setupBoundWorker({
      definitionInput: emptyScopeDefinition,
      fingerprint: () => Promise.resolve(new Map()),
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["tool.execute.before"];
    const interrupt = plugin.tool.agents_interrupt;
    if (before === undefined || interrupt === undefined) {
      throw new Error(
        "Structured-write interrupt controls must be registered."
      );
    }

    const execution = before(
      {
        callID: "preflight-interrupt",
        sessionID: "child-1",
        tool: "write",
      },
      { args: { content: "blocked", filePath: "docs/blocked.md" } }
    ).then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    );
    await sleep(250);
    await interrupt.execute(
      {
        job: "implement worker lifecycle",
        reason: "Preflight interrupt test.",
      },
      context("parent-1", "sol")
    );

    expect(await execution).toBe("Preflight interrupt test.");
    expect(sessions.aborts).toEqual(["child-1"]);
    expect((await store.readRoot()).permissions).toEqual([]);
  });

  test("registers the exact agents_permission schema without native request IDs", async () => {
    const { runtime } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const permission = plugin.tool.agents_permission;
    if (permission === undefined) {
      throw new Error("Task 10 agents_permission must be registered.");
    }
    const schema = z.object(permission.args).strict();
    expect(
      schema.parse({
        decision: "allow_once",
        job: "implement worker lifecycle",
      })
    ).toEqual({
      decision: "allow_once",
      job: "implement worker lifecycle",
    });
    expect(
      schema.parse({
        decision: "deny",
        feedback: "Keep the change inside src/**.",
        job: "implement worker lifecycle",
      })
    ).toEqual({
      decision: "deny",
      feedback: "Keep the change inside src/**.",
      job: "implement worker lifecycle",
    });
    for (const invalid of [
      { decision: "always", job: "implement worker lifecycle" },
      {
        decision: "allow_once",
        job: "implement worker lifecycle",
        request_id: "permission-internal",
      },
    ]) {
      expect(() => schema.parse(invalid)).toThrow();
    }
  });

  test("atomically scopes and binds a native child before its initial prompt", async () => {
    const sessions = new FakeSessions();
    const { store } = await setupBoundWorker({
      definitionInput: scopedDefinition,
      preserveLaunchPrompt: true,
      sessions,
    });

    expect(sessions.created).toBe(1);
    expect(sessions.appended).toEqual([
      {
        rules: [
          ...managedWorkerPermissionRules,
          { action: "ask", pattern: "*", permission: "edit" },
          { action: "allow", pattern: "src/**", permission: "edit" },
        ],
        sessionID: "child-1",
      },
    ]);
    expect(sessions.prompts).toHaveLength(1);
    expect((await store.readRoot()).workers[0]).toMatchObject({
      child_session_id: "child-1",
      job: "implement worker lifecycle",
      live_state: "starting",
      profile: "terra-medium",
    });
  });

  test("retains an out-of-scope edit event and exposes it only as bounded status/wait metadata", async () => {
    const sessions = new FakeSessions();
    const request = editPermission("permission-early-outside", [
      "docs/outside.md",
    ]);
    sessions.permissionRequests = [request];
    sessions.messageRecords.set("child-1", [permissionToolMessage(request)]);
    const { runtime, store } = await setupBoundWorker({
      definitionInput: scopedDefinition,
      sessions,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const event = plugin.event;
    const status = plugin.tool.agents_status;
    const wait = plugin.tool.agents_wait;
    if (event === undefined || status === undefined || wait === undefined) {
      throw new Error("Task 10 status and wait controls must be registered.");
    }
    await event({ event: { properties: request, type: "permission.asked" } });

    const root = await store.readRoot();
    expect(root.permissions).toEqual([
      {
        created_at: timestamp,
        permission: "edit",
        request_id: "permission-early-outside",
        requested_paths: ["docs/outside.md"],
        task_id: "child-1",
        tool: "write",
      },
    ]);
    expect(sessions.permissionReplies).toEqual([]);
    const selected = String(
      await status.execute(
        { job: "implement worker lifecycle" },
        context("parent-1", "sol")
      )
    );
    expect(JSON.parse(selected).worker).toMatchObject({
      pending_write_permission: {
        paths: ["docs/outside.md"],
        tool: "write",
      },
      writeFiles: ["src/**"],
      write_grants: [],
    });
    expect(selected).not.toContain("permission-early-outside");
    const waited = String(
      await wait.execute(
        {
          jobs: ["implement worker lifecycle"],
          timeout_ms: 5,
          until: "any",
        },
        context("parent-1", "sol")
      )
    );
    expect(JSON.parse(waited).workers[0]).toMatchObject({
      pending_write_permission: {
        paths: ["docs/outside.md"],
        tool: "write",
      },
      job: "implement worker lifecycle",
    });
    expect(waited).not.toContain("permission-early-outside");
  });

  test("auto-resumes unscoped and in-scope edit events without surfacing a Sol decision", async () => {
    for (const item of [
      { definitionInput: definition, path: "anywhere.txt" },
      { definitionInput: scopedDefinition, path: "src/in-scope.ts" },
    ]) {
      const { runtime, sessions, store } = await setupBoundWorker({
        definitionInput: item.definitionInput,
      });
      const plugin = await SolOrchestratorPlugin(
        { client: { session: {} }, directory: "/workspace" },
        { runtime }
      );
      const event = plugin.event;
      if (event === undefined) {
        throw new Error("Task 10 permission event hook must be registered.");
      }
      const request = editPermission(`permission-${item.path}`, [item.path]);
      sessions.permissionRequests = [request];
      sessions.messageRecords.set("child-1", [permissionToolMessage(request)]);

      await event({
        event: { properties: request, type: "permission.asked" },
      });

      expect(sessions.permissionReplies.at(-1)).toEqual({
        reply: "once",
        requestID: request.id,
      });
      expect(sessions.permissionListCalls).toBe(0);
      expect((await store.readRoot()).permissions).toEqual([]);
      expect((await workflowJobState(store))?.state).toBe("active");
    }
  });

  test("allow_once resumes exactly one pending edit without creating a run grant", async () => {
    const sessions = new FakeSessions();
    const request = editPermission("permission-allow-once", ["docs/once.md"]);
    sessions.permissionRequests = [request];
    sessions.messageRecords.set("child-1", [permissionToolMessage(request)]);
    const { runtime, store } = await setupBoundWorker({
      definitionInput: scopedDefinition,
      sessions,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const permission = plugin.tool.agents_permission;
    const event = plugin.event;
    if (event === undefined || permission === undefined) {
      throw new Error("Task 10 agents_permission must be registered.");
    }
    await event({ event: { properties: request, type: "permission.asked" } });

    const output = String(
      await permission.execute(
        { decision: "allow_once", job: "implement worker lifecycle" },
        context("parent-1", "sol")
      )
    );

    expect(JSON.parse(output)).toEqual({
      accepted: true,
      decision: "allow_once",
      job: "implement worker lifecycle",
    });
    expect(sessions.permissionReplies).toEqual([
      { reply: "once", requestID: "permission-allow-once" },
    ]);
    const root = await store.readRoot();
    expect(root.permissions).toEqual([]);
    expect(root.job_runs[0]?.write_grants).toEqual([]);
    expect(output).not.toContain("permission-allow-once");
  });

  test("allow_for_job persists exact run-local grants before appending rules and replying once", async () => {
    const sessions = new FakeSessions();
    const request = editPermission("permission-grant-job", ["docs/granted.md"]);
    sessions.permissionRequests = [request];
    sessions.messageRecords.set("child-1", [permissionToolMessage(request)]);
    const { runtime, store } = await setupBoundWorker({
      definitionInput: scopedDefinition,
      sessions,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const permission = plugin.tool.agents_permission;
    const event = plugin.event;
    if (permission === undefined || event === undefined) {
      throw new Error("Task 10 permission controls must be registered.");
    }
    await event({ event: { properties: request, type: "permission.asked" } });

    const output = String(
      await permission.execute(
        { decision: "allow_for_job", job: "implement worker lifecycle" },
        context("parent-1", "sol")
      )
    );

    expect(JSON.parse(output)).toEqual({
      accepted: true,
      decision: "allow_for_job",
      job: "implement worker lifecycle",
    });
    const root = await store.readRoot();
    expect(root.job_runs[0]?.write_grants).toEqual(["docs/granted.md"]);
    expect(root.permissions).toEqual([]);
    expect(root.workflows.workflows[0]?.current_version).toBe(1);
    expect(sessions.permissionOperations.slice(-2)).toEqual([
      {
        rules: [
          {
            action: "allow",
            pattern: "docs/granted.md",
            permission: "edit",
          },
        ],
        sessionID: "child-1",
        type: "append",
      },
      {
        reply: "once",
        requestID: "permission-grant-job",
        type: "reply",
      },
    ]);

    const repeated = editPermission("permission-grant-repeat", [
      "docs/granted.md",
    ]);
    sessions.permissionRequests = [repeated];
    sessions.messageRecords.set("child-1", [permissionToolMessage(repeated)]);
    await event({
      event: { properties: repeated, type: "permission.asked" },
    });
    expect(sessions.permissionReplies.at(-1)).toEqual({
      reply: "once",
      requestID: "permission-grant-repeat",
    });
    expect((await store.readRoot()).permissions).toEqual([]);
  });

  test("deny returns corrective feedback before mutation and keeps the job active", async () => {
    const sessions = new FakeSessions();
    const request = editPermission("permission-deny", ["docs/denied.md"]);
    sessions.permissionRequests = [request];
    sessions.messageRecords.set("child-1", [permissionToolMessage(request)]);
    const { runtime, store } = await setupBoundWorker({
      definitionInput: scopedDefinition,
      sessions,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const permission = plugin.tool.agents_permission;
    const event = plugin.event;
    if (event === undefined || permission === undefined) {
      throw new Error("Task 10 agents_permission must be registered.");
    }
    await event({ event: { properties: request, type: "permission.asked" } });

    await permission.execute(
      {
        decision: "deny",
        feedback: "Keep the change inside src/**.",
        job: "implement worker lifecycle",
      },
      context("parent-1", "sol")
    );

    expect(sessions.permissionReplies).toEqual([
      {
        feedback: "Keep the change inside src/**.",
        reply: "reject",
        requestID: "permission-deny",
      },
    ]);
    expect((await store.readRoot()).permissions).toEqual([]);
    expect((await store.readRoot()).job_runs[0]?.write_grants).toEqual([]);
    expect((await workflowJobState(store))?.state).toBe("active");
    await expect(
      permission.execute(
        {
          decision: "allow_once",
          feedback: "Ignored feedback is forbidden.",
          job: "implement worker lifecycle",
        },
        context("parent-1", "sol")
      )
    ).rejects.toThrow(PERMISSION_FEEDBACK_PATTERN);
  });

  test("blocks instead of guessing when one worker has multiple pending edit requests", async () => {
    const sessions = new FakeSessions();
    const first = editPermission("permission-multiple-1", ["docs/one.md"]);
    const second = editPermission("permission-multiple-2", ["docs/two.md"]);
    sessions.permissionRequests = [first, second];
    sessions.messageRecords.set("child-1", [
      permissionToolMessage(first),
      permissionToolMessage(second, "apply_patch"),
    ]);
    const { runtime, store } = await setupBoundWorker({
      definitionInput: scopedDefinition,
      sessions,
    });

    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const event = plugin.event;
    if (event === undefined) {
      throw new Error("Task 10 permission event hook must be registered.");
    }
    await event({ event: { properties: first, type: "permission.asked" } });
    await event({ event: { properties: second, type: "permission.asked" } });
    expect((await workflowJobState(store))?.state).toBe("blocked");
    expect((await store.readRoot()).workers[0]?.latest_event).toMatchObject({
      kind: "blocker",
      message: expect.stringMatching(MULTIPLE_PERMISSION_PATTERN),
    });
    expect((await store.readRoot()).permissions).toEqual([]);
    expect(sessions.permissionReplies).toEqual([]);
    expect(sessions.aborts).toEqual([]);
  });

  test("blocks a second permission event before Sol can apply a stale decision", async () => {
    const sessions = new FakeSessions();
    const first = editPermission("permission-race-1", ["docs/one.md"]);
    sessions.permissionRequests = [first];
    sessions.messageRecords.set("child-1", [permissionToolMessage(first)]);
    const { runtime, store } = await setupBoundWorker({
      definitionInput: scopedDefinition,
      sessions,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const permission = plugin.tool.agents_permission;
    const event = plugin.event;
    if (event === undefined || permission === undefined) {
      throw new Error("Task 10 agents_permission must be registered.");
    }
    await event({ event: { properties: first, type: "permission.asked" } });
    const second = editPermission("permission-race-2", ["docs/two.md"]);
    sessions.permissionRequests.push(second);
    sessions.messageRecords
      .get("child-1")
      ?.push(permissionToolMessage(second, "apply_patch"));
    await event({ event: { properties: second, type: "permission.asked" } });
    expect((await workflowJobState(store))?.state).toBe("blocked");
    expect((await store.readRoot()).permissions).toEqual([]);
    expect(sessions.permissionReplies).toEqual([]);
  });

  test("blocks a persisted permission whose native suspended request vanished across restart", async () => {
    const sessions = new FakeSessions();
    const request = editPermission("permission-vanished", ["docs/vanished.md"]);
    sessions.permissionRequests = [request];
    sessions.messageRecords.set("child-1", [permissionToolMessage(request)]);
    const { store } = await setupBoundWorker({
      definitionInput: scopedDefinition,
      sessions,
    });
    expect((await store.readRoot()).permissions).toEqual([]);
    await store.mutateRoot(({ root }) => {
      root.permissions.push({
        created_at: timestamp,
        permission: "edit",
        request_id: request.id,
        requested_paths: request.patterns,
        task_id: "child-1",
        tool: "write",
      });
    });
    sessions.permissionRequests = [];
    sessions.permissionReplyFailure = new Error(
      "Permission request not found."
    );
    const restarted = createDefaultServerRuntime({
      client: { session: {} },
      directory: "/workspace",
      options: {
        create_id: () => "restart-permission-id",
        now: () => timestamp,
        sessionAdapter: sessions,
        store,
      },
    });

    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime: restarted }
    );
    const permission = plugin.tool.agents_permission;
    if (permission === undefined) {
      throw new Error("Task 10 agents_permission must be registered.");
    }
    await expect(
      permission.execute(
        { decision: "allow_once", job: "implement worker lifecycle" },
        context("parent-1", "sol")
      )
    ).rejects.toThrow("Permission request not found.");

    expect((await workflowJobState(store))?.state).toBe("blocked");
    expect((await store.readRoot()).permissions).toEqual([]);
    expect((await store.readRoot()).workers[0]?.latest_event).toMatchObject({
      kind: "blocker",
      message: expect.stringContaining("could not be applied"),
    });
  });
});

describe("Task 8 managed background completion redaction", () => {
  test("replaces one correlated completed injection with bounded result and change metadata before persistence", async () => {
    const { runtime, sessions } = await setupBoundWorker();
    const childResult = "FULL MANAGED CHILD RESULT MUST STAY PULL-ONLY";
    const injectedResult = `${childResult}\n${"bulk ".repeat(1000)}`;
    sessions.messageRecords.set("child-1", [
      {
        info: {
          id: "worker-user-1",
          role: "user",
          sessionID: "child-1",
          time: { created: 1 },
        },
        parts: [],
      },
      {
        info: {
          finish: "stop",
          id: "assistant-final-1",
          parentID: "worker-user-1",
          role: "assistant",
          sessionID: "child-1",
          time: { completed: 2, created: 1 },
        },
        parts: [
          {
            id: "part-final-1",
            messageID: "assistant-final-1",
            sessionID: "child-1",
            text: childResult,
            type: "text",
          },
        ],
      },
    ]);
    sessions.diffRecords.set("worker-user-1", [
      {
        additions: 0,
        deletions: 3,
        patch: "FULL PATCH MUST STAY PULL-ONLY",
        path: "src/deleted.ts",
        status: "deleted",
      },
    ]);
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const redact = plugin["chat.message"];
    if (redact === undefined) {
      throw new Error("Task 8 chat.message redaction must be registered.");
    }
    const output = chatOutput(
      backgroundInjection("child-1", "completed", injectedResult)
    );

    await redact({ sessionID: "parent-1" }, output);

    const redacted = output.parts[0]?.text ?? "";
    expect(redacted).toContain("Managed worker completed");
    expect(redacted).toContain("Job: implement worker lifecycle");
    expect(redacted).toContain("Turns: 1");
    expect(redacted).toContain("Changes: 1 file, 0 additions, 3 deletions");
    expect(redacted).toContain(
      'agents_inspect({ job: "implement worker lifecycle", type: "result" })'
    );
    expect(redacted).not.toContain(injectedResult);
    expect(redacted).not.toContain("FULL PATCH MUST STAY PULL-ONLY");
    expect(redacted).not.toMatch(REDACTED_INTERNAL_PATTERN);
    expect(sessions.messageRecords.get("child-1")?.[1]?.parts[0]?.text).toBe(
      childResult
    );
  });

  test("redacts a real managed error without copying its body", async () => {
    const { runtime } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const redact = plugin["chat.message"];
    if (redact === undefined) {
      throw new Error("Task 8 chat.message redaction must be registered.");
    }
    const output = chatOutput(
      backgroundInjection(
        "child-1",
        "error",
        "FULL MANAGED TRANSPORT ERROR BODY"
      )
    );

    await redact({ sessionID: "parent-1" }, output);

    expect(output.parts[0]?.text).toContain(
      "Managed worker encountered an execution error"
    );
    expect(output.parts[0]?.text).not.toContain(
      "FULL MANAGED TRANSPORT ERROR BODY"
    );
  });

  test("suppresses a correlated preemption cancellation artifact as continuing steering metadata", async () => {
    const { runtime, store } = await setupBoundWorker();
    await store.mutateRoot(({ root }) => {
      root.deliveries.push({
        child_user_message_id: null,
        created_at: timestamp,
        delivery_id: "delivery-internal-1",
        message: "Use the corrected owner seam.",
        state: "interrupting",
        task_id: "child-1",
        updated_at: timestamp,
      });
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const redact = plugin["chat.message"];
    if (redact === undefined) {
      throw new Error("Task 8 chat.message redaction must be registered.");
    }
    const output = chatOutput(
      backgroundInjection("child-1", "error", "Task cancelled by preemption")
    );

    await redact({ sessionID: "parent-1" }, output);

    expect(output.parts[0]?.text).toContain(
      "Managed worker steering continues"
    );
    expect(output.parts[0]?.text).not.toContain("Task cancelled by preemption");
    expect(output.parts[0]?.text).not.toContain(
      "Use the corrected owner seam."
    );
  });

  test("leaves malformed, wrong-parent, unmanaged, and nonsynthetic task text unchanged", async () => {
    const { runtime } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const redact = plugin["chat.message"];
    if (redact === undefined) {
      throw new Error("Task 8 chat.message redaction must be registered.");
    }
    const cases = [
      {
        input: { sessionID: "parent-1" },
        output: chatOutput(
          '<task id="child-1" state="completed">malformed</task>'
        ),
      },
      {
        input: { sessionID: "wrong-parent" },
        output: chatOutput(
          backgroundInjection("child-1", "completed", "private result")
        ),
      },
      {
        input: { sessionID: "parent-1" },
        output: chatOutput(
          backgroundInjection("unmanaged-child", "completed", "private result")
        ),
      },
      {
        input: { sessionID: "parent-1" },
        output: chatOutput(
          backgroundInjection("child-1", "completed", "ordinary quoted text"),
          false
        ),
      },
    ];

    for (const item of cases) {
      const original = structuredClone(item.output);
      await redact(item.input, item.output);
      expect(item.output).toEqual(original);
    }
  });

  test("redacts duplicate correlated injections idempotently", async () => {
    const { runtime } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const redact = plugin["chat.message"];
    if (redact === undefined) {
      throw new Error("Task 8 chat.message redaction must be registered.");
    }
    const full = backgroundInjection(
      "child-1",
      "completed",
      "DUPLICATE FULL RESULT"
    );
    const first = chatOutput(full);
    const second = chatOutput(full);

    await redact({ sessionID: "parent-1" }, first);
    await redact({ sessionID: "parent-1" }, second);
    const firstRedaction = first.parts[0]?.text;
    await redact({ sessionID: "parent-1" }, first);

    expect(second.parts[0]?.text).toBe(firstRedaction);
    expect(first.parts[0]?.text).toBe(firstRedaction);
    expect(firstRedaction).not.toContain("DUPLICATE FULL RESULT");
  });
});

describe("Task 11 guarded worker mutation controls", () => {
  test("registers exact agents_undo and agents_redo schemas without native boundaries", async () => {
    const { runtime } = await setupBoundWorker();
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const undo = plugin.tool.agents_undo;
    const redo = plugin.tool.agents_redo;
    if (undo === undefined || redo === undefined) {
      throw new Error("Task 11 undo and redo controls must be registered.");
    }
    const undoSchema = z.object(undo.args).strict();
    const redoSchema = z.object(redo.args).strict();
    expect(
      undoSchema.parse({
        job: "implement worker lifecycle",
        reason: "Reject the current run.",
        scope: "latest_turn",
      })
    ).toEqual({
      job: "implement worker lifecycle",
      reason: "Reject the current run.",
      scope: "latest_turn",
    });
    expect(redoSchema.parse({ job: "implement worker lifecycle" })).toEqual({
      job: "implement worker lifecycle",
    });
    for (const invalid of [
      {
        job: "implement worker lifecycle",
        message_id: "native",
        reason: "No.",
      },
      { job: "implement worker lifecycle", reason: "" },
      {
        job: "implement worker lifecycle",
        reason: "No.",
        scope: "partial",
      },
    ]) {
      expect(() => undoSchema.parse(invalid)).toThrow();
    }
    expect(() =>
      redoSchema.parse({
        job: "implement worker lifecycle",
        message_id: "native",
      })
    ).toThrow();
  });

  test("turns a scoped shell violation into an exact blocker without automatic revert", async () => {
    const sessions = new FakeSessions();
    sessions.messageRecords.set("child-1", [
      {
        info: {
          id: "shell-user-1",
          role: "user",
          sessionID: "child-1",
          time: { created: Date.parse(timestamp) },
        },
        parts: [],
      },
    ]);
    const fingerprints = [
      new Map([["src/in-scope.ts", "same"]]),
      new Map([
        ["docs/outside.md", "created"],
        ["src/in-scope.ts", "same"],
      ]),
    ];
    const { runtime, store } = await setupBoundWorker({
      definitionInput: scopedDefinition,
      fingerprint: async () => fingerprints.shift() ?? new Map(),
      sessions,
    });
    const plugin = await SolOrchestratorPlugin(
      { client: { session: {} }, directory: "/workspace" },
      { runtime }
    );
    const before = plugin["tool.execute.before"];
    const after = plugin["tool.execute.after"];
    if (before === undefined || after === undefined) {
      throw new Error("Task 11 mutation hooks must be registered.");
    }
    const hook = {
      args: { command: "create docs/outside.md" },
      callID: "scoped-shell-1",
      sessionID: "child-1",
      tool: "bash",
    };
    await before(hook, { args: hook.args });
    const output = { metadata: {}, output: "command succeeded", title: "bash" };
    await after(hook, output);

    expect(output).toEqual({
      metadata: {},
      output:
        'Scoped shell write changed out-of-scope paths ["docs/outside.md"]; allowed scope is ["src/**"]. No automatic revert was attempted.',
      title: "Write scope violation",
    });
    expect((await store.readRoot()).workers[0]?.live_state).toBe("blocked");
    expect((await store.readRoot()).job_runs[0]?.state).toBe("blocked");
    expect(sessions.revertCalls).toEqual([]);
  });
});
