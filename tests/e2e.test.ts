import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Store } from "../store.ts"

const opencode = process.env.OPENCODE_BIN ?? Bun.which("opencode")
if (!opencode) throw new Error("Install OpenCode V1 1.18.35 or set OPENCODE_BIN")
const pluginDirectory = resolve(process.env.OPENCODE_CONTINUITY_PLUGIN_DIR ?? resolve(import.meta.dir, ".."))
const root = mkdtempSync(join(tmpdir(), "continuity-e2e-"))
const project = join(root, "project")
mkdirSync(project)
const stateRoot = join(root, "state")
const store = new Store(stateRoot)
const requests: any[] = []
const events: any[] = []
let processServer: ReturnType<typeof Bun.spawn>
let modelServer: ReturnType<typeof Bun.serve>
let base: string
let eventAbort = new AbortController()
let launchEnv: Record<string, string | undefined>
let refreshID: string
let cacheID: string
let cacheLastRequest: any
let releaseDelayed: (() => void) | undefined
let delayOnce = true
const handoff = "# Состояние проекта\n\nЦель: проверить достоверную передачу контекста.\nСделано: записан файл состояния.\nПроверки: подставная модель и изолированная база.\nСледующий шаг: продолжить с короткой историей, сохранив исходные ограничения.\n"

