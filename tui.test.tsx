/** @jsxImportSource @opentui/solid */
import assert from "node:assert/strict"
import { test } from "bun:test"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"

const { SolOrchestratorTuiPlugin } = await import("./tui.tsx")

function createApi({ children = [], restored = false, error, statuses = {}, theme = {} } = {}) {
  const slots = []
  const layers = []
  const dialogs = []
  const navigations = []
  const writes = []
  const childrenCalls = []
  const cleanups = []
  let eventDisposals = 0
  let layerDisposals = 0

  return {
    slots,
    layers,
    dialogs,
    navigations,
    writes,
    childrenCalls,
    cleanups,
    get eventDisposals() {
      return eventDisposals
    },
    get layerDisposals() {
      return layerDisposals
    },
    api: {
      slots: { register: (slot) => slots.push(slot) },
      keymap: {
        registerLayer(layer) {
          layers.push(layer)
          return () => {
            layerDisposals += 1
          }
        },
      },
      client: {
        session: {
          children: async (input) => {
            childrenCalls.push(input)
            if (error) throw error
            return { data: children }
          },
        },
      },
      route: {
        current: { name: "session", params: { sessionID: "parent" } },
        navigate: (name, params) => navigations.push([name, params]),
      },
      state: {
        path: { directory: "/workspace" },
        session: {
          get: () => undefined,
          status: (sessionID) => statuses[sessionID],
        },
      },
      theme: {
        current: {
          text: "#eeeeee",
          textMuted: "#777777",
          selectedListItemText: "#ffffff",
          backgroundElement: "#333333",
          ...theme,
        },
      },
      ui: {
        DialogSelect: (props) => ({ type: "DialogSelect", props }),
        dialog: {
          open: false,
          clear: () => dialogs.push({ type: "clear" }),
          replace: (render) => dialogs.push(render()),
        },
        toast: (toast) => dialogs.push({ type: "toast", toast }),
      },
      kv: {
        get: () => restored,
        set: (...value) => writes.push(value),
      },
      event: {
        on: () => () => {
          eventDisposals += 1
        },
      },
      lifecycle: {
        onDispose(cleanup) {
          cleanups.push(cleanup)
          return () => {}
        },
      },
    },
  }
}

async function renderControl(harness) {
  const right = harness.slots[0].slots.session_prompt_right
  const app = await testRender(() => <box>{right({}, { session_id: "parent" })}</box>, { width: 40, height: 3 })
  return app
}

test("registers only a priority picker command and session_prompt_right slot", async () => {
  const harness = createApi()
  await SolOrchestratorTuiPlugin(harness.api)

  assert.equal(harness.slots.length, 1)
  assert.deepEqual(Object.keys(harness.slots[0].slots), ["session_prompt_right"])
  assert.equal(harness.layers.length, 1)
  assert.equal(harness.layers[0].priority, 1)
  assert.equal(harness.layers[0].commands[0].name, "opencode-sol-orchestrator.subagents")
  assert.deepEqual(harness.layers[0].bindings, [{ key: "ctrl+x down", cmd: "opencode-sol-orchestrator.subagents" }])
  assert.equal(harness.slots.some((slot) => "session_prompt" in slot.slots), false)
})

test("uses the authoritative children response to hide and show the control under a Solid root", async () => {
  const empty = createApi()
  await SolOrchestratorTuiPlugin(empty.api)
  const emptyApp = await renderControl(empty)
  try {
    await emptyApp.waitFor(() => empty.childrenCalls.length === 1)
    await emptyApp.flush()
    assert.equal(emptyApp.captureCharFrame().includes("Subagents"), false)
    assert.deepEqual(empty.childrenCalls, [{ sessionID: "parent", directory: "/workspace" }])
  } finally {
    emptyApp.renderer.destroy()
  }

  const populated = createApi({ children: [{ id: "child-2", title: "Indexer" }] })
  await SolOrchestratorTuiPlugin(populated.api)
  const populatedApp = await renderControl(populated)
  try {
    await populatedApp.waitForFrame((frame) => frame.includes("Subagents"))
    assert.deepEqual(populated.childrenCalls, [{ sessionID: "parent", directory: "/workspace" }])
  } finally {
    populatedApp.renderer.destroy()
  }
  assert.equal(populated.eventDisposals, 3)
})

test("renders conditional Subagents content through the real host slot registry", async () => {
  const harness = createApi({ children: [{ id: "child-host", title: "Host child" }] })
  await SolOrchestratorTuiPlugin(harness.api)

  function App() {
    const registry = createSolidSlotRegistry(useRenderer(), { theme: harness.api.theme })
    const Slot = createSlot(registry)
    registry.register({ ...harness.slots[0], id: "opencode-sol-orchestrator.tui" })
    return (
      <box>
        <Slot name="session_prompt_right" session_id="parent" />
      </box>
    )
  }

  const app = await testRender(() => <App />, { width: 40, height: 3 })
  try {
    await app.waitFor(() => harness.childrenCalls.length === 1)
    await app.waitForFrame((frame) => frame.includes("Subagents"))
    assert.deepEqual(harness.childrenCalls, [{ sessionID: "parent", directory: "/workspace" }])
  } finally {
    app.renderer.destroy()
  }
})

