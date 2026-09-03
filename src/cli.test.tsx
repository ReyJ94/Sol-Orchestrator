/** @jsxImportSource @opentui/solid */

import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

const { createSolOrchestratorCliSetup } = await import("./cli.js");

let rendered: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  rendered?.renderer.destroy();
  rendered = undefined;
});

const workflow = () => ({
  available_actions: [],
  current: {
    definition: {
      objective: "Ship the simplified orchestration pipeline.",
      steps: [],
    },
    runtime: { jobs: {}, state: "active", steps: {} },
    version: 2,
    versions: [{ version: 2 }],
  },
  goal: undefined,
});

function createCliApi({
  children = [{ id: "child-1", parentID: "parent", title: "Verifier" }],
  statuses = { "child-1": "running" },
  readWorkflow = async () => null,
  route = { type: "session", sessionID: "parent" },
}: {
  children?: { id: string; parentID?: string; title?: string }[];
  statuses?: Record<string, "idle" | "running">;
  readWorkflow?: () => Promise<unknown>;
  route?: { type: string; sessionID?: string };
} = {}) {
  const slots: unknown[] = [];
  const layers: unknown[] = [];
  const selects: unknown[] = [];
  const navigations: unknown[] = [];
  const toasts: unknown[] = [];
  const eventHandlers = new Map<string, unknown[]>();
  const sessionsByID = new Map(
    (children ?? []).map((child) => [child.id, child]),
  );
  if (!sessionsByID.has("parent")) {
    sessionsByID.set("parent", { id: "parent", title: "Parent" });
  }
  return {
    api: {
      options: {},
      data: {
        on: (type: string, handler: unknown) => {
          const current = eventHandlers.get(type) ?? [];
          current.push(handler);
          eventHandlers.set(type, current);
          return () => {};
        },
        session: {
          list: () => [...sessionsByID.values()],
          get: (sessionID: string) => sessionsByID.get(sessionID),
          family: (sessionID: string) => [
            sessionID,
            ...(children ?? [])
              .filter((child) => child.parentID === sessionID)
              .map((child) => child.id),
          ],
          status: (sessionID: string) => statuses[sessionID] ?? "idle",
        },
        location: { default: () => ({ directory: "/workspace" }) },
      },
      keymap: {
        layer: (input: () => unknown) => {
          layers.push(input());
        },
      },
      ui: {
        slot: (claim: unknown) => {
          slots.push(claim);
          return () => {};
        },
        dialog: {
          select: async (options: unknown) => {
            selects.push(options);
            return undefined;
          },
        },
        toast: { show: (toast: unknown) => toasts.push(toast) },
        router: {
          current: () => route,
          navigate: (destination: unknown) => navigations.push(destination),
        },
        tabs: { enabled: () => false, open: () => false },
      },
      theme: {
        text: { default: "#eeeeee", subdued: "#777777" },
      },
    },
    eventHandlers,
    layers,
    navigations,
    selects,
    slots,
    toasts,
  };
}

async function renderFooter(harness: ReturnType<typeof createCliApi>) {
  const claim = harness.slots[0] as {
    append: string;
    render: (input: unknown) => unknown;
  };
  expect(claim.append).toBe("prompt.footer");
  rendered = await testRender(
    () => <box>{claim.render({ sessionID: "parent" }) as never}</box>,
    { height: 3, width: 52 },
  );
  return rendered;
}

test("registers keymap only inside the rendered slot, never in setup", async () => {
  const harness = createCliApi();
  await createSolOrchestratorCliSetup()(harness.api as never);
  // The host Keymap provider is absent during setup; registration must wait
  // for the slot render or activation fails with "Keymap.Provider is missing".
  expect(harness.layers).toEqual([]);
  expect(harness.slots.length).toBe(1);
  await renderFooter(harness);
  expect(harness.layers.length).toBe(1);
});

test("shows the subagent count and navigates to the picked child", async () => {
  const harness = createCliApi();
  await createSolOrchestratorCliSetup()(harness.api as never);
  const app = await renderFooter(harness);
  await app.waitForFrame((frame) => frame.includes("Subagents 1"));

  const layer = harness.layers[0] as {
    commands: { id: string; run: () => Promise<void> }[];
  };
  const command = layer.commands.find(
    (entry) => entry.id === "opencode-sol-orchestrator.subagents",
  );
  expect(command).toBeDefined();
  (harness.api.ui.dialog as { select: (options: never) => Promise<unknown> }).select =
    async (options) => {
      harness.selects.push(options);
      return "child-1";
    };
  await command?.run();
  expect(harness.navigations).toEqual([
    { type: "session", sessionID: "child-1" },
  ]);
});

