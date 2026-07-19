/** @jsxImportSource @opentui/solid */

import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

const { createSolOrchestratorTuiPlugin } = await import("./src/tui.tsx");

let rendered: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  rendered?.renderer.destroy();
  rendered = undefined;
});

const workflow = ({
  state = "active",
  jobState = "ready",
  liveState,
  latestEvent,
  resultAvailable = false,
  availableActions = [{ args: {}, tool: "workflow_delegate" }],
} = {}) => ({
  available_actions: availableActions,
  objective: "Ship the simplified orchestration pipeline.",
  state,
  steps: [
    {
      jobs: [
        {
          actor: { profile: "luna-medium", type: "worker" },
          latest_event: latestEvent,
          live_state: liveState,
          mode: "verification",
          name: "verify simplified boundary",
          objective: "Verify the final public seam.",
          result_available: resultAvailable,
          state: jobState,
          turns:
            liveState === "review"
              ? [
                  {
                    files: [
                      {
                        additions: 3,
                        deletions: 1,
                        path: "src/tui.tsx",
                        status: "modified",
                      },
                    ],
                    isolated: true,
                    result_available: true,
                    turn: 1,
                    undo_available: true,
                  },
                ]
              : [],
        },
      ],
      name: "verify",
      objective: "Prove the final projection.",
      state,
    },
  ],
  version: 2,
});

const goalBetweenWorkflows = () => ({
  available_actions: [
    {
      args: {},
      needs: ["objective", "steps"],
      tool: "workflow_start",
    },
  ],
  goal: {
    objective: "Deliver the full outcome across bounded workflows.",
    status: "active",
  },
  objective: "Deliver the full outcome across bounded workflows.",
  state: "active",
  steps: [],
  version: null,
});

function createApi({ children = [], readError, statuses = {} } = {}) {
  const slots = [];
  const layers = [];
  const dialogs = [];
  const navigations = [];
  const eventHandlers = new Map();
  const cleanups = [];
  return {
    api: {
      client: {
        session: {
          children: async () => {
            if (readError) throw readError;
            return { data: children };
          },
        },
      },
      event: {
        on(type, handler) {
          const current = eventHandlers.get(type) ?? [];
          current.push(handler);
          eventHandlers.set(type, current);
          return () => {
            eventHandlers.set(
              type,
              (eventHandlers.get(type) ?? []).filter(
                (candidate) => candidate !== handler
              )
            );
          };
        },
      },
      keymap: {
        registerLayer(layer) {
          layers.push(layer);
          return () => {};
        },
      },
      lifecycle: {
        onDispose(cleanup) {
          cleanups.push(cleanup);
          return () => {};
        },
      },
      route: {
        current: { name: "session", params: { sessionID: "parent" } },
        navigate: (name, params) => navigations.push([name, params]),
      },
      slots: { register: (slot) => slots.push(slot) },
      state: {
        path: { directory: "/workspace" },
        session: {
          get: () => undefined,
          status: (sessionID) => statuses[sessionID],
        },
      },
      theme: {
        current: {
          backgroundElement: "#333333",
          selectedListItemText: "#ffffff",
          text: "#eeeeee",
          textMuted: "#777777",
          warning: "#ffaa00",
        },
      },
      ui: {
        DialogSelect: (props) => ({ props, type: "DialogSelect" }),
        dialog: {
          clear: () => dialogs.push({ type: "clear" }),
          open: false,
          replace: (render) => dialogs.push(render()),
        },
        toast: (toast) => dialogs.push({ toast, type: "toast" }),
      },
    },
    cleanups,
    dialogs,
    layers,
    navigations,
    slots,
  };
}

async function renderControl(harness) {
  const right = harness.slots[0].slots.session_prompt_right;
  rendered = await testRender(
    () => <box>{right({}, { session_id: "parent" })}</box>,
    { height: 3, width: 52 }
  );
  return rendered;
}

test("keeps native subagent navigation and registers the semantic workflow control", async () => {
  const harness = createApi({
    children: [{ id: "child-1", title: "Verifier" }],
    statuses: { "child-1": { type: "busy" } },
  });
  await createSolOrchestratorTuiPlugin({ readWorkflow: async () => null })(
    harness.api
  );

  expect(harness.layers[0].commands.map((entry) => entry.name)).toEqual([
    "opencode-sol-orchestrator.subagents",
    "opencode-sol-orchestrator.workflow",
  ]);
  await harness.layers[0].commands[0].run();
  expect(harness.dialogs[0].type).toBe("DialogSelect");
  expect(harness.dialogs[0].props.options[0].title).toContain("Verifier");
  harness.dialogs[0].props.onSelect({ value: "child-1" });
  expect(harness.navigations).toEqual([["session", { sessionID: "child-1" }]]);
});