test("click and Ctrl+X Down invoke the picker, and selection opens the exact child", async () => {
  const harness = createApi({ children: [{ id: "child-a", title: "A" }, { id: "child-b", title: "B" }] })
  await SolOrchestratorTuiPlugin(harness.api)
  const app = await renderControl(harness)
  try {
    await app.waitForFrame((frame) => frame.includes("Subagents"))
    await app.mockMouse.click(1, 0)
    await app.waitFor(() => harness.dialogs.length === 1)
    assert.equal(harness.dialogs[0].type, "DialogSelect")

    await harness.layers[0].commands[0].run()
    assert.equal(harness.dialogs[1].type, "DialogSelect")
    assert.equal(harness.navigations.length, 0)
    assert.deepEqual(harness.dialogs[1].props.options.map((option) => option.value), ["child-a", "child-b"])

    harness.dialogs[1].props.onSelect(harness.dialogs[1].props.options[1])
    assert.deepEqual(harness.navigations, [["session", { sessionID: "child-b" }]])
  } finally {
    app.renderer.destroy()
  }
})

test("shows child status in each picker option title", async () => {
  const harness = createApi({
    children: [
      { id: "child-busy", title: "Busy worker" },
      { id: "child-retry", title: "Retry worker" },
      { id: "child-idle", title: "Idle worker" },
    ],
    statuses: {
      "child-busy": { type: "busy" },
      "child-retry": { type: "retry" },
    },
  })
  await SolOrchestratorTuiPlugin(harness.api)
  const app = await renderControl(harness)
  try {
    await app.waitForFrame((frame) => frame.includes("Subagents"))
    await app.mockMouse.click(1, 0)
    await app.waitFor(() => harness.dialogs.length === 1)
    assert.deepEqual(
      harness.dialogs[0].props.options.map((option) => option.title),
      ["● [active] Busy worker", "! [retry] Retry worker", "○ [idle] Idle worker"],
    )
  } finally {
    app.renderer.destroy()
  }
})

test("groups picker options by live status while preserving order within each group", async () => {
  const harness = createApi({
    children: [
      { id: "idle-a", title: "Idle A" },
      { id: "busy-a", title: "Busy A" },
      { id: "retry", title: "Retry" },
      { id: "busy-b", title: "Busy B" },
      { id: "idle-b", title: "Idle B" },
    ],
    statuses: {
      "busy-a": { type: "busy" },
      retry: { type: "retry" },
      "busy-b": { type: "busy" },
    },
  })
  await SolOrchestratorTuiPlugin(harness.api)
  const app = await renderControl(harness)
  try {
    await app.waitForFrame((frame) => frame.includes("Subagents"))
    await app.mockMouse.click(1, 0)
    await app.waitFor(() => harness.dialogs.length === 1)
    assert.deepEqual(harness.dialogs[0].props.options.map((option) => option.value), [
      "busy-a",
      "busy-b",
      "retry",
      "idle-a",
      "idle-b",
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("brightens Subagents on mouse over and restores muted styling on mouse out", async () => {
  const harness = createApi({ children: [{ id: "child-hover", title: "Hover worker" }] })
  await SolOrchestratorTuiPlugin(harness.api)
  const app = await renderControl(harness)
  try {
    await app.waitForFrame((frame) => frame.includes("Subagents"))
    const span = () => app.captureSpans().lines.flatMap((line) => line.spans).find((item) => item.text.includes("Subagents"))
    const color = (value) => value && [value.r, value.g, value.b, value.a]
    assert.deepEqual(color(span()?.fg), [119 / 255, 119 / 255, 119 / 255, 1])
    await app.mockMouse.moveTo(1, 0)
    await app.flush()
    assert.deepEqual(color(span()?.fg), [238 / 255, 238 / 255, 238 / 255, 1])
    assert.notDeepEqual(color(span()?.fg), [1, 1, 1, 1])
    assert.deepEqual(color(span()?.bg), [51 / 255, 51 / 255, 51 / 255, 1])
    await app.mockMouse.moveTo(20, 2)
    await app.flush()
    assert.deepEqual(color(span()?.fg), [119 / 255, 119 / 255, 119 / 255, 1])
    assert.equal(span()?.bg.a, 0)
  } finally {
    app.renderer.destroy()
  }
})

test("surfaces child-loading failures and cleans registrations through the lifecycle", async () => {
  const harness = createApi({ error: new Error("offline") })
  await SolOrchestratorTuiPlugin(harness.api)
  await harness.layers[0].commands[0].run()

  assert.deepEqual(harness.dialogs, [
    {
      type: "toast",
      toast: {
        variant: "error",
        title: "Subagents unavailable",
        message: "Failed to load subagents: offline",
        duration: 3000,
      },
    },
  ])
  assert.equal(harness.cleanups.length, 1)
  harness.cleanups[0]()
  assert.equal(harness.layerDisposals, 1)
  assert.equal(harness.eventDisposals, 0)
})
