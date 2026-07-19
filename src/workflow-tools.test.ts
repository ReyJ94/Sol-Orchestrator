import { describe, expect, test } from "bun:test";
import { GoalState } from "./goal-state.js";
import type { WorkerProfileDescriptor } from "./schema/common.js";
import {
  emptyRootSnapshot,
  RootSnapshotSchema,
} from "./schema/orchestration.js";
import { normalizeWorkflowDefinition } from "./workflow-graph.js";
import { WorkflowState } from "./workflow-state.js";
import {
  createWorkflowToolDefinitions,
  WorkflowToolService,
  type WorkflowWorkerLauncher,
} from "./workflow-tools.js";

const timestamp = "2026-07-17T00:00:00.000Z";
const context = { agent: "sol", parent_session_id: "parent-1" };
const bulkContentPattern = /result_body|transcript|patch_text/i;
const currentWorkflowPattern = /unfinished|current/i;
const internalStatusPattern =
  /workflow_id|version|lease|prompt_id|message_id|run_id|evidence_id/i;
const nativeTaskIdentifierPattern =
  /task_id|task_ids|child_session|lease|prompt_id|run_id|required_next_action|subagent_type|background/i;
const recoveryCandidatesPattern = /frame|research/i;
const reviewAndSolCandidatesPattern = /research|frame|parallel sol/i;
const solCandidatesPattern = /frame|parallel sol/i;
const versionPattern = /version|workflow_id/i;
const workerCandidatesPattern = /research|verify frame/i;
const unavailableProfilePattern = /missing-profile.*local-verifier/u;

const required = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

const steps = () => [
  {
    jobs: [
      {
        actor: { type: "orchestrator" as const },
        name: "frame",
        objective: "Frame the invariant",
      },
      {
        actor: {
          profile: "luna-max" as const,
          type: "worker" as const,
        },
        mode: "research" as const,
        name: "research",
        objective: "Research the owner",
      },
      {
        actor: { type: "orchestrator" as const },
        dependsOn: ["frame", "research"],
        name: "integrate",
        objective: "Integrate the findings",
      },
    ],
    name: "establish",
    objective: "Establish behavior",
  },
  {
    jobs: [
      {
        actor: { type: "orchestrator" as const },
        name: "parallel sol",
        objective: "Exercise concurrent Sol freedom",
      },
    ],
    name: "parallel",
    objective: "Run a parallel obligation",
  },
  {
    dependsOn: ["establish", "parallel"],
    jobs: [
      {
        actor: {
          profile: "terra-medium" as const,
          type: "worker" as const,
        },
        mode: "implementation" as const,
        name: "implement",
        objective: "Implement the owner",
        writeFiles: ["src/owner.ts"],
      },
    ],
    name: "change",
    objective: "Make the change",
  },
];

type LaunchInput = Parameters<WorkflowWorkerLauncher["launch"]>[0];

const bundledProfiles = [
  {
    description: "Clear low-risk leaf work",
    profile: "luna-medium",
  },
  {
    description: "Careful narrow leaf work",
    profile: "luna-max",
  },
  {
    description: "Cross-file leaf work",
    profile: "terra-medium",
  },
  {
    description: "Difficult ambiguous leaf work",
    profile: "terra-max",
  },
] as const;

