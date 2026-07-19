import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile as nodeReadFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Glob, spawn } from "bun";
import { z } from "zod";

import type {
  OpenCodeFileDiff,
  OpenCodeMessageRecord,
  OpenCodeSession,
} from "./opencode-session.js";
import type { OrchestrationStore } from "./orchestration-store.js";
import type {
  RootSnapshot,
  WorkerBindingRecord,
  WorkerTurnRecord,
} from "./schema/orchestration.js";
import {
  availableActionsForWorker,
  projectWorker,
  workerTurnsFor,
} from "./workflow-projection.js";

const DEFAULT_WAIT_TIMEOUT = 30_000;
const MAX_WAIT_TIMEOUT = 120_000;
const CONTROL_IDLE_SETTLE_TIMEOUT = 1000;
const UNDO_PROVENANCE_REASON = "Mutation provenance is not established.";
const MUTATING_TOOLS = new Set(["apply_patch", "bash", "edit", "write"]);
const STRUCTURED_TOOLS = new Set(["apply_patch", "edit", "write"]);
const LEADING_DOT_PATH = /^(\.\/)+/u;

const ParentContextSchema = z.object({
  parent_session_id: z.string().trim().min(1),
});

const StatusInputSchema = ParentContextSchema.extend({
  task_id: z.string().trim().min(1).optional(),
}).strict();

const InspectCommonSchema = ParentContextSchema.extend({
  task_id: z.string().trim().min(1),
  turn: z.int().positive().optional(),
});

const InspectInputSchema = z.discriminatedUnion("type", [
  InspectCommonSchema.extend({
    file: z.string().trim().min(1),
    tool: z.never().optional(),
    type: z.literal("diff"),
  }).strict(),
  InspectCommonSchema.extend({
    file: z.never().optional(),
    tool: z.int().positive(),
    type: z.literal("tool_output"),
  }).strict(),
  InspectCommonSchema.extend({
    file: z.never().optional(),
    tool: z.never().optional(),
    type: z.literal("result"),
  }).strict(),
]);

const WaitInputSchema = ParentContextSchema.extend({
  task_ids: z.array(z.string().trim().min(1)).min(1).optional(),
  timeout_ms: z
    .int()
    .min(1)
    .max(MAX_WAIT_TIMEOUT)
    .default(DEFAULT_WAIT_TIMEOUT),
  until: z.enum(["any", "all"]).default("any"),
})
  .strict()
  .superRefine((input, context) => {
    if (
      input.task_ids !== undefined &&
      new Set(input.task_ids).size !== input.task_ids.length
    ) {
      context.addIssue({
        code: "custom",
        message: "agents_wait task_ids must be unique.",
        path: ["task_ids"],
      });
    }
  });

const UndoInputSchema = ParentContextSchema.extend({
  reason: z.string().trim().min(1).max(4000),
  scope: z.enum(["latest_turn", "job_run"]).default("job_run"),
  task_id: z.string().trim().min(1),
}).strict();

const RedoInputSchema = ParentContextSchema.extend({
  task_id: z.string().trim().min(1),
}).strict();

type TurnSessionAdapter = {
  diff(sessionID: string, messageID?: string): Promise<OpenCodeFileDiff[]>;
  get(sessionID: string): Promise<OpenCodeSession>;
  message(sessionID: string, messageID: string): Promise<OpenCodeMessageRecord>;
  messages(sessionID: string): Promise<OpenCodeMessageRecord[]>;
  revert(input: {
    messageID: string;
    sessionID: string;
  }): Promise<OpenCodeSession>;
  status(): Promise<Record<string, { type: "busy" | "idle" | "retry" }>>;
  unrevert(sessionID: string): Promise<OpenCodeSession>;
};

type ReadFile = (file: string) => Promise<Uint8Array | string>;
type Fingerprint = (directory: string) => Promise<Map<string, string | null>>;
type Sleep = (duration: number) => Promise<void>;
type InspectInput = z.infer<typeof InspectInputSchema>;

type WorkerTurnsOptions = {
  readonly artifactDirectory?: string;
  readonly now?: () => number;
  readonly fingerprint?: Fingerprint;
  readonly readFile?: ReadFile;
  readonly sessions: TurnSessionAdapter;
  readonly sleep?: Sleep;
  readonly store: OrchestrationStore;
};

type ToolBoundary = {
  readonly args: unknown;
  readonly callID: string;
  readonly sessionID: string;
  readonly tool: string;
};

type MutationAudit = {
  readonly allowed: string[];
  readonly kind: "scope_audit_conflict" | "scope_violation";
  readonly paths: string[];
};

type ActiveMutation = {
  before: Map<string, string | null> | undefined;
  readonly callID: string;
  readonly directory: string;
  overlap: boolean;
  readonly sessionID: string;
  readonly source: "shell" | "structured";
  readonly taskID: string | undefined;
  readonly tool: string;
  readonly turn: number | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (content: Uint8Array | string): string =>
  createHash("sha256").update(content).digest("hex");

const canonicalPath = (directory: string, candidate: string): string => {
  const relative = path.isAbsolute(candidate)
    ? path.relative(directory, candidate)
    : candidate;
  const normalized = relative
    .replaceAll("\\", "/")
    .replace(LEADING_DOT_PATH, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Mutation path ${candidate} is outside the worktree.`);
  }
  return normalized;
};

const readHash = async (
  readFile: ReadFile,
  directory: string,
  relative: string
): Promise<string | null> => {
  try {
    return sha256(await readFile(path.join(directory, relative)));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
};

const defaultFingerprint =
  (readFile: ReadFile): Fingerprint =>
  async (directory) => {
    const child = spawn(
      [
        "git",
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { cwd: directory, stderr: "pipe", stdout: "pipe" }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Git-visible mutation fingerprint failed: ${stderr.trim() || `exit ${exitCode}`}`
      );
    }
    const files = [...new Set(stdout.split("\0").filter(Boolean))].sort();
    return new Map(
      await Promise.all(
        files.map(async (file) => {
          const relative = canonicalPath(directory, file);
          return [
            relative,
            await readHash(readFile, directory, relative),
          ] as const;
        })
      )
    );
  };

