/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/v1/tui";
import type { Session } from "@opencode-ai/sdk/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { SolOrchestratorCliSetup } from "./cli.js";
import {
  childState,
  childStatusRank,
  defaultWorkflowSummary,
  errorMessage,
  sessionTitle,
  type TuiDependencies,
  type WorkflowSummary,
  workflowControlLabel,
  workflowDialogTitle,
  workflowOptions,
  workflowStartHint,
} from "./tui-shared.js";

export type { WorkflowSummary } from "./tui-shared.js";

const subagentsCommand = "opencode-sol-orchestrator.subagents";
const workflowCommand = "opencode-sol-orchestrator.workflow";

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
          message: workflowStartHint,
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
          placeholder={
            summary.current?.definition.objective ??
            summary.goal?.objective ??
            "Workflow"
          }
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
        api.event.on("session.status", refreshSafely),
        api.event.on("session.deleted", refreshSafely),
        api.event.on("session.step.started", refreshSafely),
        api.event.on("session.step.ended", refreshSafely),
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
                    summary().goal?.status === "blocked" ||
                    summary().current?.runtime.state === "blocked" ||
                    summary().current?.runtime.state === "degraded"
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

const plugin = {
  id: "opencode-sol-orchestrator.tui",
  tui: SolOrchestratorTuiPlugin,
  setup: SolOrchestratorCliSetup,
};

export default plugin;
