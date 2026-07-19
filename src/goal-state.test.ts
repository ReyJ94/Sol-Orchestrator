import { describe, expect, test } from "bun:test";

import { GoalState } from "./goal-state.js";
import type { WorkflowDefinition } from "./schema/workflow.js";
import { normalizeWorkflowDefinition } from "./workflow-graph.js";
import { WorkflowState } from "./workflow-state.js";

const timestamp = "2026-07-18T00:00:00.000Z";
const UNFINISHED_WORKFLOW_PATTERN = /unfinished workflow/i;

const definition = (objective: string): WorkflowDefinition =>
  normalizeWorkflowDefinition({
    objective,
    steps: [
      {
        jobs: [
          {
            actor: { type: "orchestrator" },
            name: "finish",
            objective: `Finish ${objective}`,
          },
        ],
        name: "delivery",
        objective,
      },
    ],
  });

const startGoal = (state: GoalState) =>
  state.start({
    goal_id: "goal-1",
    objective: "Deliver the user's complete requested outcome",
    orchestrator_agent_id: "sol",
    parent_session_id: "parent-1",
  });

describe("GoalState lifecycle above workflows", () => {
  test("keeps one goal active across separately completed workflows", () => {
    const goals = new GoalState({ now: () => timestamp });
    const workflows = new WorkflowState({ now: () => timestamp });
    const goal = startGoal(goals);

    for (const workflowID of ["workflow-1", "workflow-2"]) {
      workflows.start({
        definition: definition(workflowID),
        goal_id: goal.goal_id,
        orchestrator_agent_id: "sol",
        parent_session_id: "parent-1",
        workflow_id: workflowID,
      });
      workflows.completeJob({
        job: "finish",
        message: `${workflowID} is complete.`,
        workflow_id: workflowID,
      });

      expect(goals.currentFor("parent-1", "sol")?.status).toBe("active");
      expect(workflows.currentFor("parent-1", "sol")).toBeUndefined();
    }

    expect(
      workflows.snapshot().workflows.map((workflow) => workflow.goal_id)
    ).toEqual(["goal-1", "goal-1"]);
  });

  test("rejects goal completion while an associated workflow is unfinished", () => {
    const goals = new GoalState({ now: () => timestamp });
    const workflows = new WorkflowState({ now: () => timestamp });
    const goal = startGoal(goals);
    workflows.start({
      definition: definition("unfinished work"),
      goal_id: goal.goal_id,
      orchestrator_agent_id: "sol",
      parent_session_id: "parent-1",
      workflow_id: "workflow-1",
    });

    expect(() =>
      goals.complete({
        current_workflow: workflows.currentFor("parent-1", "sol"),
        goal_id: goal.goal_id,
        message: "Pretend the user outcome is complete.",
      })
    ).toThrow(UNFINISHED_WORKFLOW_PATTERN);
    expect(goals.currentFor("parent-1", "sol")?.status).toBe("active");
  });

  test("blocks and resumes while terminal stop removes the goal", () => {
    const goals = new GoalState({ now: () => timestamp });
    const goal = startGoal(goals);

    goals.block({
      goal_id: goal.goal_id,
      message: "A user decision is required.",
    });
    expect(goals.currentFor("parent-1", "sol")?.status).toBe("blocked");
    goals.resume({
      goal_id: goal.goal_id,
      message: "The user supplied the decision.",
    });
    expect(goals.currentFor("parent-1", "sol")?.status).toBe("active");
    goals.stop({
      goal_id: goal.goal_id,
      message: "The user explicitly stopped this goal.",
    });
    expect(goals.currentFor("parent-1", "sol")).toBeUndefined();
    expect(goals.snapshot().goals).toEqual([]);

    expect(
      goals.start({
        goal_id: "goal-2",
        objective: "A later explicitly authorized outcome",
        orchestrator_agent_id: "sol",
        parent_session_id: "parent-1",
      }).goal_id
    ).toBe("goal-2");
  });
});

describe("GoalState continuation reservations", () => {
  test("reserves each sortable terminal assistant message at most once", () => {
    const goals = new GoalState({ now: () => timestamp });
    const goal = startGoal(goals);

    expect(
      goals.reserveContinuation({
        assistant_message_id: "msg_01",
        goal_id: goal.goal_id,
        prompt_message_id: "msg_02",
      })?.state
    ).toBe("reserved");
    expect(
      goals.reserveContinuation({
        assistant_message_id: "msg_01",
        goal_id: goal.goal_id,
        prompt_message_id: "msg_03",
      })
    ).toBeUndefined();
    expect(
      goals.reserveContinuation({
        assistant_message_id: "msg_00",
        goal_id: goal.goal_id,
        prompt_message_id: "msg_04",
      })
    ).toBeUndefined();

    goals.markContinuationFailed({
      assistant_message_id: "msg_01",
      goal_id: goal.goal_id,
      message: "Native prompt submission failed.",
    });
    expect(
      goals.reserveContinuation({
        assistant_message_id: "msg_01",
        goal_id: goal.goal_id,
        prompt_message_id: "msg_05",
      })
    ).toBeUndefined();
    expect(
      goals.reserveContinuation({
        assistant_message_id: "msg_06",
        goal_id: goal.goal_id,
        prompt_message_id: "msg_07",
      })?.assistant_message_id
    ).toBe("msg_06");
  });
});
