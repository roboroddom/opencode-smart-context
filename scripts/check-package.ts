import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { checkDocs } from "./check-docs.ts"

const project = resolve(import.meta.dir, "..")
const root = mkdtempSync(join(tmpdir(), "continuity-package-"))
console.log(`Package sandbox: ${root}`)

async function run(command: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit" })
  if (await child.exited !== 0) throw new Error(`Command failed: ${command.join(" ")}; sandbox ${root}`)
}

// Разрешённый состав проверяется отдельно от списка files, чтобы случайное расширение не прошло незаметно.
const expected = ["package.json", "index.ts", "core.ts", "store.ts", "tui.tsx", "CONTEXT-CONTINUITY-PROMPT.md", "LICENSE", "NOTICE.md", "README.md", "README.ru.md", "CONTRIBUTING.md", "CHANGELOG.md", "RELEASE-CHECKLIST.md", "UI-КАРТА.md", "bun.lock"].sort()
await run(["npm", "pack", "--ignore-scripts", "--pack-destination", root], project)
const archives = readdirSync(root).filter(name => name.endsWith(".tgz"))
if (archives.length !== 1) throw new Error("Expected exactly one package archive")
const unpack = join(root, "unpacked")
mkdirSync(unpack)
await run(["tar", "-xzf", join(root, archives[0]), "-C", unpack], project)
const packed = join(unpack, "package")
const actual = readdirSync(packed).sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected package contents: ${actual.join(", ")}`)
for (const name of actual) {
  if (!readFileSync(join(packed, name)).equals(readFileSync(join(project, name)))) throw new Error(`Package file differs from source: ${name}`)
}
checkDocs(packed)
const manifest = JSON.parse(readFileSync(join(packed, "package.json"), "utf8"))
for (const entry of Object.values(manifest.exports) as string[]) {
  if (!actual.includes(entry.replace(/^\.\//, ""))) throw new Error(`Missing export: ${entry}`)
}
if (!readFileSync(join(packed, "CONTEXT-CONTINUITY-PROMPT.md"), "utf8").includes("## Working conditions")) throw new Error("Missing model instructions")
if (!readFileSync(join(packed, "NOTICE.md"), "utf8").includes("Copyright (c) 2026 Lennart Schoch")) throw new Error("Missing third-party notice")
if (!readFileSync(join(packed, "LICENSE"), "utf8").includes("Copyright (C) 2026 by roboroddom")) throw new Error("Missing project license")

// Зависимости берутся по lock-файлу архива; исходный node_modules не используется его модулями.
await run(["bun", "install", "--frozen-lockfile"], packed)
await run(["bun", "test", "tests/e2e.test.ts", "--timeout", "30000"], project, { ...process.env, OPENCODE_CONTINUITY_PLUGIN_DIR: packed })
console.log(`Package check passed (server only): ${join(root, archives[0])}`)
