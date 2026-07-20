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
const launchFailurePattern = /could not launch/i;
const recoveryCandidatesPattern = /frame|research/i;
const reviewAndSolCandidatesPattern = /research|frame|parallel sol/i;
const solCandidatesPattern = /frame|parallel sol/i;
const versionPattern = /version|workflow_id/i;
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
          profile: "terra-max" as const,
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
    description: "Cross-file leaf work",
    profile: "terra-medium",
  },
  {
    description: "Difficult ambiguous leaf work",
    profile: "terra-max",
  },
] as const;

const harness = (
  availableWorkers: readonly WorkerProfileDescriptor[] = bundledProfiles,
  beforeLaunch?: (input: LaunchInput) => Promise<void>,
  cleanupWorkflow?: (workflowID: string) => Promise<void>
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
    async launch(input: LaunchInput) {
      launches.push(input);
      await beforeLaunch?.(input);
      const sequence = launches.filter(
        (launch) => launch.definition_job.name === input.definition_job.name
      ).length;
      const taskID = `child-${input.definition_job.name}-${sequence}`;
      state.markWorkerActive({
        job: input.definition_job.name,
        task_id: taskID,
        workflow_id: input.workflow_id,
      });
      const runSequence = required(
        state.jobState({
          job: input.definition_job.name,
          workflow_id: input.workflow_id,
        })?.run_sequence,
        "Expected active worker run sequence."
      );
      root.job_runs.push({
        job: input.definition_job.name,
        result_available: false,
        run_sequence: runSequence,
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
        run_sequence: runSequence,
        task_id: taskID,
        updated_at: timestamp,
        workflow_id: input.workflow_id,
        workflow_version: input.workflow_version,
      });
    },
  };
  const service = new WorkflowToolService({
    available_workers: () => availableWorkers,
    cleanup_workflow: cleanupWorkflow,
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
  test("registers exactly the five accepted workflow tools", () => {
    const { service } = harness();

    expect(Object.keys(createWorkflowToolDefinitions(service)).sort()).toEqual([
      "workflow_complete",
      "workflow_replace",
      "workflow_retry",
      "workflow_start",
      "workflow_status",
    ]);
  });

  test("workflow_start launches ready workers and returns refreshed semantic state", async () => {
    const { service } = harness();
    const definitions = createWorkflowToolDefinitions(service);

    const output = JSON.parse(
      String(
        await definitions.workflow_start.execute(
          { objective: "Exercise tool semantics", steps: steps() } as never,
          {
            agent: "sol",
            sessionID: "parent-1",
          } as never
        )
      )
    );

    expect(output.current.steps[0].jobs[1]).toMatchObject({
      job: "research",
      live_state: "starting",
      profile: "terra-max",
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
    expect(
      service.complete({ job_id: "frame", message: "Legacy selector" }, context)
    ).rejects.toThrow();
  });
});

describe("graph-driven worker execution", () => {
  test("removes disposable workflow artifacts after the final job completes", async () => {
    const cleaned: string[] = [];
    const { service } = harness(bundledProfiles, undefined, (workflowID) => {
      cleaned.push(workflowID);
      return Promise.resolve();
    });
    await service.start(
      {
        objective: "Clean completed workflow artifacts",
        steps: [
          {
            jobs: [
              {
                actor: { type: "orchestrator" },
                name: "close workflow",
                objective: "Close the workflow",
              },
            ],
            name: "finish",
            objective: "Finish once",
          },
        ],
      },
      context
    );

    await service.complete({ message: "The workflow is complete." }, context);

    expect(cleaned).toEqual(["internal-workflow-id"]);
  });

  test("starts every initially ready worker in parallel without another Sol action", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const { launches, service } = harness(bundledProfiles, async () => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    const status = await service.start(
      {
        objective: "Launch independent evidence concurrently",
        steps: [
          {
            jobs: [
              {
                actor: { profile: "luna-medium", type: "worker" },
                mode: "research",
                name: "inspect runtime",
                objective: "Inspect runtime behavior",
              },
              {
                actor: { profile: "terra-max", type: "worker" },
                mode: "verification",
                name: "verify contract",
                objective: "Verify the installed contract",
              },
            ],
            name: "gather evidence",
            objective: "Gather independent evidence",
          },
        ],
      },
      context
    );

    expect(launches.map((launch) => launch.definition_job.name).sort()).toEqual(
      ["inspect runtime", "verify contract"]
    );
    expect(maximumInFlight).toBe(2);
    expect(status.current?.steps[0]?.jobs.map((job) => job.state)).toEqual([
      "active",
      "active",
    ]);
    expect(
      status.available_actions.some(
        (action) => action.tool === "workflow_delegate"
      )
    ).toBe(false);
  });

  test("launches a dependent worker only after Sol accepts its prerequisite", async () => {
    const { launches, service, state } = harness();
    const status = await service.start(
      {
        objective: "Respect the review gate",
        steps: [
          {
            jobs: [
              {
                actor: { profile: "terra-max", type: "worker" },
                mode: "research",
                name: "research owner",
                objective: "Research the owner",
              },
            ],
            name: "research",
            objective: "Establish the owner",
          },
          {
            dependsOn: ["research"],
            jobs: [
              {
                actor: { profile: "terra-medium", type: "worker" },
                mode: "implementation",
                name: "implement owner",
                objective: "Implement the decided owner",
              },
            ],
            name: "implementation",
            objective: "Implement the result",
          },
        ],
      },
      context
    );

    expect(launches.map((launch) => launch.definition_job.name)).toEqual([
      "research owner",
    ]);
    expect(status.current?.steps[1]?.jobs[0]?.state).toBe("pending");
    state.markWorkerReview({
      job: "research owner",
      result_available: true,
      workflow_id: "internal-workflow-id",
    });
    expect(launches).toHaveLength(1);

    const accepted = await service.complete(
      { message: "Accepted the research result." },
      context
    );

    expect(launches.map((launch) => launch.definition_job.name)).toEqual([
      "research owner",
      "implement owner",
    ]);
    expect(accepted.current?.steps[1]?.jobs[0]?.state).toBe("active");
  });

  test("isolates one native launch failure and retry starts only that job", async () => {
    let failedOnce = false;
    const { launches, service } = harness(bundledProfiles, (input) => {
      if (input.definition_job.name === "unavailable worker" && !failedOnce) {
        failedOnce = true;
        return Promise.reject(new Error("native child creation failed"));
      }
      return Promise.resolve();
    });
    const started = await service.start(
      {
        objective: "Keep independent launch failures isolated",
        steps: [
          {
            jobs: [
              {
                actor: { profile: "luna-medium", type: "worker" },
                mode: "verification",
                name: "healthy worker",
                objective: "Run the healthy verification",
              },
              {
                actor: { profile: "terra-max", type: "worker" },
                mode: "research",
                name: "unavailable worker",
                objective: "Exercise launch failure",
              },
            ],
            name: "parallel work",
            objective: "Launch independent jobs",
          },
        ],
      },
      context
    );

    expect(
      started.current?.steps[0]?.jobs.find(
        (job) => job.name === "healthy worker"
      )?.state
    ).toBe("active");
    expect(
      started.current?.steps[0]?.jobs.find(
        (job) => job.name === "unavailable worker"
      )
    ).toMatchObject({
      state: "blocked",
      status_message: expect.stringMatching(launchFailurePattern),
    });

    const retried = await service.retry(
      { reason: "The native boundary is available now." },
      context
    );

    expect(
      launches.filter(
        (launch) => launch.definition_job.name === "healthy worker"
      )
    ).toHaveLength(1);
    expect(
      launches.filter(
        (launch) => launch.definition_job.name === "unavailable worker"
      )
    ).toHaveLength(2);
    expect(
      retried.current?.steps[0]?.jobs.find(
        (job) => job.name === "unavailable worker"
      )?.state
    ).toBe("active");
  });

  test("concurrent status recovery dispatches one persisted ready job once", async () => {
    const { launches, service, state } = harness(
      bundledProfiles,
      async () => await Promise.resolve()
    );
    state.start({
      definition: normalizeWorkflowDefinition({
        objective: "Recover ready work",
        steps: [
          {
            jobs: [
              {
                actor: { profile: "luna-medium", type: "worker" },
                mode: "verification",
                name: "recover verifier",
                objective: "Verify after restart",
              },
            ],
            name: "recover",
            objective: "Recover persisted readiness",
          },
        ],
      }),
      orchestrator_agent_id: "sol",
      parent_session_id: "parent-1",
      workflow_id: "internal-workflow-id",
    });

    const [left, right] = await Promise.all([
      service.status({}, context),
      service.status({}, context),
    ]);

    expect(launches).toHaveLength(1);
    expect(left.current?.steps[0]?.jobs[0]?.state).toBe("active");
    expect(right.current?.steps[0]?.jobs[0]?.state).toBe("active");
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
      state: "active",
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
      "active"
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

  test("creates and associates a durable goal when actionable work starts without one", async () => {
    const { service, store } = harness();

    const status = await start(service);
    const root = await store.readRoot();

    expect(root.goals.goals).toEqual([
      expect.objectContaining({
        objective: "Exercise tool semantics",
        status: "active",
      }),
    ]);
    expect(root.workflows.workflows[0]?.goal_id).toBe(
      root.goals.goals[0]?.goal_id
    );
    expect(status.goal).toEqual({
      objective: "Exercise tool semantics",
      status: "active",
    });
    expect(JSON.stringify(status)).not.toContain("internal-workflow-id");
  });

  test("joins bounded worker decision metadata into its semantic job", async () => {
    const { root, service } = harness();
    await start(service);
    const worker = required(root.workers[0], "Expected launched worker.");
    worker.latest_event = {
      created_at: timestamp,
      kind: "progress",
      message: "Located the decision owner.",
      sequence: 1,
    };
    worker.live_state = "busy";
    const run = required(root.job_runs[0], "Expected launched run.");
    run.write_grants = ["src/extra.ts"];

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
      task_id: worker.task_id,
      updated_at: timestamp,
    });
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
    const worker = required(root.workers[0], "Expected launched worker.");
    worker.live_state = "busy";
    const run = required(root.job_runs[0], "Expected launched run.");
    root.permissions.push({
      created_at: timestamp,
      permission: "edit",
      request_id: "internal-permission-id",
      requested_paths: ["src/extra.ts"],
      task_id: worker.task_id,
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
    worker.live_state = "review";
    worker.latest_event = {
      created_at: timestamp,
      kind: "result",
      result_message_id: "internal-result-message-id",
      sequence: 1,
    };
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
    const worker = required(root.workers[0], "Expected launched worker.");
    worker.latest_event = {
      created_at: timestamp,
      kind: "result",
      result_message_id: "assistant-result-1",
      sequence: 1,
    };
    worker.live_state = "review";
    const run = required(root.job_runs[0], "Expected launched run.");
    run.result_available = true;
    run.state = "review";
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
      task_id: worker.task_id,
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
    worker.live_state = "blocked";
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
    const { root, service } = harness();
    await start(service);
    const worker = required(root.workers[0], "Expected launched worker.");
    worker.live_state = "busy";
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
      task_id: worker.task_id,
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

  test("supports concurrent worker review and Sol completion in arbitrary order", async () => {
    const { service, state } = harness();
    await start(service);
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
    const { launches, service, state } = harness();
    await start(service);
    const replacement = structuredClone(
      normalizeWorkflowDefinition({
        objective: "Exercise tool semantics",
        steps: steps(),
      }).steps
    );
    required(replacement[2], "Expected replacement step fixture.").objective =
      "Make the corrected change";
    required(replacement[0], "Expected first replacement step.").jobs.push({
      actor: { profile: "luna-medium", type: "worker" },
      dependsOn: [],
      mode: "verification",
      name: "verify framing",
      objective: "Verify the retained framing independently",
    });

    const status = await service.replace(
      {
        reason: "The final stage objective needs correction.",
        steps: replacement,
      },
      context
    );

    expect(state.currentFor("parent-1", "sol")?.current_version).toBe(2);
    expect(
      launches.filter((launch) => launch.definition_job.name === "research")
    ).toHaveLength(1);
    expect(
      launches.filter(
        (launch) => launch.definition_job.name === "verify framing"
      )
    ).toHaveLength(1);
    expect(JSON.stringify(status)).not.toMatch(versionPattern);
  });

  test("updates the workflow and associated durable goal objective on a scope change", async () => {
    const { service, store } = harness();
    await start(service);

    const status = await service.replace(
      {
        objective: "Deliver the revised user outcome",
        reason: "The user replaced the original requested outcome.",
        steps: steps(),
      },
      context
    );
    const root = await store.readRoot();

    expect(status.current?.objective).toBe("Deliver the revised user outcome");
    expect(status.goal?.objective).toBe("Deliver the revised user outcome");
    expect(root.goals.goals[0]?.objective).toBe(
      "Deliver the revised user outcome"
    );
  });

  test("preserves the existing objective when replacement omits it", async () => {
    const { service } = harness();
    await start(service);

    const status = await service.replace(
      {
        reason: "Only the unfinished hierarchy changed.",
        steps: steps(),
      },
      context
    );

    expect(status.current?.objective).toBe("Exercise tool semantics");
    expect(status.goal?.objective).toBe("Exercise tool semantics");
  });

  test("retries one blocked/review job and requires semantic selection when ambiguous", async () => {
    const { service, state } = harness();
    await start(service);
    state.blockJob({
      job: "frame",
      message: "Frame blocked.",
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
    ).toBe("active");
    expect(state.currentFor("parent-1", "sol")?.current_version).toBe(1);
  });
});
