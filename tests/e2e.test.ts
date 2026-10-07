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
beforeAll(async () => {
  console.log(`E2E sandbox: ${root}`)
  modelServer = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (!req.url.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = await req.json() as any
    requests.push(body)
    const text = JSON.stringify(body.messages)
    if (text.includes("CASE_REFRESH") || text.includes("CASE_NEW") || text.includes("CASE_REJECT")) {
      const toolResults = body.messages.filter((m: any) => m.role === "tool")
      if (!toolResults.length) return stream({ name: "apply_patch", args: { patchText: `*** Begin Patch\n*** ${Bun.file(join(project, "HANDOFF.md")).size ? "Update" : "Add"} File: ${join(project, "HANDOFF.md")}\n${Bun.file(join(project, "HANDOFF.md")).size ? "@@\n-" + handoff.trimEnd().split("\n").join("\n-") + "\n" : ""}+${handoff.trimEnd().split("\n").join("\n+")}\n*** End Patch` } })
      if (toolResults.length === 1) return stream({ name: "context_handoff", args: {
        operation: text.includes("CASE_REFRESH") ? "refresh_current" : "start_session",
        handoff_path: join(project, "HANDOFF.md"), current_title: "Проверка исходной работы", next_title: "Продолжение проверки",
        continuation: text.includes("CASE_REFRESH") ? "CONTINUE_AFTER_REFRESH: проверить сохранённое состояние." : "NEW_TOPIC_ONLY: самостоятельная задача; нужный файл /project/target.ts.", resume: true,
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
  const config = { plugin: [join(pluginDirectory, "index.ts")], model: "mock/gpt-continuity-test", snapshot: false,
    provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `http://127.0.0.1:${modelServer.port}/v1`, apiKey: "test" }, models: {
      "gpt-continuity-test": { name: "Test", limit: { context: 1000000, output: 4096 } },
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
  eventAbort.abort()
  processServer?.kill()
  modelServer?.stop(true)
})
async function session(text: string) {
  const created = await request("/session", { title: "Изолированная проверка" })
  await request(`/session/${created.id}/prompt_async`, { model: { providerID: "mock", modelID: "gpt-continuity-test" }, agent: "build", parts: [{ type: "text", text }] })
  return created.id as string
}

describe("Реальный OpenCode V1 и подставной провайдер", () => {
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
    eventAbort.abort()
    processServer.kill(); await processServer.exited
    processServer = Bun.spawn([opencode, "serve", "--port", new URL(base).port, "--hostname", "127.0.0.1"], {
      cwd: project, env: launchEnv, stdout: Bun.file(join(root, "restart.stdout.log")), stderr: Bun.file(join(root, "restart.stderr.log")),
    })
    await until(async () => { try { return (await fetch(base + "/global/health", { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 20000)
    eventAbort = new AbortController()
    const count = events.length
    void listenEvents()
    await until(() => events.slice(count).some(e => e.type === "server.connected"))
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
  test("новое уточнение во время разрешения отменяет устаревший переход", async () => {
    const id = await session("CASE_NEW_CHANGED")
    const approval = await until(() => events.find(e => e.type === "permission.asked" && e.properties.sessionID === id))
    await request(`/session/${id}/message`, { model: { providerID: "mock", modelID: "gpt-continuity-test" }, agent: "build", noReply: true, parts: [{ type: "text", text: "EXTRA_USER_CHANGE: изменились требования." }] })
    await request(`/session/${id}/permissions/${approval.properties.id}`, { response: "once" })
    await until(() => store.get(id, project).transition?.phase === "cancelled")
    expect(store.get(id, project).nextSessionID).toBeUndefined()
  }, 30000)
})
