<p align="center">
  <img src="assets/sol-orchestrator-banner.png" alt="Sol Orchestrator — managed multi-agent orchestration for OpenCode" width="100%" />
</p>

# Sol Orchestrator

**A graph-native multi-agent harness for OpenCode.**

Sol Orchestrator helps one capable agent lead a team without losing sight of
the user's actual goal. Sol decides the plan, delegates focused work to less
expensive profiles, reviews their evidence, adapts when reality changes, and
stays responsible until the whole outcome is complete.

It is designed to make agentic work both smarter and cheaper. The strongest
model keeps architecture, judgment, and the important context. Workers handle
bounded investigation, implementation, and verification without filling Sol's
conversation with their full transcripts.

## Highlights

- **One goal, many workflows.** Sol remains responsible across distinct phases
  of the work and across revisions of the plan.
- **A real execution graph.** Steps and jobs describe dependencies, ownership,
  parallel work, review, and what can happen next.
- **Focused delegation.** Each worker receives one bounded job. Sol retains
  planning, integration, tradeoffs, and final judgment.
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

A **goal** is the outcome the user cares about. A **workflow** is one chapter
in reaching it. Each workflow has a versioned graph. Steps express the larger
order, while jobs assign the concrete work to Sol or a worker.

Jobs inside a step can form their own semantic DAG:

```text
inspect runtime ─┐
                 ├──> Sol reassesses ──> implement ──> verify
map callers ─────┘
```

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
/goal Replace the parser without changing emitted records. Establish the
current behavior, implement the smallest safe change, and verify the real
boundary.
```

Sol first understands enough of the task to design a useful workflow. It can
then delegate ready jobs, work on its own jobs, supervise work in progress, and
change the graph when evidence demands it. The harness keeps dependencies and
available actions explicit, so Sol does not have to invent IDs, reconstruct
protocol state, or guess which operation is legal next.

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
| **Luna Max** | Careful investigation, adversarial checking, and precise verification. |
| **Terra Medium** | Cross-file work in one known subsystem that needs stronger interpretation. |
| **Terra Max** | Difficult bounded work with real ambiguity or meaningful regression risk. |

These are useful defaults, not a closed list. You can change them or add your
own OpenCode subagent profiles. Each profile keeps its own model, reasoning
settings, and routing description; Sol Orchestrator discovers the profiles you
configure instead of hardcoding provider models.

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
