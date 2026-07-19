/** @jsxImportSource @opentui/solid */

import type { PluginOptions } from "@opencode-ai/plugin";
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { OrchestrationStore } from "./orchestration-store.js";
import { parsePluginOptions } from "./plugin-options.js";
import {
  type AvailableAction,
  projectWorkflowStatus,
  projectWorkflowSummary,
  workflowStartAvailableAction,
} from "./workflow-projection.js";

const subagentsCommand = "opencode-sol-orchestrator.subagents";
const workflowCommand = "opencode-sol-orchestrator.workflow";

type TurnSummary = {
  readonly files: readonly {
    readonly additions: number;
    readonly deletions: number;
    readonly path: string;
    readonly status: string;
  }[];
  readonly isolated: boolean;
  readonly result_available: boolean;
  readonly turn: number;
  readonly undo_available: boolean;
};

type JobSummary = {
  readonly actor: { readonly profile?: string; readonly type: string };
  readonly latest_event?: {
    readonly kind: string;
    readonly message?: string;
  } | null;
  readonly live_state?: string;
  readonly mode?: string;
  readonly name: string;
  readonly objective: string;
  readonly pending_write_permission?: {
    readonly paths: readonly string[];
    readonly tool: string;
  };
  readonly result_available: boolean;
  readonly state: string;
  readonly status_message?: string;
  readonly turns: readonly TurnSummary[];
  readonly writeFiles?: readonly string[];
  readonly write_grants?: readonly string[];
};

type StepSummary = {
  readonly jobs: readonly JobSummary[];
  readonly name: string;
  readonly objective: string;
  readonly state: string;
};

export type WorkflowSummary = {
  readonly available_actions: readonly AvailableAction[];
  readonly goal?: {
    readonly objective: string;
    readonly status: string;
    readonly status_message?: string;
  };
  readonly objective: string;
  readonly state: string;
  readonly steps: readonly StepSummary[];
  readonly version: number | null;
};

const workflowDialogTitle = (summary: WorkflowSummary): string => {
  if (summary.goal === undefined) {
    return `Workflow · v${summary.version ?? "?"} · ${summary.state}`;
  }
  if (summary.version === null) {
    return `Goal · ${summary.goal.status} · between workflows`;
  }
  return `Goal · ${summary.goal.status} · Workflow v${summary.version} · ${summary.state}`;
};

const workflowControlLabel = (summary: WorkflowSummary): string => {
  if (summary.goal === undefined) {
    return `Workflow ${summary.state}`;
  }
  if (summary.version === null) {
    return `Goal ${summary.goal.status} · between workflows`;
  }
  return `Goal ${summary.goal.status} · Workflow ${summary.state}`;
};

