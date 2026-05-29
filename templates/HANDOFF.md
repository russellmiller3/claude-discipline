# Handoff — <project> <date>

> The session-state snapshot. A fresh session (or a cheaper model) should be able to read ONLY this file and resume without re-deriving state from git logs or chat history. Keep it short, priority-first, and current — the `handoff-continuity` hook nags when it goes stale relative to work done.

> Repo at `<commit hash>` (clean / dirty + what's uncommitted).

## In flight (finish first)

1. **<epic / task>** — next concrete step — why it matters.
2. ...

## Just landed this session

- **<thing shipped>** — one line on what + where (file / commit). Repeat per item.

## Open questions / blocked

- **<question>** — needs <decision / key / hardware / someone>.

## Up next (priority order)

1. **<task>** — first step — why.
2. ...

## Gotchas for the next session

- <anything that will bite whoever picks this up: a flaky test, a manual step, a stale build that needs a rebuild, an env var>.

---
*Reset "Just landed" each session; fold anything durable into `learnings.md` (lessons) rather than letting this file grow.*
