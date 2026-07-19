import { z } from "zod";

import { WorkerProfileSchema } from "./common.js";

const MAX_NAME_LENGTH = 512;
const MAX_OBJECTIVE_LENGTH = 4000;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:\//u;

const SemanticNameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const ObjectiveSchema = z.string().trim().min(1).max(MAX_OBJECTIVE_LENGTH);

const uniqueSortedStrings = (label: string) =>
  z
    .array(SemanticNameSchema)
    .default([])
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ${label} ${value}.`,
            path: [index],
          });
        }
        seen.add(value);
      }
    })
    .transform((values) =>
      [...values].sort((left, right) => left.localeCompare(right))
    );

const WriteFileSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !value.startsWith("/"), {
    message: "writeFiles entries must be repository-relative.",
  })
  .refine((value) => !WINDOWS_ABSOLUTE_PATH_PATTERN.test(value), {
    message: "writeFiles entries must not use absolute drive paths.",
  })
  .refine((value) => !value.includes("\\"), {
    message: "writeFiles entries must use POSIX separators.",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: "writeFiles entries must not traverse with '..'.",
  });

const WriteFilesSchema = z
  .array(WriteFileSchema)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate writeFiles entry ${value}.`,
          path: [index],
        });
      }
      seen.add(value);
    }
  })
  .transform((values) =>
    [...values].sort((left, right) => left.localeCompare(right))
  );

export const WorkerModeSchema = z.enum([
  "research",
  "implementation",
  "verification",
]);

const OrchestratorActorSchema = z
  .object({ type: z.literal("orchestrator") })
  .strict();
const WorkerActorSchema = z
  .object({ profile: WorkerProfileSchema, type: z.literal("worker") })
  .strict();

export const JobActorSchema = z.discriminatedUnion("type", [
  OrchestratorActorSchema,
  WorkerActorSchema,
]);

export type JobActor = z.infer<typeof JobActorSchema>;
export type WorkerMode = z.infer<typeof WorkerModeSchema>;
export type WorkflowJob = {
  actor: JobActor;
  dependsOn: string[];
  mode?: WorkerMode;
  name: string;
  objective: string;
  writeFiles?: string[];
};

const WorkflowJobCommonShape = {
  dependsOn: uniqueSortedStrings("job dependency"),
  name: SemanticNameSchema,
  objective: ObjectiveSchema,
};

export const WorkflowJobSchema = z
  .union([
    z
      .object({
        actor: OrchestratorActorSchema,
        ...WorkflowJobCommonShape,
      })
      .strict(),
    z
      .object({
        actor: WorkerActorSchema,
        mode: WorkerModeSchema,
        ...WorkflowJobCommonShape,
        writeFiles: WriteFilesSchema.optional(),
      })
      .strict(),
  ])
  .transform((job): WorkflowJob => job);

export const WorkflowStepSchema = z
  .object({
    dependsOn: uniqueSortedStrings("step dependency"),
    jobs: z.array(WorkflowJobSchema).min(1),
    name: SemanticNameSchema,
    objective: ObjectiveSchema,
  })
  .strict();

