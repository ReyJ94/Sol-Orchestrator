import { describe, expect, test } from "bun:test";

import {
  emptyRootSnapshot,
  JobRunRecordSchema,
  PendingDeliveryRecordSchema,
  PendingPermissionRecordSchema,
  parseRootSnapshot,
  RootSnapshotSchema,
  WorkerBindingRecordSchema,
  WorkerTurnRecordSchema,
} from "./orchestration.js";

const timestamp = "2026-07-17T10:00:00.000Z";
const contentHash = "a".repeat(64);
const CURRENT_WORKFLOW_PATTERN = /current workflow/i;
const DUPLICATE_PATTERN = /duplicate/i;
const JOB_STATE_PATTERN = /job state/i;
const MATCHING_GOAL_OWNER_PATTERN = /matching goal owner/i;
const ORPHAN_PATTERN = /orphan|matching/i;
const UNDO_PATTERN = /undo/i;
const UPDATED_AT_PATTERN = /updated_at/i;
const VERSION_PATTERN = /version/i;
const WATERMARK_SEQUENCE_PATTERN = /watermark|sequence/u;
const WATERMARK_EVENT_PATTERN = /watermark|event/u;

const definition = {
  objective: "Replace durable orchestration state.",
  steps: [
    {
      dependsOn: [],
      jobs: [
        {
          actor: { type: "orchestrator" as const },
          dependsOn: [],
          name: "frame state contract",
          objective: "Record the durable-state contract.",
        },
        {
          actor: {
            profile: "luna-max" as const,
            type: "worker" as const,
          },
          dependsOn: ["frame state contract"],
          mode: "verification" as const,
          name: "verify state contract",
          objective: "Verify persistence without copying worker content.",
          writeFiles: [],
        },
      ],
      name: "replace persistence",
      objective: "Install one strict fresh durable snapshot.",
    },
  ],
};

const workflow = () => ({
  current: true,
  current_version: 1,
  orchestrator_agent_id: "sol",
  parent_session_id: "parent-1",
  versions: [
    {
      created_at: timestamp,
      definition,
      job_states: {
        "frame state contract": {
          result_available: false,
          run_sequence: 1,
          state: "completed" as const,
          updated_at: timestamp,
        },
        "verify state contract": {
          result_available: true,
          run_sequence: 1,
          state: "review" as const,
          task_id: "task-1",
          updated_at: timestamp,
        },
      },
      version: 1,
    },
  ],
  workflow_id: "workflow-1",
});

const goal = (
  input: {
    goalID?: string;
    parentSessionID?: string;
    status?: "active" | "blocked" | "completed";
  } = {}
) => ({
  continuation: null,
  created_at: timestamp,
  goal_id: input.goalID ?? "goal-1",
  objective: "Complete the real user outcome.",
  orchestrator_agent_id: "sol",
  parent_session_id: input.parentSessionID ?? "parent-1",
  status: input.status ?? ("active" as const),
  status_message: null,
  updated_at: timestamp,
});

const jobRun = () => ({
  job: "verify state contract",
  result_available: true,
  run_sequence: 1,
  started_at: timestamp,
  state: "review" as const,
  task_id: "task-1",
  updated_at: timestamp,
  workflow_id: "workflow-1",
  workflow_version: 1,
  write_grants: ["docs/generated.md"],
});

const worker = () => ({
  child_session_id: "child-1",
  created_at: timestamp,
  delivered_event_sequence: 0,
  job: "verify state contract",
  latest_event: {
    created_at: timestamp,
    kind: "result" as const,
    result_message_id: "message-assistant-1",
    sequence: 1,
  },
  live_state: "review" as const,
  mode: "verification" as const,
  parent_session_id: "parent-1",
  profile: "luna-max" as const,
  run_sequence: 1,
  task_id: "task-1",
  updated_at: timestamp,
  workflow_id: "workflow-1",
  workflow_version: 1,
});

const delivery = () => ({
  child_user_message_id: null,
  created_at: timestamp,
  delivery_id: "delivery-1",
  message: "Check the strict parser before continuing.",
  state: "pending_preemption" as const,
  task_id: "task-1",
  updated_at: timestamp,
});

const permission = () => ({
  created_at: timestamp,
  permission: "edit" as const,
  request_id: "permission-1",
  requested_paths: ["src/server.ts"],
  task_id: "task-1",
  tool: "apply_patch",
});

const turn = () => ({
  boundary_message_id: "message-user-1",
  completed_at: timestamp,
  files: [
    {
      additions: 4,
      attributed: true,
      deletions: 1,
      end_sha256: contentHash,
      path: "src/schema/orchestration.ts",
      status: "modified" as const,
    },
  ],
  mutation_epochs: [
    {
      call_id: "call-1",
      completed_at: timestamp,
      overlap: false,
      paths: ["src/worker.ts"],
      source: "structured" as const,
      started_at: timestamp,
      tool: "apply_patch",
    },
  ],
  post_undo_hashes: [],
  result_available: true,
  result_message_id: "message-assistant-1",
  run_sequence: 1,
  started_at: timestamp,
  task_id: "task-1",
  tool_outputs: [
    {
      message_id: "message-assistant-1",
      ordinal: 1,
      output_available: true,
      part_id: "part-1",
      status: "completed" as const,
      title: "Focused tests",
      tool: "bash",
    },
  ],
  turn: 1,
  undo_state: "available" as const,
  undo_unavailable_reason: null,
});

