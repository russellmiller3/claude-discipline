---
name: red-team-code
description: Use when stress-testing code AFTER it has been written and compiles. Trigger when the user says "/rt", "/red-team-code", "red team this code", "rt this", "review this code", or proactively after writing non-trivial code (50+ lines, new endpoints, new parser/compiler passes, new tools). Distinct from red-team-plan, which reviews plans before coding. This skill reviews the actual implementation for security holes, race conditions, edge cases, broken contracts, project-rule violations, and dead/duplicated code. Fixes findings directly, never asks permission.
---

# Red Team Code

**Announce:** "I'm using the red-team-code skill to stress-test [file/feature]."

## Core philosophy

Red-team-code ATTACKS real code that already compiles. It assumes the happy path "works" — its job is to find every way that's a lie, and to FIX what it finds. No "want me to fix this?" — just fix it.

**Golden rule: if you write "consider adding X" or "you should fix Y" without actually doing it, you failed.**

Distinct from `red-team-plan`: that reviews markdown plans BEFORE code exists; this reviews code AFTER it's written and compiles.

## Step 0: Scope check

| Situation | Action |
|-----------|--------|
| User just wrote code and invoked `/rt` | Review the last changed files (`git diff`) |
| User pointed at a specific file/function | Review that exact target |
| "red team this whole feature" | Review all files changed on the branch vs main |
| No recent code changes | Ask what to review — don't invent scope |

Skip if the diff is <30 lines of boring boilerplate; say so.

## Step 1: Read everything

1. `git diff main...HEAD` — understand what changed.
2. Read every changed file in full (not just the hunks — context matters).
3. Read the project's `CLAUDE.md`/`AGENTS.md` for the rules you'll check against.
4. Read the test file(s) for the changed code.
5. New endpoint/tool? Read its callers. New parser/compiler pass? Read the spec + related passes.

## Step 2: Attack checklists (run every applicable one)

### Security
- **Injection:** every string concatenated into SQL, shell, HTML, or eval'd code. Parameterize or escape.
- **XSS:** every user input rendered into HTML unescaped. `innerHTML` with untrusted data is always wrong.
- **Command injection:** every `exec`/`spawn` with user-derived args. Allowlist, don't blocklist.
- **Path traversal:** every file path built from user input. Normalize + validate against an allowed root.
- **Missing auth:** every new endpoint. Login required where it should be? Admin routes gated?
- **Secret leakage:** env vars / keys / passwords echoed to logs, error messages, or client responses.
- **CSRF, open redirects, prototype pollution, missing rate limits** on public endpoints.

### Race conditions & concurrency
- **Double-submit:** UI actions that mutate state — disable on click.
- **TOCTOU:** check-then-act (`if (exists) write()`) — someone may write in between.
- **Shared mutable state:** module-level vars mutated from multiple handlers.
- **Promise leaks:** async started but not awaited; results land after the caller's gone.
- **Listener cleanup:** `addEventListener` without matching removal on teardown.

### Edge cases
- **Empty:** `[]`, `{}`, `""`, `null`, `undefined` — handles all five?
- **Boundary:** `0`, `-1`, `Infinity`, `NaN`, `MAX_SAFE_INTEGER + 1`.
- **Huge:** 10k-char fields, 1M-item arrays, 100MB files.
- **Unicode:** emoji, RTL, combining chars, zero-width joiners.
- **Malformed:** not-JSON in a JSON body, wrong Content-Type, missing required fields.
- **Network:** upstream returns 500 / times out / returns a different shape.
- **First run vs nth run:** empty DB, migration in progress.

### Contract breaks
- **Response-shape changes:** who consumes it? Check every caller.
- **Signature changes:** a new required arg breaks every caller — make it optional or update all.
- **Removed exports:** grep for the old name before deleting.
- **Test regressions:** did new code break existing tests? Did the new tests actually run?
- **Missing test:** every new public function/endpoint needs at least one.

### Code quality
- **Dead code:** unreachable branches, unused imports/params, write-only variables.
- **Duplicated logic:** same body in 3 places — extract or keep inline consistently.
- **Orphaned comments:** describe behavior the code no longer has.
- **Stale TODO/FIXME/XXX:** real ones get a ticket; dead ones get deleted.
- **Magic numbers:** `if (status === 7)` — name it.
- **Swallowed errors:** `catch {}` that hides the failure — log, rethrow, or justify.

### Test quality
- **Always-pass tests:** tautologies, assertions against mocks that never fire.
- **No-assertion tests:** function runs without throwing, nothing is checked.
- **Flakiness:** wall-clock/`setTimeout` timing, order-dependent shared state.
- **Mocked reality:** if the mock's shape differs from production, the test proves nothing.

### Project rules
Read the project's `CLAUDE.md`/`AGENTS.md`. For EVERY rule in it, check whether the new code complies — naming conventions, architecture invariants, doc-update requirements, dependency policy, "test before declaring done." Never skip this file; its rules are the project's hard-won taste.

## Step 3: Fix first, report second

**Every finding gets fixed immediately.** Never "recommend." Never ask permission.

Flag as BLOCKED instead of fixing only when: an architectural redesign is needed (>2 files of non-trivial change), a design decision is required (e.g. "should this endpoint require auth?" when intent is unclear), or it's a breaking change needing sign-off.

After fixing, run the relevant test suite to verify no regression. If the change is observable in a running app, start it and confirm visually — **a passing unit test is not proof the UI renders.**

## Step 4: Attack report (BLUF)

- **TL;DR:** what you reviewed (file + line count), how many issues found vs fixed, the single biggest risk still open.
- **Critical fixed** — security / data loss / broken contract. One plain-English bullet each.
- **Moderate fixed** — bugs that'd bite in production.
- **Minor fixed** — dead code, stale comments, naming.
- **Still open** — anything BLOCKED, why, and what decision is needed.
- **Last line:** one opinionated next move.

## What this skill does NOT do

- Doesn't review plans (that's `red-team-plan`).
- Doesn't refactor for style preferences — only factual issues.
- Doesn't add out-of-scope features — only plugs holes in what's there.
- Doesn't run with no code to review — tells the user to write some first.
