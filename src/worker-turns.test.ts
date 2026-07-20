import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  OpenCodeFileDiff,
  OpenCodeMessageRecord,
  OpenCodeSession,
} from "./opencode-session.js";
import { OrchestrationStore } from "./orchestration-store.js";
import type { WorkerBindingRecord } from "./schema/orchestration.js";
import { WorkerTurns } from "./worker-turns.js";

const timestamp = "2026-07-17T13:00:00.000Z";
const directories: string[] = [];
const parentSessionID = "parent-1";
const taskID = "child-1";
const job = "inspect worker turn";
const RESULT_SENTINEL = "RESULT SENTINEL alpha beta";
const TOOL_SENTINEL = "TOOL OUTPUT SENTINEL";
const PATCH_SENTINEL = "PATCH SENTINEL";
const INTERNAL_ID_PATTERN =
  /boundary_message_id|result_message_id|message_id|part_id|event_sequence|delivered_event_sequence/u;
const UNADVERTISED_ITEM_PATTERN = /advertised|file/u;
const MALFORMED_TOOL_PATTERN = /tool.*state|malformed/u;
const BUSY_UNDO_PATTERN = /busy|idle/iu;
const PENDING_UNDO_PATTERN = /permission|pending/iu;
const REDO_DRIFT_PATTERN = /hash|changed|redo/iu;
const REVERT_STATE_PATTERN = /revert|marker|state/iu;
const RESULT_UNAVAILABLE_PATTERN = /result.*unavailable/i;
const UNSAFE_UNDO_PATTERN = /hash|unexpected|unsafe|conflict/iu;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

const userMessage = (): OpenCodeMessageRecord => ({
  info: {
    id: "user-turn-1",
    role: "user",
    sessionID: taskID,
    time: { created: Date.parse(timestamp) },
  },
  parts: [],
});

const toolMessage = (): OpenCodeMessageRecord => ({
  info: {
    finish: "tool-calls",
    id: "assistant-tool-1",
    parentID: "user-turn-1",
    role: "assistant",
    sessionID: taskID,
    time: {
      completed: Date.parse(timestamp) + 1000,
      created: Date.parse(timestamp) + 500,
    },
  },
  parts: [
    {
      callID: "call-internal-1",
      id: "part-tool-1",
      messageID: "assistant-tool-1",
      sessionID: taskID,
      state: {
        input: { path: "src/a.ts" },
        metadata: {},
        output: TOOL_SENTINEL,
        status: "completed",
        time: { end: 2, start: 1 },
        title: "Read source",
      },
      tool: "read",
      type: "tool",
    },
  ],
});

const finalMessage = (): OpenCodeMessageRecord => ({
  info: {
    finish: "stop",
    id: "assistant-final-1",
    parentID: "user-turn-1",
    role: "assistant",
    sessionID: taskID,
    time: {
      completed: Date.parse(timestamp) + 2000,
      created: Date.parse(timestamp) + 1500,
    },
  },
  parts: [
    {
      id: "part-result-1",
      messageID: "assistant-final-1",
      sessionID: taskID,
      text: RESULT_SENTINEL,
      type: "text",
    },
  ],
});

const addPatchPart = (
  message: OpenCodeMessageRecord,
  files: string[] = ["/workspace/src/a.ts"]
): void => {
  message.parts.push({
    files,
    hash: "snapshot-patch-1",
    id: `${message.info.id}-patch`,
    messageID: message.info.id,
    sessionID: taskID,
    type: "patch",
  });
};

class FakeTurnSessions {
  readonly records = new Map<string, OpenCodeMessageRecord[]>([
    [taskID, [userMessage(), toolMessage(), finalMessage()]],
  ]);
  readonly diffs = new Map<string, OpenCodeFileDiff[]>([
    [
      "user-turn-1",
      [
        {
          additions: 3,
          deletions: 1,
          patch: PATCH_SENTINEL,
          path: "src/a.ts",
          status: "modified",
        },
      ],
    ],
  ]);
  readonly revertCalls: Array<{ messageID: string; sessionID: string }> = [];
  readonly unrevertCalls: string[] = [];
  onRevert: (() => void) | undefined;
  onUnrevert: (() => void) | undefined;
  retainRevert = true;
  revertState: OpenCodeSession["revert"];
  statusValue: "busy" | "idle" | undefined = "idle";
  statusValues: Array<"busy" | "idle"> = [];

  diff(_sessionID: string, messageID?: string): Promise<OpenCodeFileDiff[]> {
    return Promise.resolve(this.diffs.get(messageID ?? "") ?? []);
  }

  get(sessionID: string): Promise<OpenCodeSession> {
    return Promise.resolve({
      directory: "/workspace",
      id: sessionID,
      parentID: parentSessionID,
      projectID: "project-1",
      time: { created: 1, updated: 1 },
      title: "worker",
      version: "1.18.1",
      ...(this.revertState === undefined ? {} : { revert: this.revertState }),
    });
  }

  message(
    sessionID: string,
    messageID: string
  ): Promise<OpenCodeMessageRecord> {
    const found = this.records
      .get(sessionID)
      ?.find((message) => message.info.id === messageID);
    return found === undefined
      ? Promise.reject(new Error(`Unknown message ${messageID}.`))
      : Promise.resolve(found);
  }

  messages(sessionID: string): Promise<OpenCodeMessageRecord[]> {
    return Promise.resolve(this.records.get(sessionID) ?? []);
  }

  revert(input: {
    messageID: string;
    sessionID: string;
  }): Promise<OpenCodeSession> {
    this.revertCalls.push(input);
    this.onRevert?.();
    this.revertState = this.retainRevert
      ? { messageID: input.messageID, snapshot: "snapshot-1" }
      : undefined;
    return this.get(input.sessionID);
  }

  status(): Promise<Record<string, { type: "busy" | "idle" }>> {
    const status = this.statusValues.shift() ?? this.statusValue;
    if (status === undefined) {
      return Promise.resolve({});
    }
    return Promise.resolve({ [taskID]: { type: status } });
  }

  unrevert(sessionID: string): Promise<OpenCodeSession> {
    this.unrevertCalls.push(sessionID);
    this.onUnrevert?.();
    this.revertState = undefined;
    return this.get(sessionID);
  }
}

