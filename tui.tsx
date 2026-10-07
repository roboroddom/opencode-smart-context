/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, Show } from "solid-js"
import { watch, readFileSync } from "node:fs"
import { Store } from "./store.ts"

const tui: TuiPlugin = async (api) => {
  const store = new Store()
  const [revision, setRevision] = createSignal(0)
  let queued = false
  const bump = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; setRevision(value => value + 1) })
  }
  const watcher = watch(store.root, { recursive: true }, bump)
  api.lifecycle.onDispose(() => watcher.close())
  const directory = () => api.state.path.directory
  const activeID = () => api.route.current.name === "session" ? api.route.current.params?.sessionID as string : undefined
  const enabled = (id?: string) => { revision(); return store.enabled(directory(), id) }
  const state = (id: string) => { revision(); return store.get(id, directory()) }

  function status(id?: string) {
    const mode = enabled(id) ? "ON" : "OFF"
    if (!id) return `Context continuity: ${mode}`
    const s = state(id)
    const fresh = s.boundary && (!s.usage || s.usage.at <= s.boundary.at)
    const used = fresh ? undefined : s.usage?.total
    const limit = s.contextLimit
    return `Context: ${mode}${used !== undefined && limit ? ` · ${(100 * used / limit).toFixed(1)}%` : fresh ? " · refreshed" : ""} · stage ${s.epoch}`
  }
  function alert(title: string, message: string) {
    api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message }))
    api.ui.dialog.setSize("large")
  }
  function toggle(id?: string) {
    const value = !enabled(id)
    store.setEnabled(directory(), value, id)
    bump()
    api.ui.toast({ variant: "info", message: value
      ? "Helper enabled. Information will appear in the next request."
      : "Helper disabled. No new instructions, measurements, or tool schema will be sent. The saved boundary remains." })
    openPanel()
  }
  function showState(id: string) {
    const s = state(id)
    const limit = s.contextLimit
    const input = s.usage?.input
    const t = s.transition
    alert("Context capacity", [
      status(id),
      input !== undefined && limit ? `Last measured input: ${input.toLocaleString("en-US")} tokens.\nIncluding the response: ${s.usage!.total.toLocaleString("en-US")}.\nWindow: ${limit.toLocaleString("en-US")}.\nRoom up to the 28% reference: ${Math.floor(limit * .28 - s.usage!.total).toLocaleString("en-US")}.` : "Measured usage will appear after the first response.",
      s.boundary ? "After a refresh, initial measurements may still describe the old request. History before the boundary is preserved in the database." : "Context has not been refreshed yet.",
      t ? `Last transition: ${t.phase}${t.targetID ? `\nSession: ${t.targetID}` : ""}` : "No transitions yet.",
      s.error ? `Problem: ${s.error}` : "",
      "The model decides when to transition. Built-in automatic compaction is disabled in the instance running this plugin's server part.",
    ].filter(Boolean).join("\n\n"))
  }
  function showHistory(id: string) {
    const s = state(id)
    const options = s.checkpoints.map(cp => ({
      title: `${cp.title} · ${new Date(cp.at).toLocaleString("en-US")}`,
      value: cp.id, description: `Handoff snapshot · stage ${cp.epoch}`,
      onSelect: () => alert(cp.title, readFileSync(cp.path, "utf8")),
    }))
    for (const [title, sessionID] of [["Open previous session", s.originID], ["Open next session", s.nextSessionID]]) {
      if (sessionID) options.push({ title: title!, value: sessionID, description: sessionID,
        onSelect: () => { api.ui.dialog.clear(); api.route.navigate("session", { sessionID }) } })
    }
    if (!options.length) return alert("Stages", "No transitions yet.")
    api.ui.dialog.replace(() => api.ui.DialogSelect({ title: "Stages and handoffs", options }))
  }
  async function prepare(id: string) {
    api.ui.dialog.clear()
    try {
      const s = state(id)
      const messages = api.state.session.messages(id)
      const user = messages.findLast(m => m.role === "user") as any
      const model = s.model ?? user?.model
      if (!model) throw new Error("Select a model and send the first message first")
      const result = await api.client.session.promptAsync({ sessionID: id, directory: directory(),
        agent: s.agent ?? user?.agent, model: { providerID: model.providerID, modelID: model.modelID }, variant: model.variant,
        parts: [{ type: "text", text: "Prepare a context refresh for the current session. First make HANDOFF accurate and up to date, then use context_handoff with refresh_current. Continue only already assigned, unfinished work; if we were only discussing, leave the next stage ready for my message." }],
      })
      if (result.error) throw new Error(JSON.stringify(result.error))
    } catch (error) { api.ui.toast({ variant: "error", message: String(error) }) }
  }
  function openPanel() {
    const id = activeID()
    const options = [{ title: enabled(id) ? "Disable helper" : "Enable helper", value: "toggle",
      description: id ? "For the current session" : "For new sessions in this directory", onSelect: () => toggle(id) }]
    if (id) {
      options.push({ title: "Measurements and state", value: "status", description: "No model request", onSelect: () => showState(id) })
      options.push({ title: "Stages and HANDOFF snapshots", value: "history", description: "Saved history", onSelect: () => showHistory(id) })
      if (enabled(id)) options.push({ title: "Prepare context refresh", value: "prepare", description: "The current model updates HANDOFF first", onSelect: () => { void prepare(id) } })
    }
    api.ui.dialog.replace(() => api.ui.DialogSelect({ title: status(id), options }))
  }
  api.keymap.registerLayer({ commands: [{ namespace: "palette", name: "continuity.panel",
    title: "Context continuity", desc: "Capacity, toggle, transitions, and HANDOFF", category: "Context",
    slashName: "continuity", run: openPanel,
  }] })

  function Indicator(props: { id?: string; compact?: boolean }) {
    return <box flexDirection="column" onMouseUp={openPanel}>
      <text fg={enabled(props.id) ? api.theme.current.accent : api.theme.current.textMuted}>{status(props.id)}</text>
      <Show when={!props.compact}><text fg={api.theme.current.textMuted}>/continuity · controls and history</text></Show>
    </box>
  }
  api.slots.register({ order: 105, slots: {
    home_prompt_right: () => <Indicator compact />,
    sidebar_content: (_ctx, props) => <Indicator id={props.session_id} />,
    session_prompt_right: (_ctx, props) => <Indicator id={props.session_id} compact />,
  } })
}

export default { id: "context-continuity", tui }
