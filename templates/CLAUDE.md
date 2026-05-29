# Project Rules

> The advisory layer. `CLAUDE.md` loads every session and gets ~80% compliance — good for *philosophy and defaults*. Anything that must hold 100% of the time belongs in a hook (see `docs/HOOKBOOK.md`), not here. Put the *why* here; let the hooks enforce the *what*.

## What this project is

- **Scope:** <one paragraph — who it serves, what it does, what it explicitly does NOT do.>
- **North star:** <the single outcome that ranks priorities.>
- **Glossary:** <domain terms, so the agent doesn't invent synonyms.>

## How to work here

- **Bias to action (the "Ross Perot" rule).** Don't stop at the narrow literal request or wait for permission on reversible work — figure out what's actually wanted and deliver the complete version. Hit a bug mid-task? Fix it and keep going. Obvious next step? Take it. Only stop for the genuinely irreversible or expensive (see "flag the big moves").
- **Read before you write.** Before editing a file over ~200 lines, read it in full. Before adding a handler/case, list the existing ones and confirm the new one belongs.
- **Test-first, always — Kent Beck's Red → Green → Refactor.** This is the load-bearing discipline, not a nice-to-have. **Red:** write the failing test and *watch it fail for the right reason* (a test you never saw fail proves nothing). **Green:** the smallest code that passes — resist "while I'm here." **Refactor:** clean it up with the test holding you safe. Tests written *after* the code quietly mirror the code's mistakes; tests written *first* pin down the behavior you actually meant. Only trivial typo/comment changes are exempt.
- **Verify the user-visible outcome, not the internal state.** "The variable updated" is not verification. For UI, a screenshot you can *see* the thing in is the only proof — DOM presence / `toBeVisible` can pass while the element is clipped to zero height.
- **No failing test survives a turn.** "Pre-existing" / "unrelated" is not a reason to leave a red test. Fix it or delete it deliberately.
- **Fix the root cause, not the symptom.** Repeated fixes on the same symptom mean the first one missed. Stop and probe state.
- **Replace, don't shim.** Pre-1.0, there are no external users — change the code outright and update the tests. Don't keep old paths alive "just in case."
- **Name by role, not by type.** A type name (`data`, `result`, `val`, `tmp`, `list`, `text`) says *what kind of thing* it is — which the reader can already see. A role name says *what it's for*, which is the part they actually need. The name should answer "what is this?" without scrolling up. Examples:
  - `data` → `incoming_signup` / `stripe_event` / `raw_payload`
  - `result` → `approved_deal` / `save_response` / `grade`
  - `val` → `refund_amount` / `new_threshold` / `chosen_color`
  - `list` → `open_tasks` / `matching_rows` / `recent_logs`
  - `tmp` → `draft_caption` / `partial_summary`
  - Loop counters `i`, `j`, `k` are fine — their scope is two lines, so the role is obvious.
- **Leave it better than you found it.** Fix the broken things you touch — a red test, a clear bug, a confusing name in the file you're editing. Walking past breakage to stay "in scope" is how rot accumulates. (The one thing to *not* add: speculative abstractions for futures that may never come — YAGNI. Fixing ≠ gold-plating.)
- **Work in parallel by default.** Batch independent tool calls into one step — three reads that don't depend on each other go together, not one at a time. Only serialize when the next call genuinely needs the previous result.
- **Small steps — small edits, small commits.** Rewrite a long file as several narrated edits, not one giant write. Commit one logical change at a time, with a message that says *why*. Small steps are reviewable, revertible, and bisectable — a wrong turn gets caught after one piece, not buried under ten. A giant commit is a giant blast radius.

## Engineering standards

- **Refuse to fake it.** Never stub, mock, or `TODO` past the hard part to make something "work." Before returning, ask: "if they ran this right now, would it actually do the thing?" If no, say what's missing — don't ship a hollow shell that compiles.
- **Guard silent failures at runtime.** The worst bugs run fine and do the wrong thing — no stack trace, hours lost. `Number("")` is `0`; `undefined + 1` is `NaN`; a failed save can still return `200`. Add an explicit runtime check that *trips loudly* on the empty/missing/coerced case, and a test that asserts the real outcome ("a row exists"), not just "no error."
- **Bias-check before submitting.** Did I add a branch where a type belonged? A flag where a message belonged? A string compare where an enum belonged? Did I copy a nearby pattern that was itself wrong? If yes, fix it now — don't defer the shape problem into debt.
- **Console first.** Debugging a UI/runtime issue? Read the actual error output before reading code or theorizing. The error usually names the problem in seconds; guessing wastes the session.
- **Quality bar high by default.** Compute is cheap. Prefer the thorough thing — more tests, clearer errors, cleaner shape — over the minimal diff, unless there's a real reason to keep it small.

## Research & external facts

- **Don't guess about the outside world.** Questions about what users want, what a competitor does, what an API returns, how a library behaves — look it up, don't invent a plausible answer.
- **Cite, and separate thesis from evidence.** "Source X says Y" is evidence; "I think Y because Z" is a thesis — label which. A claim isn't grounded until two independent sources agree. If the data isn't there, say "I couldn't find evidence either way."

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