async function until<T>(read: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await read()
    if (result) return result as NonNullable<T>
    await Bun.sleep(25)
  }
  throw new Error(`Timeout; sandbox ${root}`)
}
async function request(path: string, body?: unknown) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000), method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "x-opencode-directory": project }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}
async function listenEvents() {
  const response = await fetch(base + "/event", { signal: eventAbort.signal, headers: { "x-opencode-directory": project } })
  const reader = response.body!.getReader()
  let buffer = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      buffer += new TextDecoder().decode(next.value)
      let index: number
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2)
        const line = block.split("\n").find(l => l.startsWith("data: "))
        if (line) events.push(JSON.parse(line.slice(6)))
      }
    }
  } catch (error) { if (!eventAbort.signal.aborted) throw error }
}
function stream(toolCall?: { name: string; args: unknown }, text = "Ответ готов.", input = 250000) {
  const header = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "gpt-continuity-test" }
  const chunks = toolCall ? [
    { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20 } },
  ] : [
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20 } },
  ]
  return new Response(chunks.map(c => `data: ${JSON.stringify({ ...header, ...c })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
}
function responsesStream(toolCall?: { name: string; args: unknown }) {
  const id = `resp_${requests.length}`
  const item = toolCall
    ? { id: `fc_${requests.length}`, type: "function_call", call_id: `call_${requests.length}`, name: toolCall.name, arguments: JSON.stringify(toolCall.args), status: "completed" }
    : { id: `msg_${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "CACHE_PREFIX_DONE", annotations: [] }] }
  const response = { id, object: "response", model: "gpt-continuity-responses", status: "completed", output: [item], usage: { input_tokens: 250000, output_tokens: 20, total_tokens: 250020, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 12345 }, output_tokens_details: { reasoning_tokens: 0 } } }
  const chunks: any[] = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } },
    { type: "response.output_item.added", output_index: 0, item: toolCall ? { ...item, status: "in_progress", arguments: "" } : { ...item, status: "in_progress", content: [] } },
    ...(toolCall
      ? [{ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: JSON.stringify(toolCall.args) }, { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: JSON.stringify(toolCall.args) }]
      : [{ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "CACHE_PREFIX_DONE" }, { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "CACHE_PREFIX_DONE" }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]
  return new Response(chunks.map((chunk, index) => `event: ${chunk.type}\ndata: ${JSON.stringify({ ...chunk, sequence_number: index })}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })
}
beforeAll(async () => {
  console.log(`E2E sandbox: ${root}`)
  modelServer = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (!req.url.endsWith("/chat/completions") && !req.url.endsWith("/responses")) return new Response("not found", { status: 404 })
    const body = await req.json() as any
    requests.push(body)
    if (req.url.endsWith("/responses")) {
      const results = body.input.filter((m: any) => m.type === "function_call_output")
      return responsesStream(results.length < 3 ? { name: "context_handoff", args: { operation: "label_current", current_title: "Проверка кеша Responses" } } : undefined)
    }
    const text = JSON.stringify(body.messages)
    if (text.includes("CASE_CACHE_PREFIX")) {
      const results = body.messages.filter((m: any) => m.role === "tool")
      return results.length < 3
        ? stream({ name: "context_handoff", args: { operation: "label_current", current_title: "Проверка стабильного кеша" } })
        : stream(undefined, "CACHE_PREFIX_DONE")
    }
    if (text.includes("CONTINUE_AFTER_DELAY") && !text.includes("CASE_DELAY_REFRESH")) {
      if (!delayOnce) return stream(undefined, "RECOVERED_AFTER_RESTART", 5000)
      delayOnce = false
      await new Promise<void>(resolve => { releaseDelayed = resolve })
      return stream(undefined, "DELAYED_RESPONSE", 5000)
    }
    if (text.includes("CASE_REFRESH") || text.includes("CASE_NEW") || text.includes("CASE_REJECT") || text.includes("NEW_CHAIN_CONTINUE") || text.includes("CASE_DELAY_REFRESH")) {
      const toolResults = body.messages.filter((m: any) => m.role === "tool")
      if (!toolResults.length) return stream({ name: "apply_patch", args: { patchText: `*** Begin Patch\n*** ${Bun.file(join(project, "HANDOFF.md")).size ? "Update" : "Add"} File: ${join(project, "HANDOFF.md")}\n${Bun.file(join(project, "HANDOFF.md")).size ? "@@\n-" + handoff.trimEnd().split("\n").join("\n-") + "\n" : ""}+${handoff.trimEnd().split("\n").join("\n+")}\n*** End Patch` } })
      if (toolResults.length === 1) return stream({ name: "context_handoff", args: {
        operation: text.includes("CASE_REFRESH") || text.includes("NEW_CHAIN_CONTINUE") || text.includes("CASE_DELAY_REFRESH") ? "refresh_current" : "start_session",
        handoff_path: join(project, "HANDOFF.md"), current_title: "Проверка исходной работы", next_title: "Продолжение проверки",
        continuation: text.includes("CASE_DELAY_REFRESH") ? "CONTINUE_AFTER_DELAY: продолжить после задержки."
          : text.includes("CASE_NEW_CHAIN") || text.includes("CASE_REFRESH_CHAIN") ? "NEW_CHAIN_CONTINUE: продолжить и обновить контекст без ручного сообщения."
          : text.includes("CASE_REFRESH") || text.includes("NEW_CHAIN_CONTINUE") ? "CONTINUE_AFTER_REFRESH: проверить сохранённое состояние." : "NEW_TOPIC_ONLY: самостоятельная задача; нужный файл /project/target.ts.", resume: !text.includes("CASE_REFRESH_PAUSE"),
      } })
      return stream(undefined, "Передача подготовлена, управление возвращено.")
    }
    if (text.includes("CONTINUE_AFTER_REFRESH")) return stream(undefined, "RESUMED_SHORT_CONTEXT", 5000)
    if (text.includes("NEW_TOPIC_ONLY")) return stream(undefined, "NEW_SESSION_DONE", 4000)
    return stream()
  } })
  const reserve = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = reserve.port!; reserve.stop(true)
  base = `http://127.0.0.1:${port}`
  writeFileSync(join(project, "AUDIT-INSTRUCTIONS.md"), "STABLE_INSTRUCTION_V1")
  const config = { plugin: [join(pluginDirectory, "index.ts")], instructions: [join(project, "AUDIT-INSTRUCTIONS.md")], model: "mock/gpt-continuity-test", snapshot: false,
    provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `http://127.0.0.1:${modelServer.port}/v1`, apiKey: "test" }, models: {
      "gpt-continuity-test": { name: "Test", limit: { context: 1000000, output: 4096 } },
    } }, mockresponses: { npm: "@ai-sdk/openai", name: "Mock Responses", options: { baseURL: `http://127.0.0.1:${modelServer.port}/v1`, apiKey: "test" }, models: {
      "gpt-continuity-responses": { name: "Responses test", limit: { context: 1000000, output: 4096 }, variants: { high: { reasoningEffort: "high" } } },
    } } },
  }
  writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 2))
  launchEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "xdg-state"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONTINUITY_STATE_DIR: stateRoot,
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" }
  processServer = Bun.spawn([opencode, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: project, env: launchEnv,
    stdout: Bun.file(join(root, "server.stdout.log")), stderr: Bun.file(join(root, "server.stderr.log")),
  })
  console.log(`E2E server: ${base}`)
  await until(async () => { try { return (await fetch(base + "/global/health", { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 25000)
  console.log("E2E health ready")
  void listenEvents()
  await until(() => events.some(e => e.type === "server.connected"))
}, 30000)
afterAll(async () => {
  releaseDelayed?.()
  eventAbort.abort()
  processServer?.kill()
  modelServer?.stop(true)
})
async function session(text: string, providerID = "mock") {
  const created = await request("/session", { title: "Изолированная проверка" })
  await request(`/session/${created.id}/prompt_async`, { model: { providerID, modelID: providerID === "mock" ? "gpt-continuity-test" : "gpt-continuity-responses" }, variant: providerID === "mock" ? undefined : "high", agent: "build", parts: [{ type: "text", text }] })
  return created.id as string
}
async function restartServer() {
  eventAbort.abort()
  processServer.kill(); await processServer.exited
  processServer = Bun.spawn([opencode!, "serve", "--port", new URL(base).port, "--hostname", "127.0.0.1"], {
    cwd: project, env: launchEnv, stdout: Bun.file(join(root, "restart.stdout.log")), stderr: Bun.file(join(root, "restart.stderr.log")),
  })
  await until(async () => { try { return (await fetch(base + "/global/health", { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 20000)
  eventAbort = new AbortController()
  const count = events.length
  void listenEvents()
  await until(() => events.slice(count).some(e => e.type === "server.connected"))
}

describe("Реальный OpenCode V1 и подставной провайдер", () => {
  test("сохраняет ранее отправленные границы кеша между вызовами инструментов", async () => {
    const start = requests.length
    const id = await session("CASE_CACHE_PREFIX")
    cacheID = id
    await until(async () => (await request(`/session/${id}/message`)).some((m: any) => m.info.finish === "stop"))
    const calls = requests.slice(start)
    expect(calls).toHaveLength(4)
    for (let index = 1; index < calls.length; index++) {
      const previous = calls[index - 1].messages
      expect(calls[index].messages.slice(0, previous.length)).toEqual(previous)
      expect(calls[index].tools).toEqual(calls[0].tools)
    }
    cacheLastRequest = calls.at(-1)
  }, 30000)
  test("Responses API сохраняет весь прошлый input и определения инструментов", async () => {
    const start = requests.length
    const id = await session("CASE_RESPONSES_CACHE", "mockresponses")
    await until(async () => (await request(`/session/${id}/message`)).some((m: any) => m.info.finish === "stop"))
    const calls = requests.slice(start)
    expect(calls).toHaveLength(4)
    for (let index = 1; index < calls.length; index++) {
      const previous = calls[index - 1].input
      expect(calls[index].input.slice(0, previous.length)).toEqual(previous)
      expect(calls[index].tools).toEqual(calls[0].tools)
      expect(calls[index].reasoning.effort).toBe("high")
      expect(calls[index].prompt_cache_key).toBe(id)
    }
    const history = await request(`/session/${id}/message`)
    const tokens = history.findLast((m: any) => m.info.role === "assistant").info.tokens
    expect(tokens.input + tokens.cache.read + tokens.cache.write).toBe(250000)
    expect(tokens.cache.write).toBe(12345)
  }, 30000)
  test("выключение до первого сообщения удаляет инструкции и схему инструмента", async () => {
    store.setEnabled(project, false)
    const start = requests.length
    const id = await session("CASE_OFF")
    await until(async () => (await request(`/session/${id}/message`)).some((m: any) => m.info.role === "assistant" && m.info.finish === "stop"))
    const body = requests[start]
    expect(JSON.stringify(body.messages)).not.toContain("## Context continuity")
    expect(JSON.stringify(body.tools)).not.toContain("context_handoff")
    const config = await request("/config")
    expect(config.compaction).toMatchObject({ auto: false, prune: false })
    store.setEnabled(project, true)
  }, 30000)
  test("обновляет контекст после завершения шага, оставляет архив и автоматически продолжает", async () => {
    const start = requests.length
    const id = await session("CASE_REFRESH OLD_ONLY_SECRET")
    refreshID = id
    await until(() => store.get(id, project).transition?.phase === "done")
    await until(() => requests.slice(start).some(b => JSON.stringify(b.messages).includes("CONTINUE_AFTER_REFRESH") && !JSON.stringify(b.messages).includes("OLD_ONLY_SECRET")))
    const resumed = requests.slice(start).find(b => JSON.stringify(b.messages).includes("CONTINUE_AFTER_REFRESH") && !JSON.stringify(b.messages).includes("OLD_ONLY_SECRET"))
    expect(JSON.stringify(resumed.messages)).toContain("## Context continuity")
    expect(JSON.stringify(resumed.messages)).toContain("## Working conditions and the user's concerns")
    expect(JSON.stringify(resumed.messages)).toContain("Состояние проекта")
    expect(store.get(id, project).epoch).toBe(2)
    const archive = await request(`/session/${id}/message`)
    expect(JSON.stringify(archive)).toContain("OLD_ONLY_SECRET")
    expect(archive.filter((m: any) => m.info.agent === "compaction")).toHaveLength(0)
  }, 30000)
  test("после перезапуска и выключения не возвращает архив и не отправляет инструмент", async () => {
    await until(async () => !(await request("/session/status"))[refreshID])
    // Имитируем аварию после ответа провайдера, но до окончательной отметки отправки.
    store.update(refreshID, project, s => { s.transition!.phase = "ready" })
    const beforeRestart = requests.length
    await restartServer()
    await request(`/session/${refreshID}`)
    await until(() => store.get(refreshID, project).transition?.phase === "done")
    expect(requests.length).toBe(beforeRestart)
    store.setEnabled(project, false, refreshID)
    const start = requests.length
    await request(`/session/${refreshID}/prompt_async`, { model: { providerID: "mock", modelID: "gpt-continuity-test" }, agent: "build", parts: [{ type: "text", text: "AFTER_RESTART" }] })
    await until(() => requests.length > start)
    const body = requests[start]
    expect(JSON.stringify(body.messages)).toContain("Состояние проекта")
    expect(JSON.stringify(body.messages)).not.toContain("OLD_ONLY_SECRET")
    expect(JSON.stringify(body.messages)).not.toContain("## Context continuity")
    expect(JSON.stringify(body.tools)).not.toContain("context_handoff")
    // Исторические заметки остаются неизменными после перезапуска и выключения помощника.
    store.setEnabled(project, false, cacheID)
    const cacheStart = requests.length
    await request(`/session/${cacheID}/prompt_async`, { model: { providerID: "mock", modelID: "gpt-continuity-test" }, agent: "build", parts: [{ type: "text", text: "CACHE_AFTER_RESTART" }] })
    await until(() => requests.length > cacheStart)
    expect(requests[cacheStart].messages.slice(1, cacheLastRequest.messages.length)).toEqual(cacheLastRequest.messages.slice(1))
  }, 30000)
  test("создаёт отдельную сессию только после явного разрешения и не переносит старую тему", async () => {
    const start = requests.length
    const id = await session("CASE_NEW OLD_TOPIC_ONLY")
    const approval = await until(() => events.find(e => e.type === "permission.asked" && e.properties.sessionID === id))
    expect(store.get(id, project).nextSessionID).toBeUndefined()
    await request(`/session/${id}/permissions/${approval.properties.id}`, { response: "once" })
    await until(() => store.get(id, project).transition?.phase === "done")
    const target = store.get(id, project).nextSessionID!
    expect(target).toBeTruthy()
    await until(() => requests.slice(start).some(b => JSON.stringify(b.messages).includes("NEW_TOPIC_ONLY") && !JSON.stringify(b.messages).includes("OLD_TOPIC_ONLY")))
    const created = await request(`/session/${target}`)
    expect(created.title).toBe("Продолжение проверки")
    const targetHistory = await request(`/session/${target}/message`)
    expect(JSON.stringify(targetHistory)).not.toContain("OLD_TOPIC_ONLY")
    expect(targetHistory.filter((m: any) => m.info.agent === "title")).toHaveLength(0)
  }, 30000)
  test("отказ в создании новой сессии не создаёт её", async () => {
    const id = await session("CASE_REJECT")
    const approval = await until(() => events.find(e => e.type === "permission.asked" && e.properties.sessionID === id))
    await request(`/session/${id}/permissions/${approval.properties.id}`, { response: "reject" })
    await until(async () => !(await request("/session/status"))[id])
    expect(store.get(id, project).nextSessionID).toBeUndefined()
  }, 30000)
  test("новая сессия может обновить контекст в автоматическом продолжении без ручного ввода", async () => {
    const id = await session("CASE_NEW_CHAIN OLD_TOPIC_ONLY")
    const approval = await until(() => events.find(e => e.type === "permission.asked" && e.properties.sessionID === id))
    await request(`/session/${id}/permissions/${approval.properties.id}`, { response: "once" })
    const target = await until(() => store.get(id, project).nextSessionID)
    await until(() => store.get(target, project).transition?.phase === "done")
    expect(store.get(target, project).epoch).toBe(2)
    expect(store.get(target, project).transition?.operation).toBe("refresh_current")
  }, 30000)
  test("не считает отправку завершением и восстанавливает прерванное продолжение после перезапуска", async () => {
    const id = await session("CASE_DELAY_REFRESH")
    await until(() => releaseDelayed && store.get(id, project).transition?.phase === "dispatched")
    const promptID = store.get(id, project).transition!.promptID
    expect(store.get(id, project).transition!.phase).not.toBe("done")
    await restartServer()
    releaseDelayed!()
    await request(`/session/${id}`)
    await until(() => store.get(id, project).transition?.phase === "done")
    const history = await request(`/session/${id}/message`)
    expect(history.filter((m: any) => m.parts.some((p: any) => p.metadata?.continuityResume))).toHaveLength(1)
    expect(store.get(id, project).transition!.promptID).toBe(promptID)
    expect(JSON.stringify(history)).toContain("RECOVERED_AFTER_RESTART")
  }, 30000)
  test("автоматическое продолжение той же сессии может сделать следующую границу", async () => {
    const id = await session("CASE_REFRESH_CHAIN")
    await until(() => store.get(id, project).epoch === 3 && store.get(id, project).transition?.phase === "done")
    expect(store.get(id, project).checkpoints).toHaveLength(2)
    expect(store.get(id, project).transition?.targetID).toBe(id)
  }, 30000)
  test("новое уточнение во время разрешения отменяет устаревший переход", async () => {
    const id = await session("CASE_NEW_CHANGED")
    const approval = await until(() => events.find(e => e.type === "permission.asked" && e.properties.sessionID === id))
    await request(`/session/${id}/message`, { model: { providerID: "mock", modelID: "gpt-continuity-test" }, agent: "build", noReply: true, parts: [{ type: "text", text: "EXTRA_USER_CHANGE: изменились требования." }] })
    await request(`/session/${id}/permissions/${approval.properties.id}`, { response: "once" })
    await until(() => store.get(id, project).transition?.phase === "cancelled")
    expect(store.get(id, project).nextSessionID).toBeUndefined()
  }, 30000)
  test("resume=false сохраняет короткий контекст и не запускает модель до сообщения владельца", async () => {
    const start = requests.length
    const id = await session("CASE_REFRESH_PAUSE")
    await until(() => store.get(id, project).transition?.phase === "done")
    expect(requests.length - start).toBe(3)
    expect(store.get(id, project).epoch).toBe(2)
    const history = await request(`/session/${id}/message`)
    const continuation = history.find((m: any) => m.parts.some((p: any) => p.metadata?.continuityResume))
    expect(history.some((m: any) => m.info.role === "assistant" && m.info.parentID === continuation.info.id)).toBe(false)
    await request(`/session/${id}/prompt_async`, { model: { providerID: "mock", modelID: "gpt-continuity-test" }, agent: "build", parts: [{ type: "text", text: "CONTINUE_PAUSED_STAGE" }] })
    await until(() => requests.length > start + 3)
    expect(JSON.stringify(requests[start + 3].messages)).not.toContain("CASE_REFRESH_PAUSE")
    await until(async () => !(await request("/session/status"))[id])
  }, 30000)
  test("OpenCode перечитывает файлы системных инструкций между запросами без перезапуска", async () => {
    writeFileSync(join(project, "AUDIT-INSTRUCTIONS.md"), "STABLE_INSTRUCTION_V2")
    try {
      const start = requests.length
      const id = await session("CASE_SYSTEM_RELOAD")
      await until(async () => (await request(`/session/${id}/message`)).some((m: any) => m.info.finish === "stop"))
      expect(JSON.stringify(requests[start].messages)).toContain("STABLE_INSTRUCTION_V2")
      expect(JSON.stringify(requests[start].messages)).not.toContain("STABLE_INSTRUCTION_V1")
    } finally { writeFileSync(join(project, "AUDIT-INSTRUCTIONS.md"), "STABLE_INSTRUCTION_V1") }
  }, 30000)
})
