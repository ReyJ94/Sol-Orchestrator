import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  JobStateSchema,
  StepStateSchema,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  WorkflowJobSchema,
  WorkflowStateSchema,
} from "./workflow.js";

const cyclePattern = /cycle/i;
const duplicatePattern = /duplicate/i;
const jobPattern = /job/i;
const modePattern = /mode/i;
const sameStepPattern = /same step/i;
const selfPattern = /itself|self/i;
const stepPattern = /step/i;
const uniquePattern = /unique/i;
const writeFilesPattern = /writeFiles/i;

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
  WorkflowDefinitionSchema.parse({
    objective: "  Replace the parser without changing emitted records  ",
    steps: [
      {
        jobs: [
          {
            actor: { type: "orchestrator" },
            name: "frame parser claim",
            objective: "  Record the owner and RED set  ",
          },
          {
            actor: {
              profile: "luna-max",
              type: "worker",
            },
            dependsOn: ["frame parser claim"],
            mode: "research",
            name: "inspect parser boundary",
            objective: "Inspect callers and tests",
          },
        ],
        name: "establish behavior",
        objective: "Prove the parser boundary",
      },
      {
        dependsOn: ["establish behavior"],
        jobs: [
          {
            actor: {
              profile: "terra-medium",
              type: "worker",
            },
            mode: "implementation",
            name: "implement parser",
            objective: "Replace the parser owner",
            writeFiles: ["src/parser.ts", "src/**/*.test.ts"],
          },
          {
            actor: { type: "orchestrator" },
            dependsOn: ["implement parser"],
            name: "integrate parser",
            objective: "Inspect and accept the implementation",
          },
        ],
        name: "implement",
        objective: "Install the decided parser",
      },
    ],
  });