const findCycle = (
  names: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>
): string[] | undefined => {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const route: string[] = [];

  const visit = (name: string): string[] | undefined => {
    if (visiting.has(name)) {
      const start = route.indexOf(name);
      return [...route.slice(start), name];
    }
    if (visited.has(name)) {
      return;
    }
    visiting.add(name);
    route.push(name);
    for (const dependency of dependencies.get(name) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    route.pop();
    visiting.delete(name);
    visited.add(name);
    return;
  };

  for (const name of names) {
    const cycle = visit(name);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return;
};

const WorkflowDefinitionBaseSchema = z
  .object({
    objective: ObjectiveSchema,
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict();

type DefinitionCandidate = z.infer<typeof WorkflowDefinitionBaseSchema>;
type IssueContext = {
  addIssue(issue: {
    code: "custom";
    message: string;
    path: (number | string)[];
  }): void;
};

const indexDefinition = (
  definition: DefinitionCandidate,
  context: IssueContext
) => {
  const steps = new Map<string, DefinitionCandidate["steps"][number]>();
  const jobs = new Map<string, string>();
  for (const [stepIndex, step] of definition.steps.entries()) {
    if (steps.has(step.name)) {
      context.addIssue({
        code: "custom",
        message: `Step names must be unique; duplicate ${step.name}.`,
        path: ["steps", stepIndex, "name"],
      });
    }
    steps.set(step.name, step);
    for (const [jobIndex, job] of step.jobs.entries()) {
      if (jobs.has(job.name)) {
        context.addIssue({
          code: "custom",
          message: `Job names must be globally unique; duplicate ${job.name}.`,
          path: ["steps", stepIndex, "jobs", jobIndex, "name"],
        });
      }
      jobs.set(job.name, step.name);
    }
  }
  return { jobs, steps };
};

const validateStepReferences = (
  definition: DefinitionCandidate,
  stepNames: ReadonlyMap<string, DefinitionCandidate["steps"][number]>,
  context: IssueContext
): void => {
  for (const [stepIndex, step] of definition.steps.entries()) {
    for (const [dependencyIndex, dependency] of step.dependsOn.entries()) {
      const path = ["steps", stepIndex, "dependsOn", dependencyIndex];
      if (dependency === step.name) {
        context.addIssue({
          code: "custom",
          message: `Step ${step.name} cannot depend on itself.`,
          path,
        });
      } else if (!stepNames.has(dependency)) {
        context.addIssue({
          code: "custom",
          message: `Unknown step dependency ${dependency}.`,
          path,
        });
      }
    }
  }
};

const validateJobReferences = (
  definition: DefinitionCandidate,
  jobNames: ReadonlyMap<string, string>,
  context: IssueContext
): void => {
  for (const [stepIndex, step] of definition.steps.entries()) {
    const localJobs = new Set(step.jobs.map((job) => job.name));
    for (const [jobIndex, job] of step.jobs.entries()) {
      for (const [dependencyIndex, dependency] of job.dependsOn.entries()) {
        const path = [
          "steps",
          stepIndex,
          "jobs",
          jobIndex,
          "dependsOn",
          dependencyIndex,
        ];
        if (dependency === job.name) {
          context.addIssue({
            code: "custom",
            message: `Job ${job.name} cannot depend on itself.`,
            path,
          });
        } else if (!localJobs.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: jobNames.has(dependency)
              ? `Job dependency ${dependency} must be in the same step.`
              : `Unknown job dependency ${dependency}.`,
            path,
          });
        }
      }
    }
  }
};

const validateCycles = (
  definition: DefinitionCandidate,
  context: IssueContext
): void => {
  const stepCycle = findCycle(
    definition.steps.map((step) => step.name),
    new Map(definition.steps.map((step) => [step.name, step.dependsOn]))
  );
  if (stepCycle !== undefined) {
    context.addIssue({
      code: "custom",
      message: `Step dependency cycle: ${stepCycle.join(" -> ")}.`,
      path: ["steps"],
    });
  }
  for (const [stepIndex, step] of definition.steps.entries()) {
    const jobCycle = findCycle(
      step.jobs.map((job) => job.name),
      new Map(step.jobs.map((job) => [job.name, job.dependsOn]))
    );
    if (jobCycle !== undefined) {
      context.addIssue({
        code: "custom",
        message: `Job dependency cycle in step ${step.name}: ${jobCycle.join(
          " -> "
        )}.`,
        path: ["steps", stepIndex, "jobs"],
      });
    }
  }
};

export const WorkflowDefinitionSchema =
  WorkflowDefinitionBaseSchema.superRefine((definition, context) => {
    const names = indexDefinition(definition, context);
    validateStepReferences(definition, names.steps, context);
    validateJobReferences(definition, names.jobs, context);
    validateCycles(definition, context);
  });

export const JobStateSchema = z.enum([
  "pending",
  "ready",
  "active",
  "review",
  "blocked",
  "completed",
]);

export const StepStateSchema = z.enum([
  "pending",
  "active",
  "blocked",
  "completed",
]);

export const WorkflowStateSchema = z.enum(["active", "blocked", "completed"]);

export type JobState = z.infer<typeof JobStateSchema>;
export type StepState = z.infer<typeof StepStateSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowStateValue = z.infer<typeof WorkflowStateSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