type LatestEvent = NonNullable<WorkerBindingRecord["latest_event"]>;

const setup = async (
  options: {
    defaultArtifactDirectory?: boolean;
    latestEvent?: LatestEvent | null;
    liveState?: "busy" | "review";
    pendingPermission?: boolean;
    review?: boolean;
    fingerprints?: Record<string, string | null>[];
    files?: Record<string, string | null>;
    writeFiles?: string[];
    writeGrants?: string[];
  } = {}
) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "worker-turns-"));
  directories.push(directory);
  const store = new OrchestrationStore({
    now: () => timestamp,
    statePath: path.join(directory, "state-v2.json"),
  });
  await store.mutateWorkflow((workflow) => {
    workflow.start({
      definition: {
        objective: "Inspect one worker turn without bulk delivery.",
        steps: [
          {
            dependsOn: [],
            jobs: [
              {
                actor: { profile: "terra-max", type: "worker" },
                dependsOn: [],
                mode: "verification",
                name: job,
                objective: "Inspect one immutable selected item.",
                ...(options.writeFiles === undefined
                  ? {}
                  : { writeFiles: options.writeFiles }),
              },
              {
                actor: { profile: "luna-medium", type: "worker" },
                dependsOn: [],
                mode: "research",
                name: "second worker",
                objective: "Exercise independent wait watermarks.",
              },
            ],
            name: "inspect",
            objective: "Build pull-based worker inspection.",
          },
        ],
      },
      orchestrator_agent_id: "sol",
      parent_session_id: parentSessionID,
      workflow_id: "workflow-1",
    });
    workflow.markWorkerActive({
      job,
      task_id: taskID,
      workflow_id: "workflow-1",
    });
    if (options.review ?? true) {
      workflow.markWorkerReview({
        job,
        result_available: true,
        workflow_id: "workflow-1",
      });
    }
  });
  const latestEvent =
    options.latestEvent === undefined
      ? {
          created_at: timestamp,
          kind: "result" as const,
          result_message_id: "assistant-final-1",
          sequence: 1,
        }
      : options.latestEvent;
  await store.mutateRoot(({ root }) => {
    root.job_runs.push({
      job,
      result_available: options.review ?? true,
      run_sequence: 1,
      started_at: timestamp,
      state: (options.review ?? true) ? "review" : "active",
      task_id: taskID,
      updated_at: timestamp,
      workflow_id: "workflow-1",
      workflow_version: 1,
      write_grants: options.writeGrants ?? [],
    });
    root.workers.push({
      child_session_id: taskID,
      created_at: timestamp,
      delivered_event_sequence: 0,
      job,
      latest_event: latestEvent,
      live_state:
        options.liveState ?? ((options.review ?? true) ? "review" : "busy"),
      mode: "verification",
      parent_session_id: parentSessionID,
      profile: "terra-max",
      run_sequence: 1,
      task_id: taskID,
      updated_at: timestamp,
      workflow_id: "workflow-1",
      workflow_version: 1,
    });
    if (options.pendingPermission) {
      root.permissions.push({
        created_at: timestamp,
        permission: "edit",
        request_id: "permission-internal-1",
        requested_paths: ["docs/outside.md"],
        task_id: taskID,
        tool: "write",
      });
    }
  });
  const sessions = new FakeTurnSessions();
  const files = new Map<string, string | null>(
    Object.entries(options.files ?? { "src/a.ts": "const value = 1;\n" })
  );
  const fingerprints = [...(options.fingerprints ?? [])];
  let fingerprintCalls = 0;
  let milliseconds = Date.parse(timestamp);
  const turns = new WorkerTurns({
    fingerprint: () => {
      fingerprintCalls += 1;
      const next = fingerprints.shift();
      if (next !== undefined) {
        return Promise.resolve(new Map(Object.entries(next)));
      }
      return Promise.resolve(
        new Map(
          [...files]
            .filter((entry): entry is [string, string] => entry[1] !== null)
            .map(([file, content]) => [
              file,
              createHash("sha256").update(content).digest("hex"),
            ])
        )
      );
    },
    now: () => milliseconds,
    readFile: (file) => {
      const relative = path.relative("/workspace", file).replaceAll("\\", "/");
      const content = files.get(relative);
      return content === undefined || content === null
        ? Promise.reject(
            Object.assign(new Error(`Missing fixture file ${relative}.`), {
              code: "ENOENT",
            })
          )
        : Promise.resolve(Buffer.from(content));
    },
    sessions,
    sleep: (duration) => {
      milliseconds += duration;
      return Promise.resolve();
    },
    store,
    ...(options.defaultArtifactDirectory
      ? {}
      : { artifactDirectory: path.join(directory, "worker-artifacts") }),
  });
  return {
    files,
    get fingerprintCalls() {
      return fingerprintCalls;
    },
    sessions,
    store,
    turns,
  };
};

const moveFixtureToReview = async (
  store: OrchestrationStore
): Promise<void> => {
  await store.mutateRoot(({ root, workflow }) => {
    workflow.markWorkerReview({
      job,
      result_available: true,
      workflow_id: "workflow-1",
    });
    const worker = root.workers[0];
    const run = root.job_runs[0];
    if (worker === undefined || run === undefined) {
      throw new Error("The worker review fixture is unavailable.");
    }
    worker.live_state = "review";
    run.result_available = true;
    run.state = "review";
  });
};

