# Context continuity instructions

## Working conditions and the user's concerns

The owner observes a decline in the quality and speed of this setup starting around 28% context occupancy; work becomes harder beyond that point. This is the owner's practical reference, not the model's technical limit. The plugin reports current occupancy, room up to that reference, and remaining technical capacity. Measurements and approximate estimates are labelled separately.

The user is especially concerned about starting substantial work with little room left: for example, beginning a large cycle of analysis, changes, tests, design revisions, and repeated checks at 25%, then failing to finish competently or prepare an accurate handoff after quality has declined. Account for this concern early; do not assume a last-minute handoff will necessarily be good.

## Guidance for your own decision

- A sequence of small, independent fixes usually does not require a large uninterrupted reserve. Do not turn every small edit into a separate discussion about context.
- A substantial project change, research across connected components, multiple test-and-fix cycles, or uncertainty about the solution may need ample room. Compare the remaining room with the work ahead without trying to predict an exact token count.
- If the solution has been discussed but substantial implementation has not begun, this can be a convenient point to save the plan and refresh context. Continuing in the current context is also appropriate when there is enough room.
- When work is already in progress, a completed action or small stage is a better handoff point than the middle of an unfinished action. Tools and reasoning already in progress are not interrupted.

These signs inform your judgment; they are not a mandatory sequence or automatic percentage-based commands. The plugin does not choose the transition point for you.

## State transfer

Keep an up-to-date state file for each project. At the start of work, read the file already established by the project; preserve its name and location. If none exists, create `HANDOFF.md` in the project root. Update it throughout meaningful work and before finishing: what was done and verified, decisions, pitfalls and how they were handled, unfinished work, and the next step. Keep a compact picture of actual current state, replacing outdated information rather than accumulating a transcript. Do not put secrets in it or create project handoffs for unrelated everyday questions.

Once you decide to refresh context or move to a separate session, first make HANDOFF accurate and save it. Before that, do not work on titles, presentation, or secondary tasks, and do not call the transition tool. This also applies when leaving for another topic: preserve the prior work in a state from which it can reliably continue.

Preserve the goal, user constraints and prohibitions, agreed plan, decisions and reasons, what was actually done and verified, relevant pitfalls and their resolution, unfinished work, assumptions, blockers, and the next concrete step. Do not present planned work as completed or unverified claims as confirmed. Reference specific files or logs for recoverable details rather than loading the entire archive.

Only after saving the current HANDOFF should you finalize titles and perform the transition. If saving was incomplete or a new substantial clarification arrived, first bring the state up to date; the previous transfer is no longer sufficient.

## Two ways to continue

To continue the same work, you may refresh context within the current session: history is preserved, and the next stage receives the handoff and messages after the new boundary. You decide whether to refresh.

A separate new session can be useful for another topic or a substantial independent task in the same project. Explain it briefly and obtain the user's explicit approval specifically for creating a separate session. A new topic alone is not permission to create one. Respect the user's preference to stay in the current session.

For a different topic, transfer only its goal, relevant constraints, needed paths, and facts from the discussion. Do not carry over the entire HANDOFF of the previous task. An assignment remains an assignment; discussion without an instruction to act remains discussion.

## Titles

After a major task or stage, set the title to reflect the actual content of the whole work, not just its first message. At a handoff, give the completed stage a meaningful title and the continuation an appropriate one. Numbering continues for stages of the same topic; a new independent topic gets its own title and starts its own count. Titles do not replace ID-based links. Preserve a user-specified title unless the user permits a change.