test("subagents command is bound, palette-listed, and toasts when empty", async () => {
  const harness = createCliApi({ children: [] });
  await createSolOrchestratorCliSetup()(harness.api as never);
  await renderFooter(harness);
  const layer = harness.layers[0] as {
    commands: {
      bind?: string;
      id: string;
      palette?: true;
      run: () => Promise<void>;
    }[];
  };
  const command = layer.commands.find(
    (entry) => entry.id === "opencode-sol-orchestrator.subagents",
  );
  expect(command?.bind).toBe("<leader>o");
  expect(command?.palette).toBe(true);
  await command?.run();
  expect(harness.selects).toEqual([]);
  expect(harness.toasts).toEqual([
    expect.objectContaining({ message: "No subagents found" }),
  ]);
});

test("picker failures toast instead of failing silently", async () => {
  const harness = createCliApi();
  await createSolOrchestratorCliSetup()(harness.api as never);
  await renderFooter(harness);
  const layer = harness.layers[0] as {
    commands: { id: string; run: () => Promise<void> }[];
  };
  const command = layer.commands.find(
    (entry) => entry.id === "opencode-sol-orchestrator.subagents",
  );
  (harness.api.ui.dialog as { select: (options: never) => Promise<unknown> }).select =
    async () => {
      throw new Error("dialog unavailable");
    };
  await command?.run();
  expect(harness.navigations).toEqual([]);
  expect(harness.toasts).toEqual([
    expect.objectContaining({ title: "Subagents unavailable" }),
  ]);
});
test("navigation follows tab opening instead of returning early", async () => {
  const harness = createCliApi();
  await createSolOrchestratorCliSetup()(harness.api as never);
  await renderFooter(harness);
  const opened: unknown[] = [];
  (harness.api.ui as { tabs: { enabled: () => boolean; open: (id: string) => boolean } }).tabs = {
    enabled: () => true,
    open: (sessionID: string) => {
      opened.push(sessionID);
      return true;
    },
  };
  (harness.api.ui.dialog as { select: (options: never) => Promise<unknown> }).select =
    async (options) => {
      harness.selects.push(options);
      return "child-1";
    };
  const layer = harness.layers[0] as {
    commands: { id: string; run: () => Promise<void> }[];
  };
  const command = layer.commands.find(
    (entry) => entry.id === "opencode-sol-orchestrator.subagents",
  );
  await command?.run();
  expect(opened).toEqual(["child-1"]);
  expect(harness.navigations).toEqual([
    { type: "session", sessionID: "child-1" },
  ]);
});

test("unexpected picker result toasts instead of silently staying", async () => {
  const harness = createCliApi();
  await createSolOrchestratorCliSetup()(harness.api as never);
  await renderFooter(harness);
  (harness.api.ui.dialog as { select: (options: never) => Promise<unknown> }).select =
    async () => ({ value: "child-1" });
  const layer = harness.layers[0] as {
    commands: { id: string; run: () => Promise<void> }[];
  };
  const command = layer.commands.find(
    (entry) => entry.id === "opencode-sol-orchestrator.subagents",
  );
  await command?.run();
  expect(harness.navigations).toEqual([]);
  expect(harness.toasts).toEqual([
    expect.objectContaining({ title: "Subagents unavailable" }),
  ]);
});
test("shows the workflow label and opens the workflow browser", async () => {
  const harness = createCliApi({
    children: [],
    readWorkflow: async () => workflow(),
  });
  await createSolOrchestratorCliSetup({
    readWorkflow: harness.api.data.session
      ? (async () => workflow() as never)
      : undefined,
  } as never)(harness.api as never);
  const app = await renderFooter(harness);
  await app.waitForFrame((frame) => frame.includes("Workflow active"));

  const layer = harness.layers[0] as {
    commands: { id: string; run: () => Promise<void> }[];
  };
  const command = layer.commands.find(
    (entry) => entry.id === "opencode-sol-orchestrator.workflow",
  );
  await command?.run();
  const dialog = harness.selects[0] as { title: string };
  expect(dialog.title).toBe("Workflow · v2 · active");
});

test("renders plainly with no subagents and no workflow", async () => {
  const harness = createCliApi({ children: [] });
  await createSolOrchestratorCliSetup()(harness.api as never);
  const app = await renderFooter(harness);
  await app.waitForFrame((frame) => frame.includes("Subagents"));
  expect(harness.toasts).toEqual([]);
});
