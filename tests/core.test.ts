import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Store, hash, type Transition } from "../store.ts"
import { cutMessages, reconcile, usageOf } from "../core.ts"

const transition = { operation: "refresh_current", phase: "prepared", sourceUserID: "msg_latest", checkpoint: { hash: "saved" } } as Transition
describe("Целостность перехода", () => {
  test("не переключается при работающих инструментах и отменяет устаревшую передачу", () => {
    expect(reconcile({ transition, idle: false, runningTools: false })).toBe("wait")
    expect(reconcile({ transition, idle: true, runningTools: true })).toBe("wait")
    expect(reconcile({ transition, idle: true, runningTools: false, latestUserID: "newer", handoffHash: "saved" })).toBe("cancel")
    expect(reconcile({ transition, idle: true, runningTools: false, latestUserID: "msg_latest", handoffHash: "changed" })).toBe("cancel")
    expect(reconcile({ transition, idle: true, runningTools: false, latestUserID: "msg_latest", handoffHash: "saved" })).toBe("commit")
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
  })
})
