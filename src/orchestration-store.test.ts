import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { PathLike } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  OrchestrationStore,
  OrchestrationStoreError,
  resolveStatePath,
} from "./orchestration-store.js";
import { RootSnapshotSchema } from "./schema/orchestration.js";
import type { WorkflowState } from "./workflow-state.js";

const timestamp = "2026-07-17T10:00:00.000Z";
const ACTIVE_PATTERN = /active/;

const nodeFS = {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
};

const withTemporaryDirectory = async <Value>(
  run: (directory: string) => Promise<Value>
): Promise<Value> => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencode-sol-orchestrator-ts-")
  );
  try {
    return await run(directory);
  } finally {
    await nodeFS.rm(directory, { force: true, recursive: true });
  }
};

const statePathFor = (directory: string): string =>
  path.join(directory, "private", "state-v2.json");

const definition = (job: string) => ({
  objective: `Complete ${job}.`,
  steps: [
    {
      dependsOn: [],
      jobs: [
        {
          actor: { type: "orchestrator" as const },
          dependsOn: [],
          name: job,
          objective: `Own ${job}.`,
        },
      ],
      name: `step for ${job}`,
      objective: `Run ${job}.`,
    },
  ],
});

const addHistoricalWorkflow = (
  workflow: WorkflowState,
  workflowID: string
): void => {
  const job = `record ${workflowID}`;
  workflow.start({
    definition: definition(job),
    orchestrator_agent_id: "sol",
    parent_session_id: `parent-${workflowID}`,
    workflow_id: workflowID,
  });
  workflow.completeJob({
    job,
    message: "Recorded.",
    workflow_id: workflowID,
  });
};

const workflowIDs = (root: ReturnType<typeof RootSnapshotSchema.parse>) =>
  root.workflows.workflows.map((workflow) => workflow.workflow_id).sort();

