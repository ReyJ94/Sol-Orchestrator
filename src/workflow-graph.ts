import {
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowJob,
  type WorkflowStep,
} from "./schema/workflow.js";

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(stableValue(value));

export const workflowStep = (
  definition: WorkflowDefinition,
  name: string
): WorkflowStep => {
  const step = definition.steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Unknown workflow step ${name}.`);
  }
  return step;
};

export const workflowJob = (
  definition: WorkflowDefinition,
  name: string
): { job: WorkflowJob; step: WorkflowStep } => {
  for (const step of definition.steps) {
    const job = step.jobs.find((candidate) => candidate.name === name);
    if (job !== undefined) {
      return { job, step };
    }
  }
  throw new Error(`Unknown workflow job ${name}.`);
};

const stepReaches = (
  definition: WorkflowDefinition,
  from: string,
  to: string,
  visited: Set<string> = new Set()
): boolean => {
  if (from === to) {
    return true;
  }
  if (visited.has(from)) {
    return false;
  }
  visited.add(from);
  return workflowStep(definition, from).dependsOn.some(
    (dependency) =>
      dependency === to || stepReaches(definition, dependency, to, visited)
  );
};

const jobReaches = (
  step: WorkflowStep,
  from: string,
  to: string,
  visited: Set<string> = new Set()
): boolean => {
  if (from === to) {
    return true;
  }
  if (visited.has(from)) {
    return false;
  }
  visited.add(from);
  const job = step.jobs.find((candidate) => candidate.name === from);
  return (
    job?.dependsOn.some(
      (dependency) =>
        dependency === to || jobReaches(step, dependency, to, visited)
    ) ?? false
  );
};

const jobsAreOrdered = (
  definition: WorkflowDefinition,
  left: { job: WorkflowJob; step: WorkflowStep },
  right: { job: WorkflowJob; step: WorkflowStep }
): boolean => {
  if (left.step.name === right.step.name) {
    return (
      jobReaches(left.step, left.job.name, right.job.name) ||
      jobReaches(left.step, right.job.name, left.job.name)
    );
  }
  return (
    stepReaches(definition, left.step.name, right.step.name) ||
    stepReaches(definition, right.step.name, left.step.name)
  );
};

const firstGlobIndex = (value: string): number => {
  const indexes = ["*", "?", "[", "{"]
    .map((token) => value.indexOf(token))
    .filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
};

const scope = (pattern: string): { exact: boolean; prefix: string } => {
  const index = firstGlobIndex(pattern);
  return index < 0
    ? { exact: true, prefix: pattern }
    : { exact: false, prefix: pattern.slice(0, index) };
};

const scopesMayOverlap = (
  leftFiles: readonly string[],
  rightFiles: readonly string[]
): boolean => {
  if (leftFiles.length === 0 || rightFiles.length === 0) {
    return false;
  }
  return leftFiles.some((leftFile) =>
    rightFiles.some((rightFile) => {
      const left = scope(leftFile);
      const right = scope(rightFile);
      if (left.exact && right.exact) {
        return left.prefix === right.prefix;
      }
      if (left.prefix.length === 0 || right.prefix.length === 0) {
        return true;
      }
      return (
        left.prefix.startsWith(right.prefix) ||
        right.prefix.startsWith(left.prefix)
      );
    })
  );
};

export const assertConflictSafeDefinition = (
  definition: WorkflowDefinition
): void => {
  const scopedWorkers = definition.steps.flatMap((step) =>
    step.jobs
      .filter(
        (job) => job.actor.type === "worker" && job.writeFiles !== undefined
      )
      .map((job) => ({ job, step }))
  );

  for (const [index, left] of scopedWorkers.entries()) {
    for (const right of scopedWorkers.slice(index + 1)) {
      if (
        scopesMayOverlap(
          left.job.writeFiles ?? [],
          right.job.writeFiles ?? []
        ) &&
        !jobsAreOrdered(definition, left, right)
      ) {
        throw new Error(
          `Scoped worker jobs ${left.job.name} and ${right.job.name} may overlap. Add dependency ordering or author disjoint writeFiles.`
        );
      }
    }
  }
};

export const normalizeWorkflowDefinition = (
  input: unknown
): WorkflowDefinition => {
  const definition = WorkflowDefinitionSchema.parse(input);
  assertConflictSafeDefinition(definition);
  return definition;
};

export const semanticJobSignatures = (
  definition: WorkflowDefinition
): ReadonlyMap<string, string> => {
  const signatures = new Map<string, string>();
  for (const step of definition.steps) {
    for (const job of step.jobs) {
      signatures.set(
        job.name,
        stableJson({
          actor: job.actor,
          dependsOn: [...job.dependsOn].sort(),
          mode: job.mode,
          name: job.name,
          objective: job.objective,
          step: {
            dependsOn: [...step.dependsOn].sort(),
            name: step.name,
            objective: step.objective,
          },
          writeFiles:
            job.writeFiles === undefined
              ? undefined
              : [...job.writeFiles].sort(),
        })
      );
    }
  }
  return signatures;
};

const prerequisiteSteps = (
  definition: WorkflowDefinition,
  stepName: string,
  result: Set<string>
): void => {
  for (const dependency of workflowStep(definition, stepName).dependsOn) {
    if (!result.has(dependency)) {
      result.add(dependency);
      prerequisiteSteps(definition, dependency, result);
    }
  }
};

const prerequisiteLocalJobs = (
  step: WorkflowStep,
  jobName: string,
  result: Set<string>
): void => {
  const job = step.jobs.find((candidate) => candidate.name === jobName);
  if (job === undefined) {
    throw new Error(`Unknown local job ${jobName} in step ${step.name}.`);
  }
  for (const dependency of job.dependsOn) {
    if (!result.has(dependency)) {
      result.add(dependency);
      prerequisiteLocalJobs(step, dependency, result);
    }
  }
};

export const prerequisiteJobNames = (
  definition: WorkflowDefinition,
  jobName: string
): ReadonlySet<string> => {
  const { job, step } = workflowJob(definition, jobName);
  const result = new Set<string>();
  prerequisiteLocalJobs(step, job.name, result);

  const steps = new Set<string>();
  prerequisiteSteps(definition, step.name, steps);
  for (const dependencyStep of steps) {
    for (const dependencyJob of workflowStep(definition, dependencyStep).jobs) {
      result.add(dependencyJob.name);
    }
  }
  return result;
};

export const topologicalJobNames = (
  definition: WorkflowDefinition
): readonly string[] => {
  const remaining = new Set(
    definition.steps.flatMap((step) => step.jobs.map((job) => job.name))
  );
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) =>
        [...prerequisiteJobNames(definition, name)].every(
          (dependency) => !remaining.has(dependency)
        )
      )
      .sort((left, right) => left.localeCompare(right));
    if (ready.length === 0) {
      throw new Error("Workflow job topology is cyclic.");
    }
    for (const name of ready) {
      remaining.delete(name);
      ordered.push(name);
    }
  }
  return ordered;
};
