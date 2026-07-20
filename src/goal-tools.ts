import { randomUUID } from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

import type { GoalState } from "./goal-state.js";
import type { RootSnapshot } from "./schema/orchestration.js";
import { projectCanonicalWorkflowStatus } from "./workflow-projection.js";
import type { WorkflowState } from "./workflow-state.js";

const MessageSchema = z.string().trim().min(1).max(4000);
const GoalStartInputSchema = z
  .object({ objective: z.string().trim().min(1).max(8000) })
  .strict();
const GoalTransitionInputSchema = z.object({ message: MessageSchema }).strict();

type GoalToolContext = {
  readonly agent: string;
  readonly parent_session_id: string;
};

type GoalStore = {
  mutateRoot<Value>(
    mutation: (state: {
      goal: GoalState;
      root: RootSnapshot;
      workflow: WorkflowState;
    }) => Value
  ): Promise<Value>;
  readRoot(): Promise<RootSnapshot>;
};

type GoalToolServiceOptions = {
  readonly create_id?: () => string;
  readonly store: GoalStore;
};

export class GoalToolService {
  readonly #createID: () => string;
  readonly #store: GoalStore;

  constructor(options: GoalToolServiceOptions) {
    this.#createID = options.create_id ?? randomUUID;
    this.#store = options.store;
  }

  async start(input: unknown, context: unknown) {
    const parsed = GoalStartInputSchema.parse(input);
    const owner = this.#context(context);
    await this.#store.mutateRoot(({ goal, workflow }) => {
      const currentWorkflow = workflow.currentFor(
        owner.parent_session_id,
        owner.agent
      );
      const created = goal.start({
        goal_id: this.#createID(),
        objective: parsed.objective,
        orchestrator_agent_id: owner.agent,
        parent_session_id: owner.parent_session_id,
      });
      if (currentWorkflow !== undefined) {
        workflow.attachGoal({
          goal_id: created.goal_id,
          workflow_id: currentWorkflow.workflow_id,
        });
      }
    });
    return await this.status(owner);
  }

  async complete(input: unknown, context: unknown) {
    return await this.#transition(
      input,
      context,
      ({ goal, workflow, owner, message }) => {
        const current = this.#current(goal, owner);
        goal.complete({
          current_workflow: workflow.currentFor(
            owner.parent_session_id,
            owner.agent
          ),
          goal_id: current.goal_id,
          message,
        });
      }
    );
  }

  async block(input: unknown, context: unknown) {
    return await this.#transition(
      input,
      context,
      ({ goal, owner, message }) => {
        goal.block({ goal_id: this.#current(goal, owner).goal_id, message });
      }
    );
  }

  async resume(input: unknown, context: unknown) {
    return await this.#transition(
      input,
      context,
      ({ goal, owner, message }) => {
        const current = this.#current(goal, owner);
        goal.resume({ goal_id: current.goal_id, message });
      }
    );
  }

  async status(context: GoalToolContext) {
    return projectCanonicalWorkflowStatus(
      await this.#store.readRoot(),
      context
    );
  }

  async #transition(
    input: unknown,
    context: unknown,
    mutation: (input: {
      goal: GoalState;
      message: string;
      owner: GoalToolContext;
      workflow: WorkflowState;
    }) => void
  ) {
    const parsed = GoalTransitionInputSchema.parse(input);
    const owner = this.#context(context);
    await this.#store.mutateRoot(({ goal, workflow }) => {
      mutation({ goal, message: parsed.message, owner, workflow });
    });
    return await this.status(owner);
  }

  #current(goal: GoalState, owner: GoalToolContext) {
    const current = goal.currentFor(owner.parent_session_id, owner.agent);
    if (current === undefined) {
      throw new Error("No active or blocked goal exists for this session.");
    }
    return current;
  }

  #context(input: unknown): GoalToolContext {
    return z
      .object({
        agent: z.string().trim().min(1),
        parent_session_id: z.string().trim().min(1),
      })
      .strip()
      .parse(input);
  }
}

const toolResult = (value: unknown): string => JSON.stringify(value, null, 2);

const toolContext = (context: { agent: string; sessionID: string }) => ({
  agent: context.agent,
  parent_session_id: context.sessionID,
});

export const createGoalToolDefinitions = (service: GoalToolService) => ({
  goal_block: tool({
    args: GoalTransitionInputSchema.shape,
    description:
      "Suspend native goal continuation only for a genuine user-input or external-state blocker.",
    async execute(args, context) {
      return toolResult(await service.block(args, toolContext(context)));
    },
  }),
  goal_complete: tool({
    args: GoalTransitionInputSchema.shape,
    description:
      "Complete the durable user goal only after its real end state is achieved and no workflow remains unfinished.",
    async execute(args, context) {
      return toolResult(await service.complete(args, toolContext(context)));
    },
  }),
  goal_resume: tool({
    args: GoalTransitionInputSchema.shape,
    description: "Resume a blocked durable goal after its blocker is resolved.",
    async execute(args, context) {
      return toolResult(await service.resume(args, toolContext(context)));
    },
  }),
  goal_start: tool({
    args: GoalStartInputSchema.shape,
    description:
      "Start a durable goal before its first workflow or promote one current unassociated workflow.",
    async execute(args, context) {
      return toolResult(await service.start(args, toolContext(context)));
    },
  }),
});
