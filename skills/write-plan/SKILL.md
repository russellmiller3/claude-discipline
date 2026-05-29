---
name: write-plan
description: Use when creating an implementation plan for any feature, fix, or change. Trigger when the user says "write a plan", "make a plan", "plan this out", "create a plan for", or before starting any non-trivial implementation work.
---

# Write a Plan

**Announce:** "I'm using the write-plan skill."

## Rule 0: WRITE THE PLAN FILE IN SMALL INCREMENTS — ALWAYS

**Never produce the whole plan in one `Write` call.** Plans are long (300-1000 lines); a single silent write is unusable for the person watching — they sit through minutes of nothing, then get a wall of text they can't react to mid-flight.

**Required pattern:**
1. Create the file with a minimal skeleton (title + Phase Order block + problem statement + "the fix" diagram) via `Write`. Target <=100 lines.
2. Append each section with a separate `Edit` (~30-80 lines, one section each).
3. **Narrate before each Edit** — one short sentence (<=15 words): "Phase 3 now — the runtime adapter."
4. The watcher should see forward motion every 30-60s, not a 5-minute silent pause.

**Why:** the person watching is the decision-maker. They need to steer mid-draft ("skip Phase 7"), and they can't if everything lands at once. This is Rule 0 because violating it makes every later step useless — you can't red-team a plan you didn't see land piece by piece.

## Step 0.5: Phase Order block at the top (LOAD-BEARING)

**Every plan opens with a `## Phase Order (load-bearing)` block** right after the title. Downstream readers (executors, reviewers, the human) read this to know what comes first and what gates the rest. A buried "do this first" sentence is a foot-gun every read pays.

```markdown
## Phase Order (load-bearing)

**Default track:** phases 1-7 (the cheap minimal fix).
**Escalation:** phase B-1+ only if phase 7's measurement shows 1-7 wasn't enough.
**Why:** ship the cheapest fix that demonstrably helps before paying for the big one speculatively.

| Phase | Depends on | Status |
|-------|-----------|--------|
| 1 | — | required |
| 2 | Phase 1 | required |
| B-1 | Phase 7 measurement | gated |
```

Rules for the block:
- **THE HARDEST / MOST LOAD-BEARING PHASE GOES FIRST.** Always. Plans are risk-ordered work queues, not chronological wish lists. The phase that could block everything else (the structural primitive, the assumption that might fail) lands at position 1 so its failure surfaces on day one — when the cost is tiny — not on day five after three phases shipped on top of a bad assumption.
- **Find the hardest phase by asking:** which has the most unknowns? Which introduces the structurally-new thing (vs extending something that exists)? Which, if it failed, forces the most rework? Which is closest to "I'm not sure this works yet"? That one goes first.
- **Cheap polish, doc cascades, additive features, parallel-safe phases go LATER** — they're rearrangeable; the hard thing isn't.
- **Every gated phase names its gate.** One sentence on why this ordering. Table when >3 phases.

## Step 1: Assess scope (skip if the user already said)

| Signals -> Small | Signals -> Large |
|---|---|
| bug fix / single concern | new component or module |
| 1-2 files | 3+ files |
| no new architecture | new data flow or integration |
| <=3 TDD cycles | 4+ TDD cycles |

If unclear, default to **large** (better to over-plan).

## Step 2: Codebase reconnaissance (MANDATORY — do not skip)

**Before writing a word of the plan, prove the feature doesn't already exist.** Plans that duplicate existing code waste whole sessions. This is the highest-value step.

1. **Extract 3-5 specific nouns/verbs** from the request. "Fly.io deploy pipeline" -> `deploy`, `dockerfile`, `bundle`, `package`.
2. **Grep the whole codebase** for them — in parallel. Hit your CLI entry points, your server's route registrations, your UI's control definitions, and the main pipeline files (read the table of contents at the top of large files). If a keyword shows up, **read the surrounding code before planning** — you may be about to rebuild it.
3. **Read the project's canonical docs:** `CLAUDE.md`/`AGENTS.md` (rules, conventions, doc gate), the authoritative spec (`intent.md`/`SPEC.md`/`API.md`), the syntax/usage reference, `learnings.md` (scan the TOC — every entry is a bug someone already hit), and `ROADMAP.md` (what's built vs planned).
4. **Report before drafting** — tell the user in chat: what already exists that overlaps (with `path:line` cites), what's genuinely new (the delta), and which surfaces will change. If >=80% of what's proposed already exists, recommend a reuse-and-extend plan instead of net-new.

