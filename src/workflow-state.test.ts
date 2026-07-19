import { describe, expect, test } from "bun:test";

import type { WorkflowDefinition } from "./schema/workflow.js";
import { normalizeWorkflowDefinition } from "./workflow-graph.js";
import { WorkflowState } from "./workflow-state.js";

const timestamp = "2026-07-17T00:00:00.000Z";
const activeWorkerPattern = /interrupt|active worker/i;
const retryablePattern = /review|blocked/i;

const required = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

const mutableStep = (input: WorkflowDefinition, index: number) =>
  required(input.steps[index], `Expected step fixture ${index}.`);

const mutableJob = (
  input: WorkflowDefinition,
  stepIndex: number,
  jobIndex: number
) =>
  required(
    mutableStep(input, stepIndex).jobs[jobIndex],
    `Expected job fixture ${stepIndex}/${jobIndex}.`
  );

const definition = (): WorkflowDefinition =>
  normalizeWorkflowDefinition({
    objective: "Exercise deterministic scheduling",
    steps: [
      {
        jobs: [
          {
            actor: { type: "orchestrator" },
            name: "frame",
            objective: "Frame the invariant",
          },
          {
            actor: { profile: "luna-max", type: "worker" },
            mode: "research",
            name: "research",
            objective: "Research the owner",
          },
          {
            actor: { type: "orchestrator" },
            dependsOn: ["frame", "research"],
            name: "accept research",
            objective: "Accept the research",
          },
        ],
        name: "establish",
        objective: "Establish behavior",
      },
      {
        jobs: [
          {
            actor: { type: "orchestrator" },
            name: "parallel sol",
            objective: "Exercise concurrent Sol freedom",
          },
        ],
        name: "parallel",
        objective: "Run an independent Sol obligation",
      },
      {
        dependsOn: ["establish", "parallel"],
        jobs: [
          {
            actor: { profile: "terra-medium", type: "worker" },
            mode: "implementation",
            name: "implement",
            objective: "Implement the owner",
            writeFiles: ["src/owner.ts"],
          },
          {
            actor: { type: "orchestrator" },
            dependsOn: ["implement"],
            name: "integrate",
            objective: "Integrate the result",
          },
        ],
        name: "change",
        objective: "Make the change",
      },
      {
        dependsOn: ["change"],
        jobs: [
          {
            actor: { type: "orchestrator" },
            name: "finish",
            objective: "Finish the workflow",
          },
        ],
        name: "finish",
        objective: "Close the workflow",
      },
    ],
  });

const start = (state: WorkflowState): void => {
  state.start({
    definition: definition(),
    orchestrator_agent_id: "sol",
    parent_session_id: "parent-1",
    workflow_id: "workflow-1",
  });
};

const stateFor = (state: WorkflowState, job: string) =>
  state.jobState({ job, workflow_id: "workflow-1" });

const finishEstablishAndParallel = (state: WorkflowState): void => {
  state.completeJob({
    job: "frame",
    message: "Framed the invariant.",
    workflow_id: "workflow-1",
  });
  state.markWorkerActive({
    job: "research",
    task_id: "task-research",
    workflow_id: "workflow-1",
  });
  state.markWorkerReview({
    job: "research",
    result_available: true,
    workflow_id: "workflow-1",
  });
  state.completeJob({
    job: "research",
    message: "Accepted research.",
    workflow_id: "workflow-1",
  });
  state.completeJob({
    job: "accept research",
    message: "Synthesized research.",
    workflow_id: "workflow-1",
  });
  state.completeJob({
    job: "parallel sol",
    message: "Completed parallel obligation.",
    workflow_id: "workflow-1",
  });
};

const finishChange = (state: WorkflowState): void => {
  state.markWorkerActive({
    job: "implement",
    task_id: "task-implement",
    workflow_id: "workflow-1",
  });
  state.markWorkerReview({
    job: "implement",
    result_available: true,
    workflow_id: "workflow-1",
  });
  state.completeJob({
    job: "implement",
    message: "Accepted implementation.",
    workflow_id: "workflow-1",
  });
  state.completeJob({
    job: "integrate",
    message: "Integrated implementation.",
    workflow_id: "workflow-1",
  });
};

