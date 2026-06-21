# Handoff — <project> <date>

> Working-memory snapshot. A fresh session (or a cheaper model) should resume from THIS FILE ALONE — without re-reading git logs or chat history. The `handoff-continuity` hook nags when it goes stale relative to work done.

## How to maintain this file (read this first)

**EVERY WRITE IS A FULL TIDY, NOT AN APPEND (hard rule).** Any time you touch this file, re-read it top to bottom and clean the WHOLE document: delete anything now done or stale, dedupe overlapping notes, fold durable lessons into `learnings.md`, and keep the section order below. A handoff rots when people only append — every edit should leave it **shorter and current**, never longer and stale. **Don't pin volatile specifics that rot** — say "full suite green," not an exact test count; cite a commit hash only when a task actually needs it.

**When to UPDATE it:** after every few commits, at the end of a work session, when you switch tasks, or any time a context limit / compaction feels near. Cheaper to keep current than to reconstruct.

**When to READ it:** at the very start of a session, before any substantive work. It is the source of truth for "where were we."

**Keep it PRESCRIPTIVE, SHORT, and priority-first.** Tell the next session EXACTLY what to do, in order — never a vague "continue the work." It is a snapshot, not a history: if it grows past ~1.5 screens, you're logging too much — fold durable *lessons* into `learnings.md` and drop anything already captured in commits. Keep the section ORDER below; don't invent or duplicate sections (that's how handoffs rot).

**This file IS the priority queue.** Do NOT keep a separate `priority-queue.md` — the "Up next (priority queue)" section below is the single, authoritative ranked backlog. One doc, one source of truth.

**The split to remember:** `HANDOFF.md` = *transient* state ("where am I, what's next"). `learnings.md` = *durable* lessons ("how not to repeat a mistake"). A reusable lesson goes to learnings; a "pick up here" note stays here. **Gotchas that are durable belong in `learnings.md`** — keep only the immediate, session-specific trip-wires here.

**WHAT goes in each section (in this order):**
1. **Read these first** — the ordered file list a cold agent reads to come up to speed (README/architecture first, then this file, then the queue/plan, then the source files for task 1).
2. **▶ GO** — the ONE unambiguous next task (= top of the queue). Typing "go" starts here. Name the first concrete step + the exact files.
3. **State** — branch, head commit, exact test command + expected pass count, what's committed/pushed.
4. **Up next (priority queue)** — numbered, highest-impact first, each actionable (what + which files). The spine of the handoff.
5. **In flight** — anything started-but-not-done to resume FIRST (usually folds into GO).
6. **Just landed** — what shipped this session (one line each, file/commit). **Reset each session** — a delta, not a changelog.
7. **Open questions / blocked** — waiting on a decision, key, or person; skip and grab the next item.
8. **Gotchas (transient only)** — immediate trip-wires for THIS pickup. Durable ones → `learnings.md`.

---

## Read these first (come up to speed in ~5 min, in order)
1. **`README.md`** — what the project IS.
2. **`<ARCH/architecture doc>`** — how it works (diagrams if any).
3. **This file's "▶ GO" + "Up next"** — what to do (this IS the queue).
4. **`<plan / design doc>`** — deeper rationale behind the backlog.
5. **`learnings.md`** — gotchas; scan the TOC.
6. **Source files for task 1:** `<file>`, `<file>` — where the work happens.

Then: `git log --oneline <base>..HEAD` (this session's commits) + `<test command>` (expect green).

## ▶ GO (type "go" → start HERE, one unambiguous task)
**<the single next task>** — first step: `<concrete action>`. Files: `<file>`, `<file>`. (Why this and not X: <one line>.)

## State
- **Repo/branch:** `<path>` on `<branch>` (head `<hash>`, [pushed / NOT pushed]).
- **Confirm green:** `<test command>` → expect `<N / N>`.

## Up next (priority queue)
1. **<task>** — first step — why / what it unblocks. Files: `<…>`.
2. **<task>** — …

## In flight (finish first, if any)
1. **<epic / task>** — next concrete step — why it matters.

## Just landed this session
- **<thing shipped>** — one line on what + where (file / commit).

## Open questions / blocked
- **<question>** — needs <decision / key / hardware / someone>.

## Gotchas (transient — durable ones go to learnings.md)
- <flaky test / manual rebuild step / env var that bites THIS pickup>.