test("shows the exact workflow_start call when no workflow exists", async () => {
  const harness = createApi();
  await createSolOrchestratorTuiPlugin({ readWorkflow: async () => null })(
    harness.api
  );
  const app = await renderControl(harness);
  await app.waitForFrame((frame) => frame.includes("Subagents"));
  await harness.layers[0].commands[1].run();

  expect(harness.dialogs[0].toast.message).toContain(
    "workflow_start({}) · needs: objective, steps"
  );
});

test("renders active steps and jobs with the available delegation action", async () => {
  const harness = createApi();
  await createSolOrchestratorTuiPlugin({
    readWorkflow: async () => workflow(),
  })(harness.api);
  const app = await renderControl(harness);
  await app.waitForFrame((frame) => frame.includes("Workflow active"));
  await harness.layers[0].commands[1].run();

  const dialog = harness.dialogs[0];
  expect(dialog.props.title).toBe("Workflow · v2 · active");
  expect(dialog.props.options.map((option) => option.title)).toEqual(
    expect.arrayContaining([
      "Step · verify · active",
      "  Job · verify simplified boundary · ready",
      "Available · workflow_delegate({})",
    ])
  );
  expect(dialog.props.options[1].description).toContain(
    "luna-medium · verification"
  );
});

test("renders the durable goal while Sol is between workflows", async () => {
  const harness = createApi();
  await createSolOrchestratorTuiPlugin({
    readWorkflow: async () => goalBetweenWorkflows(),
  })(harness.api);
  const app = await renderControl(harness);
  await app.waitForFrame((frame) => frame.includes("Goal active"));
  await harness.layers[0].commands[1].run();

  const dialog = harness.dialogs[0];
  expect(dialog.props.title).toBe("Goal · active · between workflows");
  expect(dialog.props.options[0]).toMatchObject({
    description: "Deliver the full outcome across bounded workflows.",
    title: "Goal · active",
  });
  expect(dialog.props.options.at(-1).title).toBe(
    "Available · workflow_start({}) · needs: objective, steps"
  );
});

test("renders a blocked workflow with its blocker and exact retry call", async () => {
  const harness = createApi();
  await createSolOrchestratorTuiPlugin({
    readWorkflow: async () =>
      workflow({
        jobState: "blocked",
        latestEvent: {
          kind: "blocker",
          message: "The native permission disappeared.",
        },
        liveState: "blocked",
        availableActions: [
          {
            args: {},
            needs: ["reason"],
            tool: "workflow_retry",
          },
        ],
        state: "blocked",
      }),
  })(harness.api);
  const app = await renderControl(harness);
  await app.waitForFrame((frame) => frame.includes("Workflow blocked"));
  await harness.layers[0].commands[1].run();

  const options = harness.dialogs[0].props.options;
  expect(options[1].description).toContain(
    "The native permission disappeared."
  );
  expect(options.at(-1).title).toBe(
    "Available · workflow_retry({}) · needs: reason"
  );
});

test("renders review metadata, targeted inspection, acceptance, and undo availability", async () => {
  const harness = createApi();
  await createSolOrchestratorTuiPlugin({
    readWorkflow: async () =>
      workflow({
        jobState: "review",
        latestEvent: { kind: "result" },
        liveState: "review",
        availableActions: [
          {
            args: { job: "verify simplified boundary", type: "result" },
            tool: "agents_inspect",
          },
          {
            args: {},
            needs: ["message"],
            tool: "workflow_complete",
          },
        ],
        resultAvailable: true,
      }),
  })(harness.api);
  await harness.layers[0].commands[1].run();

  const options = harness.dialogs[0].props.options;
  expect(options[1].description).toContain("review");
  expect(options[1].description).toContain("result available");
  expect(options[2].title).toContain("src/tui.tsx · +3 -1 · isolated · undo");
  expect(options.map((option) => option.title)).toEqual(
    expect.arrayContaining([
      'Available · agents_inspect({"job":"verify simplified boundary","type":"result"})',
      "Available · workflow_complete({}) · needs: message",
    ])
  );
});

test("renders completed workflow history without inventing another action", async () => {
  const harness = createApi();
  await createSolOrchestratorTuiPlugin({
    readWorkflow: async () =>
      workflow({
        jobState: "completed",
        availableActions: [],
        state: "completed",
      }),
  })(harness.api);
  const app = await renderControl(harness);
  await app.waitForFrame((frame) => frame.includes("Workflow completed"));
  await harness.layers[0].commands[1].run();

  expect(harness.dialogs[0].props.title).toBe("Workflow · v2 · completed");
  expect(
    harness.dialogs[0].props.options.some((option) =>
      option.title.startsWith("Available ·")
    )
  ).toBe(false);
});
