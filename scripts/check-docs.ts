import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

function anchors(text: string) {
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => match[1]
    .toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")))
}

export function checkDocs(directory: string) {
  for (const name of readdirSync(directory).filter(name => name.endsWith(".md"))) {
    const path = join(directory, name)
    const text = readFileSync(path, "utf8")
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1]
      if (/^[a-z]+:/i.test(target)) continue
      const [file, anchor] = target.split("#")
      const destination = file ? resolve(dirname(path), decodeURIComponent(file)) : path
      if (!existsSync(destination)) throw new Error(`${name}: missing link target ${target}`)
      if (anchor && !anchors(readFileSync(destination, "utf8")).has(decodeURIComponent(anchor))) throw new Error(`${name}: missing heading ${target}`)
    }
    // Примеры конфигурации должны оставаться синтаксически корректными JSON.
    for (const match of text.matchAll(/^[ \t]*```json\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm)) JSON.parse(match[1])
  }
  console.log(`Documentation links and JSON examples checked: ${directory}`)
}

if (import.meta.main) checkDocs(resolve(import.meta.dir, ".."))
