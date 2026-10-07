import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Store, hash, type Transition } from "../store.ts"
import { cutMessages, insertNotices, reality, requestUser, sourceUser, reconcile, usageOf } from "../core.ts"

const transition = { operation: "refresh_current", phase: "prepared", sourceUserID: "msg_latest", checkpoint: { hash: "saved" } } as Transition
describe("Целостность перехода", () => {
  test("не переключается при работающих инструментах и отменяет устаревшую передачу", () => {
    expect(reconcile({ transition, idle: false, runningTools: false })).toBe("wait")
    expect(reconcile({ transition, idle: true, runningTools: true })).toBe("wait")
    expect(reconcile({ transition, idle: true, runningTools: false, latestUserID: "newer", handoffHash: "saved" })).toBe("cancel")
    expect(reconcile({ transition, idle: true, runningTools: false, latestUserID: "msg_latest", handoffHash: "changed" })).toBe("cancel")
    expect(reconcile({ transition, idle: true, runningTools: false, latestUserID: "msg_latest", handoffHash: "saved" })).toBe("commit")
    expect(reconcile({ transition: { ...transition, phase: "ready" }, idle: true, runningTools: false, latestUserID: "msg_latest", handoffHash: "changed" })).toBe("cancel")
    expect(reconcile({ transition: { ...transition, phase: "ready" }, idle: true, runningTools: false, latestUserID: "newer", handoffHash: "saved" })).toBe("cancel")
  })
  test("граница восстанавливается после перезапуска хранилища; архив не возвращается при выключении", () => {
    const root = mkdtempSync(join(tmpdir(), "continuity-unit-"))
    const store = new Store(root)
    const path = store.snapshot("snapshot-1", "Точное сохранённое состояние проекта")
    store.update("ses_test", "/project", s => {
      s.epoch = 2
      s.boundary = { id: "snapshot-1", path, hash: hash(readFileSync(path, "utf8")), sourcePath: "/project/HANDOFF.md", at: 1,
        title: "Первый этап", nextTitle: "Продолжение", continuation: "Проверить результат", epoch: 2, carrierID: "msg_boundary" }
    })
    store.setEnabled("/project", false, "ses_test")
    const restarted = new Store(root)
    const original = [
      { info: { id: "msg_old", role: "user" }, parts: [{ type: "text", text: "ARCHIVE_ONLY" }] },
      { info: { id: "msg_boundary", role: "user" }, parts: [{ type: "text", text: "Отметка перехода", ignored: true }] },
      { info: { id: "msg_new", role: "user" }, parts: [{ type: "text", text: "Новое уточнение" }] },
    ]
    const outgoing = structuredClone(original)
    cutMessages(outgoing, restarted.get("ses_test", "/project"))
    expect(JSON.stringify(outgoing)).not.toContain("ARCHIVE_ONLY")
    expect(JSON.stringify(outgoing)).toContain("Новое уточнение")
    expect(JSON.stringify(outgoing)).toContain("Точное сохранённое состояние")
    expect(JSON.stringify(original)).toContain("ARCHIVE_ONLY")
    expect(restarted.enabled("/project", "ses_test")).toBe(false)
  })
  test("не возвращает полный архив, если граница пропала после отката", () => {
    expect(() => cutMessages([], { boundary: { carrierID: "missing" } } as any)).toThrow("Context boundary is missing")
  })
  test("кеш учитывается в полном входе, reasoning не удваивает total", () => {
    expect(usageOf({ input: 10, cache: { read: 90 }, output: 5, reasoning: 3, total: 105 })).toEqual({ input: 100, total: 105 })
    expect(usageOf({ input: 10, cache: { read: 90 }, output: 5, reasoning: 3 })).toEqual({ input: 100, total: 108 })
  })
  test("автоматическое поручение допускает следующий переход, собственное продолжение не отменяет восстановление", () => {
    const resume = { info: { id: "msg_resume", role: "user" }, parts: [{ synthetic: true, metadata: { continuityResume: "old-transition" } }] }
    const own = { info: { id: "msg_own", role: "user" }, parts: [{ synthetic: true, metadata: { continuityResume: "current-transition" } }] }
    expect(requestUser(resume)).toBe(true)
    expect(sourceUser([resume, own], { id: "current-transition" } as any)?.info.id).toBe("msg_resume")
    expect(requestUser({ info: { role: "user" }, parts: [{ synthetic: true, ignored: true, metadata: { continuity: "marker" } }] })).toBe(false)
  })
  test("заметки сохраняются на прежних местах после перезапуска и не переписывают архив", () => {
    const root = mkdtempSync(join(tmpdir(), "continuity-notices-"))
    const store = new Store(root)
    store.update("ses_notices", "/project", s => { s.notices = [{ afterID: "msg_user", text: "Замер 1" }, { afterID: "msg_tool", text: "Замер 2" }] })
    store.setEnabled("/project", false, "ses_notices")
    const original = [
      { info: { id: "msg_user", role: "user", sessionID: "ses_notices" }, parts: [{ type: "text", text: "Вопрос" }] },
      { info: { id: "msg_tool", role: "assistant", sessionID: "ses_notices" }, parts: [{ type: "text", text: "Ответ" }] },
    ]
    const outgoing = structuredClone(original)
    insertNotices(outgoing, new Store(root).get("ses_notices", "/project"))
    expect(outgoing.map(m => m.parts[0].text)).toEqual(["Вопрос", "Замер 1", "Ответ", "Замер 2"])
    expect(original).toHaveLength(2)
    const shortened = structuredClone(original.slice(1))
    insertNotices(shortened, store.get("ses_notices", "/project"))
    expect(shortened.map(m => m.parts[0].text)).toEqual(["Ответ", "Замер 2"])
  })
  test("запоздалый замер старого этапа не выдаётся за размер нового контекста", () => {
    const state = { boundary: { at: 10 }, contextLimit: 1000000, usage: { input: 250000, total: 250100, at: 20 }, epoch: 2 } as any
    const text = reality(state, [{ info: { role: "user" }, parts: [{ type: "text", text: "Свежая передача" }] }])
    expect(text).toContain("Approximate history after refresh")
    expect(text).not.toContain("250,000")
    expect(text).not.toContain("Measured occupancy")
  })
})