If a grep hit looks like partial overlap, **stop and ask** ("I found `X` at `path:line` — is the new feature an extension, a replacement, or separate?"). Don't assume.

## Step 3: Explore the files you'll touch — organized BY PHASE

Don't plan blind. But don't dump one giant upfront read-list either — structure reads by phase so the executor reads fresh line numbers right before editing, doesn't burn context on files it won't touch for 10 cycles, and re-reads earlier-modified files with current state.

```markdown
### Always read first (every phase): | spec file | authoritative |
### Phase 1 — read: | file.js | why |
### Phase 2 — read: | other.js | why |
```

## Step 4: Fill the plan

**Small plans** -> `plans/fix-[name]-MM-DD-YYYY.md`. Sections: the problem (root cause, prior attempts) · the fix (the "aha" first, ASCII flow diagram, why it works) · files (new + modified, exact paths) · edge cases (scenario -> handling) · error UX (what the user sees, the log tag) · integration notes · implementation steps (2-4 TDD cycles: red test -> minimal code -> refactor) · testing strategy (command, success checklist) · resume prompt.

**Large plans** -> `plans/plan-[name]-MM-DD-YYYY.md`. Add: branch name (`feature/[name]`) + a progress skeleton · user-facing description with before/after diagrams + key decisions and rationale · data-flow diagram · integration points (producer -> consumer with data formats) · edge cases (state drift, destructive actions, lifecycle, error recovery) · env vars · files to create (full code, with the test file using your project's real import/render pattern) · files to modify (drift-safe markers: `Line ~XX (after \`exact snippet\`)`) · a local-vs-deployed test matrix · TDD cycles (one per smallest testable unit, with command + commit message each) · success criteria.

> **Anti-pattern — "state transition" tests that skip data shape.** For any data pipeline (response -> store -> component), a test that only checks `status === 'complete'` tells you the state machine works, not that the data is correct. Include at least one test per stage that asserts the *shape* of the output object. For every mock, ask: "does it include all the fields the consumer actually reads?" Missing fields -> test passes, UI silently breaks.

## Step 5: Add learnings + docs steps to the plan

- **Large plans:** end each phase with "run the update-learnings skill — capture this phase's lessons" as the last bullet before its commit.
- **Small plans:** one "run update-learnings" step after the final commit.
- **Docs cascade:** if the plan adds ANY new user-facing capability, syntax, command, or endpoint, make the FINAL phase a docs step that updates every surface your project keeps in sync (run the `docs-cascade` skill, or list the surfaces explicitly). If it's not in the docs, it doesn't exist — this is a ship-blocker.

## Step 6: Review before handing off

- [ ] No `[TODO]` / `[placeholder]` markers remain.
- [ ] All file paths exact (not approximate).
- [ ] TDD cycles are truly minimal (not batched).
- [ ] Edge cases have matching tests or an explicit "no test" justification.
- [ ] For any data pipeline: at least one test checks the output object's *shape*, and mocks include all fields the consumer reads.
- [ ] Branch name follows `feature/` or `fix/`.
- [ ] Docs step present in the final phase if any new capability was added.

## Step 7: Red-team the plan (MANDATORY)

Immediately invoke the **`red-team-plan`** skill on the plan you just wrote. Do NOT offer execution until red-teaming is done and findings are patched.

**Tech-debt rule (while exploring):** minor refactors (dead code, naming, dup logic) go in a "cleanup" phase at the end of the plan. Major refactors (architectural, systemic) get flagged to the user with scope — don't silently fold them in; the user decides now-or-later.

After red-teaming and patching, offer execution:
> "Plan saved to `plans/[filename].md`. Red-teamed and patched. Want me to start implementing now, or start a fresh session with it?"
