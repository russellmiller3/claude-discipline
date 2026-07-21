# Engineering Learnings

> Durable, cross-session memory. The agent reads this before working and appends to it after solving something non-obvious. Three hooks keep it alive: `learnings-toc-inject` (surfaces the TOC every session), `learnings-error-match` (surfaces the matching bullet the moment a relevant error appears), and `learnings-write-nudge` (blocks stop when you fixed a bug but logged no lesson).

## How to maintain this file (read this first)

**When to READ it:** before planning a feature, before debugging, before touching a subsystem you haven't worked on recently. Scan the TOC, open the matching section.

**When to WRITE to it:** right after you fix a non-obvious bug, hit a platform/tooling gotcha, or learn something that would cost the next person (or the next session) real time. The bar is low — *"will this bite again? probably yes" → write it.*

**WHERE to write it — by topic, not by date.** Find the existing section the lesson belongs to and merge the new bullet in. Only create a new `## Section` when nothing fits. A reader must find "the ECharts gotcha" in one place, never scattered across dated entries. **Never append a chronological log.**

**HOW to write a bullet:**
```
- **<load-bearing one-line claim>.** <Why it happens — the mechanism>. <The fix>. <Optional: date / commit hash>.
```
The **bold claim** is what a tired reader skims. The rest is for when they need the mechanism. One lesson per bullet.

**Keep the TOC in sync.** When you add a `## Section`, add its row to the table below — the `learnings-toc-inject` hook parses these headers and shows them at session start. A section that's not in the TOC is invisible.

**What does NOT go here:** anything the code, tests, or git history already record; anything that only mattered to one conversation. This file is for lessons that change how you'd act next time.

## Table of Contents

| Section | Key gotchas |
|---------|-------------|
| [Tooling & Environment](#tooling--environment) | (seed) UTF-8 BOM breaks `node --check` on a shebang line |
| [Debugging Method](#debugging-method) | (seed) probe state before swinging at a fix |

---

## Tooling & Environment

- **A UTF-8 BOM on line 1 makes `node --check` throw `SyntaxError: Invalid or unexpected token`, even though the file runs fine.** Some editors / PowerShell `Out-File` prepend an invisible `U+FEFF` before the `#!` shebang; the runtime tolerates it, the syntax checker doesn't. Fix: strip the leading byte (`if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1)`). Prevent: write plain UTF-8, no BOM. *(Seed example — replace with your own once you have them.)*

## Debugging Method

- **Probe state before shipping a fix; never guess at a cause.** Add logging / measure the actual values, reproduce, read the output, then fix. A 30-second probe beats an hour debugging a wrong fix that already landed. *(Seed example — replace with your own.)*
- **A release gate must accept proof at least as broad as the evidence that armed it.** A file-scoped TDD red cannot require a full-suite green to disarm; persist the red command and working directory, then compare normalized scopes so the same file, a covering directory, named-failure files, or the full suite can release it without allowing an unrelated green run through. *(tests-must-pass scope fix, 2026-07-21.)*
