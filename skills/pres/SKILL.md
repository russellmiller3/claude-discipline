---
name: pres
description: "PRES = Plan -> Red-team -> Execute -> Ship. The full build cycle with no manual handoffs between phases. Use when the user says '/pres [feature]', 'pres this', 'pres this plan', or wants to go from an idea (or an existing plan) all the way to shipped."
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill
---

# PRES — Plan, Red-team, Execute, Ship

**P**lan -> **R**ed-team -> **E**xecute -> **S**hip. Four phases, one continuous run, no stopping to hand off between them. This is the orchestrator that chains the other discipline skills into a single build loop.

```
  idea ──▶ [write-plan] ──▶ plan.md ──▶ [red-team-plan] ──▶ hardened plan
                                                                │
   shipped ◀── [ship] ◀── green tests ◀── [execute-plan] ◀─────┘
```

## Your task

The user gave you a feature/task to build, OR pointed at an existing plan. Run all four phases in order.

### Phase 1 — Plan

- If the user pointed at an existing plan file ("pres this plan", "pres plans/plan-foo.md"): **skip this phase.** Read the plan, then go to Phase 2.
- Otherwise: invoke the **`write-plan`** skill with the user's request. Wait for the plan file to be saved before continuing.

### Phase 2 — Red-team

Invoke the **`red-team-plan`** skill on the plan file. Fix every issue it finds by editing the plan directly. **Do not proceed with a plan that has unresolved blocking (P0/P1) risks** — a blocker means stop and surface it.

### Phase 3 — Execute

Invoke the **`execute-plan`** skill (or implement phase-by-phase yourself if no such skill is installed). Every phase gate must pass — tests green — before moving to the next phase. If a phase fails, **stop and report**; do not auto-skip.

After the code is written, run **`red-team-code`** on the diff before shipping. Fix what it finds.

### Phase 4 — Ship

Invoke the **`ship`** skill once all phases are complete and tests are green.

## On failure

If any phase fails (red-team finds a blocker, a test gate fails, ship fails), **stop immediately** and report:
- Which phase failed
- The specific failure
- What decision the user needs to make before you can continue

Do not silently skip failures or auto-fix things that require a design decision.

## Graceful degradation

This skill calls other skills by name (`write-plan`, `red-team-plan`, `execute-plan`, `red-team-code`, `ship`). If one isn't installed, do that phase inline using the same principles rather than aborting — PRES is the *sequence*, the sub-skills are conveniences.

## Arguments

Everything after `/pres` is the task description or plan-file path. Pass it straight through to Phase 1.