const changedPaths = (
  before: ReadonlyMap<string, string | null>,
  after: ReadonlyMap<string, string | null>
): string[] =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();

const timestamp = (value: unknown, fallback: string): string => {
  let milliseconds = Number.NaN;
  if (typeof value === "number") {
    milliseconds = value;
  } else if (typeof value === "string") {
    milliseconds = Date.parse(value);
  }
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : fallback;
};

const messageTime = (
  message: OpenCodeMessageRecord,
  key: "completed" | "created",
  fallback: string
): string => {
  const time: unknown = Reflect.get(message.info, "time");
  return timestamp(isRecord(time) ? time[key] : undefined, fallback);
};

const parentMessageID = (
  message: OpenCodeMessageRecord
): string | undefined => {
  const value: unknown = Reflect.get(message.info, "parentID");
  return typeof value === "string" ? value : undefined;
};

const nativeToolPart = (
  part: OpenCodeMessageRecord["parts"][number]
): boolean => {
  if (part.type !== "tool") {
    return false;
  }
  const metadata: unknown = Reflect.get(part, "metadata");
  if (isRecord(metadata) && metadata.providerExecuted === true) {
    return false;
  }
  const state: unknown = Reflect.get(part, "state");
  return !(
    isRecord(state) &&
    state.status === "error" &&
    isRecord(state.metadata) &&
    state.metadata.interrupted === true
  );
};

const terminalResult = (message: OpenCodeMessageRecord): boolean => {
  if (message.info.role !== "assistant") {
    return false;
  }
  const finish: unknown = Reflect.get(message.info, "finish");
  const summary: unknown = Reflect.get(message.info, "summary");
  const error: unknown = Reflect.get(message.info, "error");
  const time: unknown = Reflect.get(message.info, "time");
  return (
    typeof finish === "string" &&
    finish !== "tool-calls" &&
    finish !== "unknown" &&
    finish !== "content-filter" &&
    summary !== true &&
    error === undefined &&
    isRecord(time) &&
    typeof time.completed === "number" &&
    !message.parts.some(nativeToolPart)
  );
};

const resultText = (message: OpenCodeMessageRecord): string =>
  message.parts
    .filter(
      (part) =>
        part.type === "text" && part.ignored !== true && part.text !== undefined
    )
    .map((part) => part.text ?? "")
    .join("\n");

const toolState = (
  part: OpenCodeMessageRecord["parts"][number]
): Record<string, unknown> => {
  const state: unknown = Reflect.get(part, "state");
  if (
    !(
      isRecord(state) &&
      ["pending", "running", "completed", "error"].includes(
        String(state.status)
      )
    )
  ) {
    throw new Error("Malformed worker tool state in OpenCode history.");
  }
  return state;
};

const writeContract = (root: RootSnapshot, worker: WorkerBindingRecord) => {
  const workflow = root.workflows.workflows.find(
    (candidate) => candidate.workflow_id === worker.workflow_id
  );
  const version = workflow?.versions.find(
    (candidate) => candidate.version === worker.workflow_version
  );
  const job = version?.definition.steps
    .flatMap((step) => step.jobs)
    .find((candidate) => candidate.name === worker.job);
  const run = root.job_runs.find(
    (candidate) =>
      candidate.workflow_id === worker.workflow_id &&
      candidate.workflow_version === worker.workflow_version &&
      candidate.job === worker.job &&
      candidate.run_sequence === worker.run_sequence
  );
  if (job === undefined || run === undefined) {
    throw new Error(
      `Managed worker job ${JSON.stringify(worker.job)} has no write contract.`
    );
  }
  return { grants: run.write_grants, writeFiles: job.writeFiles };
};

const mutationKey = (sessionID: string, callID: string): string =>
  `${sessionID}\0${callID}`;

const terminalWorker = (worker: WorkerBindingRecord): boolean =>
  ["blocked", "interrupted", "review"].includes(worker.live_state);

const toolContent = (state: Record<string, unknown>): string => {
  const content = state.status === "error" ? state.error : state.output;
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined) {
    throw new Error("The selected worker tool output is unavailable.");
  }
  return JSON.stringify(content, null, 2);
};

const artifactSlug = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80) || "artifact";

export class WorkerTurns {
  readonly #activeMutations = new Map<string, ActiveMutation>();
  readonly #artifactRoot: Promise<string>;
  readonly #fingerprint: Fingerprint;
  readonly #now: () => number;
  readonly #readFile: ReadFile;
  readonly #sessions: TurnSessionAdapter;
  readonly #sleep: Sleep;
  readonly #store: OrchestrationStore;

  constructor(options: WorkerTurnsOptions) {
    const artifactDirectory = options.artifactDirectory;
    this.#artifactRoot =
      artifactDirectory === undefined
        ? mkdir(path.join(os.tmpdir(), "opencode"), {
            recursive: true,
          }).then(
            async () =>
              await mkdtemp(
                path.join(os.tmpdir(), "opencode", "sol-orchestrator-")
              )
          )
        : mkdir(artifactDirectory, { mode: 0o700, recursive: true }).then(
            async () => {
              await chmod(artifactDirectory, 0o700);
              return artifactDirectory;
            }
          );
    this.#now = options.now ?? Date.now;
    this.#readFile = options.readFile ?? nodeReadFile;
    this.#fingerprint =
      options.fingerprint ?? defaultFingerprint(this.#readFile);
    this.#sessions = options.sessions;
    this.#sleep =
      options.sleep ??
      ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
    this.#store = options.store;
  }

  async #waitForIdleSession(sessionID: string): Promise<boolean> {
    const deadline = this.#now() + CONTROL_IDLE_SETTLE_TIMEOUT;
    while (true) {
      const status = (await this.#sessions.status())[sessionID]?.type;
      if (status === undefined || status === "idle") {
        return true;
      }
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        return false;
      }
      await this.#sleep(Math.min(25, remaining));
    }
  }