const harness = (
  availableWorkers: readonly WorkerProfileDescriptor[] = bundledProfiles
) => {
  const state = new WorkflowState({ now: () => timestamp });
  const root = emptyRootSnapshot();
  const launches: LaunchInput[] = [];
  const store = {
    async mutateRoot<Value>(
      mutation: (value: {
        goal: GoalState;
        root: ReturnType<typeof emptyRootSnapshot>;
        workflow: WorkflowState;
      }) => Value
    ): Promise<Value> {
      const goal = GoalState.restore(root.goals, { now: () => timestamp });
      const value = mutation({ goal, root, workflow: state });
      root.goals = goal.snapshot();
      return await value;
    },
    async mutateWorkflow<Value>(
      mutation: (value: WorkflowState) => Value
    ): Promise<Value> {
      return await mutation(state);
    },
    async readWorkflow<Value>(
      reader: (value: WorkflowState) => Value
    ): Promise<Awaited<Value>> {
      return await reader(state);
    },
    readRoot() {
      return Promise.resolve(
        RootSnapshotSchema.parse({
          ...structuredClone(root),
          workflows: state.snapshot(),
        })
      );
    },
  };
  const workers = {
    launch(input: LaunchInput) {
      launches.push(input);
      const taskID = `child-${input.definition_job.name}`;
      state.markWorkerActive({
        job: input.definition_job.name,
        task_id: taskID,
        workflow_id: input.workflow_id,
      });
      root.job_runs.push({
        job: input.definition_job.name,
        result_available: false,
        run_sequence: 1,
        started_at: timestamp,
        state: "active",
        task_id: taskID,
        updated_at: timestamp,
        workflow_id: input.workflow_id,
        workflow_version: input.workflow_version,
        write_grants: [],
      });
      root.workers.push({
        child_session_id: taskID,
        created_at: timestamp,
        delivered_event_sequence: 0,
        job: input.definition_job.name,
        latest_event: null,
        live_state: "starting",
        mode: input.definition_job.mode,
        parent_session_id: input.parent_session_id,
        profile: input.definition_job.actor.profile,
        run_sequence: 1,
        task_id: taskID,
        updated_at: timestamp,
        workflow_id: input.workflow_id,
        workflow_version: input.workflow_version,
      });
      return Promise.resolve();
    },
  };
  const service = new WorkflowToolService({
    available_workers: () => availableWorkers,
    create_id: () => "internal-workflow-id",
    store,
    workers,
  });
  return { launches, root, service, state, store };
};

const start = async (service: WorkflowToolService) =>
  await service.start(
    { objective: "Exercise tool semantics", steps: steps() },
    context
  );

describe("workflow tool definitions", () => {
  test("registers exactly the six accepted workflow tools", () => {
    const { service } = harness();

    expect(Object.keys(createWorkflowToolDefinitions(service)).sort()).toEqual([
      "workflow_complete",
      "workflow_delegate",
      "workflow_replace",
      "workflow_retry",
      "workflow_start",
      "workflow_status",
    ]);
  });

  test("launches the worker atomically and returns refreshed semantic state", async () => {
    const { service } = harness();
    await start(service);
    const definitions = createWorkflowToolDefinitions(service);

    const output = JSON.parse(
      String(
        await definitions.workflow_delegate.execute({}, {
          agent: "sol",
          sessionID: "parent-1",
        } as never)
      )
    );

    expect(output.current.steps[0].jobs[1]).toMatchObject({
      job: "research",
      live_state: "starting",
      profile: "luna-max",
      state: "active",
    });
    expect(JSON.stringify(output)).not.toContain("required_next_action");
  });

  test("strict service inputs reject legacy start and selector fields", async () => {
    const { service } = harness();

    expect(
      service.start(
        {
          nodes: [],
          objective: "Legacy graph",
          path: "direct",
          reason: "Legacy field",
          steps: steps(),
        },
        context
      )
    ).rejects.toThrow();

    await start(service);
    expect(service.delegate({ job_id: "research" }, context)).rejects.toThrow();
    expect(
      service.complete({ job_id: "frame", message: "Legacy selector" }, context)
    ).rejects.toThrow();
  });
});

