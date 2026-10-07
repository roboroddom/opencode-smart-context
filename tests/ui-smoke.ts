import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const opencode = process.env.OPENCODE_BIN ?? Bun.which("opencode")
if (!opencode) throw new Error("Install OpenCode V1 1.18.35 or set OPENCODE_BIN")
const pluginDirectory = resolve(process.env.OPENCODE_CONTINUITY_PLUGIN_DIR ?? resolve(import.meta.dir, ".."))
const root = mkdtempSync(join(tmpdir(), "continuity-ui-"))
const project = join(root, "project")
mkdirSync(project)
const tuiConfig = join(root, "tui.json")
writeFileSync(tuiConfig, JSON.stringify({ "$schema": "https://opencode.ai/tui.json", plugin: [join(pluginDirectory, "tui.tsx")] }))
console.log(`UI sandbox: ${root}`)
const child = Bun.spawn([opencode], {
  cwd: project, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "xdg-state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [join(pluginDirectory, "index.ts")] }),
    OPENCODE_TUI_CONFIG: tuiConfig, OPENCODE_CONTINUITY_STATE_DIR: join(root, "state"),
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  },
})
process.on("SIGTERM", () => child.kill())
process.exit(await child.exited)
