# Handoff — <project> <date>

> Working-memory snapshot. A fresh session (or a cheaper model) should resume from THIS FILE ALONE — without re-reading git logs or chat history. The `handoff-continuity` hook nags when it goes stale relative to work done.

## How to maintain this file (read this first)

**When to UPDATE it:** after every few commits, at the end of a work session, when you switch tasks, or any time a context limit / compaction feels near. Cheaper to keep current than to reconstruct.

**When to READ it:** at the very start of a session, before any substantive work. It is the source of truth for "where were we."

**WHAT goes in each section:**
- **In flight** — started but not done. The thing to resume FIRST, with the next concrete step.
- **Just landed** — what shipped this session (file/commit). **Reset this each session** — it's a "since last handoff" delta, not a changelog.
- **Open questions / blocked** — anything waiting on a decision, key, or person.
- **Up next** — not-yet-started work, in priority order.
- **Gotchas** — what will bite whoever picks this up (a flaky test, a manual rebuild step, an env var).

**Keep it SHORT and priority-first.** This is a snapshot, not a history. If it grows past a screen, you're logging too much — fold durable *lessons* into `learnings.md` and drop anything already captured in commits.

**The split to remember:** `HANDOFF.md` = *transient* state ("where am I, what's next"). `learnings.md` = *durable* lessons ("how not to repeat a mistake"). A reusable lesson goes to learnings; a "pick up here" note stays here.

---

## In flight (finish first)

1. **<epic / task>** — next concrete step — why it matters.

## Just landed this session

- **<thing shipped>** — one line on what + where (file / commit).

## Open questions / blocked

- **<question>** — needs <decision / key / hardware / someone>.

## Up next (priority order)

1. **<task>** — first step — why.

## Gotchas for the next session

- <flaky test / manual step / stale build that needs a rebuild / env var>.
