/** @jsxImportSource @opentui/solid */

import { createSignal, onCleanup, onMount, Show } from "solid-js";

import {
  defaultWorkflowSummary,
  errorMessage,
  type TuiDependencies,
  type WorkflowSummary,
  workflowControlLabel,
  workflowDialogTitle,
  workflowOptions,
  workflowStartHint,
} from "./tui-shared.js";

// Narrow mirror of the OpenCode v2 CLI plugin context
// (`@opencode-ai/plugin/tui`, verified against `0.0.0-beta-18992`
// `dist/tui/context.d.ts`). Declared locally so this package keeps building
// against its v1 dependency while speaking the v2 host API at runtime. Only
// the members this plugin uses are listed.
export type CliContext = {
  readonly options: Readonly<Record<string, unknown>>;
  readonly data: {
    readonly on: (
      type: string,
      handler: (event: unknown) => void
    ) => () => void;
    readonly session: {
      readonly get: (
        sessionID: string
      ) => { readonly parentID?: string; readonly title?: string } | undefined;
      readonly family: (sessionID: string) => readonly string[];
      readonly status: (sessionID: string) => "idle" | "running";
    };
  };
  readonly keymap: {
    readonly layer: (
      input: () => {
        readonly commands?: readonly {
          readonly id?: string;
          readonly title?: string;
          readonly description?: string;
          readonly group?: string;
          readonly bind?: false | string;
          readonly palette?: true;
          readonly run: (
            input?: string,
            event?: unknown
          ) => void | false | Promise<void>;
        }[];
      }
    ) => void;
  };
  readonly ui: {
    readonly slot: (claim: {
      readonly append: "prompt.footer";
      readonly render: (input: { readonly sessionID?: string }) => unknown;
    }) => () => void;
    readonly dialog: {
      readonly select: <Value>(options: {
        readonly title: string;
        readonly placeholder?: string;
        readonly options: readonly {
          readonly title: string;
          readonly value: Value;
          readonly description?: string;
        }[];
      }) => Promise<Value | undefined>;
    };
    readonly toast: {
      readonly show: (options: {
        readonly title?: string;
        readonly message: string;
        readonly variant?: "info" | "success" | "warning" | "error";
        readonly duration?: number;
      }) => void;
    };
    readonly router: {
      readonly current: () =>
        | { readonly type: "home" }
        | { readonly type: "session"; readonly sessionID: string }
        | { readonly type: string };
      readonly navigate: (destination: {
        readonly type: "session";
        readonly sessionID: string;
      }) => void;
    };
    readonly tabs: {
      readonly enabled: () => boolean;
      readonly open: (sessionID: string) => boolean;
    };
  };
  readonly theme: {
    readonly text: { readonly default: string; readonly subdued: string };
    readonly feedback?: { readonly warning?: { readonly default?: string } };
  };
};

export type CliSetup = (
  context: CliContext
) => Promise<(() => void) | undefined> | (() => void) | undefined;

const subagentsCommandId = "opencode-sol-orchestrator.subagents";
const workflowCommandId = "opencode-sol-orchestrator.workflow";

const warningFg = (context: CliContext): string =>
  context.theme.feedback?.warning?.default ?? context.theme.text.subdued;

const childLabel = (status: "idle" | "running"): string =>
  status === "running" ? "● [active]" : "○ [idle]";

const navigateToSession = (context: CliContext, sessionID: string): void => {
  // v1 always navigated; tabs.open() only guarantees the tab exists, not that
  // it is focused, so navigation must follow unconditionally. Navigating to
  // the already-active session is a harmless no-op.
  if (context.ui.tabs.enabled()) {
    context.ui.tabs.open(sessionID);
  }
  context.ui.router.navigate({ type: "session", sessionID });
};

const currentSessionID = (context: CliContext): string | undefined => {
  const route = context.ui.router.current();
  if (route.type !== "session" || !("sessionID" in route)) {
    return;
  }
  return route.sessionID;
};

