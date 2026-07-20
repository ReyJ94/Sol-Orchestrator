import { z } from "zod";

import { ExternalIdSchema, TimestampSchema } from "./schema/common.js";
import type {
  JobRunRecord,
  PendingDeliveryRecord,
  RootSnapshot,
  WorkerBindingRecord,
} from "./schema/orchestration.js";
import { isCoalescibleDeliveryState } from "./schema/orchestration.js";
import type { WorkflowState } from "./workflow-state.js";

const EventMessageSchema = z.string().trim().min(1).max(8000);
const NativeStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("busy") }).strict(),
  z.object({ type: z.literal("idle") }).strict(),
  z
    .object({
      attempt: z.int().nonnegative(),
      message: EventMessageSchema.max(4000),
      next: z.number().finite(),
      type: z.literal("retry"),
    })
    .strip(),
]);
const ReconcileStatusSchema = z.union([
  NativeStatusSchema,
  z.enum(["busy", "idle"]).transform((type) => ({ type })),
  z.literal("missing"),
]);
type ReconcileStatus = z.output<typeof ReconcileStatusSchema>;
const ADDITIONAL_STEERING_SEPARATOR =
  "\n\n--- Additional priority steering received before dispatch; later instruction takes precedence on conflict ---\n";

const WorkerReportSchema = z
  .object({
    kind: z.enum(["progress", "blocker"]),
    message: EventMessageSchema,
    parent_session_id: ExternalIdSchema,
    task_id: ExternalIdSchema,
  })
  .strict();

const WorkerFinalSchema = z
  .object({
    message_id: ExternalIdSchema,
    parent_session_id: ExternalIdSchema,
    task_id: ExternalIdSchema,
  })
  .strict();

const WorkerInterruptSchema = z
  .object({
    parent_session_id: ExternalIdSchema,
    reason: EventMessageSchema,
    task_id: ExternalIdSchema,
  })
  .strict();

const DeliveryRequestSchema = z
  .object({
    delivery_id: ExternalIdSchema,
    message: EventMessageSchema,
    parent_session_id: ExternalIdSchema,
    task_id: ExternalIdSchema,
  })
  .strict();

const DeliveryMessageSchema = z
  .object({
    child_user_message_id: ExternalIdSchema,
    task_id: ExternalIdSchema,
  })
  .strict();

const DeliveryCompletionSchema = DeliveryMessageSchema.extend({
  assistant_message_id: ExternalIdSchema,
  parent_session_id: ExternalIdSchema,
}).strict();

const ReconcileSchema = z
  .object({
    child_exists: z.boolean(),
    final_message_id: ExternalIdSchema.nullable(),
    status: ReconcileStatusSchema,
    task_id: ExternalIdSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.child_exists === (input.status === "missing")) {
      context.addIssue({
        code: "custom",
        message: "Missing reconciliation status must match child existence.",
        path: ["status"],
      });
    }
  });

type Clock = () => Date | number | string;
type MutationState = { root: RootSnapshot; workflow: WorkflowState };

export type OrchestrationStateOptions = {
  readonly now?: Clock;
};

const clone = <Value>(value: Value): Value => structuredClone(value);

const timestamp = (value: Date | number | string): string => {
  let milliseconds: number;
  if (value instanceof Date) {
    milliseconds = value.getTime();
  } else if (typeof value === "number") {
    milliseconds = value;
  } else {
    milliseconds = Date.parse(value);
  }
  if (!Number.isFinite(milliseconds)) {
    throw new Error("The orchestration clock returned an invalid timestamp.");
  }
  return TimestampSchema.parse(new Date(milliseconds).toISOString());
};

export class OrchestrationState {
  readonly #now: () => string;

  constructor(options: OrchestrationStateOptions = {}) {
    const clock = options.now ?? (() => new Date());
    this.#now = () => timestamp(clock());
  }

  report(state: MutationState, input: unknown) {
    const parsed = WorkerReportSchema.parse(input);
    const worker = this.#ownedWorker(
      state.root,
      parsed.parent_session_id,
      parsed.task_id
    );
    const run = this.#activeRun(state.root, worker);
    this.#requireReportable(state.workflow, worker);
    const createdAt = this.#now();

