import type { GoalRecord, GoalSnapshot } from "./schema/orchestration.js";
import type { WorkflowRecord } from "./workflow-state.js";

type Clock = () => string;

type GoalStateOptions = {
  readonly now?: Clock;
};

const clone = <Value>(value: Value): Value => structuredClone(value);

const transitionMessage = (message: string): string => {
  const normalized = message.trim();
  if (normalized.length === 0 || normalized.length > 4000) {
    throw new Error("Goal transition message must contain 1..4000 characters.");
  }
  return normalized;
};

export class GoalState {
  readonly #goals: GoalRecord[];
  readonly #now: Clock;

  constructor(
    options: GoalStateOptions = {},
    snapshot: GoalSnapshot = { goals: [] }
  ) {
    this.#goals = clone([...snapshot.goals]);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  static restore(
    snapshot: GoalSnapshot,
    options: GoalStateOptions = {}
  ): GoalState {
    return new GoalState(options, snapshot);
  }

  snapshot(): GoalSnapshot {
    return clone({ goals: this.#goals });
  }

  start(input: {
    readonly goal_id: string;
    readonly objective: string;
    readonly orchestrator_agent_id: string;
    readonly parent_session_id: string;
  }): GoalRecord {
    if (
      this.currentFor(input.parent_session_id, input.orchestrator_agent_id) !==
      undefined
    ) {
      throw new Error("A goal is already current for this parent session.");
    }
    if (this.#goals.some((goal) => goal.goal_id === input.goal_id)) {
      throw new Error(`Goal identity ${input.goal_id} already exists.`);
    }
    const objective = input.objective.trim();
    if (objective.length === 0 || objective.length > 8000) {
      throw new Error("Goal objective must contain 1..8000 characters.");
    }
    const createdAt = this.#now();
    const goal: GoalRecord = {
      continuation: null,
      created_at: createdAt,
      goal_id: input.goal_id,
      objective,
      orchestrator_agent_id: input.orchestrator_agent_id,
      parent_session_id: input.parent_session_id,
      status: "active",
      status_message: null,
      updated_at: createdAt,
    };
    this.#goals.push(goal);
    return clone(goal);
  }

  currentFor(
    parentSessionID: string,
    orchestratorAgentID: string
  ): GoalRecord | undefined {
    const goal = this.#goals.find(
      (candidate) =>
        candidate.parent_session_id === parentSessionID &&
        candidate.orchestrator_agent_id === orchestratorAgentID &&
        (candidate.status === "active" || candidate.status === "blocked")
    );
    return goal === undefined ? undefined : clone(goal);
  }

  updateObjective(input: {
    readonly goal_id: string;
    readonly objective: string;
  }): GoalRecord {
    const goal = this.#record(input.goal_id);
    if (goal.status !== "active" && goal.status !== "blocked") {
      throw new Error(
        `Goal ${goal.goal_id} cannot change objective from ${goal.status}.`
      );
    }
    const objective = input.objective.trim();
    if (objective.length === 0 || objective.length > 8000) {
      throw new Error("Goal objective must contain 1..8000 characters.");
    }
    goal.objective = objective;
    goal.updated_at = this.#now();
    return clone(goal);
  }

  complete(input: {
    readonly current_workflow?: WorkflowRecord;
    readonly goal_id: string;
    readonly message: string;
  }): GoalRecord {
    const goal = this.#active(input.goal_id);
    if (
      input.current_workflow?.current === true &&
      input.current_workflow.parent_session_id === goal.parent_session_id &&
      input.current_workflow.orchestrator_agent_id ===
        goal.orchestrator_agent_id
    ) {
      throw new Error("Cannot complete a goal with an unfinished workflow.");
    }
    return this.#transition(goal, "completed", input.message);
  }

  block(input: {
    readonly goal_id: string;
    readonly message: string;
  }): GoalRecord {
    return this.#transition(
      this.#active(input.goal_id),
      "blocked",
      input.message
    );
  }

  stop(input: {
    readonly goal_id: string;
    readonly message: string;
  }): GoalRecord {
    const goal = this.#record(input.goal_id);
    if (goal.status !== "active" && goal.status !== "blocked") {
      throw new Error(
        `Goal ${goal.goal_id} cannot be stopped from ${goal.status}.`
      );
    }
    transitionMessage(input.message);
    const index = this.#goals.findIndex(
      (candidate) => candidate.goal_id === goal.goal_id
    );
    this.#goals.splice(index, 1);
    return clone(goal);
  }

  resume(input: {
    readonly goal_id: string;
    readonly message: string;
  }): GoalRecord {
    const goal = this.#record(input.goal_id);
    if (goal.status !== "blocked") {
      throw new Error(
        `Goal ${goal.goal_id} cannot be resumed from ${goal.status}.`
      );
    }
    return this.#transition(goal, "active", input.message);
  }

  reserveContinuation(input: {
    readonly assistant_message_id: string;
    readonly goal_id: string;
    readonly prompt_message_id: string;
  }): NonNullable<GoalRecord["continuation"]> | undefined {
    const goal = this.#active(input.goal_id);
    if (
      goal.continuation !== null &&
      input.assistant_message_id <= goal.continuation.assistant_message_id
    ) {
      return;
    }
    const continuation: NonNullable<GoalRecord["continuation"]> = {
      assistant_message_id: input.assistant_message_id,
      prompt_message_id: input.prompt_message_id,
      state: "reserved",
      updated_at: this.#now(),
    };
    goal.continuation = continuation;
    goal.updated_at = continuation.updated_at;
    return clone(continuation);
  }

  markContinuationSubmitted(input: {
    readonly assistant_message_id: string;
    readonly goal_id: string;
  }): void {
    const goal = this.#active(input.goal_id);
    const continuation = this.#reserved(goal, input.assistant_message_id);
    continuation.state = "submitted";
    continuation.updated_at = this.#now();
    goal.updated_at = continuation.updated_at;
  }

  markContinuationFailed(input: {
    readonly assistant_message_id: string;
    readonly goal_id: string;
    readonly message: string;
  }): void {
    const goal = this.#active(input.goal_id);
    const continuation = this.#reserved(goal, input.assistant_message_id);
    continuation.failure_message = transitionMessage(input.message);
    continuation.state = "failed";
    continuation.updated_at = this.#now();
    goal.updated_at = continuation.updated_at;
  }

  #active(goalID: string): GoalRecord {
    const goal = this.#record(goalID);
    if (goal.status !== "active") {
      throw new Error(`Goal ${goal.goal_id} is not active.`);
    }
    return goal;
  }

  #record(goalID: string): GoalRecord {
    const goal = this.#goals.find((candidate) => candidate.goal_id === goalID);
    if (goal === undefined) {
      throw new Error(`Unknown goal ${goalID}.`);
    }
    return goal;
  }

  #reserved(goal: GoalRecord, assistantMessageID: string) {
    const continuation = goal.continuation;
    if (
      continuation === null ||
      continuation.assistant_message_id !== assistantMessageID ||
      continuation.state !== "reserved"
    ) {
      throw new Error(
        `Goal ${goal.goal_id} has no matching reserved continuation.`
      );
    }
    return continuation;
  }

  #transition(
    goal: GoalRecord,
    status: GoalRecord["status"],
    message: string
  ): GoalRecord {
    goal.status = status;
    goal.status_message = transitionMessage(message);
    goal.updated_at = this.#now();
    return clone(goal);
  }
}