const setupTwoAttributedTurns = async () => {
  const fixture = await setup({
    fingerprints: [
      { "src/a.ts": "before-one" },
      { "src/a.ts": "after-one" },
      { "src/a.ts": "before-two" },
      { "src/a.ts": "after-two" },
    ],
    review: false,
    writeFiles: ["src/**"],
  });
  const firstFinal = fixture.sessions.records.get(taskID)?.at(-1);
  if (firstFinal === undefined) {
    throw new Error("The first final fixture message is unavailable.");
  }
  addPatchPart(firstFinal);
  await fixture.turns.beforeTool({
    args: { filePath: "/workspace/src/a.ts" },
    callID: "write-turn-1",
    sessionID: taskID,
    tool: "write",
  });
  await fixture.turns.afterTool({
    args: { filePath: "/workspace/src/a.ts" },
    callID: "write-turn-1",
    sessionID: taskID,
    tool: "write",
  });

  const secondUser = userMessage();
  secondUser.info.id = "user-turn-2";
  const secondFinal = finalMessage();
  secondFinal.info.id = "assistant-final-2";
  Reflect.set(secondFinal.info, "parentID", "user-turn-2");
  for (const part of secondFinal.parts) {
    part.id = `${part.id}-2`;
    part.messageID = "assistant-final-2";
  }
  addPatchPart(secondFinal);
  fixture.sessions.records.get(taskID)?.push(secondUser, secondFinal);
  fixture.sessions.diffs.set("user-turn-2", [
    {
      additions: 1,
      deletions: 1,
      patch: "SECOND PATCH",
      path: "src/a.ts",
      status: "modified",
    },
  ]);
  await fixture.turns.beforeTool({
    args: { filePath: "/workspace/src/a.ts" },
    callID: "write-turn-2",
    sessionID: taskID,
    tool: "write",
  });
  await fixture.turns.afterTool({
    args: { filePath: "/workspace/src/a.ts" },
    callID: "write-turn-2",
    sessionID: taskID,
    tool: "write",
  });
  await moveFixtureToReview(fixture.store);
  fixture.sessions.onRevert = () => {
    fixture.files.set("src/a.ts", "reverted\n");
  };
  return fixture;
};

