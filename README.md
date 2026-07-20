<p align="center">
  <img src="assets/sol-orchestrator-banner.png" alt="Sol Orchestrator — managed multi-agent orchestration for OpenCode" width="100%" />
</p>

# Sol Orchestrator

**A graph-native multi-agent harness for OpenCode.**

Sol Orchestrator gives one capable agent durable ownership of the user's actual
goal. Sol designs the work, executes jobs itself or delegates selected jobs to
other profiles, reviews the evidence, adapts when reality changes, and stays
responsible until the whole outcome is complete.

The strongest model keeps architecture, judgment, and the important context.
Bounded investigation, implementation, and verification can be routed to less
expensive profiles without filling Sol's conversation with their full
transcripts.

## Highlights

- **One goal, many workflows.** Sol remains responsible across distinct phases
  of the work and across revisions of the plan.
- **A real execution graph.** Steps and jobs describe dependencies, ownership,
  parallel work, review, and what can happen next.
- **Optional, focused delegation.** A workflow may be entirely Sol-owned or
  assign selected bounded jobs to workers. Sol retains planning, integration,
  tradeoffs, and final judgment.
- **Active supervision.** Sol can inspect emerging work, steer a worker early,
  review completed evidence, or deliberately wait for a meaningful event.
- **Protected context.** Worker details stay out of Sol's conversation until
  Sol chooses the specific result, diff, or tool output it needs.
- **Profiles, not hardcoded models.** Use the included profile shapes or your
  own OpenCode subagents. You control their models and reasoning settings.
- **Guidance without a cage.** The current workflow is binding, but Sol can
  replace unfinished work when new evidence proves the plan wrong.
- **A human-readable TUI.** See the durable goal, workflow graph, worker state,
  review state, blockers, progress, and actions available now.

## From one goal to many workflow graphs

Real repository work rarely fits one flat checklist. Sol Orchestrator gives it
a durable shape:

```text
Goal: ship the complete feature
│
├── Workflow 1: understand the real boundary
│   ├── Graph v1
│   │   ├── Step: frame the problem
│   │   │   └── Job: Sol defines the questions
│   │   └── Step: gather evidence
│   │       ├── Job: worker inspects the runtime
│   │       └── Job: worker maps affected callers
│   └── Graph v2              replaces unfinished v1 after new evidence
│       └── ...
│
├── Workflow 2: implement the chosen design
│   └── ...
│
└── Workflow 3: verify, integrate, and close the goal
    └── ...
```

A **goal** is the outcome the user cares about. It may require several bounded
workflows, each one coherent execution episode. Each workflow has a versioned
graph: **steps** are ordered semantic stages or decision gates, and **jobs** are
concrete substeps within a step. Every job has exactly one actor—Sol or one
worker profile. Dependencies express causal order; genuinely independent jobs
stay parallel.

Skills can shape the agents' working worldview rather than leaving every graph
to a generic phase template. They can define what evidence matters, where
decisions belong, how implementation should be ordered, and what counts as
acceptance. Sol translates that discipline into stages, jobs, dependencies, and
actor choices without copying the skill's full methodology into the harness.

The included Sol prompt names `development-loop` as the author's example and
combines it with relevant domain skills before decomposing development work.
That skill is not bundled with this plugin. Remove the reference or point it to
your own comparable skill to personalize the orchestration discipline.

Jobs inside a step can form their own semantic DAG:

```text
inspect runtime ─┐
                 ├──> Sol reassesses ──> implement ──> verify
map callers ─────┘
```

For example, a small discovery graph can keep evidence gathering parallel while
making the decision gate explicit:

```text
Step: discover boundary
  worker: inspect runtime ─┐
                           ├──> Sol: synthesize evidence
  worker: map callers ─────┘          │
                                      └──> next workflow: implement decided design
```

Workers perform bounded research, implementation, command execution, or
independent verification. Sol owns synthesis, architecture decisions,
integration, acceptance, owner-level verification, and deciding the next
workflow. A Sol job is a binding executable obligation with exact inputs, a
decision or output, and a stopping condition—not a vague reminder. When
discovery can change downstream topology, finish with Sol synthesis and author
the next workflow from evidence rather than speculating it.

This lets independent work happen together without losing the reason it was
assigned. The graph remembers what depends on what, who owns each obligation,
and which evidence changed the plan.

When a worker finishes, its job moves to review rather than silently becoming
done. Sol can accept it, request a correction, or replace unfinished parts of
the workflow. When a workflow closes, Sol returns to the durable goal and
decides what the next chapter requires.

## What using it feels like

Start OpenCode with Sol and give it the outcome you want:

```sh
opencode --agent sol
```

```text
Replace the parser without changing emitted records. Establish the current
behavior, implement the smallest safe change, and verify the real boundary.
```

Sol first understands enough of the task to design a useful workflow. Starting
that workflow automatically creates the durable goal when one does not already
exist. Informational conversation remains goal-free because it does not need a
workflow. Sol can then work on its own jobs while the harness launches ready
workers, supervise work in progress, and change the graph when evidence demands
it. The harness keeps dependencies and available actions explicit, so Sol does
not have to invent IDs, reconstruct protocol state, or guess which operation is
legal next.

Waiting is a deliberate part of supervision. If the next decision truly
depends on a worker, Sol can wait for a meaningful event without abandoning
the goal. Finishing one workflow does not finish the goal; only the user's real
outcome does.

If progress genuinely needs the user or an external change, Sol can mark the
goal blocked and explain the boundary normally. `/goal-stop` is the explicit
escape hatch: it stops associated workers and clears the orchestration, without
reverting repository or Git changes.