const rootFixture = () => ({
  deliveries: [delivery()],
  goals: { goals: [] },
  job_runs: [jobRun()],
  permissions: [permission()],
  schema_version: 1 as const,
  turns: [turn()],
  workers: [worker()],
  workflows: { workflows: [workflow()] },
});

describe("fresh orchestration persistence schema", () => {
  test("omits redundant archive summaries from the strict root", () => {
    expect(emptyRootSnapshot()).not.toHaveProperty("archives");
    expect(() =>
      parseRootSnapshot({ ...emptyRootSnapshot(), archives: [] })
    ).toThrow();
  });

  test("starts with one strict empty schema-version-1 root", () => {
    expect(emptyRootSnapshot()).toEqual({
      deliveries: [],
      goals: { goals: [] },
      job_runs: [],
      permissions: [],
      schema_version: 1,
      turns: [],
      workers: [],
      workflows: { workflows: [] },
    });
    expect(RootSnapshotSchema.parse(emptyRootSnapshot())).toEqual(
      emptyRootSnapshot()
    );
  });

  test("defaults only the absent same-version goal collection", () => {
    const { goals: _goals, ...sameVersionRoot } = emptyRootSnapshot();

    expect(parseRootSnapshot(sameVersionRoot).goals).toEqual({ goals: [] });
    expect(() =>
      parseRootSnapshot({ ...sameVersionRoot, goals: { goals: "future" } })
    ).toThrow();
  });

  test("rejects malformed, duplicate-current, and cross-owner goal authority", () => {
    expect(() =>
      parseRootSnapshot({
        ...emptyRootSnapshot(),
        goals: { goals: [{ ...goal(), status: "future" }] },
      })
    ).toThrow();
    expect(() =>
      parseRootSnapshot({
        ...emptyRootSnapshot(),
        goals: {
          goals: [goal(), goal({ goalID: "goal-2" })],
        },
      })
    ).toThrow(DUPLICATE_PATTERN);
    expect(() =>
      parseRootSnapshot({
        ...emptyRootSnapshot(),
        goals: { goals: [goal({ parentSessionID: "parent-2" })] },
        workflows: {
          workflows: [{ ...workflow(), goal_id: "goal-1" }],
        },
      })
    ).toThrow(MATCHING_GOAL_OWNER_PATTERN);
  });

  test("round-trips every durable record needed for restart reconciliation", () => {
    const root = parseRootSnapshot(rootFixture());

    expect(root.workflows.workflows[0]?.workflow_id).toBe("workflow-1");
    expect(root.job_runs[0]).toEqual(jobRun());
    expect(root.workers[0]).toEqual(worker());
    expect(root.deliveries[0]).toEqual(delivery());
    expect(root.permissions[0]).toEqual(permission());
    expect(root.turns[0]).toEqual(turn());
  });

  test("exposes strict independently reusable record schemas", () => {
    expect(JobRunRecordSchema.parse(jobRun())).toEqual(jobRun());
    expect(WorkerBindingRecordSchema.parse(worker())).toEqual(worker());
    expect(PendingDeliveryRecordSchema.parse(delivery())).toEqual(delivery());
    expect(PendingPermissionRecordSchema.parse(permission())).toEqual(
      permission()
    );
    expect(WorkerTurnRecordSchema.parse(turn())).toEqual(turn());
  });

  test.each([
    [
      "legacy checkpoint root",
      { checkpoints: [], schema_version: 4, tasks: [] },
    ],
    [
      "legacy split root",
      { orchestration: {}, schema_version: 1, workflow: {} },
    ],
    ["future root", { ...emptyRootSnapshot(), schema_version: 2 }],
  ])("rejects %s without migration or shape detection", (_label, input) => {
    expect(() => parseRootSnapshot(input)).toThrow();
  });

  test("rejects persisted worker content bodies at every metadata record", () => {
    const cases = [
      { ...jobRun(), result_body: "bulk result" },
      { ...worker(), transcript: "bulk transcript" },
      {
        ...worker(),
        latest_event: { ...worker().latest_event, result_body: "bulk result" },
      },
      { ...turn(), patch: "bulk patch" },
      {
        ...turn(),
        tool_outputs: [{ ...turn().tool_outputs[0], output: "bulk output" }],
      },
    ];

    expect(() => JobRunRecordSchema.parse(cases[0])).toThrow();
    expect(() => WorkerBindingRecordSchema.parse(cases[1])).toThrow();
    expect(() => WorkerBindingRecordSchema.parse(cases[2])).toThrow();
    expect(() => WorkerTurnRecordSchema.parse(cases[3])).toThrow();
    expect(() => WorkerTurnRecordSchema.parse(cases[4])).toThrow();
  });

  test("requires a monotonic delivered watermark within the latest event sequence", () => {
    expect(() =>
      WorkerBindingRecordSchema.parse({
        ...worker(),
        delivered_event_sequence: 2,
      })
    ).toThrow(WATERMARK_SEQUENCE_PATTERN);
    expect(() =>
      WorkerBindingRecordSchema.parse({
        ...worker(),
        delivered_event_sequence: 1,
        latest_event: null,
      })
    ).toThrow(WATERMARK_EVENT_PATTERN);
  });

  test("rejects duplicate current workflow pointers for one parent session", () => {
    const second = {
      ...workflow(),
      orchestrator_agent_id: "another-sol",
      workflow_id: "workflow-2",
    };
    expect(() =>
      parseRootSnapshot({
        ...emptyRootSnapshot(),
        workflows: { workflows: [workflow(), second] },
      })
    ).toThrow(CURRENT_WORKFLOW_PATTERN);
  });

  test("requires exact job-state keys and contiguous workflow versions", () => {
    const source = workflow();
    const missingJobState = {
      ...source,
      versions: source.versions.map((version) => ({
        ...version,
        job_states: {
          "frame state contract": version.job_states["frame state contract"],
        },
      })),
    };
    expect(() =>
      parseRootSnapshot({
        ...emptyRootSnapshot(),
        workflows: { workflows: [missingJobState] },
      })
    ).toThrow(JOB_STATE_PATTERN);

    const skippedVersionSource = workflow();
    const skippedVersion = {
      ...skippedVersionSource,
      current_version: 2,
      versions: skippedVersionSource.versions.map((version) => ({
        ...version,
        version: 2,
      })),
    };
    expect(() =>
      parseRootSnapshot({
        ...emptyRootSnapshot(),
        workflows: { workflows: [skippedVersion] },
      })
    ).toThrow(VERSION_PATTERN);
  });

  test("rejects duplicate run, worker, delivery, permission, and turn identities", () => {
    const duplicateCases = [
      { ...rootFixture(), job_runs: [jobRun(), jobRun()] },
      { ...rootFixture(), workers: [worker(), worker()] },
      { ...rootFixture(), deliveries: [delivery(), delivery()] },
      { ...rootFixture(), permissions: [permission(), permission()] },
      { ...rootFixture(), turns: [turn(), turn()] },
    ];

    for (const value of duplicateCases) {
      expect(() => parseRootSnapshot(value)).toThrow(DUPLICATE_PATTERN);
    }
  });

  test("rejects orphaned run, worker, delivery, permission, and turn metadata", () => {
    const orphanCases = [
      {
        ...rootFixture(),
        job_runs: [{ ...jobRun(), workflow_id: "missing-workflow" }],
      },
      {
        ...rootFixture(),
        workers: [
          {
            ...worker(),
            child_session_id: "orphan-child",
            task_id: "orphan-task",
          },
        ],
      },
      {
        ...rootFixture(),
        deliveries: [{ ...delivery(), task_id: "orphan-task" }],
      },
      {
        ...rootFixture(),
        permissions: [{ ...permission(), task_id: "orphan-task" }],
      },
      {
        ...rootFixture(),
        turns: [{ ...turn(), task_id: "orphan-task" }],
      },
    ];

    for (const value of orphanCases) {
      expect(() => parseRootSnapshot(value)).toThrow(ORPHAN_PATTERN);
    }
  });

  test("requires canonical paths, hashes, timestamps, and paired undo state", () => {
    expect(() =>
      PendingPermissionRecordSchema.parse({
        ...permission(),
        requested_paths: ["../outside.ts"],
      })
    ).toThrow();
    expect(() =>
      WorkerTurnRecordSchema.parse({
        ...turn(),
        files: [{ ...turn().files[0], end_sha256: "not-a-hash" }],
      })
    ).toThrow();
    expect(() =>
      WorkerTurnRecordSchema.parse({
        ...turn(),
        undo_state: "unavailable",
        undo_unavailable_reason: null,
      })
    ).toThrow(UNDO_PATTERN);
    expect(() =>
      JobRunRecordSchema.parse({
        ...jobRun(),
        started_at: "2026-07-17T11:00:00.000Z",
        updated_at: timestamp,
      })
    ).toThrow(UPDATED_AT_PATTERN);
  });

  test("keeps accepted Sol judgment metadata while rejecting worker result text", () => {
    const acceptedSource = workflow();
    const accepted = {
      ...acceptedSource,
      versions: acceptedSource.versions.map((version) => ({
        ...version,
        job_states: {
          ...version.job_states,
          "verify state contract": {
            completion_message: "Accepted after targeted inspection.",
            result_available: true,
            run_sequence: 1,
            state: "completed" as const,
            task_id: "task-1",
            updated_at: timestamp,
          },
        },
      })),
    };

    expect(() =>
      parseRootSnapshot({
        ...emptyRootSnapshot(),
        workflows: { workflows: [accepted] },
      })
    ).not.toThrow();
    expect(() =>
      parseRootSnapshot({ ...rootFixture(), result: "worker result body" })
    ).toThrow();
  });
});
