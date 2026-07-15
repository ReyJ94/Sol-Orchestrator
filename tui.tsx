/** @jsxImportSource @opentui/solid */
import type { Session } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, onMount, Show } from "solid-js"

const command = "opencode-sol-orchestrator.subagents"

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error"
}

function parentSessionID(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session") return
  const sessionID = route.params?.sessionID
  if (typeof sessionID !== "string") return
  if (api.state.session.get(sessionID)?.parentID) return
  return sessionID
}

function title(session: Session) {
  return session.title || session.id
}

export const SolOrchestratorTuiPlugin: TuiPlugin = async (api) => {
  const loadChildren = async (sessionID: string) => {
    const result = await api.client.session.children(
      { sessionID, directory: api.state.path.directory },
      { throwOnError: true },
    )
    return result.data ?? []
  }

  const openPicker = async (sessionID: string) => {
    let children: Session[]
    try {
      children = await loadChildren(sessionID)
    } catch (error) {
      api.ui.toast({
        variant: "error",
        title: "Subagents unavailable",
        message: `Failed to load subagents: ${message(error)}`,
        duration: 3000,
      })
      return
    }

    if (children.length === 0) {
      api.ui.toast({ variant: "info", message: "No subagents found", duration: 2000 })
      return
    }

    const DialogSelect = api.ui.DialogSelect
    const options = children
      .map((child) => {
        const status = api.state.session.status(child.id)?.type
        const state = status === "busy" ? "● [active]" : status === "retry" ? "! [retry]" : "○ [idle]"
        return {
          status,
          title: `${state} ${title(child)}`,
          value: child.id,
          description: status ? `${status} · ${child.id}` : child.id,
        }
      })
      .sort((left, right) => {
        const rank = (status: typeof left.status) => (status === "busy" ? 0 : status === "retry" ? 1 : 2)
        return rank(left.status) - rank(right.status)
      })
    api.ui.dialog.replace(() => (
      <DialogSelect
        title="Subagents"
        placeholder="Search subagents"
        options={options}
        onSelect={(option) => {
          if (typeof option.value !== "string") return
          api.ui.dialog.clear()
          api.route.navigate("session", { sessionID: option.value })
        }}
      />
    ))
  }

  const SubagentControl = (props: { sessionID: string }) => {
    const [children, setChildren] = createSignal<Session[]>([])
    const [hovered, setHovered] = createSignal(false)
    let active = true
    const refresh = async () => {
      try {
        const next = await loadChildren(props.sessionID)
        if (active) setChildren(next)
      } catch (error) {
        if (!active) return
        api.ui.toast({
          variant: "error",
          title: "Subagents unavailable",
          message: `Failed to load subagents: ${message(error)}`,
          duration: 3000,
        })
        setChildren([])
      }
    }
    const offEvents = [
      api.event.on("session.created", () => void refresh()),
      api.event.on("session.updated", () => void refresh()),
      api.event.on("session.deleted", () => void refresh()),
    ]

    onMount(() => void refresh())
    onCleanup(() => {
      active = false
      for (const off of offEvents) off()
    })

    return (
      <box flexShrink={0}>
        <Show when={children().length}>
          <box
            flexShrink={0}
            backgroundColor={hovered() ? api.theme.current.backgroundElement : undefined}
            onMouseOver={() => setHovered(true)}
            onMouseOut={() => setHovered(false)}
            onMouseUp={() => void openPicker(props.sessionID)}
          >
            <text fg={hovered() ? api.theme.current.text : api.theme.current.textMuted}>Subagents</text>
          </box>
        </Show>
      </box>
    )
  }

  const offLayer = api.keymap.registerLayer({
    priority: 1,
    enabled: () => parentSessionID(api) !== undefined && !api.ui.dialog.open,
    commands: [
      {
        name: command,
        title: "Subagents",
        category: "Session",
        run() {
          const sessionID = parentSessionID(api)
          if (!sessionID) return
          return openPicker(sessionID)
        },
      },
    ],
    bindings: [{ key: "ctrl+x down", cmd: command }],
  })

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, value) {
        return <SubagentControl sessionID={value.session_id} />
      },
    },
  })

  api.lifecycle.onDispose(() => {
    offLayer()
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-sol-orchestrator.tui",
  tui: SolOrchestratorTuiPlugin,
}

export default plugin
