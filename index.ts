import { tool, type Plugin } from "@opencode-ai/plugin"
import { readFileSync, statSync, realpathSync } from "node:fs"
import { dirname, resolve, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { Store, hash, type ModelRef, type Transition } from "./store.ts"
import { TOOL, NEW_SESSION_PERMISSION, cutMessages, reality, realUser, reconcile, usageOf, type Message } from "./core.ts"

const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "CONTEXT-CONTINUITY-PROMPT.md")
const RULES = readFileSync(promptPath, "utf8").split("## Working conditions")[1]
const instructions = `## Context continuity\n\n## Working conditions${RULES}\n\nTool context_handoff: refresh_current refreshes context in this session; start_session asks the user for permission to create a separate session; label_current updates the title. After saving HANDOFF and calling the transition tool, finish your current response and yield control. Use resume=true only for an already assigned, unfinished task; for discussion without an assignment, use resume=false. The plugin does not call a separate summarizer.`

function unwrap<T = any>(response: any): T {
  if (response?.error) throw new Error(JSON.stringify(response.error))
  return (response?.data ?? response) as T
}
function idFrom(result: any) { return result?.info?.id ?? result?.id }

export default (async ({ client, directory }) => {
  const api = client as any
  const store = new Store()
  const driving = new Set<string>()
  let disposed = false

  async function log(error: unknown, sessionID?: string) {
    await api.app.log({ body: { service: "context-continuity", level: "error", message: String(error), extra: { sessionID } } }).catch(() => {})
  }
  async function toast(message: string, variant = "info") {
    await api.tui.showToast({ body: { title: "Context continuity", message, variant, duration: 6000 } }).catch(() => {})
  }
  async function messages(sessionID: string): Promise<Message[]> {
    return unwrap(await api.session.messages({ path: { id: sessionID } }))
  }
  function modelBody(model: ModelRef) {
    return { model: { providerID: model.providerID, modelID: model.modelID }, variant: model.variant }
  }
  async function note(sessionID: string, t: Transition, text: string) {
    return unwrap(await api.session.prompt({ path: { id: sessionID }, body: {
      agent: t.agent, ...modelBody(t.model), noReply: true,
      parts: [{ type: "text", text, synthetic: true, ignored: true, metadata: { continuity: t.id } }],
    } }))
  }
  async function runTransition(sessionID: string) {
    if (disposed || driving.has(sessionID)) return
    const release = store.claim(sessionID)
    if (!release) return
    driving.add(sessionID)
    try {
      let state = store.get(sessionID, directory)
      let t = state.transition
      if (!t || ["done", "error", "cancelled"].includes(t.phase)) return
      const all = await messages(sessionID)
      const statuses = unwrap(await api.session.status())
      const isIdle = statuses[sessionID]?.type !== "busy" && statuses[sessionID]?.type !== "retry"
      const latest = all.findLast(realUser)
      const runningTools = all.some(m => m.parts.some(p => p.type === "tool" && ["pending", "running"].includes(p.state?.status)))
      let currentHash: string | undefined
      try { currentHash = hash(readFileSync(t.checkpoint.sourcePath, "utf8")) } catch {}
      const decision = reconcile({ transition: t, idle: isIdle, runningTools, latestUserID: latest?.info.id, handoffHash: currentHash })
      if (decision === "wait" || decision === "done") return
      if (decision === "cancel") {
        store.update(sessionID, directory, s => { s.transition!.phase = "cancelled"; s.error = "The handoff is stale: requirements or HANDOFF changed. Update it first." })
        await toast("Transition cancelled: requirements or HANDOFF changed.", "warning")
        return
      }
      if (decision === "commit") {
        if (t.operation === "refresh_current") {
          // На восстановлении ищем уже записанную отметку, а не создаём второй переход.
          let carrier = all.find(m => m.parts.some(p => p.metadata?.continuity === t!.id))
          if (!carrier) carrier = await note(sessionID, t, `↻ Stage ${state.epoch + 1}: ${t.checkpoint.nextTitle}\nPrevious stage: ${t.checkpoint.title}\nHANDOFF saved. History before this marker remains archived.`)
          const carrierID = idFrom(carrier)
          if (!carrierID) throw new Error("No context boundary ID received")
          const now = Date.now()
          store.update(sessionID, directory, s => {
            const cp = { ...t!.checkpoint, carrierID, at: now, epoch: s.epoch + 1 }
            s.boundary = cp; s.checkpoints.push(cp); s.epoch++; s.title = cp.nextTitle
            s.transition!.checkpoint = cp; s.transition!.targetID = sessionID; s.transition!.phase = "ready"
          })
          await api.session.update({ path: { id: sessionID }, body: { title: t.checkpoint.nextTitle } }).then(unwrap)
        } else {
          const sessions = unwrap<any[]>(await api.session.list())
          let target = sessions.find(s => s.metadata?.continuityTransition === t!.id)
          if (!target) {
            const source = unwrap(await api.session.get({ path: { id: sessionID } }))
            target = unwrap(await api.session.create({ body: {
              title: t.checkpoint.nextTitle, agent: t.agent,
              model: { id: t.model.modelID, providerID: t.model.providerID, variant: t.model.variant },
              permission: source.permission,
              metadata: { continuityTransition: t.id, continuityOrigin: sessionID },
            } }))
          }
          if (!target?.id) throw new Error("No new session ID received")
          store.update(target.id, directory, s => {
            s.originID = sessionID; s.model = t!.model; s.agent = t!.agent; s.title = t!.checkpoint.nextTitle
          })
          store.setEnabled(directory, store.enabled(directory, sessionID), target.id)
          store.update(sessionID, directory, s => {
            s.checkpoints.push(t!.checkpoint); s.nextSessionID = target.id; s.transition!.targetID = target.id; s.transition!.phase = "ready"
          })
          await api.session.update({ path: { id: sessionID }, body: { title: t.checkpoint.title } }).then(unwrap)
          await note(sessionID, t, `→ Separate session: ${t.checkpoint.nextTitle}\nID: ${target.id}\nThe previous work's state is saved in HANDOFF.`)
        }
      }
      state = store.get(sessionID, directory); t = state.transition!
      const updatedSource = await messages(sessionID)
      if (updatedSource.findLast(realUser)?.info.id !== t.sourceUserID) {
        store.update(sessionID, directory, s => { s.transition!.phase = "cancelled"; s.error = "New user input arrived during the transition. Automatic continuation cancelled." })
        await toast("New user input received. Automatic continuation cancelled.", "warning")
        return
      }
      const targetID = t.targetID!
      // Уникальный ID сообщения делает восстановление отправки идемпотентным.
      const targetMessages = targetID === sessionID ? await messages(sessionID) : await messages(targetID)
      let admitted = targetMessages.find(m => m.parts.some(p => p.metadata?.continuityResume === t!.id))
      if (!admitted) {
        const text = t.operation === "refresh_current"
          ? `Continuation of stage ${state.epoch}.\n${t.checkpoint.continuation}`
          : t.targetPrompt!
        admitted = unwrap(await api.session.prompt({ path: { id: targetID }, body: {
          agent: t.agent, ...modelBody(t.model), noReply: true,
          parts: [{ type: "text", text, synthetic: true, metadata: { continuityResume: t.id } }],
        } }))
      }
      if (!admitted || !idFrom(admitted)) throw new Error("No saved continuation message received")
      store.update(sessionID, directory, s => { s.transition!.promptID = idFrom(admitted) })
      // SDK V1 не экспортирует selectSession, но поддерживает тот же штатный TUI-event через publish.
      if (t.operation === "start_session") await api.tui.publish({ body: { type: "tui.session.select", properties: { sessionID: targetID } } }).then(unwrap)
      if (t.resume) {
        const status = unwrap(await api.session.status())[targetID]
        if (status && status.type !== "idle") return
        const finished = targetMessages.findLast(m => m.info.role === "assistant" && m.info.parentID === idFrom(admitted))
        if (finished?.info.error) throw new Error("Continuation failed; it will not be retried automatically")
        if (finished?.info.finish && finished.info.finish !== "tool-calls" && finished.info.time.completed) {
          store.update(sessionID, directory, s => { s.transition!.phase = "done"; s.error = undefined })
          return
        }
        // Повторяется тот же ID и те же части, а не создаётся второе поручение после аварии.
        await api.session.promptAsync({ path: { id: targetID }, body: {
          messageID: idFrom(admitted), agent: t.agent, ...modelBody(t.model), parts: admitted.parts,
        } }).then(unwrap)
        store.update(sessionID, directory, s => { s.transition!.phase = "dispatched" })
      }
      store.update(sessionID, directory, s => { s.transition!.phase = "done"; s.error = undefined })
      await toast(t.operation === "refresh_current" ? `Context refreshed. Stage ${state.epoch}.` : `Opened session “${t.checkpoint.nextTitle}”.`, "success")
    } catch (error) {
      store.update(sessionID, directory, s => { s.error = String(error); if (s.transition) { s.transition.error = String(error); s.transition.phase = "error" } })
      await log(error, sessionID); await toast(`Transition stopped: ${String(error)}`, "error")
    } finally { driving.delete(sessionID); release() }
  }
  function schedule(sessionID: string) { queueMicrotask(() => { void runTransition(sessionID) }) }

  // Отложенное восстановление начинается после завершения инициализации серверного плагина.
  const recovery = setTimeout(() => {
    for (const state of store.list()) if (state.directory === directory && state.transition) schedule(state.sessionID)
  }, 100)
  recovery.unref()
  return {
    config: async (config) => {
      // Старый SDK V1 не описывает часть реально поддерживаемой схемы 1.18.34.
      const cfg = config as any
      cfg.compaction = { ...cfg.compaction, auto: false, prune: false }
      const permissions = typeof cfg.permission === "string" ? { "*": cfg.permission } : { ...cfg.permission }
      cfg.permission = { ...permissions, [NEW_SESSION_PERMISSION]: "ask" }
    },
    "chat.message": async (_input, output) => {
      const msg = { info: output.message, parts: output.parts }
      if (!realUser(msg)) return
      store.ensureSessionEnabled(directory, output.message.sessionID)
      store.update(output.message.sessionID, directory, s => {
        s.latestUserID = output.message.id; s.agent = output.message.agent; s.model = output.message.model
      })
    },
    "chat.params": async (input) => {
      if (["title", "summary", "compaction"].includes(input.agent)) return
      const enabled = store.enabled(directory, input.sessionID)
      // Отфильтровывается сама схема инструмента; остальные разрешения пользователя не меняются.
      input.message.tools = { ...input.message.tools, [TOOL]: enabled }
      store.update(input.sessionID, directory, s => {
        s.contextLimit = input.model.limit.context; s.agent = input.agent
        s.model = { providerID: input.model.providerID, modelID: input.model.id, variant: (input.message.model as any).variant }
      })
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      if (/^You are a (?:title generator|helpful AI assistant tasked with summarizing|anchored context summarization)/.test((output.system[0] ?? "").trimStart())) return
      store.update(input.sessionID, directory, s => { s.contextLimit = input.model.limit.context })
      if (store.enabled(directory, input.sessionID)) output.system[0] = `${output.system[0] ?? ""}\n\n${instructions}`
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const all = output.messages as Message[]
      const sessionID = all[0]?.info.sessionID
      if (!sessionID) return
      const state = store.get(sessionID, directory)
      cutMessages(all, state)
      if (!store.enabled(directory, sessionID)) return
      const user = all.findLast(m => m.info.role === "user")
      if (!user) return
      all.push({ info: { ...user.info, id: `${user.info.id}_continuity` }, parts: [
        { type: "text", text: reality(state, all), synthetic: true, ignored: false },
      ] })
    },
    event: async ({ event }: any) => {
      if (event.type === "session.created") {
        const info = event.properties.info
        const sessionID = info?.id ?? event.properties.sessionID
        if (sessionID) store.ensureSessionEnabled(directory, sessionID)
      }
      if (event.type === "message.updated") {
        const info = event.properties.info
        if (info.role === "assistant" && !info.summary && usageOf(info.tokens).total > 0) {
          store.update(info.sessionID, directory, s => { s.usage = {
            ...usageOf(info.tokens), context: s.contextLimit ?? 0, messageID: info.id, at: Date.now(),
          } })
        }
      }
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        if (status.type === "idle") {
          schedule(sessionID)
          for (const s of store.list()) if (s.directory === directory && s.transition?.targetID === sessionID && s.sessionID !== sessionID) schedule(s.sessionID)
        }
      }
      if (event.type === "session.idle") schedule(event.properties.sessionID)
      if (event.type === "server.connected") for (const state of store.list()) if (state.directory === directory && state.transition) schedule(state.sessionID)
    },
    tool: {
      [TOOL]: tool({
        description: "Refresh the current session's context, create a separate session with explicit user approval, or update the title. First update and save HANDOFF. start_session asks for permission in the UI. After preparing a transition, finish your response; the plugin continues after current actions complete.",
        args: {
          operation: tool.schema.enum(["refresh_current", "start_session", "label_current"]),
          handoff_path: tool.schema.string().optional().describe("Absolute path to the updated project state file"),
          current_title: tool.schema.string().min(3).max(160).describe("Accurate title of the completed work, not just its first message"),
          next_title: tool.schema.string().min(3).max(160).optional(),
          continuation: tool.schema.string().optional().describe("Concrete next step; for a new topic, a minimal self-contained request with paths and scope"),
          resume: tool.schema.boolean().optional().describe("Continue only already assigned, unfinished work; false for discussion"),
        },
        execute: async (args, context) => {
          const sessionID = context.sessionID
          if (!store.enabled(directory, sessionID)) throw new Error("Context continuity is disabled for this session")
          const state = store.get(sessionID, directory)
          if (args.operation === "label_current") {
            await api.session.update({ path: { id: sessionID }, body: { title: args.current_title } }).then(unwrap)
            store.update(sessionID, directory, s => { s.title = args.current_title })
            return "Title updated without a separate model request."
          }
          if (state.transition && !["done", "cancelled", "error"].includes(state.transition.phase)) throw new Error("The previous transition is still in progress")
          if (!args.handoff_path || !args.continuation?.trim() || !args.next_title) throw new Error("Save HANDOFF first; provide its path, the next step, and the continuation title")
          const path = realpathSync(resolve(context.directory, args.handoff_path))
          if (!/\.(md|txt)$/i.test(basename(path))) throw new Error("The handoff must be a text state file")
          const all = await messages(sessionID)
          const latest = all.findLast(realUser)
          const assistant = all.find(m => m.info.id === context.messageID)
          const parentIndex = all.findIndex(m => m.info.id === assistant?.info.parentID)
          if (!latest || parentIndex < 0 || all.indexOf(latest) > parentIndex) throw new Error("New user input arrived. Incorporate it into HANDOFF first")
          const stat = statSync(path)
          if (stat.mtimeMs + 5 < all[parentIndex].info.time.created) throw new Error("HANDOFF has not been updated since the current request. Bring it up to date first")
          const text = readFileSync(path, "utf8")
          if (text.trim().length < 100) throw new Error("HANDOFF is too short for a reliable state transfer")
          if (args.operation === "start_session") {
            await context.ask({ permission: NEW_SESSION_PERMISSION, patterns: [args.next_title], always: [], metadata: {
              title: `Create a separate session “${args.next_title}”?`,
              description: "The current session will be preserved. The new one receives only the specified request and opens in this window.",
              prompt: args.continuation, resume: args.resume ?? false,
            } })
          }
          if (context.abort.aborted) throw new Error("Handoff cancelled")
          if (hash(readFileSync(path, "utf8")) !== hash(text)) throw new Error("HANDOFF changed during approval. Verify the current handoff first")
          const id = randomUUID()
          const snapshot = store.snapshot(id, text)
          const model = state.model ?? latest.info.model
          const transition: Transition = {
            id, operation: args.operation, phase: "prepared", sourceUserID: latest.info.id,
            sourceAssistantID: context.messageID, agent: state.agent ?? context.agent, model,
            resume: args.resume ?? false, targetDirectory: context.directory,
            targetPrompt: args.operation === "start_session" ? args.continuation : undefined,
            checkpoint: { id, at: Date.now(), title: args.current_title, nextTitle: args.next_title,
              sourcePath: path, path: snapshot, hash: hash(text), continuation: args.continuation, epoch: state.epoch },
          }
          store.update(sessionID, directory, s => { s.transition = transition; s.error = undefined })
          return "HANDOFF saved and checked. Transition prepared. Finish your current response with a brief confirmation and yield control; actions already in progress will not be interrupted."
        },
      }),
    },
    dispose: async () => { disposed = true; clearTimeout(recovery) },
  }
}) satisfies Plugin
