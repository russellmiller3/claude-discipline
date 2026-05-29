# Project Rules

> The advisory layer. `CLAUDE.md` loads every session and gets ~80% compliance — good for *philosophy and defaults*. Anything that must hold 100% of the time belongs in a hook (see `docs/HOOKBOOK.md`), not here. Put the *why* here; let the hooks enforce the *what*.

## What this project is

- **Scope:** <one paragraph — who it serves, what it does, what it explicitly does NOT do.>
- **North star:** <the single outcome that ranks priorities.>
- **Glossary:** <domain terms, so the agent doesn't invent synonyms.>

## How to work here

- **Bias to action (the "Ross Perot" rule).** Don't stop at the narrow literal request or wait for permission on reversible work — figure out what's actually wanted and deliver the complete version. Hit a bug mid-task? Fix it and keep going. Obvious next step? Take it. Only stop for the genuinely irreversible or expensive (see "flag the big moves").
- **Read before you write.** Before editing a file over ~200 lines, read it in full. Before adding a handler/case, list the existing ones and confirm the new one belongs.
- **Test-first for anything non-trivial.** Write the failing test, watch it fail for the right reason, then write the smallest code that passes. Trivial typo/comment changes are exempt.
- **Verify the user-visible outcome, not the internal state.** "The variable updated" is not verification. For UI, a screenshot you can *see* the thing in is the only proof — DOM presence / `toBeVisible` can pass while the element is clipped to zero height.
- **No failing test survives a turn.** "Pre-existing" / "unrelated" is not a reason to leave a red test. Fix it or delete it deliberately.
- **Fix the root cause, not the symptom.** Repeated fixes on the same symptom mean the first one missed. Stop and probe state.
- **Replace, don't shim.** Pre-1.0, there are no external users — change the code outright and update the tests. Don't keep old paths alive "just in case."
- **Name by role, not by type.** `approved_deal`, not `data`; `refund_amount`, not `val`. A name should say what it carries.
- **Leave it better than you found it.** Fix the broken things you touch — a red test, a clear bug, a confusing name in the file you're editing. Walking past breakage to stay "in scope" is how rot accumulates. (The one thing to *not* add: speculative abstractions for futures that may never come — YAGNI. Fixing ≠ gold-plating.)

## Memory & continuity

- **`learnings.md`** is the durable memory — scan its TOC before work, append a lesson after any non-obvious fix. (Hooks enforce both.)
- **`HANDOFF.md`** is the session-state snapshot — keep it current so the next session resumes cold.
- **Never make the same mistake twice.** When a bug costs real time, turn it into a rule — a `learnings.md` entry, or better, a hook. A mistake caught and ruled-against is a free lesson; the same mistake repeated is a self-inflicted tax. This is the engine the whole memory system runs on.

## Voice (optional — tune to taste)

- Lead with the answer; reasoning second; detail third.
- Short sentences. Bullets over walls of text.
- State a recommendation rather than a menu of equal options.

## Architecture invariants (optional — strong defaults for new projects)

> Opinionated. Keep what fits your stack; delete the rest. These are the calls that are cheap to make right early and expensive to undo later.

- **No god objects.** The root app/store/model is a *router*, not a junk drawer. State belongs to the component that owns it, not the root.
- **Typed records, not positional/stringly-typed data.** A domain object is a named struct with named fields — never a bare array/tuple/`dict[str, Any]` passed around. Reference fields by name, not index.
- **Communicate by messages, not shared mutation.** Background work returns a typed result to the main loop; it doesn't reach into and mutate shared state. Concurrent shared-mutable state is where the un-reproducible bugs live.
- **Flag the big moves before making them.** A new global/singleton, a new dependency, a changed public interface, or a diff touching many modules — surface it first. They spread cost across the whole codebase.

---
*This is a starter. Delete what doesn't fit, add your project's specifics, and move any "must always happen" rule into a hook.*