describe("WorkflowToolService status and selection", () => {
  test("returns the bounded empty projection and exact start shape", async () => {
    const { service } = harness();

    const status = await service.status({}, context);

    expect(status.current).toBeNull();
    expect(status.available_workers).toEqual(bundledProfiles);
    expect(status.available_actions).toEqual([
      {
        args: {},
        needs: ["objective"],
        tool: "goal_start",
      },
      {
        args: {},
        needs: ["objective", "steps"],
        tool: "workflow_start",
      },
    ]);
  });

  test("accepts configured custom profiles and rejects profiles absent from status", async () => {
    const customProfiles = [
      {
        description: "Local inexpensive verifier",
        profile: "local-verifier",
      },
    ] as const;
    const { service } = harness(customProfiles);
    const customSteps = [
      {
        jobs: [
          {
            actor: { profile: "local-verifier", type: "worker" as const },
            mode: "verification" as const,
            name: "verify locally",
            objective: "Verify one local surface",
          },
        ],
        name: "verify",
        objective: "Use the configured custom profile",
      },
    ];

    const status = await service.start(
      { objective: "Exercise custom profile", steps: customSteps },
      context
    );
    expect(status.available_workers).toEqual(customProfiles);
    expect(status.current?.steps[0]?.jobs[0]).toMatchObject({
      actor: { profile: "local-verifier", type: "worker" },
      state: "ready",
    });

    const unavailable = harness(customProfiles).service;
    await expect(
      unavailable.start(
        {
          objective: "Reject unavailable profile",
          steps: [
            {
              ...customSteps[0],
              jobs: [
                {
                  actor: { profile: "missing-profile", type: "worker" },
                  mode: "verification",
                  name: "verify locally",
                  objective: "Verify one local surface",
                },
              ],
            },
          ],
        },
        context
      )
    ).rejects.toThrow(unavailableProfilePattern);
  });

  test("starts atomically and exposes semantics without internal identifiers or bulk content", async () => {
    const { service } = harness();

    const status = await start(service);
    const serialized = JSON.stringify(status);

    expect(status.current?.objective).toBe("Exercise tool semantics");
    expect(status.current?.steps.map((step) => step.name)).toEqual([
      "establish",
      "parallel",
      "change",
    ]);
    expect(status.current?.steps[0]?.jobs.map((job) => job.name)).toEqual([
      "frame",
      "research",
      "integrate",
    ]);
    expect("jobs" in (status.current ?? {})).toBe(false);
    const projectedJobs = status.current?.steps.flatMap((step) => step.jobs);
    expect(projectedJobs?.find((job) => job.name === "frame")?.state).toBe(
      "active"
    );
    expect(projectedJobs?.find((job) => job.name === "research")?.state).toBe(
      "ready"
    );
    expect(serialized).not.toContain("internal-workflow-id");
    expect(serialized).not.toMatch(internalStatusPattern);
    expect(serialized).not.toMatch(bulkContentPattern);
    expect(status).not.toHaveProperty("next_actions");
    expect(status.available_actions).toEqual(
      expect.arrayContaining([
        {
          args: { job: "frame" },
          needs: ["message"],
          tool: "workflow_complete",
        },
        {
          args: { job: "parallel sol" },
          needs: ["message"],
          tool: "workflow_complete",
        },
        { args: {}, tool: "workflow_delegate" },
        {
          args: {},
          needs: ["reason", "steps"],
          tool: "workflow_replace",
        },
      ])
    );
  });

  test("associates a new workflow with the active goal in the same root mutation", async () => {
    const { service, store } = harness();
    await store.mutateRoot(({ goal }) => {
      goal.start({
        goal_id: "internal-goal-id",
        objective: "Complete the user outcome across workflows",
        orchestrator_agent_id: "sol",
        parent_session_id: "parent-1",
      });
    });

    const status = await start(service);
    const root = await store.readRoot();

    expect(root.workflows.workflows[0]?.goal_id).toBe("internal-goal-id");
    expect(status.goal).toEqual({
      objective: "Complete the user outcome across workflows",
      status: "active",
    });
    expect(JSON.stringify(status)).not.toContain("internal-goal-id");
  });

  test("joins bounded worker decision metadata into its semantic job", async () => {
    const { root, service, state } = harness();
    await start(service);
    state.markWorkerActive({
      job: "research",
      task_id: "child-1",
      workflow_id: "internal-workflow-id",
    });
    root.job_runs.push({
      job: "research",
      result_available: false,
      run_sequence: 1,
      started_at: timestamp,
      state: "active",
      task_id: "child-1",
      updated_at: timestamp,
      workflow_id: "internal-workflow-id",
      workflow_version: 1,
      write_grants: ["src/extra.ts"],
    });
    root.workers.push({
      child_session_id: "child-1",
      created_at: timestamp,
      delivered_event_sequence: 0,
      job: "research",
      latest_event: {
        created_at: timestamp,
        kind: "progress",
        message: "Located the decision owner.",
        sequence: 1,
      },
      live_state: "busy",
      mode: "research",
      parent_session_id: context.parent_session_id,
      profile: "luna-max",
      run_sequence: 1,
      task_id: "child-1",
      updated_at: timestamp,
      workflow_id: "internal-workflow-id",
      workflow_version: 1,
    });

    const status = await service.status({}, context);
    const research = status.current?.steps
      .flatMap((step) => step.jobs)
      .find((job) => job.name === "research");

    expect(research).toMatchObject({
      latest_event: {
        kind: "progress",
        message: "Located the decision owner.",
      },
      live_state: "busy",
      write_grants: ["src/extra.ts"],
    });
    expect(status.available_actions).toEqual(
      expect.arrayContaining([
        { args: { job: "research" }, tool: "agents_status" },
        {
          args: { job: "research" },
          needs: ["message"],
          tool: "agents_send",
        },
        { args: { job: "research" }, tool: "agents_interrupt" },
        {
          args: { jobs: ["research"], until: "any" },
          tool: "agents_wait",
        },
      ])
    );

    root.deliveries.push({
      child_user_message_id: null,
      created_at: timestamp,
      delivery_id: "delivery-1",
      message: "Refocus on the owner.",
      state: "pending_preemption",
      task_id: "child-1",
      updated_at: timestamp,
    });
    const worker = required(root.workers[0], "Expected seeded worker.");
    worker.live_state = "preempting";
    const preempting = await service.status({}, context);
    expect(preempting.available_actions).toContainEqual({
      args: { job: "research" },
      needs: ["message"],
      tool: "agents_send",
    });
    expect(preempting.available_actions).toContainEqual({
      args: { jobs: ["research"], until: "any" },
      tool: "agents_wait",
    });

    const delivery = required(root.deliveries[0], "Expected pending delivery.");
    delivery.child_user_message_id = "msg_claimed";
    delivery.state = "dispatched";
    const dispatched = await service.status({}, context);
    expect(
      dispatched.available_actions.some(
        (candidate) =>
          candidate.tool === "agents_send" && candidate.args.job === "research"
      )
    ).toBe(false);
  });

  test("puts permission judgment and result inspection before lifecycle closure", async () => {
    const { root, service, state } = harness();
    await start(service);
    state.markWorkerActive({
      job: "research",
      task_id: "child-1",
      workflow_id: "internal-workflow-id",
    });
    root.job_runs.push({
      job: "research",
      result_available: false,
      run_sequence: 1,
      started_at: timestamp,
      state: "active",
      task_id: "child-1",
      updated_at: timestamp,
      workflow_id: "internal-workflow-id",
      workflow_version: 1,
      write_grants: [],
    });
    root.workers.push({
      child_session_id: "child-1",
      created_at: timestamp,
      delivered_event_sequence: 0,
      job: "research",
      latest_event: null,
      live_state: "busy",
      mode: "research",
      parent_session_id: context.parent_session_id,
      profile: "luna-max",
      run_sequence: 1,
      task_id: "child-1",
      updated_at: timestamp,
      workflow_id: "internal-workflow-id",
      workflow_version: 1,
    });
    root.permissions.push({
      created_at: timestamp,
      permission: "edit",
      request_id: "internal-permission-id",
      requested_paths: ["src/extra.ts"],
      task_id: "child-1",
      tool: "apply_patch",
    });

    const permissionStatus = await service.status({}, context);
    expect(permissionStatus.available_actions).toEqual(
      expect.arrayContaining([
        {
          args: { job: "research" },
          needs: ["decision"],
          tool: "agents_permission",
        },
        { args: { job: "research" }, tool: "agents_interrupt" },
        { args: { job: "research" }, tool: "agents_status" },
      ])
    );
    expect(
      permissionStatus.available_actions.some(
        (candidate) =>
          candidate.args.job === "research" &&
          ["agents_send", "agents_wait"].includes(candidate.tool)
      )
    ).toBe(false);
    expect(JSON.stringify(permissionStatus)).not.toContain(
      "internal-permission-id"
    );

    root.permissions.length = 0;
    state.markWorkerReview({
      job: "research",
      result_available: true,
      workflow_id: "internal-workflow-id",
    });
    const worker = required(root.workers[0], "Expected seeded worker.");
    worker.live_state = "review";
    worker.latest_event = {
      created_at: timestamp,
      kind: "result",
      result_message_id: "internal-result-message-id",
      sequence: 1,
    };
    const run = required(root.job_runs[0], "Expected seeded run.");
    run.result_available = true;
    run.state = "review";

    const reviewStatus = await service.status({}, context);
    expect(reviewStatus.available_actions).toEqual(
      expect.arrayContaining([
        {
          args: { job: "research" },
          needs: ["message"],
          tool: "workflow_complete",
        },
        {
          args: {},
          needs: ["reason"],
          tool: "workflow_retry",
        },
        { args: { job: "research" }, tool: "agents_interrupt" },
      ])
    );
    expect(
      reviewStatus.available_actions.some(
        (candidate) => candidate.tool === "agents_inspect"
      )
    ).toBe(false);
    expect(JSON.stringify(reviewStatus)).not.toContain(
      "internal-result-message-id"
    );
  });

  test("exposes exact advertised content and guarded recovery actions only while available", async () => {
    const { root, service, state } = harness();
    await start(service);
    state.markWorkerActive({
      job: "research",
      task_id: "child-1",
      workflow_id: "internal-workflow-id",
    });
    root.job_runs.push({
      job: "research",
      result_available: true,
      run_sequence: 1,
      started_at: timestamp,
      state: "review",
      task_id: "child-1",
      updated_at: timestamp,
      workflow_id: "internal-workflow-id",
      workflow_version: 1,
      write_grants: [],
    });
    root.workers.push({
      child_session_id: "child-1",
      created_at: timestamp,
      delivered_event_sequence: 0,
      job: "research",
      latest_event: {
        created_at: timestamp,
        kind: "result",
        result_message_id: "assistant-result-1",
        sequence: 1,
      },
      live_state: "review",
      mode: "research",
      parent_session_id: context.parent_session_id,
      profile: "luna-max",
      run_sequence: 1,
      task_id: "child-1",
      updated_at: timestamp,
      workflow_id: "internal-workflow-id",
      workflow_version: 1,
    });
    root.turns.push({
      boundary_message_id: "user-turn-1",
      completed_at: timestamp,
      files: [
        {
          additions: 3,
          attributed: true,
          deletions: 1,
          end_sha256: "a".repeat(64),
          path: "src/parser.ts",
          status: "modified",
        },
      ],
      mutation_epochs: [],
      post_undo_hashes: [],
      result_available: true,
      result_message_id: "assistant-result-1",
      run_sequence: 1,
      started_at: timestamp,
      task_id: "child-1",
      tool_outputs: [
        {
          message_id: "assistant-tool-1",
          ordinal: 1,
          output_available: true,
          part_id: "tool-part-1",
          status: "completed",
          title: "Run focused tests",
          tool: "bash",
        },
      ],
      turn: 1,
      undo_state: "available",
      undo_unavailable_reason: null,
    });
    state.markWorkerReview({
      job: "research",
      result_available: true,
      workflow_id: "internal-workflow-id",
    });

    const review = await service.status({}, context);
    expect(review.available_actions).toEqual(
      expect.arrayContaining([
        {
          args: { job: "research", turn: 1, type: "result" },
          tool: "agents_inspect",
        },
        {
          args: {
            file: "src/parser.ts",
            job: "research",
            turn: 1,
            type: "diff",
          },
          tool: "agents_inspect",
        },
        {
          args: {
            job: "research",
            tool: 1,
            turn: 1,
            type: "tool_output",
          },
          tool: "agents_inspect",
        },
        {
          args: { job: "research" },
          needs: ["reason"],
          tool: "agents_undo",
        },
      ])
    );
    expect(
      review.available_actions.some((candidate) =>
        ["agents_send", "agents_wait", "agents_redo"].includes(candidate.tool)
      )
    ).toBe(false);

    state.blockJob({
      job: "research",
      message: "Reverted for review.",
      workflow_id: "internal-workflow-id",
    });
    const worker = required(root.workers[0], "Expected seeded worker.");
    worker.live_state = "blocked";
    const run = required(root.job_runs[0], "Expected seeded run.");
    run.state = "rejected";
    const turn = required(root.turns[0], "Expected seeded turn.");
    turn.undo_state = "redo_available";

    const blocked = await service.status({}, context);
    expect(blocked.available_actions).toContainEqual({
      args: { job: "research" },
      tool: "agents_redo",
    });
    expect(
      blocked.available_actions.some(
        (candidate) => candidate.tool === "agents_undo"
      )
    ).toBe(false);
  });

  test("advertises readable diff and completed tool output during an active turn only", async () => {
    const { root, service, state } = harness();
    await start(service);
    state.markWorkerActive({
      job: "research",
      task_id: "child-active",
      workflow_id: "internal-workflow-id",
    });
    root.job_runs.push({
      job: "research",
      result_available: false,
      run_sequence: 1,
      started_at: timestamp,
      state: "active",
      task_id: "child-active",
      updated_at: timestamp,
      workflow_id: "internal-workflow-id",
      workflow_version: 1,
      write_grants: [],
    });
    root.workers.push({
      child_session_id: "child-active",
      created_at: timestamp,
      delivered_event_sequence: 0,
      job: "research",
      latest_event: null,
      live_state: "busy",
      mode: "research",
      parent_session_id: context.parent_session_id,
      profile: "luna-max",
      run_sequence: 1,
      task_id: "child-active",
      updated_at: timestamp,
      workflow_id: "internal-workflow-id",
      workflow_version: 1,
    });
    root.turns.push({
      boundary_message_id: "user-active-1",
      completed_at: null,
      files: [
        {
          additions: 7,
          attributed: true,
          deletions: 2,
          end_sha256: "b".repeat(64),
          path: "src/emerging.ts",
          status: "modified",
        },
      ],
      mutation_epochs: [],
      post_undo_hashes: [],
      result_available: false,
      result_message_id: null,
      run_sequence: 1,
      started_at: timestamp,
      task_id: "child-active",
      tool_outputs: [
        {
          message_id: "assistant-active-tool",
          ordinal: 1,
          output_available: true,
          part_id: "active-tool-part",
          status: "completed",
          title: "Focused typecheck",
          tool: "bash",
        },
        {
          message_id: "assistant-running-tool",
          ordinal: 2,
          output_available: false,
          part_id: "running-tool-part",
          status: "running",
          title: "Long test",
          tool: "bash",
        },
      ],
      turn: 1,
      undo_state: "unavailable",
      undo_unavailable_reason: "The turn is still active.",
    });

    const status = await service.status({}, context);

    expect(status.available_actions).toContainEqual({
      args: {
        file: "src/emerging.ts",
        job: "research",
        turn: 1,
        type: "diff",
      },
      tool: "agents_inspect",
    });
    expect(status.available_actions).toContainEqual({
      args: {
        job: "research",
        tool: 1,
        turn: 1,
        type: "tool_output",
      },
      tool: "agents_inspect",
    });
    expect(
      status.available_actions.some(
        (candidate) =>
          candidate.tool === "agents_inspect" &&
          ["result", 2].includes(
            (candidate.args.type === "result"
              ? candidate.args.type
              : candidate.args.tool) as string | number
          )
      )
    ).toBe(false);
    expect(
      status.available_actions.some((candidate) =>
        ["agents_undo", "agents_redo"].includes(candidate.tool)
      )
    ).toBe(false);
  });

  test("refuses a second unfinished workflow for the same parent", async () => {
    const { service } = harness();
    await start(service);

    expect(start(service)).rejects.toThrow(currentWorkflowPattern);
  });

  test("requires semantic job selection only when several Sol obligations are completable", async () => {
    const { service, state } = harness();
    await start(service);

    expect(
      service.complete({ message: "Ambiguous completion." }, context)
    ).rejects.toThrow(solCandidatesPattern);

    await service.complete(
      { job: "parallel sol", message: "Completed independent work." },
      context
    );
    expect(
      state.jobState({
        job: "parallel sol",
        workflow_id: "internal-workflow-id",
      })?.state
    ).toBe("completed");

    await service.complete({ message: "Framed the invariant." }, context);
    expect(
      state.jobState({
        job: "frame",
        workflow_id: "internal-workflow-id",
      })?.state
    ).toBe("completed");
  });

  test("infers one ready worker and launches it without a model-visible handoff", async () => {
    const { launches, service } = harness();
    await start(service);

    const status = await service.delegate({}, context);

    expect(launches).toHaveLength(1);
    expect(launches[0]?.definition_job.name).toBe("research");
    expect(status.current?.steps[0]?.jobs[1]).toMatchObject({
      live_state: "starting",
      state: "active",
    });
    expect(JSON.stringify(status)).not.toMatch(nativeTaskIdentifierPattern);
  });

  test("requires a semantic selector when several workers are ready and preserves Sol choice", async () => {
    const { service } = harness();
    const multiWorkerSteps = structuredClone(
      normalizeWorkflowDefinition({
        objective: "Multiple ready workers",
        steps: steps(),
      }).steps
    );
    required(multiWorkerSteps[0], "Expected first step fixture.").jobs.push({
      actor: { profile: "luna-medium", type: "worker" },
      dependsOn: [],
      mode: "verification",
      name: "verify frame",
      objective: "Verify the frame independently",
    });
    await service.start(
      { objective: "Multiple ready workers", steps: multiWorkerSteps },
      context
    );

    expect(service.delegate({}, context)).rejects.toThrow(
      workerCandidatesPattern
    );
    await expect(service.delegate({}, context)).rejects.toThrow(
      'workflow_delegate({ job: "research" })'
    );
    const selected = await service.delegate({ job: "verify frame" }, context);
    expect(
      selected.current?.steps[0]?.jobs.find(
        (job) => job.name === "verify frame"
      )
    ).toMatchObject({ live_state: "starting", state: "active" });
  });

  test("supports concurrent worker review and Sol completion in arbitrary order", async () => {
    const { service, state } = harness();
    await start(service);
    state.markWorkerActive({
      job: "research",
      task_id: "task-research",
      workflow_id: "internal-workflow-id",
    });
    state.markWorkerReview({
      job: "research",
      result_available: true,
      workflow_id: "internal-workflow-id",
    });

    expect(
      service.complete(
        { message: "Ambiguous review or Sol completion." },
        context
      )
    ).rejects.toThrow(reviewAndSolCandidatesPattern);
    await service.complete(
      { job: "research", message: "Accepted worker result." },
      context
    );
    await service.complete(
      { job: "frame", message: "Completed Sol framing." },
      context
    );

    expect(
      state.jobState({
        job: "research",
        workflow_id: "internal-workflow-id",
      })?.state
    ).toBe("completed");
    expect(
      state.jobState({
        job: "parallel sol",
        workflow_id: "internal-workflow-id",
      })?.state
    ).toBe("active");
  });
});