describe("OrchestrationStore fresh namespace", () => {
  test("starts empty and persists workflow plus root metadata in one transaction", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const store = new OrchestrationStore({
        now: () => timestamp,
        statePath,
      });

      expect(await store.readRoot()).toEqual({
        deliveries: [],
        goals: { goals: [] },
        job_runs: [],
        permissions: [],
        schema_version: 1,
        turns: [],
        workers: [],
        workflows: { workflows: [] },
      });

      const result = await store.mutateRoot(({ workflow }) => {
        workflow.start({
          definition: definition("frame state"),
          orchestrator_agent_id: "sol",
          parent_session_id: "parent-1",
          workflow_id: "workflow-1",
        });
        addHistoricalWorkflow(workflow, "historical");
        return "committed";
      });

      expect(result).toBe("committed");
      const restarted = new OrchestrationStore({ statePath });
      expect(
        await restarted.readWorkflow(
          (workflow) => workflow.currentFor("parent-1", "sol")?.workflow_id
        )
      ).toBe("workflow-1");
      expect(workflowIDs(await restarted.readRoot())).toEqual([
        "historical",
        "workflow-1",
      ]);
      expect(
        RootSnapshotSchema.parse(
          JSON.parse(await nodeFS.readFile(statePath, "utf8"))
        )
      ).toBeDefined();
    }));

  test("isolates current workflows by parent and clears only the completed pointer", async () =>
    withTemporaryDirectory(async (directory) => {
      const store = new OrchestrationStore({
        now: () => timestamp,
        statePath: statePathFor(directory),
      });
      await store.mutateWorkflow((workflow) => {
        workflow.start({
          definition: definition("first obligation"),
          orchestrator_agent_id: "sol",
          parent_session_id: "parent-1",
          workflow_id: "workflow-1",
        });
        workflow.start({
          definition: definition("second obligation"),
          orchestrator_agent_id: "sol",
          parent_session_id: "parent-2",
          workflow_id: "workflow-2",
        });
      });
      await store.mutateRoot(({ workflow }) => {
        workflow.completeJob({
          job: "first obligation",
          message: "Accepted.",
          workflow_id: "workflow-1",
        });
      });

      const state = await store.readWorkflow((workflow) => ({
        first: workflow.currentFor("parent-1", "sol"),
        second: workflow.currentFor("parent-2", "sol"),
      }));
      expect(state.first).toBeUndefined();
      expect(state.second?.workflow_id).toBe("workflow-2");
      expect(
        (await store.readRoot()).workflows.workflows.find(
          (candidate) => candidate.workflow_id === "workflow-1"
        )?.current
      ).toBe(false);
    }));

  test("round-trips pending delivery, permission, worker, turn, and run metadata", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const store = new OrchestrationStore({ statePath });
      await store.mutateWorkflow((workflow) => {
        workflow.start({
          definition: {
            objective: "Verify restart metadata.",
            steps: [
              {
                dependsOn: [],
                jobs: [
                  {
                    actor: { profile: "luna-max", type: "worker" },
                    dependsOn: [],
                    mode: "verification",
                    name: "verify restart",
                    objective: "Verify restart state.",
                    writeFiles: [],
                  },
                ],
                name: "restart",
                objective: "Persist restart state.",
              },
            ],
          },
          orchestrator_agent_id: "sol",
          parent_session_id: "parent-1",
          workflow_id: "workflow-1",
        });
        workflow.markWorkerActive({
          job: "verify restart",
          task_id: "task-1",
          workflow_id: "workflow-1",
        });
      });
      await store.mutateRoot(({ root }) => {
        root.job_runs.push({
          job: "verify restart",
          result_available: false,
          run_sequence: 1,
          started_at: timestamp,
          state: "active",
          task_id: "task-1",
          updated_at: timestamp,
          workflow_id: "workflow-1",
          workflow_version: 1,
          write_grants: [],
        });
        root.workers.push({
          child_session_id: "child-1",
          created_at: timestamp,
          delivered_event_sequence: 0,
          job: "verify restart",
          latest_event: null,
          live_state: "preempting",
          mode: "verification",
          parent_session_id: "parent-1",
          profile: "luna-max",
          run_sequence: 1,
          task_id: "task-1",
          updated_at: timestamp,
          workflow_id: "workflow-1",
          workflow_version: 1,
        });
        root.deliveries.push({
          child_user_message_id: null,
          created_at: timestamp,
          delivery_id: "delivery-1",
          message: "Stop and inspect the strict parser.",
          state: "pending_preemption",
          task_id: "task-1",
          updated_at: timestamp,
        });
        root.permissions.push({
          created_at: timestamp,
          permission: "edit",
          request_id: "permission-1",
          requested_paths: ["src/server.ts"],
          task_id: "task-1",
          tool: "apply_patch",
        });
        root.turns.push({
          boundary_message_id: "message-1",
          completed_at: null,
          files: [],
          mutation_epochs: [],
          post_undo_hashes: [],
          result_available: false,
          result_message_id: null,
          run_sequence: 1,
          started_at: timestamp,
          task_id: "task-1",
          tool_outputs: [],
          turn: 1,
          undo_state: "unavailable",
          undo_unavailable_reason: "The worker turn is still active.",
        });
      });

      const restarted = new OrchestrationStore({ statePath });
      const root = await restarted.readRoot();
      expect(root.job_runs).toHaveLength(1);
      expect(root.workers[0]?.live_state).toBe("preempting");
      expect(root.deliveries[0]?.message).toBe(
        "Stop and inspect the strict parser."
      );
      expect(root.permissions[0]?.request_id).toBe("permission-1");
      expect(root.turns[0]?.undo_unavailable_reason).toMatch(ACTIVE_PATTERN);
      expect(root.job_runs[0]).not.toHaveProperty("result_body");
      expect(root.workers[0]).not.toHaveProperty("transcript");
      expect(root.turns[0]).not.toHaveProperty("patch");
      expect(root.turns[0]?.tool_outputs[0]).not.toHaveProperty("output");
    }));

  test("rejects asynchronous transactions and rolls tentative changes back", async () =>
    withTemporaryDirectory(async (directory) => {
      const store = new OrchestrationStore({
        statePath: statePathFor(directory),
      });

      await expect(
        store.mutateRoot(({ workflow }) => {
          addHistoricalWorkflow(workflow, "async");
          return Promise.resolve();
        })
      ).rejects.toMatchObject({ code: "ORCHESTRATION_ASYNC_MUTATION" });
      expect(workflowIDs(await store.readRoot())).toEqual([]);
    }));

  test("rejects a legacy root at an explicit path and quarantines its bytes exactly", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const legacy = JSON.stringify({
        checkpoints: [],
        schema_version: 4,
        tasks: [],
      });
      await nodeFS.mkdir(path.dirname(statePath), { recursive: true });
      await nodeFS.writeFile(statePath, legacy, "utf8");

      const store = new OrchestrationStore({ now: () => 1000, statePath });
      expect(await store.initialize()).toMatchObject({
        durable: true,
        reason: "corrupt_state",
        status: "recovered",
      });
      const quarantine = (await nodeFS.readdir(path.dirname(statePath))).find(
        (entry) => entry.includes(".corrupt-")
      );
      expect(quarantine).toBeDefined();
      expect(
        await nodeFS.readFile(
          path.join(path.dirname(statePath), quarantine ?? ""),
          "utf8"
        )
      ).toBe(legacy);
      await expect(nodeFS.stat(statePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await store.readRoot()).toEqual(
        RootSnapshotSchema.parse({
          deliveries: [],
          job_runs: [],
          permissions: [],
          schema_version: 1,
          turns: [],
          workers: [],
          workflows: { workflows: [] },
        })
      );
    }));

  test("quarantines malformed new-state bytes without rewriting them in place", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const original = "{not valid json\n";
      await nodeFS.mkdir(path.dirname(statePath), { recursive: true });
      await nodeFS.writeFile(statePath, original, "utf8");
      const store = new OrchestrationStore({ now: () => 1000, statePath });

      expect(await store.initialize()).toMatchObject({ status: "recovered" });
      const entries = await nodeFS.readdir(path.dirname(statePath));
      const quarantine = entries.find((entry) => entry.includes(".corrupt-"));
      expect(
        await nodeFS.readFile(
          path.join(path.dirname(statePath), quarantine ?? ""),
          "utf8"
        )
      ).toBe(original);
      await expect(nodeFS.stat(statePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  test("uses isolated degraded memory when quarantine fails and preserves disk truth", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const original = "future-or-corrupt-state";
      await nodeFS.mkdir(path.dirname(statePath), { recursive: true });
      await nodeFS.writeFile(statePath, original, "utf8");
      const fs = {
        ...nodeFS,
        rename: (from: PathLike, to: PathLike) => {
          if (from === statePath && String(to).includes(".corrupt-")) {
            return Promise.reject(new Error("quarantine unavailable"));
          }
          return nodeFS.rename(from, to);
        },
      };
      const store = new OrchestrationStore({ fs, statePath, now: () => 1000 });

      expect(await store.initialize()).toMatchObject({
        durable: false,
        reason: "quarantine_failed",
        status: "degraded",
      });
      await store.mutateRoot(({ workflow }) => {
        addHistoricalWorkflow(workflow, "degraded");
      });
      expect(workflowIDs(await store.readRoot())).toEqual(["degraded"]);
      const second = new OrchestrationStore({ fs, statePath, now: () => 1000 });
      expect(workflowIDs(await second.readRoot())).toEqual(["degraded"]);
      expect(second.health.status).toBe("degraded");
      expect(await nodeFS.readFile(statePath, "utf8")).toBe(original);
    }));

  test("retains the attempted root in degraded memory after ambiguous atomic write failure", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const fs = {
        ...nodeFS,
        rename: (from: PathLike, to: PathLike) => {
          if (to === statePath && String(from).includes(".tmp-")) {
            return Promise.reject(new Error("rename outcome unknown"));
          }
          return nodeFS.rename(from, to);
        },
      };
      const store = new OrchestrationStore({ fs, statePath });

      await expect(
        store.mutateRoot(({ workflow }) => {
          addHistoricalWorkflow(workflow, "attempted");
        })
      ).rejects.toMatchObject({ code: "ORCHESTRATION_STATE_WRITE_FAILED" });
      expect(store.health).toMatchObject({
        durable: false,
        reason: "write_failed",
        status: "degraded",
      });
      expect(workflowIDs(await store.readRoot())).toEqual(["attempted"]);
    }));

  test("uses isolated degraded memory when the state path cannot be read", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const fs = {
        ...nodeFS,
        readFile: (file: PathLike, encoding: "utf8") => {
          if (file === statePath) {
            return Promise.reject(
              Object.assign(new Error("state unavailable"), { code: "EACCES" })
            );
          }
          return nodeFS.readFile(file, encoding);
        },
      };
      const store = new OrchestrationStore({ fs, statePath });

      expect(await store.initialize()).toMatchObject({
        durable: false,
        reason: "read_failed",
        status: "degraded",
      });
      await store.mutateRoot(({ workflow }) => {
        addHistoricalWorkflow(workflow, "memory");
      });
      expect(workflowIDs(await store.readRoot())).toEqual(["memory"]);
    }));

  test("never degrades through a live lock timeout", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const lockPath = `${statePath}.lock`;
      await nodeFS.mkdir(lockPath, { recursive: true });
      await nodeFS.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({
          created_at_ms: 1000,
          pid: process.pid,
          token: "live",
        }),
        "utf8"
      );
      const store = new OrchestrationStore({
        lockTimeoutMs: 0,
        now: () => 1101,
        sleep: () => Promise.resolve(),
        staleLockMs: 100,
        statePath,
      });

      await expect(
        store.mutateRoot(({ workflow }) => {
          addHistoricalWorkflow(workflow, "blocked");
        })
      ).rejects.toMatchObject({ code: "ORCHESTRATION_LOCK_TIMEOUT" });
      expect(store.health.status).toBe("healthy");
      expect(
        JSON.parse(
          await nodeFS.readFile(path.join(lockPath, "owner.json"), "utf8")
        )
      ).toMatchObject({ token: "live" });
    }));

  test("recovers a dead stale lock without weakening ownership checks", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const lockPath = `${statePath}.lock`;
      await nodeFS.mkdir(lockPath, { recursive: true });
      await nodeFS.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ created_at_ms: 1000, pid: 999_999, token: "dead" }),
        "utf8"
      );
      const store = new OrchestrationStore({
        isProcessAlive: () => false,
        lockTimeoutMs: 0,
        now: () => 1101,
        sleep: () => Promise.resolve(),
        staleLockMs: 100,
        statePath,
      });

      await store.mutateRoot(({ workflow }) => {
        addHistoricalWorkflow(workflow, "recovered");
      });
      expect(workflowIDs(await store.readRoot())).toEqual(["recovered"]);
      await expect(nodeFS.stat(lockPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  test("serializes concurrent processes into one private atomic root", async () =>
    withTemporaryDirectory(async (directory) => {
      const statePath = statePathFor(directory);
      const moduleURL = new URL("./orchestration-store.ts", import.meta.url)
        .href;
      const script = `import { OrchestrationStore } from ${JSON.stringify(moduleURL)}; const [statePath, inputJSON] = process.argv.slice(-2); const input = JSON.parse(inputJSON); const store = new OrchestrationStore({ statePath }); await store.mutateWorkflow((workflow) => { workflow.start(input); workflow.completeJob({ job: input.definition.steps[0].jobs[0].name, message: "Recorded.", workflow_id: input.workflow_id }); });`;
      const run = (workflowID: string): Promise<void> =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--eval",
              script,
              statePath,
              JSON.stringify({
                definition: definition(`record ${workflowID}`),
                orchestrator_agent_id: "sol",
                parent_session_id: `parent-${workflowID}`,
                workflow_id: workflowID,
              }),
            ],
            { stdio: "ignore" }
          );
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`worker exited ${code}`));
            }
          });
        });

      await Promise.all([run("process-1"), run("process-2")]);

      const persisted = RootSnapshotSchema.parse(
        JSON.parse(await nodeFS.readFile(statePath, "utf8"))
      );
      expect(workflowIDs(persisted)).toEqual(["process-1", "process-2"]);
      expect((await nodeFS.stat(statePath)).mode % 0o100).toBe(0);
      expect(
        (await nodeFS.readdir(path.dirname(statePath))).filter((name) =>
          name.includes(".tmp-")
        )
      ).toEqual([]);
    }));

  test("keeps path precedence, uses state-v2.json, and never reads or rewrites old state.json", async () =>
    withTemporaryDirectory(async (directory) => {
      const home = path.join(directory, "home");
      const xdg = path.join(directory, "xdg");
      const env = {
        OPENCODE_SOL_ORCHESTRATOR_STATE_PATH: "/env/custom.json",
        XDG_STATE_HOME: xdg,
      };
      expect(
        resolveStatePath({ env, home, statePath: "/explicit/custom.json" })
      ).toBe("/explicit/custom.json");
      expect(resolveStatePath({ env, home })).toBe("/env/custom.json");
      expect(resolveStatePath({ env: { XDG_STATE_HOME: xdg }, home })).toBe(
        path.join(xdg, "opencode", "opencode-sol-orchestrator", "state-v2.json")
      );
      expect(resolveStatePath({ env: {}, home })).toBe(
        path.join(
          home,
          ".local",
          "state",
          "opencode",
          "opencode-sol-orchestrator",
          "state-v2.json"
        )
      );

      const oldPath = path.join(
        xdg,
        "opencode",
        "opencode-sol-orchestrator",
        "state.json"
      );
      const oldBytes = "legacy-state-must-remain-untouched";
      await nodeFS.mkdir(path.dirname(oldPath), { recursive: true });
      await nodeFS.writeFile(oldPath, oldBytes, "utf8");
      const store = new OrchestrationStore({
        env: { XDG_STATE_HOME: xdg },
        home,
      });
      await store.mutateRoot(({ workflow }) => {
        addHistoricalWorkflow(workflow, "fresh");
      });

      expect(store.statePath).toEndWith("state-v2.json");
      expect(await nodeFS.readFile(oldPath, "utf8")).toBe(oldBytes);
      expect(
        workflowIDs(
          RootSnapshotSchema.parse(
            JSON.parse(await nodeFS.readFile(store.statePath, "utf8"))
          )
        )
      ).toEqual(["fresh"]);
      expect(() => new OrchestrationStore({ statePath: "" })).toThrow(
        OrchestrationStoreError
      );
    }));
});
