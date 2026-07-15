<p align="center">
  <img src="./assets/sol-orchestrator-banner.png" alt="OpenCode Sol Orchestrator — managed multi-agent orchestration for OpenCode" width="100%">
</p>

# OpenCode Sol Orchestrator

Durable, model-agnostic child-worker orchestration for [OpenCode](https://opencode.ai). It gives an orchestrator six private tools to launch, monitor, steer, inspect, interrupt, and collect work from focused child sessions—while keeping planning and final integration with the parent agent.

[![GitHub](https://img.shields.io/badge/GitHub-ReyJ94%2FSol--Orchestrator-181717?logo=github)](https://github.com/ReyJ94/Sol-Orchestrator)

## Highlights

- **Durable coordination** — worker registry, prompts, checkpoints, cursors, and completion state survive restarts and concurrent writes.
- **Managed lifecycle** — reserve, admit, acknowledge, checkpoint, complete, steer, and interrupt workers with explicit prompt IDs and deadlines.
- **Parent-owned judgment** — workers report bounded evidence; the parent retains task planning, integration, and final decisions.
- **Compaction continuity** — parent compaction carries a bounded, transcript-free collaboration snapshot; compacted workers are marked for rebrief.
- **Native OpenCode experience** — a conditional **Subagents** picker routes directly to child sessions without replacing OpenCode navigation.

## Install

Install directly from GitHub:

```sh
opencode plugin github:ReyJ94/Sol-Orchestrator
```

The plugin ships separate server and TUI exports. For manual configuration, add it to both targets. If you also use `opencode-compaction`, list the orchestrator server plugin first so its collaboration context is included in the compaction prompt:

`opencode.json`:

```json
{
  "plugin": [
    ["opencode-sol-orchestrator", { "registerAgents": true }],
    "opencode-compaction"
  ]
}
```

`tui.json`:

```json
{ "plugin": ["opencode-sol-orchestrator"] }
```

For local development, generate and install a tarball:

```sh
npm pack
opencode plugin ./opencode-sol-orchestrator-0.1.0.tgz
```

## Agents and model selection

The server registers model-less defaults for `sol`, `luna-medium`, `luna-max`, `terra-medium`, and `terra-max`. Existing entries in your `agent` config always win, so provide an entry there to override a prompt, model, variant, or permission policy. No default agent is set and no model or variant is hardcoded; select Sol in OpenCode as usual, or set your own `default_agent` separately if desired.

Set `registerAgents` to `false` in the server plugin tuple to disable all default agent registration. Prompt templates are shipped in `agents/`; runtime metadata is maintained in JavaScript and templates are read when the config hook runs.

## TUI behavior

The TUI entrypoint preserves OpenCode's native layout and tool visibility, so Task cards and completed worker history remain available. It adds only a conditional `session_prompt_right` **Subagents** control after child sessions exist; selecting it opens a native `DialogSelect` listing direct child sessions and routes the selection to that child session. In parent sessions, `Ctrl+X Down` opens the same picker. Native child `Parent / Prev / Next` navigation remains OpenCode-owned.

## Behavior and limitations

Exactly six private orchestration tools are registered:

- `agents_send` sends steering, correction, rebrief, or bounded follow-up prompts.
- `agents_list` lists owned workers and their live and checkpoint state.
- `agents_read` reads one worker's messages and mailbox; `after` reads strictly after a checkpoint and `consume_through` advances that worker's cursor.
- `agents_wait` waits for selected workers, or all parent-owned workers when no selection is supplied; `after` is a parent-global mailbox cursor across the selected workers.
- `agents_interrupt` interrupts an owned worker.
- `report_to_parent` delivers acknowledgement, evidence, red evidence, diff, blocker, or completion checkpoints.

Worker ownership is checked against the current parent session. Completion delivery is deduplicated per worker turn. Prompt reservations use `pr_v1_...` IDs and advance through `admitted`, `started`, `acknowledged`, `checkpointed`, and `completed` stages; acknowledgement requires the current prompt ID. Lifecycle data derives `healthy`, `steering_unacknowledged`, `awaiting_first_checkpoint`, and `checkpoint_stale` states plus their deadlines from the configured thresholds.

Structured `task`-hook metadata records the worker profile, description, and sealed-prompt mode independently of the session title. Title parsing is retained only as a legacy recovery fallback.

State is durable, schema-versioned, and includes the worker registry, checkpoint mailboxes, cursors, completion state, and prompt state. Writes use private filesystem paths, atomic replacement, and locking, so state survives restart and concurrent writers. Malformed JSON or an unsupported schema fails closed rather than being accepted as state.

State path precedence is: plugin `statePath`; `OPENCODE_SOL_ORCHESTRATOR_STATE_PATH`; `$XDG_STATE_HOME/opencode/opencode-sol-orchestrator/state.json`; then `~/.local/state/opencode/opencode-sol-orchestrator/state.json`.

The configurable `thresholds` options default to `steeringUnacknowledgedMs: 60000`, `firstCheckpointMs: 300000`, and `checkpointStaleMs: 900000`. `compactionSnapshotMaxChars` defaults to `12000` and accepts values from `1024` through `100000`.

Locking options default to `lockTimeoutMs: 5000`, `lockRetryMs: 10`, and `staleLockMs: 60000`.

When a managed child emits `session.compacted`, the plugin durably records a rebrief-required blocker. Admitting a successful new prompt clears that requirement. During parent compaction, it appends one bounded observed-data snapshot to `output.context` containing worker identity, task, live state, current prompt, last decisive checkpoint, unresolved checkpoint, and rebrief status. It does not append transcripts or write `output.prompt`.

The plugin relies on OpenCode session, event, config, tool, and compaction-hook APIs available in OpenCode `>=1.18.1`.

The test suite and package checks cover restart, concurrency, malformed/unsupported state, and compaction behavior.

## Development

Development requires Node.js and npm. Bun is also required for the TUI test
suite.

```sh
npm install
npm test
npm run check
npm run pack:dry-run
```

Repository: <https://github.com/ReyJ94/Sol-Orchestrator>
