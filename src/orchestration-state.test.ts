import { describe, expect, test } from "bun:test";

import { OrchestrationState } from "./orchestration-state.js";
import {
  emptyRootSnapshot,
  parseRootSnapshot,
  type RootSnapshot,
  WorkflowSnapshotSchema,
} from "./schema/orchestration.js";
import type { WorkflowDefinition } from "./schema/workflow.js";
import { WorkflowState } from "./workflow-state.js";

const now = "2026-07-17T12:00:00.000Z";
const parentSessionID = "parent-1";
const taskID = "child-1";
const workflowID = "workflow-1";
const job = "implement worker events";
const INTERNAL_ID_PATTERN =
  /workflow_id|event_id|message_id|run_sequence|lease|checkpoint/u;
const TERMINAL_PATTERN = /terminal|blocked/u;
const MISSING_PATTERN = /missing/u;
const IDLE_FINAL_PATTERN = /idle.*final|final.*idle/u;
const PARENT_PATTERN = /parent/u;
const MANAGED_WORKER_PATTERN = /managed worker/u;
const PENDING_STEERING_PATTERN = /already.*delivery.*cannot accept/u;
const COALESCED_LIMIT_PATTERN = /8000|too big/iu;

const definition: WorkflowDefinition = {
  objective: "Replace checkpoint delivery with worker events.",
  steps: [
    {
      dependsOn: [],
      jobs: [
        {
          actor: { profile: "terra-medium", type: "worker" },
          dependsOn: [],
          mode: "implementation",
          name: job,
          objective: "Implement the bounded worker-event lifecycle.",
        },
      ],
      name: "replace worker lifecycle",
      objective: "Make worker lifecycle durable and model-minimal.",
    },
  ],
};

const activeFixture = (): {
  root: RootSnapshot;
  workflow: WorkflowState;
} => {
  const root = emptyRootSnapshot();
  const workflow = new WorkflowState({ now: () => now });
  workflow.start({
    definition,
    orchestrator_agent_id: "sol",
    parent_session_id: parentSessionID,
    workflow_id: workflowID,
  });
  workflow.markWorkerActive({
    job,
    task_id: taskID,
    workflow_id: workflowID,
  });
  root.workflows = WorkflowSnapshotSchema.parse(workflow.snapshot());
  root.job_runs.push({
    job,
    result_available: false,
    run_sequence: 1,
    started_at: now,
    state: "active",
    task_id: taskID,
    updated_at: now,
    workflow_id: workflowID,
    workflow_version: 1,
    write_grants: [],
  });
  root.workers.push({
    child_session_id: taskID,
    created_at: now,
    delivered_event_sequence: 0,
    job,
    latest_event: null,
    live_state: "busy",
    mode: "implementation",
    parent_session_id: parentSessionID,
    profile: "terra-medium",
    run_sequence: 1,
    task_id: taskID,
    updated_at: now,
    workflow_id: workflowID,
    workflow_version: 1,
  });
  return { root: parseRootSnapshot(root), workflow };
};

const jobState = (workflow: WorkflowState) =>
  workflow.jobState({ job, workflow_id: workflowID });

