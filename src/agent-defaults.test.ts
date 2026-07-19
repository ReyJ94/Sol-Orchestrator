import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";

import {
  agentDefinitions,
  defaultAgents,
  goalToolNames,
  mergeAgentDefinition,
  workflowToolNames,
} from "./agent-defaults.js";

const APPLICABLE_SKILLS_PATTERN = /applicable .*skills/i;
const BOUNDED_WAIT_PATTERN = /bounded `agents_wait`/u;
const DEVELOPMENT_METHOD_PATTERN = /pre-GREEN|planning gate|deep primitives/i;

test("loads every worker profile from one shared prompt source", async () => {
  const sharedURL = new URL("../agents/worker.md", import.meta.url);
  const shared = await readFile(sharedURL, "utf8");
  const agents = await defaultAgents();

  for (const name of [
    "luna-medium",
    "luna-max",
    "terra-medium",
    "terra-max",
  ] as const) {
    expect(agents[name]?.prompt).toBe(shared);
    await expect(
      stat(new URL(`../agents/${name}.md`, import.meta.url))
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("leaves model and effort ownership to OpenCode profiles", () => {
  for (const definition of Object.values(agentDefinitions)) {
    expect(definition).not.toHaveProperty("model");
    expect(definition).not.toHaveProperty("variant");
  }

  expect(
    mergeAgentDefinition(agentDefinitions["luna-medium"], {
      model: "opencode/north-mini-code-free",
      variant: "high",
    })
  ).toMatchObject({
    model: "opencode/north-mini-code-free",
    variant: "high",
  });
});

test("Sol permissions are generated from only the six clean-break workflow tools", () => {
  expect(workflowToolNames).toEqual([
    "workflow_start",
    "workflow_status",
    "workflow_complete",
    "workflow_delegate",
    "workflow_replace",
    "workflow_retry",
  ]);
  for (const toolName of workflowToolNames) {
    expect(agentDefinitions.sol.permission[toolName]).toBe("allow");
  }
  expect(agentDefinitions.sol.permission.task).toBe("deny");
});

test("goal lifecycle permissions exclude user-only stop", () => {
  expect(goalToolNames).toEqual([
    "goal_start",
    "goal_complete",
    "goal_block",
    "goal_resume",
  ]);
  for (const toolName of goalToolNames) {
    expect(agentDefinitions.sol.permission[toolName]).toBe("allow");
  }
  expect(agentDefinitions.sol.permission).not.toHaveProperty("goal_stop");
});

test("keeps harness mechanics in prompts and development methodology in applicable skills", async () => {
  const agents = await defaultAgents();
  const sol = agents.sol?.prompt;
  const worker = agents["luna-medium"]?.prompt;
  if (sol === undefined || worker === undefined) {
    throw new Error("Expected generated Sol and luna-medium prompts.");
  }

  expect(sol).toContain("available_actions");
  expect(sol).toContain("/goal-stop");
  expect(sol).toMatch(BOUNDED_WAIT_PATTERN);
  expect(sol).toMatch(APPLICABLE_SKILLS_PATTERN);
  expect(sol).toContain("gather only enough read-only orientation context");
  expect(sol).toContain("think again");
  expect(sol).toContain("least expensive safe workers");
  expect(sol).toContain("`workflow_status.available_workers` is authoritative");
  expect(sol).toContain("configured OpenCode agent profile");
  expect(sol).toContain("Minimize expensive-model execution");
  expect(sol).toContain("Protect your context");
  expect(sol).toContain("returns only private artifact file metadata");
  expect(sol).toContain(
    "ordinary terminal tools such as `rg`, globbing, and `jq`"
  );
  expect(sol).toContain("never injects the artifact body into your context");
  expect(sol).toContain("atomically creates, scopes, binds, and starts");
  expect(sol).toContain("binds consequential execution");
  expect(sol).toContain("must help rather than imprison you");
  expect(sol).toContain("agents_status({ job? })");
  expect(sol).not.toContain("required_next_action");
  expect(sol).not.toContain("task_id");
  expect(sol).not.toContain("next_actions");
  expect(sol).not.toMatch(DEVELOPMENT_METHOD_PATTERN);
  expect(worker).not.toMatch(DEVELOPMENT_METHOD_PATTERN);
  expect(worker).toContain(
    "Do not self-block solely because a job-relevant structured write is outside the scope"
  );
  expect(worker).toContain("call the structured tool and wait for Sol");
});

describe("managed worker permission bootstrap", () => {
  test.each([
    "luna-medium",
    "luna-max",
    "terra-medium",
    "terra-max",
  ])("keeps %s edit permission at ask when user config tries to weaken it", (name) => {
    const definition = agentDefinitions[name as keyof typeof agentDefinitions];
    const merged = mergeAgentDefinition(definition, {
      permission: {
        edit: "allow",
        read: "allow",
        webfetch: "allow",
      },
    });

    expect(merged).toMatchObject({
      permission: {
        edit: "ask",
        read: "allow",
        webfetch: "allow",
      },
    });
  });

  test("does not add a read restriction to managed workers", () => {
    for (const name of [
      "luna-medium",
      "luna-max",
      "terra-medium",
      "terra-max",
    ] as const) {
      expect(agentDefinitions[name].permission).not.toHaveProperty("read");
      expect(agentDefinitions[name].permission).not.toHaveProperty("glob");
      expect(agentDefinitions[name].permission).not.toHaveProperty("grep");
    }
  });
});
