---
name: red-team-plan
description: Use when stress-testing any implementation plan before coding begins. Trigger when the user says "red team this", "bulletproof this plan", "review this plan", "is this plan solid?", or before handing any plan to an executor. Also trigger proactively after the write-plan skill produces a plan with 4+ TDD cycles, async operations, or UI components — those break most.
---

# Red Team Plan

**Announce:** "I'm using the red-team-plan skill to bulletproof `[plan-name]`."

## Core philosophy

Red Team doesn't just find holes — it **fills them with explicit code, tests, and specs** the implementer can copy-paste. The goal: a plan so detailed that a sleep-deprived junior dev at 3am (or a small, cheap model) could implement it correctly with zero questions.

**Golden rule: if Red Team says "add a test" without writing the actual test code, Red Team failed.**

## Mode restriction

Red Team edits ONLY the plan (`.md`). It does NOT implement code. If it finds an issue beyond plan-level fixes (a real architectural problem), it stops and flags that the design needs rethinking before this plan proceeds.

## Step 0: Scope check

| Plan type | Action |
|-----------|--------|
| 1-2 TDD cycles, no async, no UI | Lightweight review (edge cases + line numbers) |
| 3+ cycles OR async/state/UI | Full red team |
| Already a red-teamed doc | Say so; don't re-review |
| No TDD cycles at all | Flag as an architectural gap — needs `write-plan` first |

## Step 1: Read everything

1. The plan file, completely.
2. Your project's **authoritative spec / contracts** (whatever defines shapes, endpoints, auth rules, env vars — `intent.md`, `API.md`, an OpenAPI file, the schema). This is the single source of truth the plan must not contradict.
3. EVERY source file in the plan's "Files to Modify" section.
4. Note current line numbers of code the plan references.

## Step 2: Priority checks (in order)

### Priority 1 — Diff safety (the #1 implementation failure)
Edits that match too broadly nuke adjacent functions and drop imports. For every modification, verify the edit matches ONLY the target (not neighbors), imports are preserved, no "looked unused" helper is removed, and the location is anchored with a context marker (function/class it lives in). **Replacing >10 lines? Flag for manual verification.** Vague edit locations = BLOCKED until fixed.

### Priority 2 — Line-number verification
For each code block with line numbers: Read the file, confirm the number still matches. If drifted, update the plan + add `<!-- line verified YYYY-MM-DD -->`. New file? Note "unverifiable — new file." Wrong numbers = BLOCKED until fixed.

### Priority 3 — Import/export audit
For every new function/component/method: is it exported? Is the import added at every use site? Any circular dep (A imports B imports A)? Named vs default matching the file's pattern? **Auto-fail:** new function with no export, or a use site with no import.

### Priority 4 — Dead-code detection
Flag unreachable branches, unused params, duplicate constants (import from one source), and computed-but-never-read values. Mark each `// DELETE — never used` in the plan.

### Priority 5 — Spec cross-reference (single source of truth)
Cross-reference the plan against your project's authoritative spec/contracts:
- **Shapes/types:** does the plan use real field names, types, defaults? Flag any field it invents that the spec doesn't have.
- **Auth/permissions:** does each endpoint get the right auth level? An endpoint that should require auth but doesn't = BLOCKED.
- **API contracts:** request/response shapes match the spec's input/output?
- **Security constraints:** does any code use a pattern the project forbids (unsanitized eval, raw SQL concat, etc.)?
- **Env vars:** referenced correctly, and added to the spec's env list if new?
- **Data-access rules:** if it touches the DB, does it respect row-level/ownership rules?

Minor mismatch (wrong field name) -> fix in the plan. Major contradiction (wrong auth level, missing security check) -> BLOCKED. If the plan adds new shapes/endpoints/env vars, add a "spec update strategy" section INTO the plan: what to add, and that it lands in the end-of-phase commit.

