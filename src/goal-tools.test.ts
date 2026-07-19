import { describe, expect, test } from "bun:test";

import { GoalState } from "./goal-state.js";
import { createGoalToolDefinitions, GoalToolService } from "./goal-tools.js";
import {
  emptyRootSnapshot,
  type RootSnapshot,
  RootSnapshotSchema,
} from "./schema/orchestration.js";
import { WorkflowState } from "./workflow-state.js";

const timestamp = "2026-07-18T00:00:00.000Z";
const context = { agent: "sol", parent_session_id: "parent-1" };
const INTERNAL_ID_PATTERN =
  /assistant-internal|prompt-internal|internal-goal-id/u;
const UNFINISHED_WORKFLOW_PATTERN = /unfinished workflow/i;

const harness = () => {
  let root: RootSnapshot = emptyRootSnapshot();
  const store = {
    mutateRoot<Value>(
      mutation: (state: {
        goal: GoalState;
        root: RootSnapshot;
        workflow: WorkflowState;
      }) => Value
    ): Promise<Value> {
      const draft = structuredClone(root);
      const goal = GoalState.restore(draft.goals, { now: () => timestamp });
      const workflow = WorkflowState.restore(draft.workflows, {
        now: () => timestamp,
      });
      const value = mutation({ goal, root: draft, workflow });
      root = RootSnapshotSchema.parse({
        ...draft,
        goals: goal.snapshot(),
        workflows: workflow.snapshot(),
      });
      return Promise.resolve(value);
    },
    readRoot: () => Promise.resolve(structuredClone(root)),
  };
  const service = new GoalToolService({
    create_id: () => "internal-goal-id",
    store,
  });
  return { readRoot: store.readRoot, service, store };
};

describe("goal tool definitions", () => {
  test("registers only the explicit minimal goal lifecycle", () => {
    const { service } = harness();

    expect(Object.keys(createGoalToolDefinitions(service)).sort()).toEqual([
      "goal_block",
      "goal_complete",
      "goal_resume",
      "goal_start",
    ]);
  });
});

describe("GoalToolService lifecycle", () => {
  test("starts an explicitly requested goal and never projects its internal identity", async () => {
    const { readRoot, service } = harness();

    const status = await service.start(
      { objective: "Deliver the complete user outcome" },
      context
    );

    expect(status.goal).toEqual({
      objective: "Deliver the complete user outcome",
      status: "active",
    });
    expect(JSON.stringify(status)).not.toContain("internal-goal-id");
    expect((await readRoot()).goals.goals[0]?.goal_id).toBe("internal-goal-id");
    expect(status.available_actions).toEqual(
      expect.arrayContaining([
        { args: {}, needs: ["objective", "steps"], tool: "workflow_start" },
        { args: {}, needs: ["message"], tool: "goal_block" },
        { args: {}, needs: ["message"], tool: "goal_complete" },
      ])
    );
  });

  test("rejects dishonest completion and preserves block and resume semantics", async () => {
    const { service, store } = harness();
    await service.start({ objective: "One goal" }, context);
    await store.mutateRoot(({ goal, workflow }) => {
      const current = goal.currentFor("parent-1", "sol");
      if (current === undefined) {
        throw new Error("Expected current goal fixture.");
      }
      workflow.start({
        definition: {
          objective: "Current work",
          steps: [
            {
              dependsOn: [],
              jobs: [
                {
                  actor: { type: "orchestrator" },
                  dependsOn: [],
                  name: "finish",
                  objective: "Finish",
                },
              ],
              name: "work",
              objective: "Work",
            },
          ],
        },
        goal_id: current.goal_id,
        orchestrator_agent_id: "sol",
        parent_session_id: "parent-1",
        workflow_id: "workflow-1",
      });
    });

    await expect(
      service.complete({ message: "Not really done" }, context)
    ).rejects.toThrow(UNFINISHED_WORKFLOW_PATTERN);

    await store.mutateRoot(({ workflow }) => {
      workflow.completeJob({
        job: "finish",
        message: "Workflow done.",
        workflow_id: "workflow-1",
      });
    });
    expect(
      (await service.block({ message: "Need the user's decision" }, context))
        .goal?.status
    ).toBe("blocked");
    expect(
      (await service.resume({ message: "The user answered" }, context)).goal
        ?.status
    ).toBe("active");
    expect((await service.status(context)).goal?.status).toBe("active");
  });

  test("projects a failed native continuation without protocol identifiers", async () => {
    const { service, store } = harness();
    await service.start({ objective: "Visible liveness failure" }, context);
    await store.mutateRoot(({ goal }) => {
      goal.reserveContinuation({
        assistant_message_id: "assistant-internal",
        goal_id: "internal-goal-id",
        prompt_message_id: "prompt-internal",
      });
      goal.markContinuationFailed({
        assistant_message_id: "assistant-internal",
        goal_id: "internal-goal-id",
        message: "Native goal continuation failed.",
      });
    });

    const status = await service.status(context);
    expect(status.goal).toMatchObject({
      liveness: {
        message: "Native goal continuation failed.",
        state: "failed",
      },
    });
    expect(JSON.stringify(status)).not.toMatch(INTERNAL_ID_PATTERN);
  });
});