    if (parsed.kind === "progress") {
      worker.latest_event = {
        created_at: createdAt,
        kind: "progress",
        message: parsed.message,
        sequence: this.#nextEventSequence(worker),
      };
      if (worker.live_state === "starting" || worker.live_state === "idle") {
        worker.live_state = "busy";
      }
      worker.updated_at = createdAt;
      run.updated_at = createdAt;
      return { accepted: true as const, kind: parsed.kind, terminal: false };
    }

    this.#block(state, worker, run, parsed.message, "blocker", "blocked");
    return { accepted: true as const, kind: parsed.kind, terminal: true };
  }

  final(state: MutationState, input: unknown) {
    const parsed = WorkerFinalSchema.parse(input);
    const worker = this.#ownedWorker(
      state.root,
      parsed.parent_session_id,
      parsed.task_id
    );
    if (
      worker.latest_event?.kind === "result" &&
      worker.latest_event.result_message_id === parsed.message_id
    ) {
      return {
        accepted: true as const,
        duplicate: true,
        result_available: true,
      };
    }
    const run = this.#activeRun(state.root, worker);
    const runtime = state.workflow.jobState({
      job: worker.job,
      workflow_id: worker.workflow_id,
    });
    if (runtime?.state !== "active") {
      throw new Error(
        `Managed worker job ${JSON.stringify(worker.job)} cannot publish a final result from ${runtime?.state ?? "missing"}.`
      );
    }
    state.workflow.markWorkerReview({
      job: worker.job,
      result_available: true,
      workflow_id: worker.workflow_id,
    });
    const createdAt = this.#now();
    run.result_available = true;
    run.state = "review";
    run.updated_at = createdAt;
    worker.latest_event = {
      created_at: createdAt,
      kind: "result",
      result_message_id: parsed.message_id,
      sequence: this.#nextEventSequence(worker),
    };
    worker.live_state = "review";
    worker.updated_at = createdAt;
    return {
      accepted: true as const,
      duplicate: false,
      result_available: true,
    };
  }

  interrupt(state: MutationState, input: unknown) {
    const parsed = WorkerInterruptSchema.parse(input);
    const worker = this.#ownedWorker(
      state.root,
      parsed.parent_session_id,
      parsed.task_id
    );
    if (
      worker.live_state === "review" &&
      worker.latest_event?.kind === "result"
    ) {
      return {
        completed: true as const,
        interrupted: false as const,
        result_available: true as const,
        task_id: worker.task_id,
      };
    }
    if (worker.live_state === "interrupted") {
      this.#removeDelivery(state.root, worker.task_id);
      return { interrupted: true as const, task_id: worker.task_id };
    }
    const run = this.#run(state.root, worker);
    const runtime = state.workflow.jobState({
      job: worker.job,
      workflow_id: worker.workflow_id,
    });
    if (
      runtime?.state === "active" ||
      runtime?.state === "ready" ||
      runtime?.state === "review"
    ) {
      state.workflow.blockJob({
        job: worker.job,
        message: parsed.reason,
        workflow_id: worker.workflow_id,
      });
    } else if (runtime?.state !== "blocked") {
      throw new Error(
        `Managed worker job ${JSON.stringify(worker.job)} cannot be interrupted from ${runtime?.state ?? "missing"}.`
      );
    }
    const createdAt = this.#now();
    run.state = "interrupted";
    run.updated_at = createdAt;
    worker.latest_event = {
      created_at: createdAt,
      kind: "interrupted",
      message: parsed.reason,
      sequence: this.#nextEventSequence(worker),
    };
    worker.live_state = "interrupted";
    worker.updated_at = createdAt;
    this.#removeDelivery(state.root, worker.task_id);
    return { interrupted: true as const, task_id: worker.task_id };
  }

  requestDelivery(state: MutationState, input: unknown) {
    const parsed = DeliveryRequestSchema.parse(input);
    const worker = this.#ownedWorker(
      state.root,
      parsed.parent_session_id,
      parsed.task_id
    );
    const run = this.#activeRun(state.root, worker);
    const runtime = state.workflow.jobState({
      job: worker.job,
      workflow_id: worker.workflow_id,
    });
    if (runtime?.state !== "active") {
      throw new Error(
        `Managed worker job ${JSON.stringify(worker.job)} cannot receive steering from ${runtime?.state ?? "missing"}.`
      );
    }
    const existing = this.#delivery(state.root, worker.task_id);
    if (existing !== undefined && isCoalescibleDeliveryState(existing.state)) {
      existing.message = EventMessageSchema.parse(
        `${existing.message}${ADDITIONAL_STEERING_SEPARATOR}${parsed.message}`
      );
      const updatedAt = this.#now();
      existing.updated_at = updatedAt;
      worker.updated_at = updatedAt;
      run.updated_at = updatedAt;
      return {
        accepted: true as const,
        coalesced: true as const,
        state: existing.state,
      };
    }
    if (existing !== undefined) {
      throw new Error(
        `Managed worker job ${JSON.stringify(worker.job)} already has a ${existing.state} delivery that cannot accept more steering. Call agents_status({ job: ${JSON.stringify(worker.job)} }) or agents_wait({ jobs: [${JSON.stringify(worker.job)}], until: "any" }).`
      );
    }
    const createdAt = this.#now();
    state.root.deliveries.push({
      child_user_message_id: null,
      created_at: createdAt,
      delivery_id: parsed.delivery_id,
      message: parsed.message,
      state: "pending_preemption",
      task_id: worker.task_id,
      updated_at: createdAt,
    });
    worker.live_state = "preempting";
    worker.updated_at = createdAt;
    run.updated_at = createdAt;
    return {
      accepted: true as const,
      coalesced: false as const,
      state: "pending_preemption" as const,
    };
  }

  waitForToolBoundary(root: RootSnapshot, taskID: string): boolean {
    return this.#transitionDelivery(
      root,
      ExternalIdSchema.parse(taskID),
      ["pending_preemption"],
      "waiting_tool_boundary"
    );
  }

  preemptDelivery(root: RootSnapshot, taskID: string): boolean {
    return this.#transitionDelivery(
      root,
      ExternalIdSchema.parse(taskID),
      ["pending_preemption", "waiting_tool_boundary"],
      "interrupting"
    );
  }

  dispatchDelivery(
    root: RootSnapshot,
    input: unknown
  ): PendingDeliveryRecord | null {
    const parsed = DeliveryMessageSchema.parse(input);
    const delivery = this.#delivery(root, parsed.task_id);
    if (
      delivery === undefined ||
      !["pending_preemption", "waiting_tool_boundary", "interrupting"].includes(
        delivery.state
      )
    ) {
      return null;
    }
    const updatedAt = this.#now();
    delivery.child_user_message_id = parsed.child_user_message_id;
    delivery.state = "dispatched";
    delivery.updated_at = updatedAt;
    const worker = this.#worker(root, parsed.task_id);
    worker.live_state = "preempting";
    worker.updated_at = updatedAt;
    this.#activeRun(root, worker).updated_at = updatedAt;
    return clone(delivery);
  }

  startDelivery(root: RootSnapshot, input: unknown): boolean {
    const parsed = DeliveryMessageSchema.parse(input);
    const delivery = this.#delivery(root, parsed.task_id);
    if (
      delivery?.state !== "dispatched" ||
      delivery.child_user_message_id !== parsed.child_user_message_id
    ) {
      return false;
    }
    const updatedAt = this.#now();
    delivery.state = "started";
    delivery.updated_at = updatedAt;
    const worker = this.#worker(root, parsed.task_id);
    worker.live_state = "busy";
    worker.updated_at = updatedAt;
    this.#activeRun(root, worker).updated_at = updatedAt;
    return true;
  }

  completeDelivery(state: MutationState, input: unknown): boolean {
    const parsed = DeliveryCompletionSchema.parse(input);
    const worker = this.#ownedWorker(
      state.root,
      parsed.parent_session_id,
      parsed.task_id
    );
    const delivery = this.#delivery(state.root, worker.task_id);
    if (
      delivery?.state !== "started" ||
      delivery.child_user_message_id !== parsed.child_user_message_id
    ) {
      return false;
    }
    this.final(state, {
      message_id: parsed.assistant_message_id,
      parent_session_id: parsed.parent_session_id,
      task_id: worker.task_id,
    });
    delivery.state = "completed";
    delivery.updated_at = this.#now();
    return true;
  }

  clearCompletedDelivery(root: RootSnapshot, taskID: string): boolean {
    const parsedTaskID = ExternalIdSchema.parse(taskID);
    if (this.#delivery(root, parsedTaskID)?.state !== "completed") {
      return false;
    }
    this.#removeDelivery(root, parsedTaskID);
    return true;
  }

  delivery(root: RootSnapshot, taskID: string): PendingDeliveryRecord | null {
    const delivery = this.#delivery(root, ExternalIdSchema.parse(taskID));
    return delivery === undefined ? null : clone(delivery);
  }

  reconcile(state: MutationState, input: unknown) {
    const parsed = ReconcileSchema.parse(input);
    const worker = this.#worker(state.root, parsed.task_id);
    if (
      worker.live_state === "blocked" ||
      worker.live_state === "interrupted"
    ) {
      return { action: "blocked" as const, task_id: worker.task_id };
    }
    if (!parsed.child_exists) {
      this.#block(
        state,
        worker,
        this.#run(state.root, worker),
        "Managed worker child session is missing during restart reconciliation.",
        "blocker",
        "blocked"
      );
      return { action: "blocked" as const, task_id: worker.task_id };
    }
    const delivery = this.#delivery(state.root, worker.task_id);
    if (delivery?.state === "completed" && worker.live_state === "review") {
      return { action: "review" as const, task_id: worker.task_id };
    }
    if (delivery !== undefined) {
      return this.#reconcileDelivery(
        state.root,
        worker,
        delivery,
        parsed.status
      );
    }
    if (worker.live_state === "review") {
      return { action: "review" as const, task_id: worker.task_id };
    }
    if (parsed.final_message_id !== null) {
      this.final(state, {
        message_id: parsed.final_message_id,
        parent_session_id: worker.parent_session_id,
        task_id: worker.task_id,
      });
      return { action: "review" as const, task_id: worker.task_id };
    }
    if (parsed.status !== "missing" && parsed.status.type !== "idle") {
      this.setLiveState(state.root, {
        status: parsed.status,
        task_id: worker.task_id,
      });
      return {
        action:
          parsed.status.type === "retry"
            ? ("retrying" as const)
            : ("busy" as const),
        task_id: worker.task_id,
      };
    }
    this.#block(
      state,
      worker,
      this.#activeRun(state.root, worker),
      "Managed worker is idle without a final assistant result after restart.",
      "blocker",
      "blocked"
    );
    return { action: "blocked" as const, task_id: worker.task_id };
  }

  setLiveState(
    root: RootSnapshot,
    input: { readonly status: unknown; readonly task_id: string }
  ): void {
    const parsed = {
      status: NativeStatusSchema.parse(input.status),
      task_id: ExternalIdSchema.parse(input.task_id),
    };
    const worker = this.#worker(root, parsed.task_id);
    if (
      worker.live_state === "review" ||
      worker.live_state === "blocked" ||
      worker.live_state === "interrupted"
    ) {
      return;
    }
    const updatedAt = this.#now();
    const delivery = this.#delivery(root, worker.task_id);
    if (parsed.status.type === "retry") {
      worker.live_state = "retrying";
      if (delivery !== undefined && delivery.state !== "started") {
        worker.live_state = "preempting";
      }
      worker.updated_at = updatedAt;
      this.#activeRun(root, worker).updated_at = updatedAt;
      return;
    }
    let liveState: "busy" | "idle" | "preempting" | "starting" =
      parsed.status.type;
    if (delivery !== undefined && delivery.state !== "started") {
      liveState = "preempting";
    }
    worker.live_state = liveState;
    worker.updated_at = updatedAt;
    this.#activeRun(root, worker).updated_at = updatedAt;
  }

  #reconcileDelivery(
    root: RootSnapshot,
    worker: WorkerBindingRecord,
    delivery: PendingDeliveryRecord,
    status: ReconcileStatus
  ) {
    const updatedAt = this.#now();
    worker.live_state =
      delivery.state === "started" &&
      status !== "missing" &&
      status.type === "busy"
        ? "busy"
        : "preempting";
    worker.updated_at = updatedAt;
    this.#activeRun(root, worker).updated_at = updatedAt;
    return {
      action: "resume_delivery" as const,
      delivery: delivery.state,
      task_id: worker.task_id,
    };
  }

  worker(root: RootSnapshot, taskID: string): WorkerBindingRecord {
    return clone(this.#worker(root, ExternalIdSchema.parse(taskID)));
  }

  #block(
    state: MutationState,
    worker: WorkerBindingRecord,
    run: JobRunRecord,
    message: string,
    kind: "blocker",
    runState: "blocked"
  ): void {
    state.workflow.blockJob({
      job: worker.job,
      message,
      workflow_id: worker.workflow_id,
    });
    const createdAt = this.#now();
    run.state = runState;
    run.updated_at = createdAt;
    worker.latest_event = {
      created_at: createdAt,
      kind,
      message,
      sequence: this.#nextEventSequence(worker),
    };
    worker.live_state = "blocked";
    worker.updated_at = createdAt;
    this.#removeDelivery(state.root, worker.task_id);
  }

  #transitionDelivery(
    root: RootSnapshot,
    taskID: string,
    expected: PendingDeliveryRecord["state"][],
    next: PendingDeliveryRecord["state"]
  ): boolean {
    const delivery = this.#delivery(root, taskID);
    if (delivery === undefined || !expected.includes(delivery.state)) {
      return false;
    }
    const updatedAt = this.#now();
    delivery.state = next;
    delivery.updated_at = updatedAt;
    const worker = this.#worker(root, taskID);
    worker.live_state = "preempting";
    worker.updated_at = updatedAt;
    this.#activeRun(root, worker).updated_at = updatedAt;
    return true;
  }

  #delivery(
    root: RootSnapshot,
    taskID: string
  ): PendingDeliveryRecord | undefined {
    return root.deliveries.find((delivery) => delivery.task_id === taskID);
  }

  #removeDelivery(root: RootSnapshot, taskID: string): void {
    const index = root.deliveries.findIndex(
      (delivery) => delivery.task_id === taskID
    );
    if (index !== -1) {
      root.deliveries.splice(index, 1);
    }
  }

  #requireReportable(workflow: WorkflowState, worker: WorkerBindingRecord) {
    const runtime = workflow.jobState({
      job: worker.job,
      workflow_id: worker.workflow_id,
    });
    if (
      runtime?.state !== "active" ||
      worker.live_state === "blocked" ||
      worker.live_state === "interrupted" ||
      worker.live_state === "review"
    ) {
      throw new Error(
        `Managed worker job ${JSON.stringify(worker.job)} is terminal or blocked and cannot report progress.`
      );
    }
  }

  #nextEventSequence(worker: WorkerBindingRecord): number {
    return (worker.latest_event?.sequence ?? 0) + 1;
  }

  #ownedWorker(
    root: RootSnapshot,
    parentSessionID: string,
    taskID: string
  ): WorkerBindingRecord {
    const worker = this.#worker(root, taskID);
    if (worker.parent_session_id !== parentSessionID) {
      throw new Error(
        "The selected managed worker belongs to a different parent session."
      );
    }
    return worker;
  }

  #worker(root: RootSnapshot, taskID: string): WorkerBindingRecord {
    const worker = root.workers.find(
      (candidate) =>
        candidate.task_id === taskID || candidate.child_session_id === taskID
    );
    if (worker === undefined) {
      throw new Error("The selected managed worker is unavailable.");
    }
    return worker;
  }

  #activeRun(root: RootSnapshot, worker: WorkerBindingRecord): JobRunRecord {
    const run = this.#run(root, worker);
    if (run.state !== "active") {
      throw new Error(
        `Managed worker job ${JSON.stringify(worker.job)} run is terminal in ${run.state}.`
      );
    }
    return run;
  }

  #run(root: RootSnapshot, worker: WorkerBindingRecord): JobRunRecord {
    const run = root.job_runs.find(
      (candidate) =>
        candidate.workflow_id === worker.workflow_id &&
        candidate.workflow_version === worker.workflow_version &&
        candidate.job === worker.job &&
        candidate.run_sequence === worker.run_sequence
    );
    if (run === undefined) {
      throw new Error(
        `Managed worker job ${JSON.stringify(worker.job)} has no bound job run.`
      );
    }
    return run;
  }
}