### Priority 6 — Tech-debt scan
While reading the referenced files, watch the surrounding code. **Minor** debt (dead paths, naming drift, dup logic, stale comments) -> add as a cleanup task in the plan. **Major** debt (architectural, systemic, won't-scale) -> flag to the user with scope estimate; do NOT silently add it.

## Step 3: Attack checklists

### Edge cases — the big table
For EVERY user input, fill in the relevant rows:

| Input | Edge case | Expected | Test? |
|-------|-----------|----------|-------|
| Text | `""` / whitespace-only | validation error / trim-then-empty | Yes |
| Text | 10,000 chars | truncate or reject with a limit | Yes |
| Text | `<script>` | escape, don't execute | Yes |
| Number | negative when should be positive | clamp or reject | Yes |
| Number | `NaN` from bad parse / `Infinity` | default or reject | Yes |
| File | 0 bytes / 100MB / wrong MIME | specific error, reject early | Yes |
| Array | `[]` / 1000+ items | handle gracefully / paginate | Yes |
| Object | missing required field / extra fields | validate / ignore extras | Yes |
| Null/undefined | where a value is expected | explicit default, not `?.` spam | Yes |

Add feature-specific rows.

### Race conditions (any async op)
Double-submit (disable on click), type-while-loading (cancel old / AbortController), close-mid-request (`if (!mounted) return`), navigate-away (teardown cleanup). Define the prevention for each.

### UI footguns (any UI work)
Specify BOTH states for every element: dark mode (both color values), mobile breakpoint, focus outline, hover transition, text overflow (truncate/wrap/clamp), z-index value + why, scroll container + max-height. Write a per-element state table (light / dark / hover / focus / disabled).

### Reactive-framework footguns (if the stack has reactivity — React/Vue/Svelte/Solid)
Check every effect/watcher for infinite loops (effect that writes a value it reads), direct mutation that breaks change-tracking (replace, don't mutate-in-place), missing prop destructure, and dependency-tracking mistakes in conditionals.

### State machines (any loading/async state)
Define the full machine: `IDLE -> LOADING -> SUCCESS / ERROR -> (retry)`. For each state: what's visible, what's hidden, what the user CAN and CAN'T do.

### Data contracts (any API integration)
Document every response's exact shape (JSDoc or example object) with which fields are required, optional, and nullable.

### Error strings
Not "show an error" — the exact copy. If the plan says "show error message" with no string, write the string.

## Step 4: TDD-cycle audit
For each cycle, verify: the exact test code is written (copy-paste ready, not described), the test command is specified, "green" is defined, implementation code is included for simple cycles, and the refactor step is NOT "none" (every cycle cleans something). If a cycle just says "add a test for X," write the test yourself.

## Step 5: Devil's advocate
For every feature, ask: double-click? response 5s late? data in a different shape? runs on mobile (44px touch targets)? what will the implementer wrongly assume? first run vs nth run? storage/network unavailable?

## Step 6: Drunk-junior-dev / cheap-model gate (MUST pass before reporting)
Could a sleep-deprived junior (or a small model) implement each cycle with zero questions? Fix any cycle that: lacks full code (write it, or extract a >15-line component to a sub-file the plan copies in), uses ambiguous verbs ("wire up", "integrate" — replace with the exact import + insertion point), describes a test in prose, has a non-explicit file path, has an unanchored edit location, assumes knowledge from another cycle, or has a vague command. **Fix it now — never "noted for later."**

## Step 7: Fix first, then report

**Red Team ALWAYS fixes what it finds.** Never ask "want me to fix this?" — just fix it (or mark BLOCKED for architectural issues only).

- **Output 1 — the updated plan file (saved to disk):** restructured to the template order, all fixes applied directly, ZERO red-team commentary. The plan reads like a clean recipe, not a post-mortem.
- **Output 2 — the attack report (in chat, NOT in the plan):** Critical / Moderate / Low findings, each as "what was found -> what was fixed," plus a "remaining risks" list of anything still worth watching during implementation.

## Step 8: Handoff
End with: "Plan updated and saved to `[path]`. Attack report above. Ready to execute." If an architectural issue was found: "BLOCKED: [issue] needs a design decision before this plan can proceed."
