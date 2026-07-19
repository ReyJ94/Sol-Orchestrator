import { randomUUID } from "node:crypto";
import type { PathLike } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { GoalState } from "./goal-state.js";
import {
  emptyRootSnapshot,
  GoalSnapshotSchema,
  parseRootSnapshot,
  type RootSnapshot,
  RootSnapshotSchema,
  WorkflowSnapshotSchema,
} from "./schema/orchestration.js";
import { WorkflowState } from "./workflow-state.js";

export const StoreHealthSchema = z.discriminatedUnion("status", [
  z
    .object({
      durable: z.literal(true),
      state_path: z.string().min(1),
      status: z.literal("healthy"),
    })
    .strict(),
  z
    .object({
      durable: z.literal(true),
      quarantine_path: z.string().min(1),
      reason: z.literal("corrupt_state"),
      state_path: z.string().min(1),
      status: z.literal("recovered"),
    })
    .strict(),
  z
    .object({
      durable: z.literal(false),
      reason: z.enum(["read_failed", "quarantine_failed", "write_failed"]),
      state_path: z.string().min(1),
      status: z.literal("degraded"),
    })
    .strict(),
]);

export type StoreHealth = z.infer<typeof StoreHealthSchema>;

type Clock = () => Date | number | string;
type Sleep = (duration: number) => Promise<void>;
type ProcessAlive = (pid: number | undefined) => boolean;
type FileSystemAdapter = Pick<
  typeof defaultFileSystem,
  "chmod" | "mkdir" | "open" | "rename" | "rm" | "stat" | "writeFile"
> & {
  readFile: (file: PathLike, encoding: "utf8") => Promise<string>;
};
type DegradedEntry = {
  health: Extract<StoreHealth, { status: "degraded" }>;
  root: RootSnapshot;
};
type LockLease = {
  created_at_ms?: number;
  pid?: number;
  token?: string;
};
type StoreOptions = {
  env?: NodeJS.ProcessEnv;
  fs?: FileSystemAdapter;
  home?: string;
  isProcessAlive?: ProcessAlive;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  now?: Clock;
  sleep?: Sleep;
  staleLockMs?: number;
  statePath?: string;
};

export type RootMutationState = {
  goal: GoalState;
  root: RootSnapshot;
  workflow: WorkflowState;
};

type DegradedReason = Extract<StoreHealth, { status: "degraded" }>["reason"];

const defaultFileSystem = {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
};

const localQueues = new Map<string, Promise<unknown>>();
const degradedRoots = new Map<string, DegradedEntry>();

const clone = <Value>(value: Value): Value => structuredClone(value);

const freeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error;

const hasCode = (error: unknown, code: string): boolean =>
  isNodeError(error) && error.code === code;

const isMissing = (error: unknown): boolean => hasCode(error, "ENOENT");
const isExisting = (error: unknown): boolean => hasCode(error, "EEXIST");

const defaultProcessAlive: ProcessAlive = (pid) => {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
};

const milliseconds = (value: Date | number | string): number => {
  let result: number;
  if (value instanceof Date) {
    result = value.getTime();
  } else if (typeof value === "number") {
    result = value;
  } else {
    result = Date.parse(value);
  }
  if (!Number.isFinite(result)) {
    throw new OrchestrationStoreError(
      "ORCHESTRATION_CLOCK_INVALID",
      "The orchestration store clock returned an invalid timestamp."
    );
  }
  return result;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

export class OrchestrationStoreError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "OrchestrationStoreError";
    this.code = code;
  }
}

export const resolveStatePath = (
  options: { env?: NodeJS.ProcessEnv; home?: string; statePath?: string } = {}
): string => {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  if (options.statePath !== undefined) {
    if (options.statePath.length === 0) {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_STATE_PATH_INVALID",
        "statePath must be a non-empty string."
      );
    }
    return options.statePath;
  }
  if (env.OPENCODE_SOL_ORCHESTRATOR_STATE_PATH) {
    return env.OPENCODE_SOL_ORCHESTRATOR_STATE_PATH;
  }
  if (env.XDG_STATE_HOME) {
    return path.join(
      env.XDG_STATE_HOME,
      "opencode",
      "opencode-sol-orchestrator",
      "state-v2.json"
    );
  }
  if (home.length === 0) {
    throw new OrchestrationStoreError(
      "ORCHESTRATION_HOME_INVALID",
      "The orchestration store home directory must be a non-empty string."
    );
  }
  return path.join(
    home,
    ".local",
    "state",
    "opencode",
    "opencode-sol-orchestrator",
    "state-v2.json"
  );
};