describe("WorkflowState scheduling and derived state", () => {
  test("activates dependency-ready Sol jobs and leaves workers ready concurrently", () => {
    const state = new WorkflowState({ now: () => timestamp });
    start(state);

    expect(stateFor(state, "frame")?.state).toBe("active");
    expect(stateFor(state, "parallel sol")?.state).toBe("active");
    expect(stateFor(state, "research")?.state).toBe("ready");
    expect(stateFor(state, "accept research")?.state).toBe("pending");
    expect(stateFor(state, "implement")?.state).toBe("pending");
    expect(
      state.stepState({ step: "establish", workflow_id: "workflow-1" })
    ).toBe("active");
    expect(state.stepState({ step: "change", workflow_id: "workflow-1" })).toBe(
      "pending"
    );
    expect(state.workflowState("workflow-1")).toBe("active");
  });

  test("moves worker results to review and requires Sol acceptance", () => {
    const state = new WorkflowState({ now: () => timestamp });
    start(state);

    state.markWorkerActive({
      job: "research",
      task_id: "task-research",
      workflow_id: "workflow-1",
    });
    state.markWorkerReview({
      job: "research",
      result_available: true,
      workflow_id: "workflow-1",
    });

    expect(stateFor(state, "research")?.state).toBe("review");
    expect(stateFor(state, "accept research")?.state).toBe("pending");

    state.completeJob({
      job: "research",
      message: "Accepted the bounded result.",
      workflow_id: "workflow-1",
    });
    expect(stateFor(state, "research")?.state).toBe("completed");
    expect(stateFor(state, "research")?.completion_message).toBe(
      "Accepted the bounded result."
    );
  });

  test("derives blocked state before pending/active and preserves dependent pending steps", () => {
    const state = new WorkflowState({ now: () => timestamp });
    start(state);
    state.markWorkerActive({
      job: "research",
      task_id: "task-research",
      workflow_id: "workflow-1",
    });
    state.blockJob({
      job: "research",
      message: "Repository evidence contradicted the brief.",
      workflow_id: "workflow-1",
    });

    expect(
      state.stepState({ step: "establish", workflow_id: "workflow-1" })
    ).toBe("blocked");
    expect(state.stepState({ step: "change", workflow_id: "workflow-1" })).toBe(
      "pending"
    );
    expect(state.workflowState("workflow-1")).toBe("blocked");
  });

  test("advances to a fixed point and clears only the completed current pointer", () => {
    const state = new WorkflowState({ now: () => timestamp });
    start(state);
    finishEstablishAndParallel(state);

    expect(stateFor(state, "implement")?.state).toBe("ready");
    expect(
      state.stepState({ step: "establish", workflow_id: "workflow-1" })
    ).toBe("completed");

    finishChange(state);
    expect(stateFor(state, "finish")?.state).toBe("active");
    state.completeJob({
      job: "finish",
      message: "Workflow is complete.",
      workflow_id: "workflow-1",
    });

    expect(state.workflowState("workflow-1")).toBe("completed");
    expect(state.currentFor("parent-1", "sol")).toBeUndefined();
    expect(state.snapshot().workflows).toHaveLength(1);
  });

  test("retries only review or blocked jobs without changing the version", () => {
    const state = new WorkflowState({ now: () => timestamp });
    start(state);
    state.markWorkerActive({
      job: "research",
      task_id: "task-research",
      workflow_id: "workflow-1",
    });
    state.markWorkerReview({
      job: "research",
      result_available: true,
      workflow_id: "workflow-1",
    });

    state.retryJob({
      job: "research",
      reason: "Result did not prove the owning seam.",
      workflow_id: "workflow-1",
    });
    expect(stateFor(state, "research")?.state).toBe("ready");
    expect(stateFor(state, "research")?.run_sequence).toBe(1);
    expect(state.currentFor("parent-1", "sol")?.current_version).toBe(1);

    state.markWorkerActive({
      job: "research",
      task_id: "task-research-2",
      workflow_id: "workflow-1",
    });
    expect(stateFor(state, "research")?.run_sequence).toBe(2);
    expect(() =>
      state.retryJob({
        job: "research",
        reason: "Cannot retry active work.",
        workflow_id: "workflow-1",
      })
    ).toThrow(retryablePattern);
  });
});

