import { describe, expect, test } from "bun:test";
import { emptyRootSnapshot } from "./schema/orchestration.js";
import {
  managedWorkerPermissionRules,
  WorkerLauncher,
} from "./worker-launcher.js";
import { normalizeWorkflowDefinition } from "./workflow-graph.js";
import { WorkflowState } from "./workflow-state.js";
import type { WorkflowWorkerLauncher } from "./workflow-tools.js";

const timestamp = "2026-07-19T00:00:00.000Z";
const definition = normalizeWorkflowDefinition({
  objective: "Launch one bounded worker.",
  steps: [
    {
      jobs: [
        {
          actor: { profile: "luna-medium", type: "worker" },
          mode: "implementation",
          name: "write fixture",
          objective: "Write only the bounded fixture and verify it.",
          writeFiles: ["fixture.txt"],
        },
      ],
      name: "execute",
      objective: "Execute the bounded change.",
    },
  ],
});

const harness = () => {
  const root = emptyRootSnapshot();
  const workflow = new WorkflowState({ now: () => timestamp });
  workflow.start({
    definition,
    orchestrator_agent_id: "sol",
    parent_session_id: "parent-1",
    workflow_id: "workflow-1",
  });
  const store = {
    async mutateRoot<Value>(
      mutation: (state: { root: typeof root; workflow: WorkflowState }) => Value
    ): Promise<Value> {
      return await mutation({ root, workflow });
    },
    async readWorkflow<Value>(
      reader: (state: WorkflowState) => Value
    ): Promise<Awaited<Value>> {
      return await reader(workflow);
    },
  };
  const operations: string[] = [];
  let childCount = 0;
  let permissionFailure: Error | undefined;
  let promptFailure: Error | undefined;
  const sessions = {
    abort(sessionID: string) {
      operations.push(`abort:${sessionID}`);
      return Promise.resolve();
    },
    appendPermissions(sessionID: string, rules: unknown[]) {
      operations.push(`permissions:${sessionID}:${JSON.stringify(rules)}`);
      return permissionFailure === undefined
        ? Promise.resolve()
        : Promise.reject(permissionFailure);
    },
    createChild(input: { parentID: string; title: string }) {
      childCount += 1;
      const id = `child-${childCount}`;
      operations.push(`create:${input.parentID}:${input.title}:${id}`);
      return Promise.resolve({
        directory: "/workspace",
        id,
        parentID: input.parentID,
        projectID: "project-1",
        time: { created: 1, updated: 1 },
        title: input.title,
        version: "1.18.3",
      });
    },
    promptAsync(input: {
      agent: string;
      messageID: string;
      sessionID: string;
      text: string;
    }) {
      operations.push(
        `prompt:${input.sessionID}:${input.agent}:${input.messageID}:${input.text}`
      );
      return promptFailure === undefined
        ? Promise.resolve()
        : Promise.reject(promptFailure);
    },
    remove(sessionID: string) {
      operations.push(`remove:${sessionID}`);
      return Promise.resolve();
    },
  };
  const launcher = new WorkerLauncher(store, {
    create_message_id: () => "msg_019abcdef001AbCdEfGhIjKlMn",
    now: () => timestamp,
    sessions,
  });
  const job = definition.steps[0]?.jobs[0];
  if (job?.actor.type !== "worker" || job.mode === undefined) {
    throw new Error("Worker launch fixture is unavailable.");
  }
  const input: Parameters<WorkflowWorkerLauncher["launch"]>[0] = {
    definition_job: { ...job, actor: job.actor, mode: job.mode },
    parent_session_id: "parent-1",
    step: "execute",
    workflow_id: "workflow-1",
    workflow_version: 1,
  };
  return {
    input,
    launcher,
    operations,
    root,
    setPermissionFailure(error: Error) {
      permissionFailure = error;
    },
    setPromptFailure(error: Error) {
      promptFailure = error;
    },
    workflow,
  };
};

describe("WorkerLauncher", () => {
  test("creates, scopes, binds, and starts one native child in that order", async () => {
    const { input, launcher, operations, root, workflow } = harness();

    await launcher.launch(input);

    expect(operations).toEqual([
      "create:parent-1:write fixture (@luna-medium subagent):child-1",
      `permissions:child-1:${JSON.stringify([
        ...managedWorkerPermissionRules,
        { action: "ask", pattern: "*", permission: "edit" },
        { action: "allow", pattern: "fixture.txt", permission: "edit" },
      ])}`,
      'prompt:child-1:luna-medium:msg_019abcdef001AbCdEfGhIjKlMn:This authored semantic job is your binding execution contract.\n\nJob: write fixture\n\nMode: implementation\n\nWrite only the bounded fixture and verify it.\n\nWrite scope (reads remain unrestricted): ["fixture.txt"]',
    ]);
    expect(
      workflow.jobState({ job: "write fixture", workflow_id: "workflow-1" })
    ).toMatchObject({ run_sequence: 1, state: "active" });
    expect(root.workers[0]).toMatchObject({
      job: "write fixture",
      live_state: "starting",
      profile: "luna-medium",
    });
  });

  test("removes an unbound child when permission bootstrap fails", async () => {
    const {
      input,
      launcher,
      operations,
      root,
      setPermissionFailure,
      workflow,
    } = harness();
    setPermissionFailure(new Error("permission bootstrap failed"));

    await expect(launcher.launch(input)).rejects.toThrow(
      "permission bootstrap failed"
    );

    expect(operations.at(-1)).toBe("remove:child-1");
    expect(root.workers).toEqual([]);
    expect(
      workflow.jobState({ job: "write fixture", workflow_id: "workflow-1" })
        ?.state
    ).toBe("ready");
  });

  test("blocks a durably bound worker when OpenCode rejects its first prompt", async () => {
    const { input, launcher, operations, root, setPromptFailure, workflow } =
      harness();
    setPromptFailure(new Error("prompt rejected"));

    await expect(launcher.launch(input)).rejects.toThrow("prompt rejected");

    expect(operations.at(-1)).toBe("abort:child-1");
    expect(
      workflow.jobState({ job: "write fixture", workflow_id: "workflow-1" })
        ?.state
    ).toBe("blocked");
    expect(root.workers[0]).toMatchObject({
      latest_event: { kind: "blocker" },
      live_state: "blocked",
    });
  });

  test("allows only one concurrent launch to bind the ready job", async () => {
    const { input, launcher, operations, root } = harness();

    const settled = await Promise.allSettled([
      launcher.launch(input),
      launcher.launch(input),
    ]);

    expect(
      settled.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(root.workers).toHaveLength(1);
    expect(operations).toContain("remove:child-2");
  });
});
