---
name: handoff
description: Create or update HANDOFF.md to pass full session context to a fresh agent (often a cheaper model) so it can resume work without re-deriving state from chat or git logs. Use when ending a session, switching tasks, or when the user says "handoff", "save context", "write a resume prompt", or "I'm done for now".
---

# Handoff — Session Context Transfer for a Cold Agent

**Purpose:** Write `HANDOFF.md` so a FRESH SESSION (often a cheaper model) picks up cleanly and finishes the work. The handoff is the bridge between this session's full context and the next session's empty context.

## Optimize for completeness, not brevity

The reader is a **cold agent**, not a human skimming. The agent reads this file line by line as primary context for the entire next session. Underdetailed handoffs cause the picking-up agent to re-derive state from git log + chat (wasting turns and missing things), lose cross-repo state, and work on the wrong thing because the *why* got dropped.

So: **as long as needed.** A small session might be 100 lines; a busy multi-repo session might be 250+. Don't pad, but don't cut detail the agent needs to resume. Use clear section headings so a human CAN jump around, but write for the agent that reads it all.

## HARD RULES

1. **ACTION FIRST. Reference second. Always.** The cold agent must know WHAT TO DO within 30 seconds of opening the file. Section order (load-bearing, do not deviate):
   1. **Pick up here** — branch, head commit, test command, item 1 in one paragraph. Cold orientation.
   2. **Resume order** — dependency-ordered numbered list, one line of reasoning per item ("item N first because items after it fail without it").
   3. **What's broken or stub** — read BEFORE touching code. Trip-wires for things that look-shipped-but-aren't.
   4. **Next session — priority order (full detail)** — scope + size estimate + why-it-matters + what-it-unblocks per item.
   5. **Inline reference material** for the top items (templates, target code shape) — placed next to the item that needs it.
   6. **Strategic context** — why this work matters for the goal. Read AFTER you know what you're doing.
   7. **Cross-repo state** — table: repo / branch / last commit / tests / working tree.
   8. **What this session shipped** — one line each; full detail lives in the changelog.
   9. **Human-owned items** — non-coding backlog (account setup, credentials, decisions), kept separate so the agent doesn't conflate it with technical work.
   10. **Tested vs assumed** — where surprise bugs likely lurk.
   11. **Blocked on the human** — skip these, grab the next item.
   The anti-pattern this prevents: strategic context first, action buried at section 5. The agent should be able to act after reading sections 1-2 alone.
2. **Cross-repo state always.** If the session touched more than one repo, every touched repo gets a row: branch, last commit, dirty state.
3. **Every work item gets a size estimate** so the agent has scope sense (small / medium / large, or your project's convention).
4. **Separate technical items from human-owned items.** Two sections. Account setup / credentials / decisions are NOT coding work — don't let the agent pick them up as tasks.
5. **Mark broken vs stub vs working explicitly.** For any active piece, the agent needs to know which features look shipped but aren't wired end-to-end.
6. **Bullets and tables over paragraphs.** Every line stands alone.
7. **Resume order has reasoning.** Not just items 1-5 — name what each unblocks. The agent needs the dependency graph, not just a list.

## Where things go (don't bloat HANDOFF with content that lives elsewhere)

| Content | File |
|---|---|
| Priorities for next session, strategic standing, broken/stub inventory, human-owned items | `HANDOFF.md` |
| What shipped this session (full detail) | `CHANGELOG.md` (newest at top) — handoff REFERENCES it, doesn't duplicate |
| What the project can do today | `FEATURES.md` |
| Bug stories / what broke + how it was fixed | `learnings.md` |
| Long-running design decisions | `intent.md` / `PHILOSOPHY.md` |
| "Where does X live / how do I Y" | `FAQ.md` |

## The shape

```markdown
# Handoff — YYYY-MM-DD ([session shorthand])

## Pick up here (30-second orientation)
**Repo:** [path] on `[branch]` (head `[hash]`, [pushed / NOT pushed]).
**Confirm green before resuming:** [exact test command] -> expect [N/N passing].
**Start on:** item 1 below ([one line]).
**After item 1:** item 2 ([one line, name the cliff if any]).

Read the rest top-to-bottom before touching code.

## Resume order (dependency-ordered)
1. **[Item]** — [why first: what it unblocks].
2. **[Item]** — [why second].

## What's broken or stub right now (read BEFORE touching code)
**[Area A]:**
- [x] [hard breakage — won't compile / fails on click]
- [!] [stub — looks shipped, not wired end-to-end]

## Next session — priority order (full detail)
1. **[Item]** ([size estimate]). Scope: [one line]. **Why it matters:** [one line]. **Unblocks:** items N, M.

## [Inline reference for top items, if any]

## Strategic context
One short paragraph: where we are relative to the goal, and what this session changed about that. If the session was INFRASTRUCTURE-shaped (refactors, primitives, tooling), say so — that compounds but doesn't ship the product. Distinguish "compounds" from "ships."

## Cross-repo state
| Repo | Branch | Last commit | Tests | Working tree |
|---|---|---|---|---|

## What this session shipped (one line each — full detail in CHANGELOG)
- ...

## Human-owned items (separate from technical backlog)
A. **[Item]** — needs the human (account / credential / decision). Notes.

## Tested vs assumed (where surprise bugs likely lurk)
- [x] **Tested end-to-end:** [driven + saw evidence]
- [!] **Green but not driven:** [shipped behind passing tests, never exercised] <- look here first

## Blocked on the human (skip these, grab the next item)
- [Item] — needs [key / hardware / decision]
```

## Hygiene before saving

Before writing the handoff, do these three:
1. **Add a CHANGELOG entry** for what shipped (newest at top, dated). The handoff references it; don't duplicate it.
2. **Add FEATURES rows** for any new capability; update headline counts.
3. **Trim the roadmap** — anything shipped this session that was on the roadmap gets deleted from it (it's in CHANGELOG/FEATURES now). The roadmap is forward-looking only.

## After writing

Tell the user: "Handoff saved at [path]. [N] lines. The next session should read HANDOFF.md + the latest CHANGELOG entry, then start on item 1." If it's >250 lines, add: "Long handoff — the session covered [N] repos / [N] open threads; the agent needs the detail, you can skim."

## Anti-patterns the picking-up agent will notice

- "What shipped" with no context for WHY it matters.
- Work items with no size estimate -> no scope sense.
- Human-owned items mixed into the technical backlog -> agent picks the wrong thing.
- No "what's broken" inventory -> agent trips into a known stub.
- No resume-order reasoning -> agent picks the cheapest item, not the load-bearing one.
- Single-repo state when the session was multi-repo.