describe("WorkflowState replacement", () => {
  test("creates one next version and retains unchanged completed prerequisite closure", () => {
    const state = new WorkflowState({ now: () => timestamp });
    start(state);
    finishEstablishAndParallel(state);
    finishChange(state);

    const replacement = definition();
    mutableStep(replacement, 3).objective = "Close the revised workflow";
    mutableJob(replacement, 3, 0).objective = "Finish revised workflow";
    state.replace({
      reason: "Verification requires a clearer final obligation.",
      steps: replacement.steps,
      workflow_id: "workflow-1",
    });

    expect(state.currentFor("parent-1", "sol")?.current_version).toBe(2);
    expect(stateFor(state, "frame")?.state).toBe("completed");
    expect(stateFor(state, "research")?.state).toBe("completed");
    expect(stateFor(state, "implement")?.state).toBe("completed");
    expect(stateFor(state, "integrate")?.state).toBe("completed");
    expect(stateFor(state, "finish")?.state).toBe("active");
    expect(state.snapshot().workflows[0]?.versions).toHaveLength(2);
  });

  test("resets a changed job and every completion whose prerequisite closure changed", () => {
    const state = new WorkflowState({ now: () => timestamp });
    start(state);
    finishEstablishAndParallel(state);
    finishChange(state);

    const replacement = definition();
    mutableJob(replacement, 0, 0).objective = "Frame a corrected invariant";
    state.replace({
      reason: "The original frame was incomplete.",
      steps: replacement.steps,
      workflow_id: "workflow-1",
    });

    expect(stateFor(state, "frame")?.state).toBe("active");
    // Research is a parallel root job in the same step, not a prerequisite of
    // frame, so its unchanged completion remains valid.
    expect(stateFor(state, "research")?.state).toBe("completed");
    expect(stateFor(state, "accept research")?.state).toBe("pending");
    expect(stateFor(state, "implement")?.state).toBe("pending");
    expect(stateFor(state, "integrate")?.state).toBe("pending");
  });

  test("retains an unchanged active worker but rejects removal, movement, or semantic change", () => {
    const unchanged = new WorkflowState({ now: () => timestamp });
    start(unchanged);
    unchanged.markWorkerActive({
      job: "research",
      task_id: "task-research",
      workflow_id: "workflow-1",
    });
    unchanged.replace({
      reason: "Change an unrelated downstream objective.",
      steps: definition().steps.map((step) =>
        step.name === "finish"
          ? { ...step, objective: "Close with revised wording" }
          : step
      ),
      workflow_id: "workflow-1",
    });
    expect(stateFor(unchanged, "research")?.state).toBe("active");
    expect(stateFor(unchanged, "research")?.task_id).toBe("task-research");

    for (const mutation of ["change", "remove", "move"] as const) {
      const state = new WorkflowState({ now: () => timestamp });
      start(state);
      state.markWorkerActive({
        job: "research",
        task_id: "task-research",
        workflow_id: "workflow-1",
      });
      const replacement = definition();
      const step = mutableStep(replacement, 0);
      const index = step.jobs.findIndex((job) => job.name === "research");
      const worker = step.jobs[index];
      if (worker === undefined) {
        throw new Error("Expected research worker fixture.");
      }
      if (mutation === "change") {
        worker.objective = "Changed active objective";
      } else {
        step.jobs.splice(index, 1);
        const dependent = step.jobs.find(
          (job) => job.name === "accept research"
        );
        if (dependent === undefined) {
          throw new Error("Expected dependent Sol job fixture.");
        }
        dependent.dependsOn = dependent.dependsOn.filter(
          (dependency) => dependency !== "research"
        );
        if (mutation === "move") {
          mutableStep(replacement, 1).jobs.push(worker);
        }
      }

      expect(() =>
        state.replace({
          reason: `Attempt to ${mutation} active work.`,
          steps: replacement.steps,
          workflow_id: "workflow-1",
        })
      ).toThrow(activeWorkerPattern);
      expect(state.currentFor("parent-1", "sol")?.current_version).toBe(1);
    }
  });

  test("ordinary progress, review, retry, and blocking never change version", () => {
    const state = new WorkflowState({ now: () => timestamp });
    start(state);
    state.completeJob({
      job: "frame",
      message: "Framed.",
      workflow_id: "workflow-1",
    });
    state.markWorkerActive({
      job: "research",
      task_id: "task-research",
      workflow_id: "workflow-1",
    });
    state.markWorkerReview({
      job: "research",
      result_available: true,
      workflow_id: "workflow-1",
    });
    state.retryJob({
      job: "research",
      reason: "Retry unchanged research.",
      workflow_id: "workflow-1",
    });
    state.markWorkerActive({
      job: "research",
      task_id: "task-research-2",
      workflow_id: "workflow-1",
    });
    state.blockJob({
      job: "research",
      message: "Transient transport loss.",
      workflow_id: "workflow-1",
    });

    expect(state.currentFor("parent-1", "sol")?.current_version).toBe(1);
  });
});