describe("WorkflowToolService replacement and retry", () => {
  test("replacement after launch creates only one next version", async () => {
    const { service, state } = harness();
    await start(service);
    await service.delegate({}, context);
    const replacement = steps();
    required(replacement[2], "Expected replacement step fixture.").objective =
      "Make the corrected change";

    const status = await service.replace(
      {
        reason: "The final stage objective needs correction.",
        steps: replacement,
      },
      context
    );

    expect(state.currentFor("parent-1", "sol")?.current_version).toBe(2);
    expect(JSON.stringify(status)).not.toMatch(versionPattern);
  });

  test("retries one blocked/review job and requires semantic selection when ambiguous", async () => {
    const { service, state } = harness();
    await start(service);
    state.blockJob({
      job: "frame",
      message: "Frame blocked.",
      workflow_id: "internal-workflow-id",
    });
    state.markWorkerActive({
      job: "research",
      task_id: "task-research",
      workflow_id: "internal-workflow-id",
    });
    state.markWorkerReview({
      job: "research",
      result_available: true,
      workflow_id: "internal-workflow-id",
    });

    expect(
      service.retry({ reason: "Ambiguous recovery." }, context)
    ).rejects.toThrow(recoveryCandidatesPattern);

    await service.retry(
      { job: "research", reason: "Research needs another pass." },
      context
    );
    expect(
      state.jobState({
        job: "research",
        workflow_id: "internal-workflow-id",
      })?.state
    ).toBe("ready");
    expect(state.currentFor("parent-1", "sol")?.current_version).toBe(1);
  });
});