export class OrchestrationStore {
  readonly #fs: FileSystemAdapter;
  readonly #statePath: string;
  readonly #lockPath: string;
  readonly #recoveryPath: string;
  readonly #now: Clock;
  readonly #sleep: Sleep;
  readonly #isProcessAlive: ProcessAlive;
  readonly #lockTimeoutMs: number;
  readonly #lockRetryMs: number;
  readonly #staleLockMs: number;
  #health: StoreHealth;
  #degradedRoot: RootSnapshot | undefined;

  constructor(options: StoreOptions = {}) {
    const lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    const lockRetryMs = options.lockRetryMs ?? 10;
    const staleLockMs = options.staleLockMs ?? 60_000;
    for (const [name, value] of Object.entries({
      lockRetryMs,
      lockTimeoutMs,
      staleLockMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new OrchestrationStoreError(
          "ORCHESTRATION_LOCK_OPTIONS_INVALID",
          `${name} must be a non-negative safe integer.`
        );
      }
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_STORE_OPTIONS_INVALID",
        "The orchestration store now option must be a function."
      );
    }
    this.#fs = options.fs ?? defaultFileSystem;
    this.#statePath = resolveStatePath(options);
    this.#lockPath = `${this.#statePath}.lock`;
    this.#recoveryPath = `${this.#lockPath}.recovery`;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep =
      options.sleep ??
      ((duration) =>
        new Promise((resolve) => {
          setTimeout(resolve, duration);
        }));
    this.#isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.#lockTimeoutMs = lockTimeoutMs;
    this.#lockRetryMs = lockRetryMs;
    this.#staleLockMs = staleLockMs;
    this.#health = freeze({
      durable: true,
      state_path: this.#statePath,
      status: "healthy",
    });
  }

  get statePath(): string {
    return this.#statePath;
  }

  get health(): StoreHealth {
    this.#currentDegradedRoot();
    return freeze(clone(this.#health));
  }

  async initialize(): Promise<StoreHealth> {
    await this.readRoot();
    return this.health;
  }

  async readRoot(): Promise<RootSnapshot> {
    return this.#snapshot(await this.#rootForRead());
  }

  async readWorkflow<Value>(
    reader: (state: WorkflowState) => Value
  ): Promise<Awaited<Value>> {
    if (typeof reader !== "function") {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_READER_INVALID",
        "The workflow store reader must be a function."
      );
    }
    const root = await this.#rootForRead();
    return await reader(this.#workflowState(root));
  }

  async readGoal<Value>(
    reader: (state: GoalState) => Value
  ): Promise<Awaited<Value>> {
    if (typeof reader !== "function") {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_READER_INVALID",
        "The goal store reader must be a function."
      );
    }
    const root = await this.#rootForRead();
    return await reader(this.#goalState(root));
  }

  mutateWorkflow<Value>(
    mutation: (state: WorkflowState) => Value
  ): Promise<Value> {
    if (typeof mutation !== "function") {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_MUTATION_INVALID",
        "The workflow store mutation must be a function."
      );
    }
    return this.mutateRoot(({ workflow }) => mutation(workflow));
  }

  mutateGoal<Value>(mutation: (state: GoalState) => Value): Promise<Value> {
    if (typeof mutation !== "function") {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_MUTATION_INVALID",
        "The goal store mutation must be a function."
      );
    }
    return this.mutateRoot(({ goal }) => mutation(goal));
  }

  mutateRoot<Value>(
    mutation: (state: RootMutationState) => Value
  ): Promise<Value> {
    if (typeof mutation !== "function") {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_MUTATION_INVALID",
        "The root orchestration mutation must be a function."
      );
    }
    return this.#serialize(async () => {
      const degraded = this.#currentDegradedRoot();
      if (degraded !== undefined) {
        return this.#mutateDegraded(degraded, mutation);
      }
      return await this.#withLock(async () => {
        const loaded = await this.#loadUnderLock();
        const degradedAfterLoad = this.#currentDegradedRoot();
        if (degradedAfterLoad !== undefined) {
          return this.#mutateDegraded(degradedAfterLoad, mutation);
        }
        const draft = clone(loaded);
        const goal = this.#goalState(draft);
        const workflow = this.#workflowState(draft);
        const value = mutation({ goal, root: draft, workflow });
        if (isPromiseLike(value)) {
          throw new OrchestrationStoreError(
            "ORCHESTRATION_ASYNC_MUTATION",
            "Orchestration store mutation callbacks must be synchronous."
          );
        }
        draft.goals = GoalSnapshotSchema.parse(goal.snapshot());
        draft.workflows = WorkflowSnapshotSchema.parse(workflow.snapshot());
        const snapshot = this.#snapshot(draft);
        try {
          await this.#write(snapshot);
        } catch (error) {
          this.#enterDegraded(snapshot, "write_failed");
          throw error;
        }
        return value;
      });
    });
  }

  #mutateDegraded<Value>(
    current: RootSnapshot,
    mutation: (state: RootMutationState) => Value
  ): Value {
    const draft = clone(current);
    const goal = this.#goalState(draft);
    const workflow = this.#workflowState(draft);
    const value = mutation({ goal, root: draft, workflow });
    if (isPromiseLike(value)) {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_ASYNC_MUTATION",
        "Orchestration store mutation callbacks must be synchronous."
      );
    }
    draft.goals = GoalSnapshotSchema.parse(goal.snapshot());
    draft.workflows = WorkflowSnapshotSchema.parse(workflow.snapshot());
    this.#replaceDegradedRoot(this.#snapshot(draft));
    return value;
  }

  async #rootForRead(): Promise<RootSnapshot> {
    const degraded = this.#currentDegradedRoot();
    if (degraded !== undefined) {
      return degraded;
    }
    try {
      return await this.#loadDisk();
    } catch (error) {
      if (this.#storeErrorCode(error) === "ORCHESTRATION_STATE_INVALID") {
        return this.#serialize(() =>
          this.#withLock(() => this.#loadUnderLock())
        );
      }
      if (this.#storeErrorCode(error) === "ORCHESTRATION_STATE_READ_FAILED") {
        return this.#enterDegraded(this.#emptyRoot(), "read_failed");
      }
      throw error;
    }
  }

  async #loadUnderLock(): Promise<RootSnapshot> {
    const degraded = this.#currentDegradedRoot();
    if (degraded !== undefined) {
      return degraded;
    }
    try {
      return await this.#loadDisk();
    } catch (error) {
      const code = this.#storeErrorCode(error);
      if (code === "ORCHESTRATION_STATE_INVALID") {
        return this.#quarantineInvalid();
      }
      if (code === "ORCHESTRATION_STATE_READ_FAILED") {
        return this.#enterDegraded(this.#emptyRoot(), "read_failed");
      }
      throw error;
    }
  }

  async #loadDisk(): Promise<RootSnapshot> {
    let contents: string;
    try {
      contents = await this.#fs.readFile(this.#statePath, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return this.#emptyRoot();
      }
      throw new OrchestrationStoreError(
        "ORCHESTRATION_STATE_READ_FAILED",
        `Could not read orchestration state at ${this.#statePath}.`,
        { cause: error }
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(contents);
    } catch (error) {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_STATE_INVALID",
        `Orchestration state at ${this.#statePath} contains malformed JSON.`,
        { cause: error }
      );
    }
    try {
      return this.#snapshot(parseRootSnapshot(input));
    } catch (error) {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_STATE_INVALID",
        `Orchestration state at ${this.#statePath} is invalid or uses an unsupported schema.`,
        { cause: error }
      );
    }
  }

  async #quarantineInvalid(): Promise<RootSnapshot> {
    const quarantinePath = `${this.#statePath}.corrupt-${milliseconds(this.#now())}-${randomUUID()}`;
    try {
      await this.#fs.rename(this.#statePath, quarantinePath);
    } catch (renameError) {
      if (isMissing(renameError)) {
        return this.#emptyRoot();
      }
      return this.#enterDegraded(this.#emptyRoot(), "quarantine_failed");
    }
    this.#health = StoreHealthSchema.parse({
      durable: true,
      quarantine_path: quarantinePath,
      reason: "corrupt_state",
      state_path: this.#statePath,
      status: "recovered",
    });
    return this.#emptyRoot();
  }

  #enterDegraded(root: RootSnapshot, reason: DegradedReason): RootSnapshot {
    const health = StoreHealthSchema.parse({
      durable: false,
      reason,
      state_path: this.#statePath,
      status: "degraded",
    });
    if (health.status !== "degraded") {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_HEALTH_INVALID",
        "Degraded health parsing returned a non-degraded state."
      );
    }
    const snapshot = this.#snapshot(root);
    this.#health = health;
    this.#degradedRoot = snapshot;
    degradedRoots.set(this.#statePath, { health, root: snapshot });
    return snapshot;
  }

  #currentDegradedRoot(): RootSnapshot | undefined {
    const shared = degradedRoots.get(this.#statePath);
    if (shared !== undefined) {
      this.#degradedRoot = shared.root;
      this.#health = shared.health;
    }
    return this.#degradedRoot;
  }

  #replaceDegradedRoot(root: RootSnapshot): void {
    const shared = degradedRoots.get(this.#statePath);
    if (shared === undefined) {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_DEGRADED_STATE_MISSING",
        "The shared degraded orchestration root is unavailable."
      );
    }
    const snapshot = this.#snapshot(root);
    degradedRoots.set(this.#statePath, {
      health: shared.health,
      root: snapshot,
    });
    this.#degradedRoot = snapshot;
  }

  #emptyRoot(): RootSnapshot {
    return this.#snapshot(emptyRootSnapshot());
  }

  #workflowState(root: RootSnapshot): WorkflowState {
    return WorkflowState.restore(root.workflows, {
      now: () => new Date(milliseconds(this.#now())).toISOString(),
    });
  }

  #goalState(root: RootSnapshot): GoalState {
    return GoalState.restore(root.goals, {
      now: () => new Date(milliseconds(this.#now())).toISOString(),
    });
  }

  #snapshot(root: RootSnapshot): RootSnapshot {
    return freeze(RootSnapshotSchema.parse(clone(root)));
  }

  #storeErrorCode(error: unknown): string | undefined {
    return error instanceof OrchestrationStoreError ? error.code : undefined;
  }

  async #serialize<Value>(operation: () => Promise<Value>): Promise<Value> {
    const prior = localQueues.get(this.#statePath) ?? Promise.resolve();
    const queued = prior.catch(() => undefined).then(operation);
    localQueues.set(this.#statePath, queued);
    try {
      return await queued;
    } finally {
      if (localQueues.get(this.#statePath) === queued) {
        localQueues.delete(this.#statePath);
      }
    }
  }

  async #write(snapshot: RootSnapshot): Promise<void> {
    const validated = RootSnapshotSchema.parse(snapshot);
    const directory = path.dirname(this.#statePath);
    const temporaryPath = `${this.#statePath}.tmp-${process.pid}-${randomUUID()}`;
    let temporaryCreated = false;
    try {
      await this.#fs.mkdir(directory, { mode: 0o700, recursive: true });
      await this.#fs.chmod(directory, 0o700).catch(() => undefined);
      const handle = await this.#fs.open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#fs.rename(temporaryPath, this.#statePath);
      temporaryCreated = false;
      await this.#fs.chmod(this.#statePath, 0o600).catch(() => undefined);
    } catch (error) {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_STATE_WRITE_FAILED",
        `Could not atomically write orchestration state at ${this.#statePath}.`,
        { cause: error }
      );
    } finally {
      if (temporaryCreated) {
        await this.#fs
          .rm(temporaryPath, { force: true })
          .catch(() => undefined);
      }
    }
  }

  async #withLock<Value>(operation: () => Promise<Value>): Promise<Value> {
    const lease = await this.#acquireLock();
    try {
      return await operation();
    } finally {
      await this.#releaseLock(lease);
    }
  }

  async #acquireLock(): Promise<LockLease> {
    const token = randomUUID();
    const started = milliseconds(this.#now());
    try {
      await this.#fs.mkdir(path.dirname(this.#statePath), {
        mode: 0o700,
        recursive: true,
      });
      await this.#fs
        .chmod(path.dirname(this.#statePath), 0o700)
        .catch(() => undefined);
    } catch (error) {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_LOCK_FAILED",
        `Could not prepare orchestration state directory at ${path.dirname(this.#statePath)}.`,
        { cause: error }
      );
    }
    while (true) {
      const recovery = await this.#readLease(this.#recoveryPath);
      if (recovery !== undefined) {
        if (this.#staleLease(recovery)) {
          await this.#breakStaleRecovery(recovery);
          continue;
        }
        await this.#waitForLock(started);
        continue;
      }
      try {
        return await this.#createLease(this.#lockPath, token);
      } catch (error) {
        if (!isExisting(error)) {
          throw new OrchestrationStoreError(
            "ORCHESTRATION_LOCK_FAILED",
            `Could not acquire orchestration state lock at ${this.#lockPath}.`,
            { cause: error }
          );
        }
        const current = await this.#readLease(this.#lockPath);
        if (
          current !== undefined &&
          this.#staleLease(current) &&
          (await this.#recoverStaleLock(current, started))
        ) {
          continue;
        }
        await this.#waitForLock(started);
      }
    }
  }

  async #createLease(lockPath: string, token: string): Promise<LockLease> {
    await this.#fs.mkdir(lockPath, { mode: 0o700 });
    try {
      await this.#fs.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({
          created_at_ms: milliseconds(this.#now()),
          pid: process.pid,
          token,
        }),
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
    } catch (error) {
      await this.#fs
        .rm(lockPath, { force: true, recursive: true })
        .catch(() => undefined);
      throw error;
    }
    return { token };
  }

  async #readLease(lockPath: string): Promise<LockLease | undefined> {
    let contents: string;
    try {
      contents = await this.#fs.readFile(
        path.join(lockPath, "owner.json"),
        "utf8"
      );
    } catch (error) {
      if (!isMissing(error)) {
        throw new OrchestrationStoreError(
          "ORCHESTRATION_LOCK_FAILED",
          `Could not read orchestration state lock at ${lockPath}.`,
          { cause: error }
        );
      }
      return this.#leaseFromDirectory(lockPath);
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "token" in parsed &&
        typeof parsed.token === "string" &&
        parsed.token.length > 0 &&
        "created_at_ms" in parsed &&
        typeof parsed.created_at_ms === "number" &&
        Number.isFinite(parsed.created_at_ms)
      ) {
        return {
          created_at_ms: parsed.created_at_ms,
          pid:
            "pid" in parsed &&
            typeof parsed.pid === "number" &&
            Number.isSafeInteger(parsed.pid) &&
            parsed.pid > 0
              ? parsed.pid
              : undefined,
          token: parsed.token,
        };
      }
    } catch {
      return this.#leaseFromDirectory(lockPath);
    }
    return this.#leaseFromDirectory(lockPath);
  }

  async #leaseFromDirectory(lockPath: string): Promise<LockLease | undefined> {
    try {
      const details = await this.#fs.stat(lockPath);
      return {
        created_at_ms: Number.isFinite(details.mtimeMs)
          ? details.mtimeMs
          : undefined,
      };
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw new OrchestrationStoreError(
        "ORCHESTRATION_LOCK_FAILED",
        `Could not inspect orchestration state lock at ${lockPath}.`,
        { cause: error }
      );
    }
  }

  #staleLease(lease: LockLease): boolean {
    if (
      lease.created_at_ms === undefined ||
      !Number.isFinite(lease.created_at_ms) ||
      milliseconds(this.#now()) - lease.created_at_ms <= this.#staleLockMs
    ) {
      return false;
    }
    return !this.#isProcessAlive(lease.pid);
  }

  #sameLease(
    expected: LockLease | undefined,
    current: LockLease | undefined
  ): boolean {
    if (expected === undefined || current === undefined) {
      return false;
    }
    if (expected.token !== undefined) {
      return expected.token === current.token;
    }
    return (
      current.token === undefined &&
      expected.created_at_ms === current.created_at_ms
    );
  }

  async #waitForLock(started: number): Promise<void> {
    if (milliseconds(this.#now()) - started >= this.#lockTimeoutMs) {
      throw new OrchestrationStoreError(
        "ORCHESTRATION_LOCK_TIMEOUT",
        `Timed out waiting for the live orchestration state lock at ${this.#lockPath}.`
      );
    }
    await this.#sleep(this.#lockRetryMs);
  }

  async #recoverStaleLock(
    candidate: LockLease,
    started: number
  ): Promise<boolean> {
    const recovery = await this.#acquireRecoveryGuard(started);
    try {
      const current = await this.#readLease(this.#lockPath);
      if (
        !(this.#sameLease(candidate, current) && this.#staleLease(candidate))
      ) {
        return false;
      }
      const abandoned = `${this.#lockPath}.abandoned-${candidate.token ?? "missing"}-${randomUUID()}`;
      try {
        await this.#fs.rename(this.#lockPath, abandoned);
      } catch (error) {
        if (isMissing(error)) {
          return true;
        }
        throw new OrchestrationStoreError(
          "ORCHESTRATION_LOCK_FAILED",
          `Could not quarantine stale orchestration state lock at ${this.#lockPath}.`,
          { cause: error }
        );
      }
      await this.#fs.rm(abandoned, { force: true, recursive: true });
      return true;
    } finally {
      await this.#releaseLease(this.#recoveryPath, recovery.token);
    }
  }

  async #acquireRecoveryGuard(started: number): Promise<LockLease> {
    const token = randomUUID();
    while (true) {
      try {
        return await this.#createLease(this.#recoveryPath, token);
      } catch (error) {
        if (!isExisting(error)) {
          throw new OrchestrationStoreError(
            "ORCHESTRATION_LOCK_FAILED",
            `Could not acquire orchestration recovery guard at ${this.#recoveryPath}.`,
            { cause: error }
          );
        }
        const current = await this.#readLease(this.#recoveryPath);
        if (current !== undefined && this.#staleLease(current)) {
          await this.#breakStaleRecovery(current);
          continue;
        }
        await this.#waitForLock(started);
      }
    }
  }

  async #breakStaleRecovery(candidate: LockLease): Promise<void> {
    const current = await this.#readLease(this.#recoveryPath);
    if (!(this.#sameLease(candidate, current) && this.#staleLease(candidate))) {
      return;
    }
    const abandoned = `${this.#recoveryPath}.abandoned-${candidate.token ?? "missing"}-${randomUUID()}`;
    try {
      await this.#fs.rename(this.#recoveryPath, abandoned);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw new OrchestrationStoreError(
        "ORCHESTRATION_LOCK_FAILED",
        `Could not quarantine stale orchestration recovery guard at ${this.#recoveryPath}.`,
        { cause: error }
      );
    }
    await this.#fs.rm(abandoned, { force: true, recursive: true });
  }

  async #releaseLock(lease: LockLease): Promise<void> {
    await this.#releaseLease(this.#lockPath, lease.token);
  }

  async #releaseLease(
    lockPath: string,
    token: string | undefined
  ): Promise<void> {
    try {
      const owner = await this.#readLease(lockPath);
      if (owner?.token !== token) {
        return;
      }
      await this.#fs.rm(lockPath, { force: true, recursive: true });
    } catch (error) {
      if (!isMissing(error)) {
        throw new OrchestrationStoreError(
          "ORCHESTRATION_LOCK_RELEASE_FAILED",
          `Could not release orchestration state lock at ${lockPath}.`,
          { cause: error }
        );
      }
    }
  }
}