## Sol and worker profiles

| Profile | Best used for |
| --- | --- |
| **Sol** | Owning the goal, designing workflows, steering workers, integrating evidence, and making the final call. |
| **Luna Medium** | Clear, narrow work with an obvious method and an easily checked result. |
| **Terra Medium** | Cross-file work in one known subsystem that needs stronger interpretation. |
| **Terra Max** | Difficult bounded work with real ambiguity or meaningful regression risk. |

These are useful defaults, not a closed list. You can change them or add your
own OpenCode subagent profiles. Each profile keeps its own model, reasoning
settings, and routing description; Sol Orchestrator discovers the profiles you
configure instead of hardcoding provider models.

### Customizing bundled agents

With the default `registerAgents: true`, configuration for the bundled `sol`
and worker profile names can customize their model, variant, description,
prompt/persona, and ordinary tool capabilities. Sol Orchestrator appends its
versioned harness contract after a custom prompt and keeps its required mode,
limits, and orchestration permissions authoritative. Set `registerAgents: false`
to opt out of bundled registration entirely and provide fully custom agents.
Keep custom prompts focused on persona or worldview rather than copying the
plugin's harness mechanics.

## Context stays useful

Long worker sessions do not spill into Sol's conversation. Sol first sees
compact state and artifact metadata. When it needs evidence, it selects one
result, diff, or tool output and receives a private local path. It can then use
ordinary terminal search tools such as `rg`, `jq`, and file globs to find the
relevant lines.

This keeps the most capable model focused on decisions instead of transcript
management. It also makes review explicit: a worker's final answer is evidence
for Sol, not an automatic claim that the job is complete.

## TUI

The included TUI preserves OpenCode's normal session navigation and adds:

- **Subagents** — a stable view of workers managed by Sol.
- **Goal & Workflow** — the durable goal, graph version, steps, jobs, actors,
  progress, blockers, changed files, review state, and actions available now.

The interface uses the semantic names from the workflow. Internal correlation
details stay out of the way.

## Install

Install directly from GitHub:

```sh
opencode plugin github:ReyJ94/Sol-Orchestrator
```

Restart OpenCode, then start with:

```sh
opencode --agent sol
```

The installer configures both the server and TUI entrypoints. OpenCode loads
plugins and agent prompts at startup, so restart it after installing or
updating the plugin.

<details>
<summary><strong>Command reference</strong></summary>

Most users only need to start Sol and describe the outcome. The remaining
actions are the semantic controls Sol uses while running the workflow.

### Start and stop

| Command | Purpose |
| --- | --- |
| `opencode --agent sol` | Start OpenCode with Sol as the orchestrator. |
| `/goal` | Show the current durable goal and workflow status. |
| `/goal <objective>` | Explicitly create a goal before its first workflow, or promote an unassociated current workflow. |
| `/goal-stop` | Stop the goal and its workers without reverting repository changes. |

### Goal and workflow actions

| Action | Purpose |
| --- | --- |
| `goal_complete` | Close the goal after the user's full outcome is proven. |
| `goal_block` | Pause liveness at a genuine user or external boundary. |
| `goal_resume` | Continue after the blocker is resolved. |
| `workflow_status` | Read the current graph and the actions possible now. |
| `workflow_start` | Start a complete semantic workflow, create its durable goal when absent, and launch ready workers automatically. |
| `workflow_complete` | Complete Sol's job or accept a reviewed worker result. |
| `workflow_retry` | Reopen one reviewed or blocked job without redesigning it. |
| `workflow_replace` | Replace unfinished work with a new graph version and, when scope changed, update the workflow and goal objective together. |

### Worker actions

| Action | Purpose |
| --- | --- |
| `agents_status` | See compact worker state and the controls available now. |
| `agents_inspect` | Materialize one selected result, diff, or tool output for targeted local search. |
| `agents_send` | Steer work that is already in progress. |
| `agents_wait` | Wait for a meaningful event from one or more workers. |
| `agents_interrupt` | Stop a worker that is obsolete, while preserving a result that completed just before the interrupt. |
| `agents_permission` | Decide a suspended write outside an authored scope. |
| `agents_undo` | Revert an isolated worker turn when its safety checks pass. |
| `agents_redo` | Restore that turn while the guarded redo window remains valid. |

</details>

## Optional companion plugins

Sol Orchestrator works on its own. These plugins complement it when you want a
more complete agent workspace.

### [OpenCode Compaction](https://github.com/ReyJ94/Opencode-Operational-Checkpoint)

Preserves an operational checkpoint when OpenCode compacts a long session, so
the next turn retains decisions, current work, and the bounded Sol workflow
state instead of a transcript-shaped summary.

```sh
opencode plugin github:ReyJ94/Opencode-Operational-Checkpoint
```

Install or configure Sol Orchestrator first so the compaction plugin can include
its workflow checkpoint.

### [OpenCode Skill Picker](https://github.com/ReyJ94/Opencode-Skill-Picker)

Lets you choose which skills are available in a session with `/manage-skills`.
This keeps agent context focused while still allowing the right development or
domain skills to shape the workflow.

```sh
opencode plugin github:ReyJ94/Opencode-Skill-Picker
```

## Development

Sol Orchestrator uses Bun and TypeScript:

```sh
bun install
bun run check
bun run build:local
bun pm pack --dry-run
```

Supported OpenCode version: **1.18.1 or newer**.

## License

[MIT](LICENSE) · [Repository](https://github.com/ReyJ94/Sol-Orchestrator)