export const createSolOrchestratorCliSetup =
  (dependencies: TuiDependencies = {}): CliSetup =>
  (context) => {
    const readWorkflow = dependencies.readWorkflow ?? defaultWorkflowSummary;
    const pluginOptions = { ...context.options };

    const listChildren = (sessionID: string) =>
      context.data.session
        .family(sessionID)
        .filter(
          (candidate) =>
            candidate !== sessionID &&
            context.data.session.get(candidate)?.parentID === sessionID
        )
        .map((id) => ({
          id,
          status: context.data.session.status(id),
          title: context.data.session.get(id)?.title || id,
        }))
        .sort((left, right) => {
          const rank = (status: "idle" | "running") =>
            status === "running" ? 0 : 1;
          return rank(left.status) - rank(right.status);
        });

    const openSubagentsPicker = async (sessionID: string) => {
      let children: {
        id: string;
        status: "idle" | "running";
        title: string;
      }[] = [];
      try {
        children = listChildren(sessionID);
      } catch (error) {
        context.ui.toast.show({
          duration: 3000,
          message: `Failed to load subagents: ${errorMessage(error)}`,
          title: "Subagents unavailable",
          variant: "error",
        });
        return;
      }
      if (children.length === 0) {
        context.ui.toast.show({
          duration: 2000,
          message: "No subagents found",
          variant: "info",
        });
        return;
      }
      let selected: string | undefined;
      try {
        selected = await context.ui.dialog.select({
          options: children.map((child) => ({
            description: child.status === "running" ? "running" : "idle",
            title: `${childLabel(child.status)} ${child.title}`,
            value: child.id,
          })),
          placeholder: "Search subagents",
          title: "Subagents",
        });
      } catch (error) {
        context.ui.toast.show({
          duration: 3000,
          message: `Failed to open picker: ${errorMessage(error)}`,
          title: "Subagents unavailable",
          variant: "error",
        });
        return;
      }
      if (selected === undefined) {
        return;
      }
      if (typeof selected !== "string") {
        context.ui.toast.show({
          duration: 3000,
          message: `Unexpected picker result: ${errorMessage(selected)}`,
          title: "Subagents unavailable",
          variant: "error",
        });
        return;
      }
      try {
        navigateToSession(context, selected);
      } catch (error) {
        context.ui.toast.show({
          duration: 3000,
          message: `Failed to open subagent: ${errorMessage(error)}`,
          title: "Subagents unavailable",
          variant: "error",
        });
      }
    };

    const openWorkflow = async (sessionID: string) => {
      const summary = await readWorkflow(sessionID, pluginOptions);
      if (summary === null) {
        context.ui.toast.show({
          duration: 4000,
          message: workflowStartHint,
          title: "Goal & workflow",
          variant: "info",
        });
        return;
      }
      await context.ui.dialog.select({
        options: workflowOptions(summary),
        placeholder:
          summary.current?.definition.objective ??
          summary.goal?.objective ??
          "Workflow",
        title: workflowDialogTitle(summary),
      });
    };

    const Footer = (props: { sessionID: string }) => {
      const [children, setChildren] = createSignal<
        readonly { id: string; status: "idle" | "running"; title: string }[]
      >([]);
      const [workflow, setWorkflow] = createSignal<WorkflowSummary | null>(
        null
      );
      let active = true;
      let layerRegistered = false;
      const refresh = async () => {
        try {
          const [nextChildren, nextWorkflow] = await Promise.all([
            listChildren(props.sessionID),
            readWorkflow(props.sessionID, pluginOptions),
          ]);
          if (active) {
            setChildren(nextChildren);
            setWorkflow(nextWorkflow);
          }
        } catch {
          if (active) {
            setChildren([]);
          }
        }
      };
      const refreshSafely = () => {
        refresh().catch(() => undefined);
      };
      // `keymap.layer` reads the host Keymap provider, so it must run inside
      // a rendered component: calling it in `setup` fails activation with
      // "Keymap.Provider is missing".
      if (!layerRegistered) {
        layerRegistered = true;
        context.keymap.layer(() => ({
          commands: [
            {
              bind: "<leader>o",
              description: "Jump to a subagent session",
              group: "Session",
              id: subagentsCommandId,
              palette: true,
              run: () => {
                const sessionID = currentSessionID(context);
                if (sessionID !== undefined) {
                  openSubagentsPicker(sessionID).catch(() => undefined);
                }
              },
              title: "Subagents",
            },
            {
              bind: "<leader>w",
              description: "Show goal and workflow status",
              group: "Session",
              id: workflowCommandId,
              palette: true,
              run: () => {
                const sessionID = currentSessionID(context);
                if (sessionID !== undefined) {
                  openWorkflow(sessionID).catch(() => undefined);
                }
              },
              title: "Goal & workflow status",
            },
          ],
        }));
      }
      const offEvents = [
        "session.created",
        "session.deleted",
        "session.idle",
        "session.execution.started",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
      ].map((type) => context.data.on(type, refreshSafely));
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
            flexShrink={0}
            onMouseUp={() => {
              openSubagentsPicker(props.sessionID).catch(() => undefined);
            }}
          >
            <text fg={context.theme.text.subdued}>
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
                  openWorkflow(props.sessionID).catch(() => undefined);
                }}
              >
                <text
                  fg={
                    summary().goal?.status === "blocked" ||
                    summary().current?.runtime.state === "blocked" ||
                    summary().current?.runtime.state === "degraded"
                      ? warningFg(context)
                      : context.theme.text.subdued
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

    const unregister = context.ui.slot({
      append: "prompt.footer",
      render: (input) =>
        input.sessionID === undefined ? null : (
          <Footer sessionID={input.sessionID} />
        ),
    });
    return () => {
      unregister();
    };
  };

export const SolOrchestratorCliSetup: CliSetup =
  createSolOrchestratorCliSetup();
