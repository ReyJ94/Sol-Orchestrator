import { readFile } from "node:fs/promises";
import type { WorkerProfileDescriptor } from "./schema/common.js";

type PermissionAction = "allow" | "ask" | "deny";
type AgentDefinition = {
  readonly description: string;
  readonly mode: "primary" | "subagent";
  readonly permission: Record<string, unknown>;
  readonly steps?: number;
};
type AgentWithPrompt = AgentDefinition & { readonly prompt: string };

export const workflowToolNames = [
  "workflow_start",
  "workflow_status",
  "workflow_complete",
  "workflow_delegate",
  "workflow_replace",
  "workflow_retry",
] as const;

export const goalToolNames = [
  "goal_start",
  "goal_complete",
  "goal_block",
  "goal_resume",
] as const;

const workflowPermissions = (
  action: PermissionAction
): Record<(typeof workflowToolNames)[number], PermissionAction> =>
  Object.fromEntries(workflowToolNames.map((name) => [name, action])) as Record<
    (typeof workflowToolNames)[number],
    PermissionAction
  >;

const goalPermissions = (
  action: PermissionAction
): Record<(typeof goalToolNames)[number], PermissionAction> =>
  Object.fromEntries(goalToolNames.map((name) => [name, action])) as Record<
    (typeof goalToolNames)[number],
    PermissionAction
  >;

const worker = (description: string): AgentDefinition => ({
  description,
  mode: "subagent",
  permission: {
    "agents_*": "deny",
    doom_loop: "deny",
    edit: "ask",
    report_to_parent: "allow",
    task: "deny",
    todowrite: "deny",
    ...workflowPermissions("deny"),
    ...goalPermissions("deny"),
  },
  steps: 48,
});

export const agentDefinitions = Object.freeze({
  "luna-max": worker(
    "Narrow leaf work requiring careful multi-step investigation, adversarial checking, or precise verification"
  ),
  "luna-medium": worker(
    "Clear low-risk leaf work on one surface with an obvious method and easily checked result"
  ),
  sol: {
    description:
      "Sole task owner that defaults bounded execution to managed workers and owns final verification",
    mode: "primary",
    permission: {
      "agents_*": "allow",
      report_to_parent: "deny",
      task: "deny",
      ...workflowPermissions("allow"),
      ...goalPermissions("allow"),
    },
  },
  "terra-max": worker(
    "Difficult bounded leaf work resolving genuine ambiguity or regression risk inside Sol's decided local design"
  ),
  "terra-medium": worker(
    "Leaf work needing stronger interpretation or cross-file execution within one known subsystem"
  ),
} satisfies Record<string, AgentDefinition>);

const bundledWorkerProfileNames = [
  "luna-medium",
  "luna-max",
  "terra-medium",
  "terra-max",
] as const;

export const bundledWorkerProfiles = Object.freeze(
  bundledWorkerProfileNames.map(
    (profile): WorkerProfileDescriptor => ({
      description: agentDefinitions[profile].description,
      profile,
    })
  )
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const mergeAgentDefinition = (
  defaultAgent: AgentDefinition,
  userAgent: unknown
): unknown => {
  if (userAgent === undefined) {
    return defaultAgent;
  }
  if (!isRecord(userAgent)) {
    return userAgent;
  }
  const merged: Record<string, unknown> = { ...defaultAgent, ...userAgent };
  if (isRecord(defaultAgent.permission) && isRecord(userAgent.permission)) {
    merged.permission = {
      ...defaultAgent.permission,
      ...userAgent.permission,
      ...(isRecord(defaultAgent.permission.task) &&
      isRecord(userAgent.permission.task)
        ? {
            task: {
              ...defaultAgent.permission.task,
              ...userAgent.permission.task,
            },
          }
        : {}),
      ...(defaultAgent.mode === "subagent" &&
      defaultAgent.permission.edit === "ask"
        ? { edit: "ask" }
        : {}),
    };
  }
  return merged;
};

export const defaultAgents = async (): Promise<
  Record<string, AgentWithPrompt>
> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(agentDefinitions).map(async ([name, definition]) => [
        name,
        {
          ...definition,
          prompt: await readFile(
            new URL(
              name === "sol" ? "../agents/sol.md" : "../agents/worker.md",
              import.meta.url
            ),
            "utf8"
          ),
        },
      ])
    )
  );
