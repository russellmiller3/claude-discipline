# Engineering Learnings

Lessons learned during development. **Organized by topic — merge new lessons into existing sections, don't append chronologically.** A reader should find "the ECharts gotcha" in one place, not scattered across dated blocks.

**How to use:**
- **Before** planning a feature, debugging, or touching an unfamiliar subsystem: scan the TOC, read the matching section.
- **After** a non-obvious fix, a platform gotcha, or anything that would bite the next developer: write a one-bullet lesson under the right topic.

**Bullet format:**
```
- **<load-bearing one-line claim>.** <Why it happens — the mechanism>. <The fix>. <Optional: date / commit>.
```
The bold claim is the part a tired reader skims. The rest is for when they need the mechanism.

> This file pairs with three hooks: `learnings-toc-inject` (surfaces this TOC every session), `learnings-error-match` (surfaces the matching bullet the moment a relevant error appears), and `learnings-write-nudge` (blocks stop when you fixed a bug but wrote no lesson). Keep the `## Section` headers and this TOC in sync — the hooks parse them.

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