type TuiDependencies = {
  readonly readWorkflow?: (
    parentSessionID: string,
    options: PluginOptions | undefined
  ) => Promise<WorkflowSummary | null>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

const parentSessionID = (api: TuiPluginApi): string | undefined => {
  const route = api.route.current;
  if (route.name !== "session") {
    return;
  }
  const sessionID = route.params?.sessionID;
  if (typeof sessionID !== "string") {
    return;
  }
  if (api.state.session.get(sessionID)?.parentID) {
    return;
  }
  return sessionID;
};

const sessionTitle = (session: Session): string => session.title || session.id;

type ChildStatus = SessionStatus["type"] | undefined;

const childState = (status: ChildStatus): string => {
  if (status === "busy") {
    return "● [active]";
  }
  if (status === "retry") {
    return "! [retry]";
  }
  return "○ [idle]";
};

const childStatusRank = (status: ChildStatus): number => {
  if (status === "busy") {
    return 0;
  }
  if (status === "retry") {
    return 1;
  }
  return 2;
};

const exactCall = (action: AvailableAction): string =>
  `${action.tool}(${JSON.stringify(action.args)})${
    action.needs === undefined ? "" : ` · needs: ${action.needs.join(", ")}`
  }`;

const defaultWorkflowSummary = async (
  parentID: string,
  options: PluginOptions | undefined
): Promise<WorkflowSummary | null> => {
  const parsed = parsePluginOptions(options);
  const store = new OrchestrationStore({ statePath: parsed.statePath });
  try {
    const root = await store.readRoot();
    const record =
      root.workflows.workflows
        .filter((candidate) => candidate.parent_session_id === parentID)
        .toSorted((left, right) => right.current_version - left.current_version)
        .find((candidate) => candidate.current) ??
      root.workflows.workflows
        .filter((candidate) => candidate.parent_session_id === parentID)
        .at(-1);
    const goal = root.goals.goals.find(
      (candidate) =>
        candidate.parent_session_id === parentID &&
        (candidate.status === "active" || candidate.status === "blocked")
    );
    if (record === undefined && goal === undefined) {
      return null;
    }
    if (record === undefined && goal !== undefined) {
      const projection = projectWorkflowStatus(root, {
        agent: goal.orchestrator_agent_id,
        parent_session_id: parentID,
      });
      return {
        available_actions: projection.available_actions,
        goal: {
          objective: goal.objective,
          status: goal.status,
          ...(goal.status_message === null
            ? {}
            : { status_message: goal.status_message }),
        },
        objective: goal.objective,
        state: goal.status,
        steps: [],
        version: null,
      };
    }
    if (record === undefined) {
      return null;
    }
    const summary = projectWorkflowSummary(root, record, "all");
    const associatedGoal = root.goals.goals.find(
      (candidate) => candidate.goal_id === record.goal_id
    );
    return {
      ...summary,
      ...(associatedGoal === undefined
        ? {}
        : {
            goal: {
              objective: associatedGoal.objective,
              status: associatedGoal.status,
              ...(associatedGoal.status_message === null
                ? {}
                : { status_message: associatedGoal.status_message }),
            },
          }),
    };
  } catch (error) {
    return {
      available_actions: [],
      objective: `Workflow state unavailable: ${errorMessage(error)}`,
      state: "degraded",
      steps: [],
      version: null,
    };
  }
};

const actorLabel = (job: JobSummary): string =>
  job.actor.type === "orchestrator" ? "Sol" : (job.actor.profile ?? "worker");

const jobDescription = (job: JobSummary): string =>
  [
    actorLabel(job),
    job.mode,
    job.live_state,
    job.result_available ? "result available" : undefined,
    job.latest_event?.message,
    job.status_message,
    job.pending_write_permission
      ? `permission: ${job.pending_write_permission.tool} ${job.pending_write_permission.paths.join(", ")}`
      : undefined,
    job.write_grants && job.write_grants.length > 0
      ? `grants: ${job.write_grants.join(", ")}`
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");

const workflowOptions = (summary: WorkflowSummary) => [
  ...(summary.goal === undefined
    ? []
    : [
        {
          description: summary.goal.status_message ?? summary.goal.objective,
          title: `Goal · ${summary.goal.status}`,
          value: "goal",
        },
      ]),
  ...summary.steps.flatMap((step) => [
    {
      description: step.objective,
      title: `Step · ${step.name} · ${step.state}`,
      value: `step:${step.name}`,
    },
    ...step.jobs.flatMap((job) => [
      {
        description: jobDescription(job),
        title: `  Job · ${job.name} · ${job.state}`,
        value: `job:${job.name}`,
      },
      ...job.turns.flatMap((turn) =>
        turn.files.length === 0
          ? [
              {
                description: `turn ${turn.turn} · ${turn.isolated ? "isolated" : "shared"} · ${turn.undo_available ? "undo available" : "undo unavailable"}`,
                title: `    Turn ${turn.turn}`,
                value: `turn:${job.name}:${turn.turn}`,
              },
            ]
          : turn.files.map((file) => ({
              description: `turn ${turn.turn} · ${file.status}`,
              title: `    ${file.path} · +${file.additions} -${file.deletions} · ${turn.isolated ? "isolated" : "shared"} · ${turn.undo_available ? "undo" : "no undo"}`,
              value: `turn:${job.name}:${turn.turn}:${file.path}`,
            }))
      ),
    ]),
  ]),
  ...summary.available_actions.map((action, index) => ({
    description: "Currently available semantic action",
    title: `Available · ${exactCall(action)}`,
    value: `available:${index}`,
  })),
];

export const createSolOrchestratorTuiPlugin =
  (dependencies: TuiDependencies = {}): TuiPlugin =>
  (api, options) => {
    const readWorkflow = dependencies.readWorkflow ?? defaultWorkflowSummary;
    const loadChildren = async (sessionID: string) => {
      const result = await api.client.session.children(
        { directory: api.state.path.directory, sessionID },
        { throwOnError: true }
      );
      return result.data ?? [];
    };

    const openPicker = async (sessionID: string) => {
      let children: Session[];
      try {
        children = await loadChildren(sessionID);
      } catch (error) {
        api.ui.toast({
          duration: 3000,
          message: `Failed to load subagents: ${errorMessage(error)}`,
          title: "Subagents unavailable",
          variant: "error",
        });
        return;
      }
      if (children.length === 0) {
        api.ui.toast({
          duration: 2000,
          message: "No subagents found",
          variant: "info",
        });
        return;
      }
      const DialogSelect = api.ui.DialogSelect;
      const pickerOptions = children
        .map((child) => {
          const status = api.state.session.status(child.id)?.type;
          return {
            description: status ?? "idle",
            status,
            title: `${childState(status)} ${sessionTitle(child)}`,
            value: child.id,
          };
        })
        .sort(
          (left, right) =>
            childStatusRank(left.status) - childStatusRank(right.status)
        );
      api.ui.dialog.replace(() => (
        <DialogSelect
          onSelect={(selected) => {
            if (typeof selected.value !== "string") {
              return;
            }
            api.ui.dialog.clear();
            api.route.navigate("session", { sessionID: selected.value });
          }}
          options={pickerOptions}
          placeholder="Search subagents"
          title="Subagents"
        />
      ));
    };

    const showWorkflow = async (sessionID: string) => {
      const summary = await readWorkflow(sessionID, options);
      if (summary === null) {
        api.ui.toast({
          duration: 4000,
          message: `No durable goal or workflow · Start /goal <objective>, or use ${exactCall(workflowStartAvailableAction)}`,
          title: "Goal & workflow",
          variant: "info",
        });
        return;
      }
      const DialogSelect = api.ui.DialogSelect;
      api.ui.dialog.replace(() => (
        <DialogSelect
          onSelect={() => undefined}
          options={workflowOptions(summary)}
          placeholder={summary.objective}
          title={workflowDialogTitle(summary)}
        />
      ));
    };

    const SubagentControl = (props: { sessionID: string }) => {
      const [children, setChildren] = createSignal<Session[]>([]);
      const [workflow, setWorkflow] = createSignal<WorkflowSummary | null>(
        null
      );
      const [hovered, setHovered] = createSignal(false);
      let active = true;
      const refresh = async () => {
        try {
          const [nextChildren, nextWorkflow] = await Promise.all([
            loadChildren(props.sessionID),
            readWorkflow(props.sessionID, options),
          ]);
          if (active) {
            setChildren(nextChildren);
            setWorkflow(nextWorkflow);
          }
        } catch (error) {
          if (!active) {
            return;
          }
          api.ui.toast({
            duration: 3000,
            message: `Failed to load subagents: ${errorMessage(error)}`,
            title: "Subagents unavailable",
            variant: "error",
          });
          setChildren([]);
        }
      };
      const refreshSafely = () => {
        refresh().catch(() => undefined);
      };
      const offEvents = [
        api.event.on("session.created", refreshSafely),
        api.event.on("session.updated", refreshSafely),
        api.event.on("session.deleted", refreshSafely),
        api.event.on("message.updated", refreshSafely),
        api.event.on("message.part.updated", refreshSafely),
      ];
      onMount(refreshSafely);
      onCleanup(() => {
        active = false;
        for (const off of offEvents) {
          off();
        }
      });
      return (
        <box flexShrink={0}>
          <box
            backgroundColor={
              hovered() ? api.theme.current.backgroundElement : undefined
            }
            flexShrink={0}
            onMouseOut={() => setHovered(false)}
            onMouseOver={() => setHovered(true)}
            onMouseUp={() => {
              openPicker(props.sessionID).catch(() => undefined);
            }}
          >
            <text
              fg={
                hovered() ? api.theme.current.text : api.theme.current.textMuted
              }
            >
              {children().length > 0
                ? `Subagents ${children().length}`
                : "Subagents"}
            </text>
          </box>
          <Show when={workflow()}>
            {(summary: () => WorkflowSummary) => (
              <box
                flexShrink={0}
                onMouseUp={() => {
                  showWorkflow(props.sessionID).catch(() => undefined);
                }}
              >
                <text
                  fg={
                    summary().state === "blocked" ||
                    summary().state === "degraded"
                      ? api.theme.current.warning
                      : api.theme.current.textMuted
                  }
                >
                  {workflowControlLabel(summary())}
                </text>
              </box>
            )}
          </Show>
        </box>
      );
    };

    const offLayer = api.keymap.registerLayer({
      bindings: [
        { cmd: subagentsCommand, key: "ctrl+x down" },
        { cmd: workflowCommand, key: "ctrl+x up" },
      ],
      commands: [
        {
          category: "Session",
          name: subagentsCommand,
          run() {
            const sessionID = parentSessionID(api);
            return sessionID ? openPicker(sessionID) : undefined;
          },
          title: "Subagents",
        },
        {
          category: "Session",
          name: workflowCommand,
          run() {
            const sessionID = parentSessionID(api);
            return sessionID ? showWorkflow(sessionID) : undefined;
          },
          title: "Goal & workflow status",
        },
      ],
      enabled: () => parentSessionID(api) !== undefined && !api.ui.dialog.open,
      priority: 1,
    });
    api.slots.register({
      slots: {
        session_prompt_right(_context, value) {
          return <SubagentControl sessionID={value.session_id} />;
        },
      },
    });
    api.lifecycle.onDispose(offLayer);
    return Promise.resolve();
  };

export const SolOrchestratorTuiPlugin = createSolOrchestratorTuiPlugin();

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-sol-orchestrator.tui",
  tui: SolOrchestratorTuiPlugin,
};

export default plugin;
