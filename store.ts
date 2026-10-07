import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, existsSync, symlinkSync, readlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type ModelRef = { providerID: string; modelID: string; variant?: string }
export type Usage = { input: number; total: number; context: number; messageID: string; at: number; created?: number }
export type Notice = { afterID: string; text: string }
export type Checkpoint = {
  id: string; at: number; title: string; path: string; hash: string; sourcePath: string
  carrierID?: string; continuation: string; nextTitle: string; epoch: number
}
export type Transition = {
  id: string; operation: "refresh_current" | "start_session"; phase: "prepared" | "ready" | "dispatched" | "done" | "cancelled" | "error"
  checkpoint: Checkpoint; sourceUserID: string; sourceAssistantID: string
  targetID?: string; promptID?: string; agent: string; model: ModelRef; resume: boolean
  targetPrompt?: string; targetDirectory: string; error?: string
}
export type SessionState = {
  version: 1; sessionID: string; directory: string; enabled?: boolean; epoch: number
  usage?: Usage; contextLimit?: number; model?: ModelRef; agent?: string; latestUserID?: string
  checkpoints: Checkpoint[]; boundary?: Checkpoint; transition?: Transition
  notices?: Notice[]
  originID?: string; nextSessionID?: string; title?: string; error?: string
}

export function hash(text: string) { return createHash("sha256").update(text).digest("hex") }
export function dataRoot() {
  return process.env.OPENCODE_CONTINUITY_STATE_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode-context-continuity")
}

// Настройки отделены от состояния: переключатель интерфейса не перезаписывает переход сервера.
export class Store {
  constructor(readonly root = dataRoot()) {
    for (const name of ["sessions", "settings", "snapshots"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
  }
  private file(kind: string, id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("Invalid continuity state id")
    return join(this.root, kind, `${id}.json`)
  }
  private read<T>(file: string): T | undefined {
    if (!existsSync(file)) return
    // Повреждённое состояние не заменяем пустым: это могло бы вернуть весь архив модели.
    return JSON.parse(readFileSync(file, "utf8")) as T
  }
  private write(file: string, value: unknown) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temporary, file)
  }
  workspaceKey(directory: string) { return `workspace-${hash(directory)}` }
  enabled(directory: string, sessionID?: string) {
    const own = sessionID ? this.read<{ enabled: boolean }>(this.file("settings", sessionID)) : undefined
    return own?.enabled ?? this.read<{ enabled: boolean }>(this.file("settings", this.workspaceKey(directory)))?.enabled ?? true
  }
  setEnabled(directory: string, enabled: boolean, sessionID?: string) {
    this.write(this.file("settings", sessionID ?? this.workspaceKey(directory)), { enabled })
  }
  ensureSessionEnabled(directory: string, sessionID: string) {
    const file = this.file("settings", sessionID)
    if (!existsSync(file)) this.write(file, { enabled: this.enabled(directory) })
  }
  claim(sessionID: string, kind = "dispatch"): (() => void) | undefined {
    const file = `${this.file("sessions", sessionID)}.${kind}-lock`
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Ссылка содержит владельца уже в момент создания: авария не оставит пустой lock-файл.
        symlinkSync(String(process.pid), file)
        return () => { try { unlinkSync(file) } catch {} }
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error
        let pid: number
        try { pid = Number(readlinkSync(file)) } catch { return }
        // Восстановление только после смерти прежнего владельца, без произвольного таймера.
        if (!pid) return
        try { process.kill(pid, 0); return } catch (probe: any) { if (probe.code !== "ESRCH") return }
        try { unlinkSync(file) } catch {}
      }
    }
  }
  get(sessionID: string, directory: string): SessionState {
    return this.read<SessionState>(this.file("sessions", sessionID)) ?? {
      version: 1, sessionID, directory, epoch: 1, checkpoints: [],
    }
  }
  update(sessionID: string, directory: string, change: (state: SessionState) => void) {
    let release = this.claim(sessionID, "write")
    const wait = new Int32Array(new SharedArrayBuffer(4))
    for (let retry = 0; !release && retry < 100; retry++) {
      Atomics.wait(wait, 0, 0, 5)
      release = this.claim(sessionID, "write")
    }
    if (!release) throw new Error("Continuity state is being updated by another process")
    try {
      const state = this.get(sessionID, directory)
      change(state)
      this.write(this.file("sessions", sessionID), state)
      return state
    } finally { release() }
  }
  list(): SessionState[] {
    return readdirSync(join(this.root, "sessions")).filter(name => name.endsWith(".json"))
      .map(name => this.read<SessionState>(join(this.root, "sessions", name))!)
  }
  snapshot(id: string, text: string) {
    const file = join(this.root, "snapshots", `${id}.md`)
    writeFileSync(file, text, { flag: "wx", mode: 0o600 })
    return file
  }
}
