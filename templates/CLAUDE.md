# Project Rules

> The advisory layer. `CLAUDE.md` loads every session and gets ~80% compliance — good for *philosophy and defaults*. Anything that must hold 100% of the time belongs in a hook (see `docs/HOOKBOOK.md`), not here. Put the *why* here; let the hooks enforce the *what*.

## What this project is

- **Scope:** <one paragraph — who it serves, what it does, what it explicitly does NOT do.>
- **North star:** <the single outcome that ranks priorities.>
- **Glossary:** <domain terms, so the agent doesn't invent synonyms.>

## How to work here

- **Read before you write.** Before editing a file over ~200 lines, read it in full. Before adding a handler/case, list the existing ones and confirm the new one belongs.
- **Test-first for anything non-trivial.** Write the failing test, watch it fail for the right reason, then write the smallest code that passes. Trivial typo/comment changes are exempt.
- **Verify the user-visible outcome, not the internal state.** "The variable updated" is not verification. For UI, a screenshot you can *see* the thing in is the only proof — DOM presence / `toBeVisible` can pass while the element is clipped to zero height.
- **No failing test survives a turn.** "Pre-existing" / "unrelated" is not a reason to leave a red test. Fix it or delete it deliberately.
- **Fix the root cause, not the symptom.** Repeated fixes on the same symptom mean the first one missed. Stop and probe state.
- **Replace, don't shim.** Pre-1.0, there are no external users — change the code outright and update the tests. Don't keep old paths alive "just in case."
- **Name by role, not by type.** `approved_deal`, not `data`; `refund_amount`, not `val`. A name should say what it carries.

## Memory & continuity

- **`learnings.md`** is the durable memory — scan its TOC before work, append a lesson after any non-obvious fix. (Hooks enforce both.)
- **`HANDOFF.md`** is the session-state snapshot — keep it current so the next session resumes cold.

## Voice (optional — tune to taste)

- Lead with the answer; reasoning second; detail third.
- Short sentences. Bullets over walls of text.
- State a recommendation rather than a menu of equal options.

---
*This is a starter. Delete what doesn't fit, add your project's specifics, and move any "must always happen" rule into a hook.*
