import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";

import {
  agentDefinitions,
  defaultAgents,
  goalToolNames,
  mergeAgentDefinition,
  workflowToolNames,
} from "./agent-defaults.js";

const DEVELOPMENT_METHOD_PATTERN = /pre-GREEN|planning gate|deep primitives/i;
const EXHAUSTIVE_TOOL_CATALOG_PATTERN =
  /The five workflow tools have distinct purposes|^- `agents_status\(/mu;
const TOOL_SCHEMA_OWNERSHIP_PATTERN =
  /Enabled tool schemas own each call's local purpose and arguments/u;
const SINGLE_MODE_SINGLE_OWNER_PATTERN =
  /one mode, one owner, and one observable deliverable/u;
const LOCAL_SOURCE_AUTHORITY_PATTERN =
  /provided repository, local, or version-matched source is authoritative over web substitution/u;
const STOP_AT_DELIVERABLE_PATTERN =
  /stop when the requested evidence or output and its verification are complete/iu;
const DRIFT_SUPERVISION_PATTERN =
  /many completed tools with no progress or result|reopening settled decisions/u;
const NON_DUPLICATE_VERIFICATION_PATTERN =
  /accept credible scoped worker verification as evidence.*do not rerun identical checks solely to confirm accepted work.*new integration risk, evidence conflicts, or the final repository gate/iu;
const SOL_SKILL_FIRST_PATTERN =
  /load applicable skills before substantive graph design.*shape the problem-specific method/iu;
const SKILL_DIRECTED_GRAPH_PATTERN =
  /for development work, load `development-loop` plus relevant domain skills.*determine what matters operationally.*stages, jobs, dependencies, actor choices, worker briefs, testing and implementation order, and acceptance evidence.*do not restate their methodology/iu;
const SOL_OWNERSHIP_PATTERN =
  /problem framing, architecture, decomposition, actor\/profile selection, dependency ordering, integration, verification judgment, and final decisions/iu;
const GRAPH_SEMANTICS_PATTERN =
  /meaningful evidence or decision gate.*smallest independently useful executable unit.*schema's substeps.*causal dependencies.*parallel independent work/iu;
const EPISODIC_WORKFLOW_PATTERN =
  /one goal may require multiple bounded workflows.*each workflow is one coherent execution episode/iu;
const SEMANTIC_GRAPH_PATTERN =
  /steps are ordered semantic stages or decision gates.*jobs are concrete substeps inside steps.*exactly one actor.*dependencies encode causal order.*independent jobs remain parallel/iu;
const SOL_WORK_SELECTION_PATTERN =
  /Use Sol for synthesis, architecture decisions, integration, acceptance, owner-level verification, and deciding the next workflow.*Use workers for bounded research, implementation, command execution, and independent verification/iu;
const BINDING_SOL_JOB_PATTERN =
  /Sol job objective is a binding executable obligation.*exact inputs.*decision or output.*stopping condition.*not a vague reminder/iu;
const TOPOLOGY_DISCOVERY_PATTERN =
  /discovery can change downstream topology.*end the workflow with Sol synthesis.*author the next workflow from that evidence rather than speculating it/iu;
const DELEGATION_DEFAULT_PATTERN =
  /Sol-owned jobs are reserved for framing, synthesis, architecture, integration, and judgment.*delegate bounded research, implementation, command execution, and independent verification by default when that protects Sol's context/iu;
const NO_DUPLICATE_DELEGATION_PATTERN =
  /never duplicate a delegated job.*direct execution remains valid when the user requests it or delegation overhead exceeds its value/iu;
const WORKER_EXECUTION_ARM_PATTERN =
  /execution arm with one decided mode, owner, and deliverable.*never chooses architecture, scope, workflow, or product policy/iu;
const MODE_STOP_PATTERN =
  /research returns evidence rather than plans.*implementation follows a decided design.*verification reports failures rather than fixing them/iu;
const EVIDENCE_BOUNDARY_PATTERN =
  /unrestricted read capability is not authority to expand the evidence surface.*honor explicit evidence and file boundaries/iu;
const MISSING_DECISION_BLOCKER_PATTERN =
  /architecture, scope, ownership, or product policy.*not already decided.*report a blocker and stop/iu;
const HARNESS_CONTRACT_PATTERN =
  /Sol Orchestrator Harness Contract v1.*required.*last-authoritative/iu;

test("loads every worker profile from one shared prompt source", async () => {
  const sharedURL = new URL("../agents/worker.md", import.meta.url);
  const shared = await readFile(sharedURL, "utf8");
  const agents = await defaultAgents();

  for (const name of ["luna-medium", "terra-medium", "terra-max"] as const) {
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

test("Sol permissions are generated from only the five clean-break workflow tools", () => {
  expect(workflowToolNames).toEqual([
    "workflow_start",
    "workflow_status",
    "workflow_complete",
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
  expect(sol).toContain("call `workflow_status({})` first");
  expect(sol).toContain("Protect your context");
  expect(sol).toContain("least expensive profile");
  expect(sol).toContain("creates, scopes, binds, and prompts that worker");
  expect(sol).toContain("include a revised objective");
  expect(sol).toMatch(HARNESS_CONTRACT_PATTERN);
  expect(worker).toMatch(HARNESS_CONTRACT_PATTERN);
  expect(sol).toMatch(TOOL_SCHEMA_OWNERSHIP_PATTERN);
  expect(sol).not.toMatch(EXHAUSTIVE_TOOL_CATALOG_PATTERN);
  expect(sol).not.toContain("required_next_action");
  expect(sol).not.toContain("task_id");
  expect(sol).not.toContain("next_actions");
  expect(sol).not.toContain("workflow_delegate");
  expect(sol).not.toMatch(DEVELOPMENT_METHOD_PATTERN);
  expect(worker).not.toMatch(DEVELOPMENT_METHOD_PATTERN);
  expect(worker).toContain(
    "Do not self-block solely because a job-relevant structured write is outside the scope"
  );
  expect(worker).toContain("call the structured tool and wait for Sol");
});

test("converges worker jobs on one bounded, locally authoritative deliverable", async () => {
  const agents = await defaultAgents();
  const sol = agents.sol?.prompt;
  const worker = agents["luna-medium"]?.prompt;
  if (sol === undefined || worker === undefined) {
    throw new Error("Expected generated Sol and luna-medium prompts.");
  }

  expect(sol).toMatch(SINGLE_MODE_SINGLE_OWNER_PATTERN);
  expect(sol).toMatch(LOCAL_SOURCE_AUTHORITY_PATTERN);
  expect(worker).toMatch(LOCAL_SOURCE_AUTHORITY_PATTERN);
  expect(worker).toMatch(STOP_AT_DELIVERABLE_PATTERN);
  expect(sol).toMatch(DRIFT_SUPERVISION_PATTERN);
  expect(sol).toContain("check `agents_status`");
  expect(sol).toContain("steer once to the exact remaining deliverable");
  expect(sol).toContain("interrupt or replace it if unchanged");
});

test("assigns control-plane judgment to Sol and bounded execution to workers", async () => {
  const agents = await defaultAgents();
  const sol = agents.sol?.prompt;
  const worker = agents["luna-medium"]?.prompt;
  if (sol === undefined || worker === undefined) {
    throw new Error("Expected generated Sol and luna-medium prompts.");
  }

  expect(sol).toMatch(SOL_SKILL_FIRST_PATTERN);
  expect(sol).toMatch(SKILL_DIRECTED_GRAPH_PATTERN);
  expect(sol).toMatch(SOL_OWNERSHIP_PATTERN);
  expect(sol).toMatch(GRAPH_SEMANTICS_PATTERN);
  expect(sol).toMatch(EPISODIC_WORKFLOW_PATTERN);
  expect(sol).toMatch(SEMANTIC_GRAPH_PATTERN);
  expect(sol).toMatch(SOL_WORK_SELECTION_PATTERN);
  expect(sol).toMatch(BINDING_SOL_JOB_PATTERN);
  expect(sol).toMatch(TOPOLOGY_DISCOVERY_PATTERN);
  expect(sol).toMatch(DELEGATION_DEFAULT_PATTERN);
  expect(sol).toMatch(NO_DUPLICATE_DELEGATION_PATTERN);
  expect(sol).toMatch(NON_DUPLICATE_VERIFICATION_PATTERN);
  expect(worker).toMatch(WORKER_EXECUTION_ARM_PATTERN);
  expect(worker).toMatch(MODE_STOP_PATTERN);
  expect(worker).toMatch(EVIDENCE_BOUNDARY_PATTERN);
  expect(worker).toMatch(MISSING_DECISION_BLOCKER_PATTERN);
  expect(worker).not.toContain(
    "unless Sol later gives an explicit implementation brief"
  );
});

describe("managed worker permission bootstrap", () => {
  test.each([
    "luna-medium",
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
    for (const name of ["luna-medium", "terra-medium", "terra-max"] as const) {
      expect(agentDefinitions[name].permission).not.toHaveProperty("read");
      expect(agentDefinitions[name].permission).not.toHaveProperty("glob");
      expect(agentDefinitions[name].permission).not.toHaveProperty("grep");
    }
  });

  test("preserves user model, variant, and ordinary capability permissions", () => {
    const merged = mergeAgentDefinition(agentDefinitions["luna-medium"], {
      model: "openai/gpt-5.6-terra",
      variant: "high",
      permission: {
        edit: "allow",
        skill: "allow",
        webfetch: "allow",
      },
    });

    expect(merged).toMatchObject({
      model: "openai/gpt-5.6-terra",
      variant: "high",
      permission: {
        edit: "ask",
        skill: "allow",
        webfetch: "allow",
      },
    });
  });

  test("keeps a user worldview before the required, last-authoritative worker harness", async () => {
    const agents = await defaultAgents();
    const harness = agents["luna-medium"];
    if (harness === undefined) {
      throw new Error("Expected generated luna-medium harness.");
    }

    const userPrompt = "You are a patient reviewer who favors small changes.";
    const merged = mergeAgentDefinition(harness, {
      description: "My customized worker",
      model: "openai/gpt-5.6-terra",
      variant: "high",
      prompt: userPrompt,
      permission: {
        "agents_*": "allow",
        edit: "allow",
        skill: "allow",
        webfetch: "allow",
        workflow_start: "allow",
      },
    });

    expect(merged).toMatchObject({
      description: "My customized worker",
      model: "openai/gpt-5.6-terra",
      mode: "subagent",
      steps: 48,
      variant: "high",
      permission: {
        "agents_*": "deny",
        edit: "ask",
        skill: "allow",
        webfetch: "allow",
        workflow_start: "deny",
      },
    });
    expect(merged).toHaveProperty("prompt");
    const prompt = (merged as { prompt: string }).prompt;
    expect(prompt).toContain(userPrompt);
    expect(prompt).toContain(harness.prompt);
    expect(prompt.indexOf(userPrompt)).toBeLessThan(
      prompt.indexOf(harness.prompt)
    );
    expect(prompt).toMatch(HARNESS_CONTRACT_PATTERN);
  });

  test("keeps Sol's harness permissions authoritative while allowing ordinary capabilities", async () => {
    const agents = await defaultAgents();
    const sol = agents.sol;
    if (sol === undefined) {
      throw new Error("Expected generated Sol harness.");
    }

    const merged = mergeAgentDefinition(sol, {
      permission: {
        "agents_*": "deny",
        goal_complete: "deny",
        task: "allow",
        webfetch: "allow",
        workflow_start: "deny",
      },
    });

    expect(merged).toMatchObject({
      permission: {
        "agents_*": "allow",
        goal_complete: "allow",
        task: "deny",
        webfetch: "allow",
        workflow_start: "allow",
      },
    });
  });
});
