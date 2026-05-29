# Skills

Per-skill reference for Claude Discipline — **7 workflow skills**. Hooks enforce
("you can't do the wrong thing"); skills are the *workflows* ("the right thing is
one command away"). They're optional (`node scripts/install.mjs --skills`) and
**generic by design** — they carry the *method* with project-specifics stripped,
so you point them at your repo and they fit.

A skill runs when you invoke it by name (e.g. `/pres`) or say one of its trigger
phrases; some also fire proactively (noted per skill). They compose into one loop:

```
  idea ─▶ write-plan ─▶ red-team-plan ─▶ execute ─▶ red-team-code ─▶ ship
                                                                       │
                              docs-cascade ◀───────────────────────────┘
   (handoff at any boundary — pass full context to the next session)
```

---

## `pres` — the orchestrator
**Invoke:** `/pres [feature]`, "pres this", "pres this plan".
Runs the whole build cycle — **P**lan → **R**ed-team → **E**xecute → **S**hip — as one continuous run with no manual handoff between phases. Chains the other skills: `write-plan` → `red-team-plan` → execute → `ship`. If you point it at an existing plan ("pres this plan"), it skips planning and starts at red-team. **Hard stop:** it will not execute a plan with unresolved blocking (P0/P1) risks — a blocker means surface it, not push through. Use it when you want idea-to-shipped in one go.

## `write-plan` — phased plan, hardest part first
**Invoke:** "write a plan", "plan this out", "create a plan for", or before any non-trivial build.
Produces a phased TDD plan where the **hardest / most load-bearing phase goes first** — a plan is a risk-ordered work queue, not a chronological wishlist, so the assumption that could sink everything fails on day one when it's cheap. **Rule 0:** the plan is written in *small narrated increments* (skeleton, then one section per edit), never one giant silent write — so you can steer mid-draft ("skip phase 7") instead of reacting to a wall of text.

## `red-team-plan` — attack the plan before coding
**Invoke:** "red team this", "bulletproof this plan", "review this plan"; fires proactively on a fresh plan with 4+ TDD cycles, async, or UI (the kinds that break).
Stress-tests a plan for edge cases, race conditions, and spec contradictions — and **fills the holes with copy-paste-ready code, tests, and specs**, not vague advice. Golden rule: *if it says "add a test" without writing the actual test, it failed.* Edits only the plan (`.md`); if it finds a real architectural problem, it stops and flags that the design needs rethinking before the plan proceeds.

## `red-team-code` — attack the code that compiles
**Invoke:** `/rt`, "red team this code", "rt this"; fires proactively after non-trivial code (50+ lines, new endpoints, new passes).
Assumes the happy path "works" and hunts every way that's a lie: security holes, concurrency bugs, broken contracts, edge cases, dead/duplicated code, rule violations — then **fixes what it finds directly, no "want me to fix this?"** Golden rule: *if you write "consider adding X" without doing it, you failed.* Distinct from `red-team-plan`: that reviews the plan before code exists; this reviews real code after it compiles.

## `ship` — full ship discipline, not a bare merge
**Invoke:** "ship it", "ship this", or when a feature is done and verified.
Runs the easy-to-forget ritual as gates: **doc gate** (blocks if a feature isn't documented — invokes `docs-cascade` if installed) → **test gate** (must be green) → **data-at-risk check** → commit → merge to main → delete the branch → push. Also updates `HANDOFF.md` / `learnings.md` / project `CLAUDE.md` for anything that emerged, and ends with a plain-English wrap-up of what shipped.

## `docs-cascade` — sync every doc surface
**Invoke:** "update docs", "doc cascade", "sync the docs", or before declaring a feature done.
Enforces "if a feature exists in the code but not the docs, it doesn't exist." **Config-driven:** you define your project's doc surfaces once (spec/reference, user guide, changelog, capability inventory, AI-facing prompts), then this skill updates each after every feature so they don't drift out of sync one ship at a time. Starts by narrating *significance* ("you can now export a styled PDF"), not a changelog.

## `handoff` — cold-start the next session
**Invoke:** "handoff", "save context", "write a resume prompt", "I'm done for now", or when switching tasks.
Writes `HANDOFF.md` for a **cold agent** (often a cheaper model) so it resumes without re-deriving state from chat or git logs. Optimized for completeness over brevity, with a load-bearing section order: **action first** (pick-up-here: branch, head commit, test command, item 1) → resume order → what's broken/stubbed → full next-session detail. The bridge between this session's full context and the next session's empty one.

---

*Skills are starting points. Each `SKILL.md` is editable — change the method to match how your team works, point `docs-cascade` at your surfaces, and they fit any repo.*