describe("OrchestrationState", () => {
  test("records bounded progress without changing the active job or persisting protocol IDs", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });

    const result = state.report(
      { root, workflow },
      {
        kind: "progress",
        message: "The event owner is isolated and the RED suite is running.",
        parent_session_id: parentSessionID,
        task_id: taskID,
      }
    );

    expect(result).toEqual({
      accepted: true,
      kind: "progress",
      terminal: false,
    });
    expect(jobState(workflow)?.state).toBe("active");
    expect(root.job_runs[0]?.state).toBe("active");
    expect(root.workers[0]?.latest_event).toEqual({
      created_at: now,
      kind: "progress",
      message: "The event owner is isolated and the RED suite is running.",
      sequence: 1,
    });
    expect(root.workers[0]?.delivered_event_sequence).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(INTERNAL_ID_PATTERN);
  });

  test("makes a blocker terminal for the run and rejects later worker reports", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });

    const result = state.report(
      { root, workflow },
      {
        kind: "blocker",
        message: "The OpenCode child session disappeared.",
        parent_session_id: parentSessionID,
        task_id: taskID,
      }
    );

    expect(result).toEqual({ accepted: true, kind: "blocker", terminal: true });
    expect(jobState(workflow)?.state).toBe("blocked");
    expect(root.job_runs[0]?.state).toBe("blocked");
    expect(root.workers[0]?.live_state).toBe("blocked");
    expect(() =>
      state.report(
        { root, workflow },
        {
          kind: "progress",
          message: "This must not be accepted after the blocker.",
          parent_session_id: parentSessionID,
          task_id: taskID,
        }
      )
    ).toThrow(TERMINAL_PATTERN);
  });

  test("moves one completed assistant message to review exactly once without storing its body", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });
    const input = {
      message_id: "assistant-final-1",
      parent_session_id: parentSessionID,
      task_id: taskID,
    };

    expect(state.final({ root, workflow }, input)).toEqual({
      accepted: true,
      duplicate: false,
      result_available: true,
    });
    expect(state.final({ root, workflow }, input)).toEqual({
      accepted: true,
      duplicate: true,
      result_available: true,
    });
    expect(jobState(workflow)?.state).toBe("review");
    expect(root.job_runs[0]).toMatchObject({
      result_available: true,
      state: "review",
    });
    expect(root.workers[0]).toMatchObject({
      latest_event: {
        created_at: now,
        kind: "result",
        result_message_id: "assistant-final-1",
        sequence: 1,
      },
      live_state: "review",
    });
    expect(JSON.stringify(root)).not.toContain("identical final result text");
  });

  test("interrupts an active run, blocks its workflow job, and records only a bounded reason", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });

    expect(
      state.interrupt(
        { root, workflow },
        {
          parent_session_id: parentSessionID,
          reason: "Sol changed the owning implementation decision.",
          task_id: taskID,
        }
      )
    ).toEqual({ interrupted: true, task_id: taskID });
    expect(jobState(workflow)?.state).toBe("blocked");
    expect(root.job_runs[0]?.state).toBe("interrupted");
    expect(root.workers[0]?.live_state).toBe("interrupted");
    expect(root.workers[0]?.latest_event).toMatchObject({
      kind: "interrupted",
      message: "Sol changed the owning implementation decision.",
      sequence: 1,
    });
  });

  test("reconciles busy, completed-idle, missing, and idle-without-final workers after restart", () => {
    const state = new OrchestrationState({ now: () => now });

    const busy = activeFixture();
    expect(
      state.reconcile(busy, {
        child_exists: true,
        final_message_id: null,
        status: "busy",
        task_id: taskID,
      })
    ).toEqual({ action: "busy", task_id: taskID });
    expect(busy.root.workers[0]?.live_state).toBe("busy");

    const completed = activeFixture();
    expect(
      state.reconcile(completed, {
        child_exists: true,
        final_message_id: "assistant-final-restart",
        status: "idle",
        task_id: taskID,
      })
    ).toEqual({ action: "review", task_id: taskID });
    expect(jobState(completed.workflow)?.state).toBe("review");

    const missing = activeFixture();
    expect(
      state.reconcile(missing, {
        child_exists: false,
        final_message_id: null,
        status: "missing",
        task_id: taskID,
      })
    ).toEqual({ action: "blocked", task_id: taskID });
    expect(jobState(missing.workflow)?.latest_message).toMatch(MISSING_PATTERN);

    const missingReview = activeFixture();
    state.final(missingReview, {
      message_id: "assistant-before-disappearance",
      parent_session_id: parentSessionID,
      task_id: taskID,
    });
    expect(
      state.reconcile(missingReview, {
        child_exists: false,
        final_message_id: null,
        status: "missing",
        task_id: taskID,
      })
    ).toEqual({ action: "blocked", task_id: taskID });
    expect(jobState(missingReview.workflow)?.state).toBe("blocked");

    const idle = activeFixture();
    expect(
      state.reconcile(idle, {
        child_exists: true,
        final_message_id: null,
        status: "idle",
        task_id: taskID,
      })
    ).toEqual({ action: "blocked", task_id: taskID });
    expect(jobState(idle.workflow)?.latest_message).toMatch(IDLE_FINAL_PATTERN);
  });

  test("rejects wrong parent ownership and unknown workers without recovery by agent type", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });

    expect(() =>
      state.report(
        { root, workflow },
        {
          kind: "progress",
          message: "Wrong parent.",
          parent_session_id: "parent-2",
          task_id: taskID,
        }
      )
    ).toThrow(PARENT_PATTERN);
    expect(() =>
      state.report(
        { root, workflow },
        {
          kind: "progress",
          message: "Unknown child.",
          parent_session_id: parentSessionID,
          task_id: "unknown-child",
        }
      )
    ).toThrow(MANAGED_WORKER_PATTERN);
  });

  test("coalesces ordered steering into one durable delivery before dispatch", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });

    expect(
      state.requestDelivery(
        { root, workflow },
        {
          delivery_id: "delivery-1",
          message: "Use the corrected owner seam.",
          parent_session_id: parentSessionID,
          task_id: taskID,
        }
      )
    ).toEqual({
      accepted: true,
      coalesced: false,
      state: "pending_preemption",
    });
    expect(root.deliveries).toEqual([
      {
        child_user_message_id: null,
        created_at: now,
        delivery_id: "delivery-1",
        message: "Use the corrected owner seam.",
        state: "pending_preemption",
        task_id: taskID,
        updated_at: now,
      },
    ]);
    expect(root.workers[0]?.live_state).toBe("preempting");

    expect(
      state.requestDelivery(
        { root, workflow },
        {
          delivery_id: "delivery-2",
          message: "Also include the installed-version caveat.",
          parent_session_id: parentSessionID,
          task_id: taskID,
        }
      )
    ).toEqual({
      accepted: true,
      coalesced: true,
      state: "pending_preemption",
    });
    expect(
      state.requestDelivery(
        { root, workflow },
        {
          delivery_id: "delivery-3",
          message: "Return immediately after that.",
          parent_session_id: parentSessionID,
          task_id: taskID,
        }
      )
    ).toEqual({
      accepted: true,
      coalesced: true,
      state: "pending_preemption",
    });
    expect(root.deliveries).toHaveLength(1);
    expect(root.deliveries[0]).toMatchObject({
      delivery_id: "delivery-1",
      message:
        "Use the corrected owner seam.\n\n--- Additional priority steering received before dispatch; later instruction takes precedence on conflict ---\nAlso include the installed-version caveat.\n\n--- Additional priority steering received before dispatch; later instruction takes precedence on conflict ---\nReturn immediately after that.",
      state: "pending_preemption",
    });
  });

  test("rejects coalescing after dispatch without changing the claimed prompt", () => {
    for (const started of [false, true]) {
      const { root, workflow } = activeFixture();
      const state = new OrchestrationState({ now: () => now });
      state.requestDelivery(
        { root, workflow },
        {
          delivery_id: "delivery-1",
          message: "Use the corrected owner seam.",
          parent_session_id: parentSessionID,
          task_id: taskID,
        }
      );
      state.dispatchDelivery(root, {
        child_user_message_id: "worker-follow-up-1",
        task_id: taskID,
      });
      if (started) {
        state.startDelivery(root, {
          child_user_message_id: "worker-follow-up-1",
          task_id: taskID,
        });
      }

      expect(() =>
        state.requestDelivery(
          { root, workflow },
          {
            delivery_id: "delivery-2",
            message: "This cannot join an already claimed prompt.",
            parent_session_id: parentSessionID,
            task_id: taskID,
          }
        )
      ).toThrow(PENDING_STEERING_PATTERN);
      expect(root.deliveries).toHaveLength(1);
      expect(root.deliveries[0]?.message).toBe("Use the corrected owner seam.");
      expect(root.deliveries[0]?.state).toBe(
        started ? "started" : "dispatched"
      );
    }
  });

  test("rejects an oversized coalesced prompt atomically", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });
    state.requestDelivery(
      { root, workflow },
      {
        delivery_id: "delivery-1",
        message: "a".repeat(7900),
        parent_session_id: parentSessionID,
        task_id: taskID,
      }
    );

    expect(() =>
      state.requestDelivery(
        { root, workflow },
        {
          delivery_id: "delivery-2",
          message: "b".repeat(100),
          parent_session_id: parentSessionID,
          task_id: taskID,
        }
      )
    ).toThrow(COALESCED_LIMIT_PATTERN);
    expect(root.deliveries).toHaveLength(1);
    expect(root.deliveries[0]?.delivery_id).toBe("delivery-1");
    expect(root.deliveries[0]?.message).toBe("a".repeat(7900));
  });

  test("advances tool-boundary, interrupt, dispatch, and start with compare-and-set semantics", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });
    state.requestDelivery(
      { root, workflow },
      {
        delivery_id: "delivery-1",
        message: "Continue from the accepted correction.",
        parent_session_id: parentSessionID,
        task_id: taskID,
      }
    );

    expect(state.waitForToolBoundary(root, taskID)).toBe(true);
    expect(state.waitForToolBoundary(root, taskID)).toBe(false);
    expect(root.deliveries[0]?.state).toBe("waiting_tool_boundary");
    expect(state.preemptDelivery(root, taskID)).toBe(true);
    expect(state.preemptDelivery(root, taskID)).toBe(false);
    expect(root.deliveries[0]?.state).toBe("interrupting");
    expect(
      state.dispatchDelivery(root, {
        child_user_message_id: "worker-follow-up-1",
        task_id: taskID,
      })
    ).toMatchObject({
      child_user_message_id: "worker-follow-up-1",
      message: "Continue from the accepted correction.",
      state: "dispatched",
    });
    expect(
      state.dispatchDelivery(root, {
        child_user_message_id: "worker-follow-up-duplicate",
        task_id: taskID,
      })
    ).toBeNull();
    expect(
      state.startDelivery(root, {
        child_user_message_id: "foreign-user-message",
        task_id: taskID,
      })
    ).toBe(false);
    expect(
      state.startDelivery(root, {
        child_user_message_id: "worker-follow-up-1",
        task_id: taskID,
      })
    ).toBe(true);
    expect(
      state.startDelivery(root, {
        child_user_message_id: "worker-follow-up-1",
        task_id: taskID,
      })
    ).toBe(false);
    expect(root.deliveries[0]?.state).toBe("started");
  });

  test("completes only the correlated steering turn and does not create a new job run", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });
    state.requestDelivery(
      { root, workflow },
      {
        delivery_id: "delivery-1",
        message: "Finish the same workflow job.",
        parent_session_id: parentSessionID,
        task_id: taskID,
      }
    );
    state.dispatchDelivery(root, {
      child_user_message_id: "worker-follow-up-1",
      task_id: taskID,
    });
    state.startDelivery(root, {
      child_user_message_id: "worker-follow-up-1",
      task_id: taskID,
    });

    expect(
      state.completeDelivery(
        { root, workflow },
        {
          assistant_message_id: "assistant-follow-up-1",
          child_user_message_id: "foreign-user-message",
          parent_session_id: parentSessionID,
          task_id: taskID,
        }
      )
    ).toBe(false);
    expect(root.deliveries).toHaveLength(1);
    expect(
      state.completeDelivery(
        { root, workflow },
        {
          assistant_message_id: "assistant-follow-up-1",
          child_user_message_id: "worker-follow-up-1",
          parent_session_id: parentSessionID,
          task_id: taskID,
        }
      )
    ).toBe(true);
    expect(root.deliveries).toHaveLength(1);
    expect(root.deliveries[0]?.state).toBe("completed");
    expect(root.job_runs).toHaveLength(1);
    expect(root.job_runs[0]).toMatchObject({
      result_available: true,
      run_sequence: 1,
      state: "review",
    });
    expect(jobState(workflow)?.state).toBe("review");
    expect(state.clearCompletedDelivery(root, taskID)).toBe(true);
    expect(state.clearCompletedDelivery(root, taskID)).toBe(false);
    expect(root.deliveries).toEqual([]);
  });

  test("restart reconciliation preserves a pending delivery instead of blocking an idle worker", () => {
    const { root, workflow } = activeFixture();
    const state = new OrchestrationState({ now: () => now });
    state.requestDelivery(
      { root, workflow },
      {
        delivery_id: "delivery-1",
        message: "Resume this steering message after restart.",
        parent_session_id: parentSessionID,
        task_id: taskID,
      }
    );
    state.preemptDelivery(root, taskID);

    expect(
      state.reconcile(
        { root, workflow },
        {
          child_exists: true,
          final_message_id: null,
          status: "idle",
          task_id: taskID,
        }
      )
    ).toEqual({
      action: "resume_delivery",
      delivery: "interrupting",
      task_id: taskID,
    });
    expect(jobState(workflow)?.state).toBe("active");
    expect(root.workers[0]?.live_state).toBe("preempting");
  });
});