  async refresh(taskID: string): Promise<void> {
    const root = await this.#store.readRoot();
    const worker = root.workers.find(
      (candidate) => candidate.task_id === taskID
    );
    if (worker === undefined) {
      throw new Error("The selected current managed worker is unavailable.");
    }
    const [session, messages, statuses] = await Promise.all([
      this.#sessions.get(worker.child_session_id),
      this.#sessions.messages(worker.child_session_id),
      this.#sessions.status(),
    ]);
    const boundaries = messages.filter(
      (message) => message.info.role === "user"
    );
    const turns: WorkerTurnRecord[] = [];

    for (const [index, boundary] of boundaries.entries()) {
      const existing = root.turns.find(
        (turn) =>
          turn.task_id === worker.task_id &&
          turn.run_sequence === worker.run_sequence &&
          turn.boundary_message_id === boundary.info.id
      );
      const mutationEpochs = existing?.mutation_epochs ?? [];
      const assistantMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          parentMessageID(message) === boundary.info.id
      );
      const final = assistantMessages.filter(terminalResult).at(-1);
      const diffs = await this.#sessions.diff(
        worker.child_session_id,
        boundary.info.id
      );
      const attributed = (file: string): boolean =>
        mutationEpochs.some(
          (epoch) =>
            epoch.completed_at !== null &&
            !epoch.overlap &&
            epoch.paths.includes(file)
        ) &&
        !mutationEpochs.some(
          (epoch) => epoch.overlap && epoch.paths.includes(file)
        );
      const files =
        existing?.completed_at !== null && existing !== undefined
          ? existing.files.map((file) => ({
              ...file,
              attributed: attributed(file.path),
            }))
          : await Promise.all(
              diffs.map(async (diff) => ({
                additions: diff.additions,
                attributed: attributed(diff.path),
                deletions: diff.deletions,
                end_sha256:
                  diff.status === "deleted"
                    ? null
                    : sha256(
                        await this.#readFile(
                          path.join(session.directory, diff.path)
                        )
                      ),
                path: diff.path,
                status: diff.status,
              }))
            );
      let ordinal = 0;
      const toolOutputs = assistantMessages.flatMap((message) =>
        message.parts
          .filter((part) => part.type === "tool")
          .map((part) => {
            const state = toolState(part);
            const tool: unknown = Reflect.get(part, "tool");
            if (typeof tool !== "string" || tool.length === 0) {
              throw new Error(
                "Malformed worker tool name in OpenCode history."
              );
            }
            ordinal += 1;
            const status = String(state.status) as
              | "completed"
              | "error"
              | "pending"
              | "running";
            return {
              message_id: message.info.id,
              ordinal,
              output_available:
                (status === "completed" && Object.hasOwn(state, "output")) ||
                (status === "error" && Object.hasOwn(state, "error")),
              part_id: part.id,
              status,
              title: typeof state.title === "string" ? state.title : "",
              tool,
            };
          })
      );
      const startedAt = messageTime(boundary, "created", worker.created_at);
      turns.push({
        boundary_message_id: boundary.info.id,
        completed_at:
          final === undefined
            ? null
            : messageTime(final, "completed", worker.updated_at),
        files,
        mutation_epochs: mutationEpochs,
        post_undo_hashes: existing?.post_undo_hashes ?? [],
        result_available: final !== undefined,
        result_message_id: final?.info.id ?? null,
        run_sequence: worker.run_sequence,
        started_at: startedAt,
        task_id: worker.task_id,
        tool_outputs: toolOutputs,
        turn: index + 1,
        undo_state:
          existing?.undo_state === "redo_available" ||
          existing?.undo_state === "redo_unavailable"
            ? existing.undo_state
            : "unavailable",
        undo_unavailable_reason:
          existing?.undo_state === "redo_available"
            ? null
            : (existing?.undo_unavailable_reason ?? UNDO_PROVENANCE_REASON),
      });
    }

    await this.#evaluateTurnSafety({
      messages,
      root,
      session,
      status: statuses[worker.child_session_id]?.type ?? "idle",
      turns,
      worker,
    });

    await this.#store.mutateRoot(({ root: current }) => {
      const currentWorker = current.workers.find(
        (candidate) => candidate.task_id === taskID
      );
      if (
        currentWorker === undefined ||
        currentWorker.run_sequence !== worker.run_sequence ||
        currentWorker.child_session_id !== worker.child_session_id
      ) {
        throw new Error(
          `Managed worker job ${JSON.stringify(worker.job)} changed while refreshing turns.`
        );
      }
      current.turns = [
        ...current.turns.filter(
          (turn) =>
            turn.task_id !== taskID || turn.run_sequence !== worker.run_sequence
        ),
        ...turns,
      ];
    });
  }

  async beforeTool(input: ToolBoundary): Promise<void> {
    if (!MUTATING_TOOLS.has(input.tool)) {
      return;
    }
    let root = await this.#store.readRoot();
    const worker = root.workers.find(
      (candidate) => candidate.child_session_id === input.sessionID
    );
    let turn: number | undefined;
    let directory = "";
    let needsFingerprint = false;
    if (worker !== undefined) {
      await this.refresh(worker.task_id);
      root = await this.#store.readRoot();
      const currentTurns = workerTurnsFor(root, worker);
      turn = currentTurns.at(-1)?.turn;
      if (turn === undefined) {
        throw new Error(
          `Managed worker job ${JSON.stringify(worker.job)} has no current turn boundary.`
        );
      }
      directory = (await this.#sessions.get(worker.child_session_id)).directory;
      const contract = writeContract(root, worker);
      needsFingerprint =
        STRUCTURED_TOOLS.has(input.tool) ||
        (input.tool === "bash" && contract.writeFiles !== undefined);
    }
    const active: ActiveMutation = {
      before: undefined,
      callID: input.callID,
      directory,
      overlap: false,
      sessionID: input.sessionID,
      source: input.tool === "bash" ? "shell" : "structured",
      taskID: worker?.task_id,
      tool: input.tool,
      turn,
    };
    for (const mutation of this.#activeMutations.values()) {
      if (mutation.sessionID === active.sessionID) {
        continue;
      }
      mutation.overlap = true;
      active.overlap = true;
      if (mutation.taskID !== undefined && mutation.turn !== undefined) {
        await this.#setEpochOverlap(
          mutation.taskID,
          mutation.turn,
          mutation.callID
        );
      }
    }
    this.#activeMutations.set(
      mutationKey(input.sessionID, input.callID),
      active
    );
    if (worker !== undefined && turn !== undefined) {
      const startedAt = this.#timestamp();
      await this.#store.mutateRoot(({ root: current }) => {
        const currentTurn = current.turns.find(
          (candidate) =>
            candidate.task_id === worker.task_id && candidate.turn === turn
        );
        if (currentTurn === undefined) {
          throw new Error("Managed mutation turn changed before tool start.");
        }
        currentTurn.mutation_epochs.push({
          call_id: input.callID,
          completed_at: null,
          overlap: active.overlap,
          paths: [],
          source: active.source,
          started_at: startedAt,
          tool: input.tool,
        });
      });
    }
    if (needsFingerprint) {
      active.before = await this.#fingerprint(directory);
    }
  }

  async afterTool(input: ToolBoundary): Promise<MutationAudit | null> {
    if (!MUTATING_TOOLS.has(input.tool)) {
      return null;
    }
    const key = mutationKey(input.sessionID, input.callID);
    const active = this.#activeMutations.get(key);
    if (active === undefined) {
      return null;
    }
    let paths: string[] = [];
    if (active.before !== undefined) {
      paths = changedPaths(
        active.before,
        await this.#fingerprint(active.directory)
      );
    }
    this.#activeMutations.delete(key);
    if (active.taskID === undefined || active.turn === undefined) {
      return null;
    }
    await this.#store.mutateRoot(({ root }) => {
      const turn = root.turns.find(
        (candidate) =>
          candidate.task_id === active.taskID && candidate.turn === active.turn
      );
      const epoch = turn?.mutation_epochs.find(
        (candidate) => candidate.call_id === active.callID
      );
      if (turn === undefined || epoch === undefined) {
        throw new Error(
          "Managed mutation epoch disappeared before completion."
        );
      }
      epoch.completed_at = this.#timestamp();
      epoch.overlap = active.overlap;
      epoch.paths = paths;
    });
    if (active.source !== "shell" || active.before === undefined) {
      return null;
    }
    const root = await this.#store.readRoot();
    const worker = root.workers.find(
      (candidate) => candidate.task_id === active.taskID
    );
    if (worker === undefined) {
      throw new Error("Managed shell worker disappeared after execution.");
    }
    const contract = writeContract(root, worker);
    const allowed = [...(contract.writeFiles ?? []), ...contract.grants].sort();
    if (active.overlap && paths.length > 0) {
      return { allowed, kind: "scope_audit_conflict", paths };
    }
    const outside = paths.filter(
      (file) => !allowed.some((pattern) => new Glob(pattern).match(file))
    );
    return outside.length === 0
      ? null
      : { allowed, kind: "scope_violation", paths: outside };
  }

  async reconcileIncompleteMutations(): Promise<string[]> {
    return await this.#store.mutateRoot(({ root, workflow }) => {
      const taskIDs = [
        ...new Set(
          root.turns
            .filter((turn) =>
              turn.mutation_epochs.some((epoch) => epoch.completed_at === null)
            )
            .map((turn) => turn.task_id)
        ),
      ].sort();
      const blocked: string[] = [];
      for (const taskID of taskIDs) {
        const worker = root.workers.find(
          (candidate) => candidate.task_id === taskID
        );
        const run = root.job_runs.find(
          (candidate) =>
            candidate.task_id === taskID &&
            candidate.run_sequence === worker?.run_sequence
        );
        if (
          worker === undefined ||
          run === undefined ||
          worker.live_state === "blocked" ||
          worker.live_state === "interrupted"
        ) {
          continue;
        }
        workflow.blockJob({
          job: worker.job,
          message:
            "A managed mutation did not reach its tool after-hook; scope auditing and undo provenance are unavailable.",
          workflow_id: worker.workflow_id,
        });
        run.state = "blocked";
        run.updated_at = this.#timestamp();
        worker.live_state = "blocked";
        worker.latest_event = {
          created_at: this.#timestamp(),
          kind: "blocker",
          message:
            "A managed mutation did not reach its tool after-hook; scope auditing and undo provenance are unavailable.",
          sequence: (worker.latest_event?.sequence ?? 0) + 1,
        };
        worker.updated_at = this.#timestamp();
        blocked.push(taskID);
      }
      return blocked;
    });
  }

  async undo(input: unknown) {
    const parsed = UndoInputSchema.parse(input);
    const initialRoot = await this.#store.readRoot();
    const initialWorker = this.#selectOwned(
      initialRoot,
      parsed.parent_session_id,
      parsed.task_id
    )[0];
    if (initialWorker === undefined || initialWorker.live_state !== "review") {
      throw new Error("agents_undo requires a managed worker in review.");
    }
    if (!(await this.#waitForIdleSession(initialWorker.child_session_id))) {
      throw new Error("agents_undo requires an idle worker session.");
    }
    await this.refresh(parsed.task_id);
    const root = await this.#store.readRoot();
    const worker = this.#selectOwned(
      root,
      parsed.parent_session_id,
      parsed.task_id
    )[0];
    if (worker === undefined || worker.live_state !== "review") {
      throw new Error("agents_undo requires a managed worker in review.");
    }
    if (
      root.permissions.some((item) => item.task_id === worker.task_id) ||
      root.deliveries.some(
        (item) => item.task_id === worker.task_id && item.state !== "completed"
      )
    ) {
      throw new Error(
        "agents_undo requires no pending permission or follow-up delivery."
      );
    }
    const session = await this.#sessions.get(worker.child_session_id);
    if (session.revert !== undefined) {
      throw new Error("The worker already has an active native revert.");
    }
    const completed = workerTurnsFor(root, worker).filter(
      (turn) => turn.completed_at !== null
    );
    const selected =
      parsed.scope === "latest_turn" ? completed.slice(-1) : completed;
    const boundary = selected[0];
    if (boundary === undefined || boundary.undo_state !== "available") {
      throw new Error(
        boundary?.undo_unavailable_reason ?? "Worker undo is unavailable."
      );
    }
    const reverted = await this.#sessions.revert({
      messageID: boundary.boundary_message_id,
      sessionID: worker.child_session_id,
    });
    if (
      reverted.revert?.messageID !== boundary.boundary_message_id ||
      reverted.revert.partID !== undefined
    ) {
      throw new Error("OpenCode did not retain the expected revert marker.");
    }
    const paths = this.#selectedEndFiles(selected);
    const postUndoFingerprint = await this.#fingerprint(session.directory);
    for (const file of paths.keys()) {
      if (!postUndoFingerprint.has(file)) {
        postUndoFingerprint.set(
          file,
          await readHash(this.#readFile, session.directory, file)
        );
      }
    }
    const postUndoHashes = [...postUndoFingerprint]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, hash]) => ({ path: file, sha256: hash }));
    try {
      await this.#store.mutateRoot(({ root: current, workflow }) => {
        const currentWorker = current.workers.find(
          (candidate) => candidate.task_id === worker.task_id
        );
        const run = current.job_runs.find(
          (candidate) =>
            candidate.task_id === worker.task_id &&
            candidate.run_sequence === worker.run_sequence
        );
        const currentBoundary = current.turns.find(
          (turn) =>
            turn.task_id === worker.task_id &&
            turn.boundary_message_id === boundary.boundary_message_id
        );
        if (
          currentWorker?.live_state !== "review" ||
          run === undefined ||
          currentBoundary === undefined
        ) {
          throw new Error("Worker state changed before undo was committed.");
        }
        workflow.blockJob({
          job: worker.job,
          message: parsed.reason,
          workflow_id: worker.workflow_id,
        });
        run.state = "rejected";
        run.updated_at = this.#timestamp();
        currentWorker.live_state = "blocked";
        currentWorker.latest_event = {
          created_at: this.#timestamp(),
          kind: "blocker",
          message: parsed.reason,
          sequence: (currentWorker.latest_event?.sequence ?? 0) + 1,
        };
        currentWorker.updated_at = this.#timestamp();
        currentBoundary.post_undo_hashes = postUndoHashes;
        currentBoundary.undo_state = "redo_available";
        currentBoundary.undo_unavailable_reason = null;
      });
    } catch (error) {
      await this.#sessions
        .unrevert(worker.child_session_id)
        .catch(() => undefined);
      throw error;
    }
    return { accepted: true, scope: parsed.scope, task_id: worker.task_id };
  }

  async redo(input: unknown) {
    const parsed = RedoInputSchema.parse(input);
    const initialRoot = await this.#store.readRoot();
    const initialWorker = this.#selectOwned(
      initialRoot,
      parsed.parent_session_id,
      parsed.task_id
    )[0];
    if (initialWorker === undefined) {
      throw new Error("The selected current managed worker is unavailable.");
    }
    if (initialWorker.live_state !== "blocked") {
      throw new Error("Worker redo is unavailable.");
    }
    if (!(await this.#waitForIdleSession(initialWorker.child_session_id))) {
      throw new Error("agents_redo requires an idle worker session.");
    }
    await this.refresh(parsed.task_id);
    const root = await this.#store.readRoot();
    const worker = this.#selectOwned(
      root,
      parsed.parent_session_id,
      parsed.task_id
    )[0];
    if (worker === undefined) {
      throw new Error("The selected current managed worker is unavailable.");
    }
    const turn = workerTurnsFor(root, worker).find(
      (candidate) => candidate.undo_state === "redo_available"
    );
    const resultMessageID = workerTurnsFor(root, worker)
      .map((candidate) => candidate.result_message_id)
      .filter((candidate): candidate is string => candidate !== null)
      .at(-1);
    if (
      worker.live_state !== "blocked" ||
      turn === undefined ||
      resultMessageID === undefined ||
      turn.undo_unavailable_reason !== null
    ) {
      throw new Error(
        turn?.undo_unavailable_reason ?? "Worker redo is unavailable."
      );
    }
    const session = await this.#sessions.get(worker.child_session_id);
    if (session.revert?.messageID !== turn.boundary_message_id) {
      throw new Error("OpenCode no longer retains the matching redo state.");
    }
    await this.#assertFingerprint(
      session.directory,
      new Map(turn.post_undo_hashes.map((item) => [item.path, item.sha256])),
      "redo"
    );
    await this.#sessions.unrevert(worker.child_session_id);
    const original = this.#selectedEndFiles(
      workerTurnsFor(root, worker).filter(
        (candidate) => candidate.turn >= turn.turn
      )
    );
    await this.#assertHashes(session.directory, original, "restored redo");
    await this.#store.mutateRoot(({ root: current, workflow }) => {
      const currentWorker = current.workers.find(
        (candidate) => candidate.task_id === worker.task_id
      );
      const run = current.job_runs.find(
        (candidate) =>
          candidate.task_id === worker.task_id &&
          candidate.run_sequence === worker.run_sequence
      );
      const currentTurn = current.turns.find(
        (candidate) =>
          candidate.task_id === worker.task_id && candidate.turn === turn.turn
      );
      if (
        currentWorker?.live_state !== "blocked" ||
        run === undefined ||
        currentTurn === undefined
      ) {
        throw new Error("Worker state changed before redo was committed.");
      }
      workflow.restoreWorkerReview({
        job: worker.job,
        task_id: worker.task_id,
        workflow_id: worker.workflow_id,
      });
      run.state = "review";
      run.updated_at = this.#timestamp();
      currentWorker.live_state = "review";
      currentWorker.latest_event = {
        created_at: this.#timestamp(),
        kind: "result",
        result_message_id: resultMessageID,
        sequence: (currentWorker.latest_event?.sequence ?? 0) + 1,
      };
      currentWorker.updated_at = this.#timestamp();
      currentTurn.post_undo_hashes = [];
      currentTurn.undo_state = "available";
      currentTurn.undo_unavailable_reason = null;
    });
    return { accepted: true, task_id: worker.task_id };
  }

  async status(input: unknown) {
    const parsed = StatusInputSchema.parse(input);
    const before = await this.#ownedWorkers(
      parsed.parent_session_id,
      parsed.task_id
    );
    await Promise.all(before.map((worker) => this.refresh(worker.task_id)));
    const root = await this.#store.readRoot();
    const workers = this.#selectOwned(
      root,
      parsed.parent_session_id,
      parsed.task_id
    );
    if (parsed.task_id === undefined) {
      return {
        workers: workers.map((worker) => projectWorker(root, worker, "none")),
      };
    }
    const worker = workers[0];
    if (worker === undefined) {
      throw new Error("The selected current managed worker is unavailable.");
    }
    return {
      available_actions: availableActionsForWorker(root, worker, "all"),
      worker: projectWorker(root, worker, "all"),
    };
  }

  async compactionStatus(parentSessionID: string) {
    const root = await this.#store.readRoot();
    const workflow = root.workflows.workflows.find(
      (candidate) =>
        candidate.current && candidate.parent_session_id === parentSessionID
    );
    const version = workflow?.versions.find(
      (candidate) => candidate.version === workflow.current_version
    );
    if (version === undefined) {
      return [];
    }
    const taskIDs = new Set(
      Object.values(version.job_states).flatMap((runtime) =>
        runtime.task_id === undefined ? [] : [runtime.task_id]
      )
    );
    return this.#selectOwned(root, parentSessionID)
      .filter((worker) => taskIDs.has(worker.task_id))
      .map((worker) => projectWorker(root, worker, "all"));
  }

  async inspect(input: unknown) {
    const parsed = InspectInputSchema.parse(input);
    await this.refresh(parsed.task_id);
    const root = await this.#store.readRoot();
    const worker = this.#selectOwned(
      root,
      parsed.parent_session_id,
      parsed.task_id
    )[0];
    if (worker === undefined) {
      throw new Error("The selected current managed worker is unavailable.");
    }
    const turns = workerTurnsFor(root, worker);
    const turn =
      parsed.turn === undefined
        ? turns.at(-1)
        : turns.find((candidate) => candidate.turn === parsed.turn);
    if (turn === undefined) {
      throw new Error("The selected completed worker turn is unavailable.");
    }
    const content = await this.#inspectionContent(parsed, worker, turn);
    const artifact = await this.#materializeInspection(
      parsed,
      worker,
      turn,
      content
    );
    return {
      artifact,
      ...(parsed.type === "diff" ? { file: parsed.file } : {}),
      ...(parsed.type === "tool_output" ? { tool: parsed.tool } : {}),
      task_id: parsed.task_id,
      turn: turn.turn,
      type: parsed.type,
    };
  }

  async cleanupWorkflow(workflowID: string): Promise<void> {
    const root = await this.#artifactRoot;
    await rm(this.#workflowArtifactDirectory(root, workflowID), {
      force: true,
      recursive: true,
    });
  }

  async #materializeInspection(
    input: InspectInput,
    worker: WorkerBindingRecord,
    turn: WorkerTurnRecord,
    content: string
  ) {
    const root = await this.#artifactRoot;
    const directory = path.join(
      this.#workflowArtifactDirectory(root, worker.workflow_id),
      `${artifactSlug(worker.job)}-${sha256(worker.task_id).slice(0, 10)}`,
      `turn-${turn.turn}`
    );
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    let file = "result.md";
    if (input.type === "diff") {
      file = `diff-${artifactSlug(input.file)}.patch`;
    } else if (input.type === "tool_output") {
      const output = turn.tool_outputs.find(
        (candidate) => candidate.ordinal === input.tool
      );
      if (output === undefined) {
        throw new Error(
          "The selected advertised worker tool output is unavailable."
        );
      }
      file = `tool-${input.tool}-${artifactSlug(output.tool)}.txt`;
    }
    const artifactPath = path.join(directory, file);
    await writeFile(artifactPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(artifactPath, 0o600);
    return {
      bytes: Buffer.byteLength(content, "utf8"),
      directory,
      file,
      path: artifactPath,
      sha256: sha256(content),
    };
  }

  #workflowArtifactDirectory(root: string, workflowID: string): string {
    return path.join(root, `workflow-${sha256(workflowID).slice(0, 16)}`);
  }

  async wait(input: unknown) {
    const parsed = WaitInputSchema.parse(input);
    const deadline = this.#now() + parsed.timeout_ms;
    while (true) {
      const root = await this.#store.readRoot();
      const selected = this.#waitSelection(root, parsed);
      const eligible = selected.filter(
        (worker) =>
          terminalWorker(worker) ||
          (worker.latest_event !== null &&
            worker.latest_event.sequence > worker.delivered_event_sequence)
      );
      const complete =
        parsed.until === "any"
          ? eligible.length > 0
          : selected.length > 0 && eligible.length === selected.length;
      if (complete) {
        const returned = parsed.until === "any" ? eligible : selected;
        const sequences = new Map(
          returned.map((worker) => [
            worker.task_id,
            worker.latest_event?.sequence ?? 0,
          ])
        );
        await this.#store.mutateRoot(({ root: current }) => {
          for (const worker of current.workers) {
            const sequence = sequences.get(worker.task_id);
            if (
              sequence !== undefined &&
              sequence > worker.delivered_event_sequence
            ) {
              worker.delivered_event_sequence = sequence;
            }
          }
        });
        return {
          timed_out: false,
          workers: returned.map((worker) =>
            projectWorker(root, worker, "none")
          ),
        };
      }
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        return {
          timed_out: true,
          workers: selected.map((worker) =>
            projectWorker(root, worker, "none")
          ),
        };
      }
      await this.#sleep(Math.min(25, remaining));
    }
  }

  async #evaluateTurnSafety(input: {
    readonly messages: OpenCodeMessageRecord[];
    readonly root: RootSnapshot;
    readonly session: OpenCodeSession;
    readonly status: "busy" | "idle" | "retry";
    readonly turns: WorkerTurnRecord[];
    readonly worker: WorkerBindingRecord;
  }): Promise<void> {
    for (const [index, turn] of input.turns.entries()) {
      if (
        turn.undo_state === "redo_available" ||
        turn.undo_state === "redo_unavailable"
      ) {
        const reason = await this.#redoUnavailableReason(
          input.session,
          input.status,
          turn
        );
        turn.undo_state =
          reason === null ? "redo_available" : "redo_unavailable";
        turn.undo_unavailable_reason = reason;
        continue;
      }
      const selected = input.turns.slice(index);
      const reason = await this.#undoUnavailableReason({
        messages: input.messages,
        root: input.root,
        selected,
        session: input.session,
        status: input.status,
        worker: input.worker,
      });
      turn.undo_state = reason === null ? "available" : "unavailable";
      turn.undo_unavailable_reason = reason;
    }
  }

  async #undoUnavailableReason(input: {
    readonly messages: OpenCodeMessageRecord[];
    readonly root: RootSnapshot;
    readonly selected: WorkerTurnRecord[];
    readonly session: OpenCodeSession;
    readonly status: "busy" | "idle" | "retry";
    readonly worker: WorkerBindingRecord;
  }): Promise<string | null> {
    const boundary = input.selected[0];
    if (
      boundary === undefined ||
      input.selected.some((turn) => turn.completed_at === null)
    ) {
      return "The selected worker turn is not complete.";
    }
    if (input.worker.live_state !== "review" || input.status !== "idle") {
      return "Worker undo requires an idle worker in review.";
    }
    if (
      input.root.permissions.some(
        (permission) => permission.task_id === input.worker.task_id
      ) ||
      input.root.deliveries.some(
        (delivery) =>
          delivery.task_id === input.worker.task_id &&
          delivery.state !== "completed"
      )
    ) {
      return "Worker undo is unavailable while a permission or follow-up is pending.";
    }
    if (input.session.revert !== undefined) {
      return "OpenCode already has an active revert for this worker.";
    }
    if (
      input.selected.some((turn) =>
        turn.mutation_epochs.some(
          (epoch) => epoch.completed_at === null || epoch.overlap
        )
      )
    ) {
      return "A managed mutation overlapped or did not reach its after-hook.";
    }
    if (
      input.selected.some(
        (turn) =>
          turn.files.length > 0 && turn.files.some((file) => !file.attributed)
      )
    ) {
      return UNDO_PROVENANCE_REASON;
    }
    const expected = this.#selectedEndFiles(input.selected);
    try {
      await this.#assertHashes(input.session.directory, expected, "undo");
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Worker undo hash mismatch.";
    }
    let native: string[];
    try {
      native = this.#nativeRevertPaths(
        input.messages,
        boundary.boundary_message_id,
        input.session.directory
      );
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "OpenCode revert patch preflight failed.";
    }
    const expectedPaths = [...expected.keys()].sort();
    if (JSON.stringify(native) !== JSON.stringify(expectedPaths)) {
      return `OpenCode revert patch contains unexpected or missing paths: ${JSON.stringify(native)}.`;
    }
    return null;
  }

  async #redoUnavailableReason(
    session: OpenCodeSession,
    status: "busy" | "idle" | "retry",
    turn: WorkerTurnRecord
  ): Promise<string | null> {
    if (status !== "idle") {
      return "Worker redo requires an idle child session.";
    }
    if (session.revert?.messageID !== turn.boundary_message_id) {
      return "OpenCode no longer retains the matching redo state.";
    }
    try {
      await this.#assertFingerprint(
        session.directory,
        new Map(turn.post_undo_hashes.map((item) => [item.path, item.sha256])),
        "redo"
      );
      return null;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Worker redo hash mismatch.";
    }
  }

  #nativeRevertPaths(
    messages: OpenCodeMessageRecord[],
    boundaryMessageID: string,
    directory: string
  ): string[] {
    const boundaryIndex = messages.findIndex(
      (message) => message.info.id === boundaryMessageID
    );
    if (boundaryIndex < 0) {
      throw new Error(
        "OpenCode revert boundary is missing from child history."
      );
    }
    const files: string[] = [];
    for (const message of messages.slice(boundaryIndex)) {
      for (const part of message.parts) {
        if (part.type !== "patch") {
          continue;
        }
        const value: unknown = Reflect.get(part, "files");
        if (
          !Array.isArray(value) ||
          value.some((item) => typeof item !== "string")
        ) {
          throw new Error("OpenCode revert patch paths are malformed.");
        }
        files.push(
          ...(value as string[]).map((item) => canonicalPath(directory, item))
        );
      }
    }
    return [...new Set(files)].sort();
  }

  #selectedEndFiles(
    selected: readonly WorkerTurnRecord[]
  ): Map<string, string | null> {
    const expected = new Map<string, string | null>();
    for (const turn of selected) {
      for (const file of turn.files) {
        expected.set(file.path, file.end_sha256);
      }
    }
    return expected;
  }

  async #assertHashes(
    directory: string,
    expected: ReadonlyMap<string, string | null>,
    operation: string
  ): Promise<void> {
    const conflicts: string[] = [];
    for (const [file, hash] of expected) {
      if ((await readHash(this.#readFile, directory, file)) !== hash) {
        conflicts.push(file);
      }
    }
    if (conflicts.length > 0) {
      throw new Error(
        `Worker ${operation} hash conflict: ${conflicts.sort().join(", ")}.`
      );
    }
  }

  async #assertFingerprint(
    directory: string,
    expected: ReadonlyMap<string, string | null>,
    operation: string
  ): Promise<void> {
    const current = await this.#fingerprint(directory);
    const paths = [...new Set([...expected.keys(), ...current.keys()])].sort();
    const conflicts = paths.filter((file) => {
      if (!expected.has(file)) {
        return true;
      }
      if (!current.has(file)) {
        return expected.get(file) !== null;
      }
      return expected.get(file) !== current.get(file);
    });
    if (conflicts.length > 0) {
      throw new Error(
        `Worker ${operation} worktree conflict: ${conflicts.join(", ")}.`
      );
    }
  }

  async #setEpochOverlap(
    taskID: string,
    turn: number,
    callID: string
  ): Promise<void> {
    await this.#store.mutateRoot(({ root }) => {
      const epoch = root.turns
        .find(
          (candidate) => candidate.task_id === taskID && candidate.turn === turn
        )
        ?.mutation_epochs.find((candidate) => candidate.call_id === callID);
      if (epoch !== undefined) {
        epoch.overlap = true;
      }
    });
  }

  #timestamp(): string {
    return new Date(this.#now()).toISOString();
  }

  async #inspectionContent(
    input: InspectInput,
    worker: WorkerBindingRecord,
    turn: WorkerTurnRecord
  ): Promise<string> {
    if (input.type === "result") {
      return await this.#resultContent(worker, turn);
    }
    if (input.type === "tool_output") {
      return await this.#toolOutputContent(worker, turn, input.tool);
    }
    if (!turn.files.some((file) => file.path === input.file)) {
      throw new Error(
        "The selected file was not advertised for this worker turn."
      );
    }
    const diff = (
      await this.#sessions.diff(
        worker.child_session_id,
        turn.boundary_message_id
      )
    ).find((candidate) => candidate.path === input.file);
    if (diff === undefined) {
      throw new Error("The selected advertised worker diff is unavailable.");
    }
    return diff.patch;
  }

  async #resultContent(
    worker: WorkerBindingRecord,
    turn: WorkerTurnRecord
  ): Promise<string> {
    if (turn.result_message_id === null) {
      throw new Error("The selected worker result is unavailable.");
    }
    const content = resultText(
      await this.#sessions.message(
        worker.child_session_id,
        turn.result_message_id
      )
    );
    if (content.length === 0) {
      throw new Error("The selected worker result is empty.");
    }
    return content;
  }

  async #toolOutputContent(
    worker: WorkerBindingRecord,
    turn: WorkerTurnRecord,
    ordinal: number
  ): Promise<string> {
    const output = turn.tool_outputs.find(
      (candidate) => candidate.ordinal === ordinal
    );
    if (output === undefined || !output.output_available) {
      throw new Error(
        "The selected advertised worker tool output is unavailable."
      );
    }
    const message = await this.#sessions.message(
      worker.child_session_id,
      output.message_id
    );
    const part = message.parts.find(
      (candidate) => candidate.id === output.part_id
    );
    if (part === undefined || part.type !== "tool") {
      throw new Error("The selected worker tool output is malformed.");
    }
    return toolContent(toolState(part));
  }

  async #ownedWorkers(parentSessionID: string, taskID?: string) {
    const root = await this.#store.readRoot();
    return this.#selectOwned(root, parentSessionID, taskID);
  }

  #selectOwned(
    root: RootSnapshot,
    parentSessionID: string,
    taskID?: string
  ): WorkerBindingRecord[] {
    const workers = root.workers.filter(
      (worker) =>
        worker.parent_session_id === parentSessionID &&
        (taskID === undefined || worker.task_id === taskID)
    );
    if (taskID !== undefined && workers.length === 0) {
      throw new Error("The selected current managed worker is unavailable.");
    }
    return workers;
  }

  #waitSelection(
    root: RootSnapshot,
    input: z.infer<typeof WaitInputSchema>
  ): WorkerBindingRecord[] {
    const owned = this.#selectOwned(root, input.parent_session_id);
    if (input.task_ids === undefined) {
      return owned.filter((worker) => !terminalWorker(worker));
    }
    const selected = input.task_ids.map((taskID) => {
      const worker = owned.find((candidate) => candidate.task_id === taskID);
      if (worker === undefined) {
        throw new Error("The selected current managed worker is unavailable.");
      }
      return worker;
    });
    return selected;
  }
}
