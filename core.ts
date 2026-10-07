import { readFileSync } from "node:fs"
import { hash, type SessionState, type Transition } from "./store.ts"

export const TOOL = "context_handoff"
export const NEW_SESSION_PERMISSION = "continuity_new_session"
export const WORKING_PERCENT = 28
export type Message = { info: any; parts: any[] }

export function realUser(message: Message) {
  return message.info.role === "user" && message.parts.some(p => !p.ignored && !p.synthetic)
}
export function requestUser(message: Message) {
  return realUser(message) || message.info.role === "user" && message.parts.some(p => !p.ignored && p.metadata?.continuityResume)
}
export function sourceUser(messages: Message[], transition?: Transition) {
  return messages.findLast(m => requestUser(m) && !m.parts.some(p => transition && p.metadata?.continuityResume === transition.id))
}
export function usageOf(tokens: any) {
  const input = (tokens?.input ?? 0) + (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0)
  return { input, total: tokens?.total || input + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0) }
}
export function estimate(text: string) { return Math.ceil(text.length / 3) }
export function checkpointText(state: SessionState) {
  const boundary = state.boundary!
  const text = readFileSync(boundary.path, "utf8")
  if (hash(text) !== boundary.hash) throw new Error("Continuity checkpoint checksum mismatch")
  return `## State handoff: ${boundary.nextTitle}\n\n${text}\n\n## Continuation\n${boundary.continuation}`
}

// Приём адаптирован из MIT-референса opencode-cache-compact: меняется только отправляемая история.
export function cutMessages(messages: Message[], state: SessionState) {
  if (!state.boundary) return
  const index = messages.findIndex(m => m.info.id === state.boundary!.carrierID)
  if (index < 0) throw new Error("Context boundary is missing. History may have been reverted before the transition; open the continuity panel.")
  const carrier = messages[index]
  const text = checkpointText(state)
  carrier.parts = [{ type: "text", text, synthetic: true, ignored: false,
    sessionID: carrier.info.sessionID, messageID: carrier.info.id }]
  messages.splice(0, index)
}

// Уже отправленная заметка остаётся на прежнем месте: её конец служит границей кеша OpenAI.
export function insertNotices(messages: Message[], state: SessionState) {
  const notices = new Map((state.notices ?? []).map(n => [n.afterID, n.text]))
  const result: Message[] = []
  for (const message of messages) {
    result.push(message)
    const text = notices.get(message.info.id)
    if (text === undefined) continue
    result.push({ info: { id: `${message.info.id}_continuity`, sessionID: message.info.sessionID, role: "user", time: message.info.time },
      parts: [{ type: "text", text, synthetic: true, ignored: false }] })
  }
  messages.splice(0, messages.length, ...result)
}

export function reality(state: SessionState, messages: Message[]) {
  const usage = state.usage
  const newest = messages.findLast(m => m.info.role === "assistant" && m.info.tokens && usageOf(m.info.tokens).total > 0)
  const measured = newest ? usageOf(newest.info.tokens) : state.boundary ? undefined : usage
  const context = state.contextLimit ?? usage?.context ?? 0
  if (!context || !measured && !state.boundary) return "Context usage: the first request has not completed; no measured usage is available yet. The owner's working reference is about 28% of the window."
  // После границы старые показатели не описывают новый короткий запрос.
  const fresh = !!state.boundary && !newest
  const lastIndex = newest ? messages.indexOf(newest) : -1
  const tail = lastIndex >= 0 ? messages.slice(lastIndex).flatMap(m => m.parts)
    .filter(p => p.type === "tool" && p.state?.status === "completed").map(p => p.state.output ?? "").join("\n") : ""
  const input = fresh ? estimate(JSON.stringify(messages)) : measured!.input
  const used = fresh ? input : measured!.total
  const added = fresh ? 0 : estimate(tail)
  return [
    "## Current context conditions",
    `${fresh ? "Approximate history after refresh (excluding system instructions and tool schemas)" : "Measured input of the last request, including cache"}: ${input.toLocaleString("en-US")} tokens.`,
    ...(!fresh ? [`Including the last request's response: ${used.toLocaleString("en-US")} tokens.`] : []),
    `Window size: ${context.toLocaleString("en-US")}. ${fresh ? "Approximate" : "Measured"} occupancy: ${(100 * used / context).toFixed(1)}%.`,
    `Room up to the observed ${WORKING_PERCENT}% working reference: ${Math.floor(context * WORKING_PERCENT / 100 - used - added).toLocaleString("en-US")} tokens (a negative value means it has been exceeded).`,
    `Technical room remaining: about ${Math.max(0, context - used - added).toLocaleString("en-US")} tokens; the future response also needs space.`,
    ...(added ? [`New tool results: approximately ${added.toLocaleString("en-US")} additional tokens; exact usage will be reported by the provider after the request.`] : []),
    `Stage ${state.epoch}. This is information for your decision, not an instruction to transition.`,
  ].join("\n")
}

export type Decision = "wait" | "cancel" | "commit" | "dispatch" | "done"
// Решение относится только к уже выбранному переходу, а не к процентному порогу.
export function reconcile(input: { transition?: Transition; idle: boolean; runningTools: boolean; latestUserID?: string; handoffHash?: string }): Decision {
  const t = input.transition
  if (!t || ["done", "error", "cancelled"].includes(t.phase)) return "done"
  if (!input.idle || input.runningTools) return "wait"
  if (t.phase !== "dispatched" && (input.latestUserID !== t.sourceUserID || input.handoffHash !== t.checkpoint.hash)) return "cancel"
  return t.phase === "prepared" ? "commit" : "dispatch"
}