describe("WorkflowDefinitionSchema", () => {
  test("advertises actor-specific job inputs in generated tool schemas", () => {
    const schema = z.toJSONSchema(WorkflowJobSchema, { io: "input" });
    const branches = schema.anyOf;

    expect(branches).toHaveLength(2);
    const [orchestrator, worker] = branches ?? [];
    expect(orchestrator).toMatchObject({
      additionalProperties: false,
      properties: {
        actor: {
          properties: { type: { const: "orchestrator" } },
        },
      },
      required: ["actor", "name", "objective"],
    });
    expect(Object.keys(orchestrator?.properties ?? {}).sort()).toEqual([
      "actor",
      "dependsOn",
      "name",
      "objective",
    ]);
    expect(worker).toMatchObject({
      additionalProperties: false,
      properties: {
        actor: {
          properties: {
            type: { const: "worker" },
          },
        },
        mode: {
          enum: ["research", "implementation", "verification"],
        },
        writeFiles: { type: "array" },
      },
      required: ["actor", "mode", "name", "objective"],
    });
  });

  test("accepts mixed actors without research read lists and normalizes authored order", () => {
    const parsed = definition();

    expect(parsed.objective).toBe(
      "Replace the parser without changing emitted records"
    );
    expect(parsed.steps[0]?.dependsOn).toEqual([]);
    expect(parsed.steps[0]?.jobs[0]?.dependsOn).toEqual([]);
    expect(parsed.steps[0]?.jobs[0]?.objective).toBe(
      "Record the owner and RED set"
    );
    expect(parsed.steps[0]?.jobs[1]).not.toHaveProperty("writeFiles");
    expect(parsed.steps[1]?.jobs[0]?.writeFiles).toEqual([
      "src/**/*.test.ts",
      "src/parser.ts",
    ]);
  });

  test("distinguishes omitted write scope from an explicitly empty scope", () => {
    const input = definition();
    const worker = input.steps[0]?.jobs[1];
    if (worker === undefined) {
      throw new Error("Expected worker fixture.");
    }

    const omitted = WorkflowDefinitionSchema.parse(input);
    const empty = WorkflowDefinitionSchema.parse({
      ...input,
      steps: input.steps.map((step, index) =>
        index === 0
          ? {
              ...step,
              jobs: step.jobs.map((job) =>
                job.name === worker.name ? { ...job, writeFiles: [] } : job
              ),
            }
          : step
      ),
    });

    expect(omitted.steps[0]?.jobs[1]).not.toHaveProperty("writeFiles");
    expect(empty.steps[0]?.jobs[1]?.writeFiles).toEqual([]);
  });

  test.each([
    "activation",
    "allowedFiles",
    "allowedTools",
    "completionGuard",
    "condition",
    "evidenceRequirements",
    "kind",
    "required",
  ])("rejects legacy job field %s", (field) => {
    const input = structuredClone(definition()) as unknown as {
      steps: { jobs: Record<string, unknown>[] }[];
    };
    const job = input.steps[0]?.jobs[0];
    if (job === undefined) {
      throw new Error("Expected job fixture.");
    }
    job[field] = field === "required" ? true : [];

    expect(() => WorkflowDefinitionSchema.parse(input)).toThrow();
  });

  test.each([
    "accountable",
    "completionGuard",
    "entryGuard",
    "kind",
    "onFailure",
    "onSuccess",
  ])("rejects legacy step field %s", (field) => {
    const input = structuredClone(definition()) as unknown as {
      steps: Record<string, unknown>[];
    };
    const step = input.steps[0];
    if (step === undefined) {
      throw new Error("Expected step fixture.");
    }
    step[field] = [];

    expect(() => WorkflowDefinitionSchema.parse(input)).toThrow();
  });

  test("requires worker mode and rejects worker-only fields on Sol jobs", () => {
    const input = structuredClone(definition());
    const worker = input.steps[0]?.jobs[1];
    const orchestrator = input.steps[0]?.jobs[0];
    if (worker === undefined || orchestrator === undefined) {
      throw new Error("Expected mixed actor fixtures.");
    }
    worker.mode = undefined;
    expect(() => WorkflowDefinitionSchema.parse(input)).toThrow(modePattern);

    worker.mode = "research";
    Object.assign(orchestrator, { mode: "verification" });
    expect(() => WorkflowDefinitionSchema.parse(input)).toThrow(modePattern);

    (orchestrator as { mode?: string }).mode = undefined;
    Object.assign(orchestrator, { writeFiles: [] });
    expect(() => WorkflowDefinitionSchema.parse(input)).toThrow(
      writeFilesPattern
    );
  });

  test.each([
    "/absolute/path.ts",
    "C:/absolute/path.ts",
    "../outside.ts",
    "src/../outside.ts",
    "src\\windows.ts",
    "",
    "   ",
  ])("rejects invalid write scope %j", (writeFile) => {
    const input = structuredClone(definition());
    const worker = input.steps[1]?.jobs[0];
    if (worker === undefined) {
      throw new Error("Expected worker fixture.");
    }
    worker.writeFiles = [writeFile];

    expect(() => WorkflowDefinitionSchema.parse(input)).toThrow();
  });

  test("rejects duplicate write scopes after normalization", () => {
    const input = structuredClone(definition());
    const worker = input.steps[1]?.jobs[0];
    if (worker === undefined) {
      throw new Error("Expected worker fixture.");
    }
    worker.writeFiles = ["src/parser.ts", "src/parser.ts"];

    expect(() => WorkflowDefinitionSchema.parse(input)).toThrow(
      duplicatePattern
    );
  });

  test("requires globally unique semantic job names", () => {
    const input = structuredClone(definition());
    const duplicate = input.steps[1]?.jobs[0];
    if (duplicate === undefined) {
      throw new Error("Expected job fixture.");
    }
    duplicate.name = "frame parser claim";

    expect(() => WorkflowDefinitionSchema.parse(input)).toThrow(uniquePattern);
  });

  test("rejects unknown, repeated, self, and cyclic step dependencies", () => {
    const unknown = structuredClone(definition());
    mutableStep(unknown, 1).dependsOn = ["missing"];
    expect(() => WorkflowDefinitionSchema.parse(unknown)).toThrow(stepPattern);

    const repeated = structuredClone(definition());
    mutableStep(repeated, 1).dependsOn = [
      "establish behavior",
      "establish behavior",
    ];
    expect(() => WorkflowDefinitionSchema.parse(repeated)).toThrow(
      duplicatePattern
    );

    const self = structuredClone(definition());
    mutableStep(self, 0).dependsOn = ["establish behavior"];
    expect(() => WorkflowDefinitionSchema.parse(self)).toThrow(selfPattern);

    const cyclic = structuredClone(definition());
    mutableStep(cyclic, 0).dependsOn = ["implement"];
    expect(() => WorkflowDefinitionSchema.parse(cyclic)).toThrow(cyclePattern);
  });

  test("rejects unknown, cross-step, repeated, self, and cyclic local job dependencies", () => {
    const unknown = structuredClone(definition());
    mutableJob(unknown, 0, 1).dependsOn = ["missing"];
    expect(() => WorkflowDefinitionSchema.parse(unknown)).toThrow(jobPattern);

    const crossStep = structuredClone(definition());
    mutableJob(crossStep, 1, 0).dependsOn = ["frame parser claim"];
    expect(() => WorkflowDefinitionSchema.parse(crossStep)).toThrow(
      sameStepPattern
    );

    const repeated = structuredClone(definition());
    mutableJob(repeated, 0, 1).dependsOn = [
      "frame parser claim",
      "frame parser claim",
    ];
    expect(() => WorkflowDefinitionSchema.parse(repeated)).toThrow(
      duplicatePattern
    );

    const self = structuredClone(definition());
    mutableJob(self, 0, 0).dependsOn = ["frame parser claim"];
    expect(() => WorkflowDefinitionSchema.parse(self)).toThrow(selfPattern);

    const cyclic = structuredClone(definition());
    mutableJob(cyclic, 0, 0).dependsOn = ["inspect parser boundary"];
    expect(() => WorkflowDefinitionSchema.parse(cyclic)).toThrow(cyclePattern);
  });
});

describe("workflow lifecycle schemas", () => {
  test("expose only the accepted job, step, and workflow states", () => {
    expect(JobStateSchema.options).toEqual([
      "pending",
      "ready",
      "active",
      "review",
      "blocked",
      "completed",
    ]);
    expect(StepStateSchema.options).toEqual([
      "pending",
      "active",
      "blocked",
      "completed",
    ]);
    expect(WorkflowStateSchema.options).toEqual([
      "active",
      "blocked",
      "completed",
    ]);
    expect(() => JobStateSchema.parse("failed")).toThrow();
    expect(() => JobStateSchema.parse("skipped")).toThrow();
    expect(() => JobStateSchema.parse("invalidated")).toThrow();
  });
});