describe("WorkerTurns pull-based metadata", () => {
  test("reads advertised diff and completed tool output before the worker turn finishes", async () => {
    const fixture = await setup({
      latestEvent: {
        created_at: timestamp,
        kind: "progress",
        message: "An emerging change is ready for supervision.",
        sequence: 1,
      },
      liveState: "busy",
      review: false,
    });
    fixture.sessions.records.set(taskID, [userMessage(), toolMessage()]);

    const status = await fixture.turns.status({
      parent_session_id: parentSessionID,
      task_id: taskID,
    });
    if (status.available_actions === undefined) {
      throw new Error(
        "Expected selected-worker actions during the active turn."
      );
    }

    expect(status.available_actions).toEqual(
      expect.arrayContaining([
        {
          args: {
            file: "src/a.ts",
            job,
            turn: 1,
            type: "diff",
          },
          tool: "agents_inspect",
        },
        {
          args: { job, tool: 1, turn: 1, type: "tool_output" },
          tool: "agents_inspect",
        },
      ])
    );
    expect(
      status.available_actions.some((action) =>
        ["agents_undo", "agents_redo"].includes(action.tool)
      )
    ).toBe(false);
    const diff = await fixture.turns.inspect({
      file: "src/a.ts",
      parent_session_id: parentSessionID,
      task_id: taskID,
      turn: 1,
      type: "diff",
    });
    const tool = await fixture.turns.inspect({
      parent_session_id: parentSessionID,
      task_id: taskID,
      tool: 1,
      turn: 1,
      type: "tool_output",
    });
    expect(JSON.stringify({ diff, tool })).not.toContain(PATCH_SENTINEL);
    expect(JSON.stringify({ diff, tool })).not.toContain(TOOL_SENTINEL);
    expect(await readFile(diff.artifact.path, "utf8")).toBe(PATCH_SENTINEL);
    expect(await readFile(tool.artifact.path, "utf8")).toBe(TOOL_SENTINEL);
    await expect(
      fixture.turns.inspect({
        parent_session_id: parentSessionID,
        task_id: taskID,
        turn: 1,
        type: "result",
      })
    ).rejects.toThrow(RESULT_UNAVAILABLE_PATTERN);
  });

  test("projects authored scope, run grants, and one pending write decision without its native ID", async () => {
    const { turns } = await setup({
      latestEvent: {
        created_at: timestamp,
        kind: "progress",
        message: "One structured write requires a Sol decision.",
        sequence: 1,
      },
      liveState: "busy",
      pendingPermission: true,
      review: false,
      writeFiles: ["src/**"],
      writeGrants: ["docs/approved.md"],
    });

    const selected = JSON.stringify(
      await turns.status({
        parent_session_id: parentSessionID,
        task_id: taskID,
      })
    );
    expect(JSON.parse(selected).worker).toMatchObject({
      pending_write_permission: {
        paths: ["docs/outside.md"],
        tool: "write",
      },
      writeFiles: ["src/**"],
      write_grants: ["docs/approved.md"],
    });
    expect(selected).not.toContain("permission-internal-1");

    const waited = JSON.stringify(
      await turns.wait({
        parent_session_id: parentSessionID,
        task_ids: [taskID],
        timeout_ms: 5,
        until: "any",
      })
    );
    expect(JSON.parse(waited).workers[0]).toMatchObject({
      pending_write_permission: {
        paths: ["docs/outside.md"],
        tool: "write",
      },
      write_grants: ["docs/approved.md"],
    });
    expect(waited).not.toContain("permission-internal-1");
  });

  test("numbers user-message turns and persists only diff/tool/result correlation plus metadata", async () => {
    const { store, turns } = await setup();

    await turns.refresh(taskID);

    const root = await store.readRoot();
    expect(root.turns).toHaveLength(1);
    expect(root.turns[0]).toMatchObject({
      boundary_message_id: "user-turn-1",
      completed_at: "2026-07-17T13:00:02.000Z",
      files: [
        {
          additions: 3,
          attributed: false,
          deletions: 1,
          end_sha256: createHash("sha256")
            .update("const value = 1;\n")
            .digest("hex"),
          path: "src/a.ts",
          status: "modified",
        },
      ],
      result_available: true,
      result_message_id: "assistant-final-1",
      tool_outputs: [
        {
          message_id: "assistant-tool-1",
          ordinal: 1,
          output_available: true,
          part_id: "part-tool-1",
          status: "completed",
          title: "Read source",
          tool: "read",
        },
      ],
      turn: 1,
      undo_state: "unavailable",
    });
    const persisted = JSON.stringify(root.turns[0]);
    expect(persisted).not.toContain(RESULT_SENTINEL);
    expect(persisted).not.toContain(TOOL_SENTINEL);
    expect(persisted).not.toContain(PATCH_SENTINEL);
  });

  test("keeps a terminal result that also contains a provider-executed tool part", async () => {
    const { sessions, store, turns } = await setup();
    const providerFinal = finalMessage();
    providerFinal.parts.unshift({
      callID: "provider-call-1",
      id: "provider-part-1",
      messageID: "assistant-final-1",
      metadata: { providerExecuted: true },
      sessionID: taskID,
      state: {
        input: {},
        metadata: {},
        output: "provider output",
        status: "completed",
        time: { end: 2, start: 1 },
        title: "Provider search",
      },
      tool: "web_search",
      type: "tool",
    });
    sessions.records.set(taskID, [userMessage(), providerFinal]);

    await turns.refresh(taskID);

    expect((await store.readRoot()).turns[0]).toMatchObject({
      result_available: true,
      result_message_id: "assistant-final-1",
      tool_outputs: [
        {
          ordinal: 1,
          output_available: true,
          tool: "web_search",
        },
      ],
    });
  });

  test("projects compact list and selected status without internal IDs or bulk content", async () => {
    const { turns } = await setup();

    const listed = await turns.status({ parent_session_id: parentSessionID });
    const selected = await turns.status({
      parent_session_id: parentSessionID,
      task_id: taskID,
    });

    if (listed.workers === undefined) {
      throw new Error("Worker list projection is unavailable.");
    }
    if (selected.worker === undefined || !("turns" in selected.worker)) {
      throw new Error("Selected worker projection is unavailable.");
    }
    expect(listed.workers).toHaveLength(1);
    expect(listed.workers[0]).toMatchObject({
      job,
      live_state: "review",
      mode: "verification",
      profile: "terra-max",
      result_available: true,
      turn_count: 1,
    });
    expect(selected.worker.turns[0]).toEqual({
      completed: true,
      files: [
        {
          additions: 3,
          deletions: 1,
          path: "src/a.ts",
          status: "modified",
        },
      ],
      isolated: false,
      result_available: true,
      tool_outputs: [
        {
          output_available: true,
          status: "completed",
          title: "Read source",
          tool: "read",
          tool_number: 1,
        },
      ],
      turn: 1,
      undo_available: false,
      undo_unavailable_reason: "Mutation provenance is not established.",
    });
    expect(selected.available_actions).toEqual(
      expect.arrayContaining([
        {
          args: { job, turn: 1, type: "result" },
          tool: "agents_inspect",
        },
        {
          args: {
            file: "src/a.ts",
            job,
            turn: 1,
            type: "diff",
          },
          tool: "agents_inspect",
        },
        {
          args: { job, tool: 1, turn: 1, type: "tool_output" },
          tool: "agents_inspect",
        },
        { args: {}, needs: ["message"], tool: "workflow_complete" },
        { args: {}, needs: ["reason"], tool: "workflow_retry" },
        { args: { job }, tool: "agents_interrupt" },
      ])
    );
    expect(selected).not.toHaveProperty("next_actions");
    const projected = JSON.stringify({ listed, selected });
    expect(projected).not.toMatch(INTERNAL_ID_PATTERN);
    expect(projected).not.toContain(RESULT_SENTINEL);
    expect(projected).not.toContain(TOOL_SENTINEL);
    expect(projected).not.toContain(PATCH_SENTINEL);
  });

  test("materializes exactly one advertised result, tool output, or diff and returns metadata only", async () => {
    const { turns } = await setup();
    await turns.status({ parent_session_id: parentSessionID, task_id: taskID });

    const result = await turns.inspect({
      parent_session_id: parentSessionID,
      task_id: taskID,
      turn: 1,
      type: "result",
    });
    const tool = await turns.inspect({
      parent_session_id: parentSessionID,
      task_id: taskID,
      tool: 1,
      turn: 1,
      type: "tool_output",
    });
    const diff = await turns.inspect({
      file: "src/a.ts",
      parent_session_id: parentSessionID,
      task_id: taskID,
      turn: 1,
      type: "diff",
    });

    expect(result).toMatchObject({
      artifact: {
        bytes: Buffer.byteLength(RESULT_SENTINEL),
        file: "result.md",
        sha256: createHash("sha256").update(RESULT_SENTINEL).digest("hex"),
      },
      type: "result",
    });
    expect(tool).toMatchObject({
      artifact: {
        bytes: Buffer.byteLength(TOOL_SENTINEL),
        file: "tool-1-read.txt",
      },
      tool: 1,
    });
    expect(diff).toMatchObject({
      artifact: {
        bytes: Buffer.byteLength(PATCH_SENTINEL),
        file: "diff-src-a-ts.patch",
      },
      file: "src/a.ts",
    });
    expect(await readFile(result.artifact.path, "utf8")).toBe(RESULT_SENTINEL);
    expect(await readFile(tool.artifact.path, "utf8")).toBe(TOOL_SENTINEL);
    expect(await readFile(diff.artifact.path, "utf8")).toBe(PATCH_SENTINEL);
    expect(path.dirname(result.artifact.path)).toBe(result.artifact.directory);
    expect(path.basename(result.artifact.path)).toBe(result.artifact.file);
    expect((await stat(result.artifact.directory)).mode % 0o1000).toBe(0o700);
    expect((await stat(result.artifact.path)).mode % 0o1000).toBe(0o600);
    const metadata = JSON.stringify({ result, tool, diff });
    expect(metadata).not.toMatch(INTERNAL_ID_PATTERN);
    expect(metadata).not.toContain(RESULT_SENTINEL);
    expect(metadata).not.toContain(TOOL_SENTINEL);
    expect(metadata).not.toContain(PATCH_SENTINEL);
  });

  test("materializes default artifacts inside OpenCode's permission-free temporary directory", async () => {
    const { turns } = await setup({ defaultArtifactDirectory: true });
    await turns.status({ parent_session_id: parentSessionID, task_id: taskID });

    const result = await turns.inspect({
      parent_session_id: parentSessionID,
      task_id: taskID,
      turn: 1,
      type: "result",
    });

    const relative = path.relative(
      path.join(os.tmpdir(), "opencode"),
      result.artifact.path
    );
    expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(false);
    const workflowDirectory = path.resolve(result.artifact.directory, "../..");
    directories.push(path.dirname(workflowDirectory));

    await turns.cleanupWorkflow("workflow-1");

    await expect(stat(workflowDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("inspects an advertised completed tool output from a superseded turn", async () => {
    const { sessions, turns } = await setup();
    const secondUser: OpenCodeMessageRecord = {
      info: {
        id: "user-turn-2",
        role: "user",
        sessionID: taskID,
        time: { created: Date.parse(timestamp) + 2500 },
      },
      parts: [],
    };
    const secondFinal = finalMessage();
    secondFinal.info.id = "assistant-final-2";
    secondFinal.info.parentID = "user-turn-2";
    secondFinal.info.time = {
      completed: Date.parse(timestamp) + 4000,
      created: Date.parse(timestamp) + 3000,
    };
    sessions.records.set(taskID, [
      userMessage(),
      toolMessage(),
      secondUser,
      secondFinal,
    ]);

    const inspected = await turns.inspect({
      parent_session_id: parentSessionID,
      task_id: taskID,
      tool: 1,
      turn: 1,
      type: "tool_output",
    });
    expect(inspected).toMatchObject({
      artifact: { file: "tool-1-read.txt" },
      tool: 1,
      turn: 1,
    });
    expect(await readFile(inspected.artifact.path, "utf8")).toBe(TOOL_SENTINEL);
  });

  test("treats an omitted native status entry as idle in review", async () => {
    const { sessions, turns } = await setup();
    sessions.statusValue = undefined;

    const selected = await turns.status({
      parent_session_id: parentSessionID,
      task_id: taskID,
    });
    if (selected.worker === undefined || !("turns" in selected.worker)) {
      throw new Error("Selected worker turns are unavailable.");
    }
    expect(selected.worker.turns[0]?.undo_unavailable_reason).toBe(
      "Mutation provenance is not established."
    );
  });

  test("does not treat a completed steering delivery as pending undo work", async () => {
    const { store, turns } = await setup();
    await store.mutateRoot(({ root }) => {
      root.deliveries.push({
        child_user_message_id: "msg_completed-steering",
        created_at: timestamp,
        delivery_id: "completed-delivery-1",
        message: "Already delivered steering.",
        state: "completed",
        task_id: taskID,
        updated_at: timestamp,
      });
    });

    const selected = await turns.status({
      parent_session_id: parentSessionID,
      task_id: taskID,
    });
    if (selected.worker === undefined || !("turns" in selected.worker)) {
      throw new Error("Selected worker turns are unavailable.");
    }
    expect(selected.worker.turns[0]?.undo_unavailable_reason).toBe(
      "Mutation provenance is not established."
    );
  });

  test("writes the complete UTF-8 result without injecting any of it into metadata", async () => {
    const { sessions, turns } = await setup();
    const multibyte = finalMessage();
    const textPart = multibyte.parts[0];
    if (textPart === undefined) {
      throw new Error("Result text fixture is unavailable.");
    }
    textPart.text = "A€B";
    sessions.records.set(taskID, [userMessage(), multibyte]);
    await turns.refresh(taskID);

    const result = await turns.inspect({
      parent_session_id: parentSessionID,
      task_id: taskID,
      type: "result",
    });
    expect(await readFile(result.artifact.path, "utf8")).toBe("A€B");
    expect(JSON.stringify(result)).not.toContain("A€B");
  });

  test("rejects invalid inspection combinations and unavailable or malformed selected items", async () => {
    const { sessions, turns } = await setup();
    await turns.refresh(taskID);

    for (const input of [
      { parent_session_id: parentSessionID, task_id: taskID, type: "diff" },
      {
        file: "src/a.ts",
        parent_session_id: parentSessionID,
        task_id: taskID,
        type: "result",
      },
      {
        parent_session_id: parentSessionID,
        task_id: taskID,
        type: "tool_output",
      },
      {
        parent_session_id: parentSessionID,
        task_id: taskID,
        tool: 1,
        type: "result",
      },
    ]) {
      await expect(turns.inspect(input)).rejects.toThrow();
    }
    await expect(
      turns.inspect({
        file: "src/unadvertised.ts",
        parent_session_id: parentSessionID,
        task_id: taskID,
        type: "diff",
      })
    ).rejects.toThrow(UNADVERTISED_ITEM_PATTERN);
    const malformed = toolMessage();
    const part = malformed.parts[0];
    if (part !== undefined) {
      Reflect.deleteProperty(part, "state");
    }
    sessions.records.set(taskID, [userMessage(), malformed, finalMessage()]);
    await expect(turns.refresh(taskID)).rejects.toThrow(MALFORMED_TOOL_PATTERN);
  });

  test("waits on internal event watermarks and advances only returned workers", async () => {
    const progress: LatestEvent = {
      created_at: timestamp,
      kind: "progress",
      message: "First bounded progress.",
      sequence: 1,
    };
    const { store, turns } = await setup({
      latestEvent: progress,
      liveState: "busy",
      review: false,
    });

    const first = await turns.wait({
      parent_session_id: parentSessionID,
      task_ids: [taskID],
      timeout_ms: 5,
      until: "any",
    });
    expect(first).toMatchObject({ timed_out: false });
    expect(first.workers[0]).toMatchObject({
      job,
      latest_event: { kind: "progress", message: "First bounded progress." },
    });
    expect((await store.readRoot()).workers[0]?.delivered_event_sequence).toBe(
      1
    );

    const timeout = await turns.wait({
      parent_session_id: parentSessionID,
      task_ids: [taskID],
      timeout_ms: 5,
      until: "all",
    });
    expect(timeout.timed_out).toBe(true);
    expect((await store.readRoot()).workers[0]?.delivered_event_sequence).toBe(
      1
    );

    await store.mutateRoot(({ root }) => {
      const worker = root.workers[0];
      if (worker !== undefined) {
        worker.latest_event = {
          created_at: timestamp,
          kind: "progress",
          message: "Second bounded progress.",
          sequence: 2,
        };
      }
    });
    const second = await turns.wait({
      parent_session_id: parentSessionID,
      task_ids: [taskID],
      timeout_ms: 5,
      until: "all",
    });
    expect(second.timed_out).toBe(false);
    expect(second.workers[0]?.latest_event).toEqual({
      kind: "progress",
      message: "Second bounded progress.",
    });
    expect((await store.readRoot()).workers[0]?.delivered_event_sequence).toBe(
      2
    );
  });

  test("times out honestly for an active idle worker without a new event", async () => {
    const { store, turns } = await setup({
      latestEvent: null,
      liveState: "busy",
      review: false,
    });
    await store.mutateRoot(({ root }) => {
      const worker = root.workers[0];
      if (worker !== undefined) {
        worker.live_state = "idle";
      }
    });

    expect(
      await turns.wait({
        parent_session_id: parentSessionID,
        task_ids: [taskID],
        timeout_ms: 5,
        until: "all",
      })
    ).toMatchObject({ timed_out: true });
  });

  test("any/all waits advance only the exact workers returned", async () => {
    const firstProgress: LatestEvent = {
      created_at: timestamp,
      kind: "progress",
      message: "First worker event.",
      sequence: 1,
    };
    const { store, turns } = await setup({
      latestEvent: firstProgress,
      liveState: "busy",
      review: false,
    });
    await store.mutateWorkflow((workflow) => {
      workflow.markWorkerActive({
        job: "second worker",
        task_id: "child-2",
        workflow_id: "workflow-1",
      });
    });
    await store.mutateRoot(({ root }) => {
      root.job_runs.push({
        job: "second worker",
        result_available: false,
        run_sequence: 1,
        started_at: timestamp,
        state: "active",
        task_id: "child-2",
        updated_at: timestamp,
        workflow_id: "workflow-1",
        workflow_version: 1,
        write_grants: [],
      });
      root.workers.push({
        child_session_id: "child-2",
        created_at: timestamp,
        delivered_event_sequence: 0,
        job: "second worker",
        latest_event: null,
        live_state: "busy",
        mode: "research",
        parent_session_id: parentSessionID,
        profile: "luna-medium",
        run_sequence: 1,
        task_id: "child-2",
        updated_at: timestamp,
        workflow_id: "workflow-1",
        workflow_version: 1,
      });
    });

    const any = await turns.wait({
      parent_session_id: parentSessionID,
      task_ids: [taskID, "child-2"],
      timeout_ms: 5,
      until: "any",
    });
    expect(any.workers.map((worker) => worker.job)).toEqual([job]);
    let workers = (await store.readRoot()).workers;
    expect(workers.find((worker) => worker.task_id === taskID)).toMatchObject({
      delivered_event_sequence: 1,
    });
    expect(
      workers.find((worker) => worker.task_id === "child-2")
    ).toMatchObject({ delivered_event_sequence: 0 });

    await store.mutateRoot(({ root }) => {
      const first = root.workers.find((worker) => worker.task_id === taskID);
      const second = root.workers.find(
        (worker) => worker.task_id === "child-2"
      );
      if (first !== undefined) {
        first.latest_event = {
          created_at: timestamp,
          kind: "progress",
          message: "First worker second event.",
          sequence: 2,
        };
      }
      if (second !== undefined) {
        second.latest_event = {
          created_at: timestamp,
          kind: "progress",
          message: "Second worker first event.",
          sequence: 1,
        };
      }
    });
    const all = await turns.wait({
      parent_session_id: parentSessionID,
      task_ids: [taskID, "child-2"],
      timeout_ms: 5,
      until: "all",
    });
    expect(all.workers.map((worker) => worker.job)).toEqual([
      job,
      "second worker",
    ]);
    workers = (await store.readRoot()).workers;
    expect(
      workers.map((worker) => ({
        sequence: worker.delivered_event_sequence,
        task_id: worker.task_id,
      }))
    ).toEqual([
      { sequence: 2, task_id: taskID },
      { sequence: 1, task_id: "child-2" },
    ]);
  });

  test("attributes exact structured changes while ignoring a pre-existing dirty baseline", async () => {
    const fixture = await setup({
      fingerprints: [
        { "docs/pre-existing.md": "dirty", "src/a.ts": "before" },
        { "docs/pre-existing.md": "dirty", "src/a.ts": "after" },
      ],
      review: false,
      writeFiles: ["src/**"],
    });
    const final = fixture.sessions.records.get(taskID)?.at(-1);
    if (final === undefined) {
      throw new Error("The final fixture message is unavailable.");
    }
    addPatchPart(final);

    await fixture.turns.beforeTool({
      args: { filePath: "/workspace/src/a.ts" },
      callID: "write-call-1",
      sessionID: taskID,
      tool: "write",
    });
    expect(
      await fixture.turns.afterTool({
        args: { filePath: "/workspace/src/a.ts" },
        callID: "write-call-1",
        sessionID: taskID,
        tool: "write",
      })
    ).toBeNull();
    await moveFixtureToReview(fixture.store);

    const status = await fixture.turns.status({
      parent_session_id: parentSessionID,
      task_id: taskID,
    });
    if (status.worker === undefined || !("turns" in status.worker)) {
      throw new Error("The attributed worker status is unavailable.");
    }
    expect(status.worker.turns[0]).toMatchObject({
      isolated: true,
      undo_available: true,
    });
    expect((await fixture.store.readRoot()).turns[0]?.files).toMatchObject([
      { attributed: true, path: "src/a.ts" },
    ]);
  });

  test("audits only scoped shell calls and reports exact violation paths without reverting", async () => {
    const scoped = await setup({
      fingerprints: [
        { "docs/pre-existing.md": "dirty", "src/a.ts": "same" },
        {
          "docs/outside.md": "created",
          "docs/pre-existing.md": "dirty",
          "src/a.ts": "same",
        },
      ],
      review: false,
      writeFiles: ["src/**"],
    });
    await scoped.turns.beforeTool({
      args: { command: "create docs/outside.md" },
      callID: "bash-call-1",
      sessionID: taskID,
      tool: "bash",
    });
    expect(
      await scoped.turns.afterTool({
        args: { command: "create docs/outside.md" },
        callID: "bash-call-1",
        sessionID: taskID,
        tool: "bash",
      })
    ).toEqual({
      allowed: ["src/**"],
      kind: "scope_violation",
      paths: ["docs/outside.md"],
    });

    const unscoped = await setup({
      fingerprints: [{ "docs/unrestricted.md": "before" }],
      review: false,
    });
    await unscoped.turns.beforeTool({
      args: { command: "write anywhere" },
      callID: "bash-call-2",
      sessionID: taskID,
      tool: "bash",
    });
    expect(
      await unscoped.turns.afterTool({
        args: { command: "write anywhere" },
        callID: "bash-call-2",
        sessionID: taskID,
        tool: "bash",
      })
    ).toBeNull();
    expect(unscoped.fingerprintCalls).toBe(0);
  });

  test("treats an overlapping mutator as a conservative scope-audit conflict", async () => {
    const fixture = await setup({
      fingerprints: [{ "src/a.ts": "before" }, { "src/a.ts": "after" }],
      review: false,
      writeFiles: ["src/**"],
    });
    await fixture.turns.beforeTool({
      args: { command: "update src/a.ts" },
      callID: "worker-bash",
      sessionID: taskID,
      tool: "bash",
    });
    await fixture.turns.beforeTool({
      args: { command: "concurrent parent mutation" },
      callID: "parent-bash",
      sessionID: parentSessionID,
      tool: "bash",
    });
    expect(
      await fixture.turns.afterTool({
        args: { command: "update src/a.ts" },
        callID: "worker-bash",
        sessionID: taskID,
        tool: "bash",
      })
    ).toEqual({
      allowed: ["src/**"],
      kind: "scope_audit_conflict",
      paths: ["src/a.ts"],
    });
    await fixture.turns.afterTool({
      args: { command: "concurrent parent mutation" },
      callID: "parent-bash",
      sessionID: parentSessionID,
      tool: "bash",
    });
  });

  test("blocks restart recovery when a durable mutation never reached its after-hook", async () => {
    const fixture = await setup({
      fingerprints: [{ "src/a.ts": "before" }],
      review: false,
      writeFiles: ["src/**"],
    });
    await fixture.turns.beforeTool({
      args: { command: "mutate then lose the process" },
      callID: "lost-shell",
      sessionID: taskID,
      tool: "bash",
    });

    expect(await fixture.turns.reconcileIncompleteMutations()).toEqual([
      taskID,
    ]);
    const root = await fixture.store.readRoot();
    expect(root.workers[0]?.live_state).toBe("blocked");
    expect(root.job_runs[0]?.state).toBe("blocked");
    expect(root.turns[0]?.mutation_epochs).toMatchObject([
      { call_id: "lost-shell", completed_at: null },
    ]);
  });

  test("undoes and redoes one isolated reviewed job run through guarded native boundaries", async () => {
    const fixture = await setup({
      files: { "README.md": "seed\n", "result.txt": "STEERED\n" },
      fingerprints: [
        { "README.md": "seed\n" },
        { "README.md": "seed\n", "result.txt": "STEERED\n" },
      ],
      review: false,
      writeFiles: ["result.txt"],
    });
    const final = fixture.sessions.records.get(taskID)?.at(-1);
    if (final === undefined) {
      throw new Error("The final fixture message is unavailable.");
    }
    fixture.sessions.diffs.set("user-turn-1", [
      {
        additions: 1,
        deletions: 0,
        patch: "+STEERED",
        path: "result.txt",
        status: "added",
      },
    ]);
    addPatchPart(final, ["/workspace/result.txt"]);
    await fixture.turns.beforeTool({
      args: { filePath: "/workspace/result.txt" },
      callID: "write-call-undo",
      sessionID: taskID,
      tool: "write",
    });
    await fixture.turns.afterTool({
      args: { filePath: "/workspace/result.txt" },
      callID: "write-call-undo",
      sessionID: taskID,
      tool: "write",
    });
    await moveFixtureToReview(fixture.store);
    fixture.sessions.onRevert = () => {
      fixture.files.set("result.txt", null);
    };
    fixture.sessions.onUnrevert = () => {
      fixture.files.set("result.txt", "STEERED\n");
    };
    fixture.sessions.statusValues = ["busy", "idle"];

    expect(
      await fixture.turns.undo({
        parent_session_id: parentSessionID,
        reason: "Reject the complete worker result.",
        scope: "job_run",
        task_id: taskID,
      })
    ).toEqual({ accepted: true, scope: "job_run", task_id: taskID });
    expect(fixture.sessions.revertCalls).toEqual([
      { messageID: "user-turn-1", sessionID: taskID },
    ]);
    let root = await fixture.store.readRoot();
    expect(root.turns[0]?.undo_state).toBe("redo_available");
    expect(root.job_runs[0]?.state).toBe("rejected");
    expect(root.workers[0]?.live_state).toBe("blocked");

    fixture.sessions.statusValue = "busy";
    await expect(
      fixture.turns.redo({
        parent_session_id: parentSessionID,
        task_id: taskID,
      })
    ).rejects.toThrow(BUSY_UNDO_PATTERN);
    expect(fixture.sessions.unrevertCalls).toEqual([]);
    fixture.sessions.statusValue = "idle";

    fixture.files.set("result.txt", "DRIFT\n");
    await expect(
      fixture.turns.redo({
        parent_session_id: parentSessionID,
        task_id: taskID,
      })
    ).rejects.toThrow(REDO_DRIFT_PATTERN);
    expect(fixture.sessions.unrevertCalls).toEqual([]);
    fixture.files.set("result.txt", null);
    fixture.sessions.statusValues = ["busy", "idle"];

    expect(
      await fixture.turns.redo({
        parent_session_id: parentSessionID,
        task_id: taskID,
      })
    ).toEqual({ accepted: true, task_id: taskID });
    expect(fixture.sessions.unrevertCalls).toEqual([taskID]);
    root = await fixture.store.readRoot();
    expect(root.turns[0]?.undo_state).toBe("available");
    expect(root.job_runs[0]?.state).toBe("review");
    expect(root.workers[0]?.live_state).toBe("review");
  });

  test("selects the latest-turn boundary separately from the default complete-run boundary", async () => {
    const latest = await setupTwoAttributedTurns();
    await latest.turns.undo({
      parent_session_id: parentSessionID,
      reason: "Reject only the latest turn.",
      scope: "latest_turn",
      task_id: taskID,
    });
    expect(latest.sessions.revertCalls).toEqual([
      { messageID: "user-turn-2", sessionID: taskID },
    ]);

    const completeRun = await setupTwoAttributedTurns();
    await completeRun.turns.undo({
      parent_session_id: parentSessionID,
      reason: "Reject the complete run.",
      task_id: taskID,
    });
    expect(completeRun.sessions.revertCalls).toEqual([
      { messageID: "user-turn-1", sessionID: taskID },
    ]);
  });

  test("refuses undo while busy or permission-suspended and refuses redo after post-undo drift", async () => {
    const fixture = await setup({
      fingerprints: [{ "src/a.ts": "before" }, { "src/a.ts": "after" }],
      review: false,
      writeFiles: ["src/**"],
    });
    const final = fixture.sessions.records.get(taskID)?.at(-1);
    if (final === undefined) {
      throw new Error("The final fixture message is unavailable.");
    }
    addPatchPart(final);
    await fixture.turns.beforeTool({
      args: { filePath: "/workspace/src/a.ts" },
      callID: "write-guarded",
      sessionID: taskID,
      tool: "write",
    });
    await fixture.turns.afterTool({
      args: { filePath: "/workspace/src/a.ts" },
      callID: "write-guarded",
      sessionID: taskID,
      tool: "write",
    });
    await moveFixtureToReview(fixture.store);
    fixture.sessions.statusValue = "busy";
    await expect(
      fixture.turns.undo({
        parent_session_id: parentSessionID,
        reason: "Busy must fail.",
        task_id: taskID,
      })
    ).rejects.toThrow(BUSY_UNDO_PATTERN);
    expect(fixture.sessions.revertCalls).toEqual([]);

    fixture.sessions.statusValue = "idle";
    await fixture.store.mutateRoot(({ root }) => {
      root.permissions.push({
        created_at: timestamp,
        permission: "edit",
        request_id: "permission-undo-guard",
        requested_paths: ["docs/pending.md"],
        task_id: taskID,
        tool: "write",
      });
    });
    await expect(
      fixture.turns.undo({
        parent_session_id: parentSessionID,
        reason: "Pending permission must fail.",
        task_id: taskID,
      })
    ).rejects.toThrow(PENDING_UNDO_PATTERN);
    expect(fixture.sessions.revertCalls).toEqual([]);
    await fixture.store.mutateRoot(({ root }) => {
      root.permissions = [];
    });
    fixture.sessions.onRevert = () => {
      fixture.files.set("src/a.ts", "reverted\n");
    };
    await fixture.turns.undo({
      parent_session_id: parentSessionID,
      reason: "Create a guarded redo window.",
      task_id: taskID,
    });
    fixture.files.set("docs/unrelated-user-change.md", "changed after undo\n");
    await expect(
      fixture.turns.redo({
        parent_session_id: parentSessionID,
        task_id: taskID,
      })
    ).rejects.toThrow(REDO_DRIFT_PATTERN);
    expect(fixture.sessions.unrevertCalls).toEqual([]);
  });

  test("does not commit plugin undo state when OpenCode omits the expected revert marker", async () => {
    const fixture = await setup({
      fingerprints: [{ "src/a.ts": "before" }, { "src/a.ts": "after" }],
      review: false,
      writeFiles: ["src/**"],
    });
    const final = fixture.sessions.records.get(taskID)?.at(-1);
    if (final === undefined) {
      throw new Error("The final fixture message is unavailable.");
    }
    addPatchPart(final);
    await fixture.turns.beforeTool({
      args: { filePath: "/workspace/src/a.ts" },
      callID: "write-missing-revert",
      sessionID: taskID,
      tool: "write",
    });
    await fixture.turns.afterTool({
      args: { filePath: "/workspace/src/a.ts" },
      callID: "write-missing-revert",
      sessionID: taskID,
      tool: "write",
    });
    await moveFixtureToReview(fixture.store);
    fixture.sessions.retainRevert = false;

    await expect(
      fixture.turns.undo({
        parent_session_id: parentSessionID,
        reason: "Native state must be retained.",
        task_id: taskID,
      })
    ).rejects.toThrow(REVERT_STATE_PATTERN);
    const root = await fixture.store.readRoot();
    expect(root.job_runs[0]?.state).toBe("review");
    expect(root.workers[0]?.live_state).toBe("review");
  });

  test("refuses hash drift and unexpected native patch paths before any revert call", async () => {
    for (const hazard of ["hash_drift", "unexpected_patch"] as const) {
      const fixture = await setup({
        fingerprints: [{ "src/a.ts": "before" }, { "src/a.ts": "after" }],
        review: false,
        writeFiles: ["src/**"],
      });
      const final = fixture.sessions.records.get(taskID)?.at(-1);
      if (final === undefined) {
        throw new Error("The final fixture message is unavailable.");
      }
      addPatchPart(
        final,
        hazard === "unexpected_patch"
          ? ["/workspace/src/a.ts", "/workspace/docs/unexpected.md"]
          : undefined
      );
      await fixture.turns.beforeTool({
        args: { filePath: "/workspace/src/a.ts" },
        callID: `write-${hazard}`,
        sessionID: taskID,
        tool: "write",
      });
      await fixture.turns.afterTool({
        args: { filePath: "/workspace/src/a.ts" },
        callID: `write-${hazard}`,
        sessionID: taskID,
        tool: "write",
      });
      await moveFixtureToReview(fixture.store);
      if (hazard === "hash_drift") {
        fixture.files.set("src/a.ts", "changed after worker completion\n");
      }

      await expect(
        fixture.turns.undo({
          parent_session_id: parentSessionID,
          reason: "This must fail closed.",
          task_id: taskID,
        })
      ).rejects.toThrow(UNSAFE_UNDO_PATTERN);
      expect(fixture.sessions.revertCalls).toEqual([]);
    }
  });
});
