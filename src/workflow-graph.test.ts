import { describe, expect, test } from "bun:test";

import type { WorkflowDefinition } from "./schema/workflow.js";
import {
  assertConflictSafeDefinition,
  normalizeWorkflowDefinition,
  prerequisiteJobNames,
  semanticJobSignatures,
} from "./workflow-graph.js";

const overlapPattern = /overlap|dependency/i;

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

const graph = (): WorkflowDefinition =>
  normalizeWorkflowDefinition({
    objective: "Exercise graph semantics",
    steps: [
      {
        jobs: [
          {
            actor: { type: "orchestrator" },
            name: "frame",
            objective: "Frame the work",
          },
          {
            actor: { profile: "luna-max", type: "worker" },
            dependsOn: ["frame"],
            mode: "research",
            name: "research",
            objective: "Research the seam",
          },
        ],
        name: "establish",
        objective: "Establish behavior",
      },
      {
        dependsOn: ["establish"],
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
            actor: { profile: "luna-medium", type: "worker" },
            mode: "verification",
            name: "verify",
            objective: "Verify the result",
          },
        ],
        name: "verify",
        objective: "Verify the change",
      },
    ],
  });

describe("workflow graph normalization", () => {
  test("normalizes the complete strict definition", () => {
    const normalized = normalizeWorkflowDefinition(graph());

    expect(normalized.steps[0]?.dependsOn).toEqual([]);
    expect(normalized.steps[0]?.jobs[0]?.dependsOn).toEqual([]);
    expect(normalized.steps[1]?.dependsOn).toEqual(["establish"]);
  });

  test("computes the transitive prerequisite closure across local jobs and step dependencies", () => {
    expect([...prerequisiteJobNames(graph(), "integrate")].sort()).toEqual([
      "frame",
      "implement",
      "research",
    ]);
    expect([...prerequisiteJobNames(graph(), "verify")].sort()).toEqual([
      "frame",
      "implement",
      "integrate",
      "research",
    ]);
  });

  test("canonical signatures ignore authored array order after normalization", () => {
    const left = graph();
    const rightInput = structuredClone(left);
    mutableJob(rightInput, 1, 0).writeFiles = ["src/z.ts", "src/owner.ts"];
    const first = normalizeWorkflowDefinition(rightInput);
    const reordered = structuredClone(first);
    mutableJob(reordered, 1, 0).writeFiles = ["src/owner.ts", "src/z.ts"];

    expect(semanticJobSignatures(first).get("implement")).toBe(
      semanticJobSignatures(normalizeWorkflowDefinition(reordered)).get(
        "implement"
      )
    );
  });

  test("signature changes when the job moves or any semantic owner field changes", () => {
    const original = graph();
    const originalSignature = semanticJobSignatures(original).get("implement");

    const changedObjective = structuredClone(original);
    mutableStep(changedObjective, 1).objective = "A different stage contract";
    expect(semanticJobSignatures(changedObjective).get("implement")).not.toBe(
      originalSignature
    );

    const changedMode = structuredClone(original);
    mutableJob(changedMode, 1, 0).mode = "verification";
    expect(semanticJobSignatures(changedMode).get("implement")).not.toBe(
      originalSignature
    );

    const changedStepDependency = structuredClone(original);
    mutableStep(changedStepDependency, 1).dependsOn = [];
    expect(
      semanticJobSignatures(changedStepDependency).get("implement")
    ).not.toBe(originalSignature);

    const moved = structuredClone(original);
    const implementation = mutableStep(moved, 1).jobs.shift();
    if (implementation === undefined) {
      throw new Error("Expected implementation fixture.");
    }
    mutableStep(moved, 2).jobs.push(implementation);
    expect(semanticJobSignatures(moved).get("implement")).not.toBe(
      originalSignature
    );
  });
});

describe("optional write-scope conflict checks", () => {
  const parallelWorkers = (
    leftScope: string[] | undefined,
    rightScope: string[] | undefined,
    rightDependsOn: string[] = []
  ): WorkflowDefinition =>
    normalizeWorkflowDefinition({
      objective: "Run parallel workers",
      steps: [
        {
          jobs: [
            {
              actor: { profile: "terra-medium", type: "worker" },
              mode: "implementation",
              name: "left",
              objective: "Change the left owner",
              ...(leftScope === undefined ? {} : { writeFiles: leftScope }),
            },
            {
              actor: { profile: "terra-medium", type: "worker" },
              dependsOn: rightDependsOn,
              mode: "implementation",
              name: "right",
              objective: "Change the right owner",
              ...(rightScope === undefined ? {} : { writeFiles: rightScope }),
            },
          ],
          name: "change",
          objective: "Change two owners",
        },
      ],
    });

  test("rejects unordered scoped workers whose globs may overlap", () => {
    expect(() =>
      assertConflictSafeDefinition(
        parallelWorkers(["src/**"], ["src/worker.ts"])
      )
    ).toThrow(overlapPattern);
  });

  test("accepts explicit dependency ordering for overlapping scopes", () => {
    expect(() =>
      assertConflictSafeDefinition(
        parallelWorkers(["src/**"], ["src/worker.ts"], ["left"])
      )
    ).not.toThrow();
  });

  test("accepts disjoint explicit scopes and explicitly empty scopes", () => {
    expect(() =>
      assertConflictSafeDefinition(
        parallelWorkers(["src/left/**"], ["test/right/**"])
      )
    ).not.toThrow();
    expect(() =>
      assertConflictSafeDefinition(parallelWorkers([], ["src/**"]))
    ).not.toThrow();
  });

  test("does not serialize unscoped workers", () => {
    expect(() =>
      assertConflictSafeDefinition(parallelWorkers(undefined, ["src/**"]))
    ).not.toThrow();
    expect(() =>
      assertConflictSafeDefinition(parallelWorkers(undefined, undefined))
    ).not.toThrow();
  });
});
