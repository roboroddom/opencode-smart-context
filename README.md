# OpenCode Smart Context

English · [Русский](README.ru.md)

The plugin gives the model two ways to manage context: **shorten history and continue the current task**, or **open a separate chat for a different topic**. The model sees context usage and chooses an appropriate time.

## Two modes

### 1. Continue in the same chat with a shorter context

This is an alternative to built-in context compaction in OpenCode/Codex. The chat and task stay the same, but the model receives saved work state and subsequent messages instead of the entire accumulated conversation. Earlier messages remain available in the chat history.

Here, the main model decides when to compact based on remaining room and the work ahead. It saves `HANDOFF.md`: a file containing the task, decisions, constraints, check results, and next step. The plugin snapshots it and performs the transition after current actions finish. No separate summarization model is called.

### 2. Open a new chat for a different topic

When a long conversation moves to another topic, the model can suggest a separate chat. With your approval, the plugin creates it with a new title and transfers only what that topic needs.

This is a different conversation, not another stage of the previous task: the new discussion does not carry the old history. The previous chat stays available, and separate topics are easier to find later.

## Why this plugin exists

In long GPT-6.1 sessions, the creator noticed longer reasoning, getting stuck, and going off-task around a third of the context window. This led to a working reference of about 28%. The aim is to keep the model in its more productive part of the window rather than wait for the technical limit.

Built-in automatic compaction was hard to trust: why did it happen at that moment, and which details survived? The creator kept starting fresh chats manually. A particular concern was beginning a substantial implementation-and-testing cycle around 25%, then reaching a point where the model worked worse and could no longer prepare a good handoff.

The plugin therefore reports remaining room without switching on a percentage or timer. The model can prepare a handoff before a large phase or after a completed small step.

## Review the handoff while work happens

The model maintains HANDOFF during work, and you read small file diffs alongside its replies. A mistake or missing decision can be corrected immediately. Before a transition, the model updates already reviewed state instead of making you reconstruct the session and audit a long summary from scratch.

## When it helps

- GPT-6.1 Sol or GPT Astra takes longer to think, gets stuck, or loses instructions in a long chat.
- Automatic compaction loses important details.
- You have to move the task into a fresh chat yourself.
- Different topics pile up in one conversation and become hard to find.

In the creator's daily use, this approach noticeably reduced getting stuck and made extended work substantially more comfortable. It helps through context management; clear tasks and approval rules are still needed.

## Use

Open `/continuity` to enable or disable the helper, view context usage, and inspect handoff history. It starts enabled.

The model performs transitions through `context_handoff`. `resume=true` automatically continues assigned work; `resume=false` stores the continuation without starting the model and waits for your message. The latter also lets you select another model through `/models`.

The plugin's [model instructions](CONTEXT-CONTINUITY-PROMPT.md) cover this context workflow. Your usual agent instructions and project rules still apply; personal rules from the creator's setup are not included.

## What the model receives

When enabled, the plugin adds the following to each normal request:

- The text of [CONTEXT-CONTINUITY-PROMPT.md](CONTEXT-CONTINUITY-PROMPT.md): concerns, transition timing, and the rule to maintain each project's state. If no state file exists, the model should create `HANDOFF.md` in the project root.
- The `context_handoff` tool description from [index.ts](index.ts).
- Current usage and remaining-room estimates generated in [core.ts](core.ts).

These are the instructions the creator finds comfortable to work with. Edit `CONTEXT-CONTINUITY-PROMPT.md` to suit your workflow, then restart OpenCode. Preserve the `## Working conditions` heading: the loader uses it as the start of the instructions.

Your work state lives in a separate project HANDOFF. A current-chat refresh substitutes its snapshot for old history; a different chat receives only the request the model prepared for the new topic.

## Install

Local version `0.1.0`. Tested server: **OpenCode V1 1.18.35, Linux**. V2 untested.

<details>
<summary>Local setup and configuration</summary>

Clone the complete source directory outside OpenCode's auto-loaded `plugins/` directories, then install its locked dependencies:

```sh
git clone https://github.com/roboroddom/opencode-smart-context.git
cd opencode-smart-context
bun install --frozen-lockfile
```

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/ABSOLUTE/PATH/opencode-smart-context/index.ts"],
  "compaction": { "auto": false, "prune": false }
}
```

`~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/ABSOLUTE/PATH/opencode-smart-context/tui.tsx"]
}
```

Replace the paths, preserve existing settings/plugin entries, and restart OpenCode. With `XDG_CONFIG_HOME`, use `$XDG_CONFIG_HOME/opencode/`.

State: `~/.local/share/opencode-context-continuity/`, or `$XDG_DATA_HOME/opencode-context-continuity/`. `OPENCODE_CONTINUITY_STATE_DIR` overrides it; server and UI must share the path.

To remove: save HANDOFF, let transitions finish, remove both plugin entries, restore previous compaction settings, and restart. Continue in a new session from HANDOFF: removing the plugin removes its filtering of old history. The toggle preserves saved boundaries.

If `/undo` removes a boundary, use `/redo` where possible or start a new session from HANDOFF. Do not delete state to repair it.

</details>

**The server disables built-in automatic compaction and pruning for the whole instance, even with the helper toggled off. A missed transition can cause a context-limit error.** The 28% reference is the creator's working observation, not an automatic trigger.

## Development

`bun run check` · `bun run check:package` — types, documents, tests, and archive checks; local mock provider, no subscription usage.

[Development guide](CONTRIBUTING.md) · [Release checklist](RELEASE-CHECKLIST.md) · [UI checks](UI-КАРТА.md)

The project's own code uses [0BSD](LICENSE): use, modify, and redistribute it freely, without an attribution requirement. [NOTICE.md](NOTICE.md) preserves the separate MIT notice for the technique adapted from [opencode-cache-compact](https://github.com/lennartschoch/opencode-cache-compact).

## A working experiment

This is a vibe-coded experiment and a proposed workflow, not a finished agent harness. It already works and, in the creator's experience, makes an ordinary chat with standard compaction substantially more comfortable.

If the idea interests you, ask your agent to study the code and adapt the approach with your own instructions, prompts, and transition rules.

Further research covers assembling each step's input more efficiently: reusing a properly structured, cacheable prefix to reduce input costs where the provider supports caching. Other directions include topic-specific handoffs, short- and long-term memory, and better orchestration. These are open questions, not existing plugin features.
