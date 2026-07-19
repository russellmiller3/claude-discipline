---
name: distill-learnings
description: Mine the accumulated learnings.md gotchas with first-principles reasoning and turn recurring ones into ENFORCED hooks/rules. Cluster loose lessons by root cause, run a first-principles teardown on each cluster, consolidate the file, and propose a hook or CLAUDE.md rule for anything that has bitten twice. Use when the user says "/distill-learnings", "distill the learnings", "mine learnings", "consolidate learnings", "turn learnings into hooks", or when the SessionStart nudge says a distill is due. This is the batch refinement pass — distinct from the per-fix learnings-write-nudge (which captures one lesson) and learnings-to-hooks-nudge (which flags one lesson on read).
---

# Distill Learnings — the batch first-principles refinement pass

**Announce:** "I'm using the distill-learnings skill."

## What this is (and the one job it does)

`learnings.md` files are an **append-only pile of surface gotchas** — captured fast, at the moment
of a fix, never revisited. Left alone they grow messy: duplicates, five symptoms of one deeper
cause, and lessons that recurred but never became a reflex. This skill is the **periodic distiller**
that closes the Getty loop mechanically:

```
capture (per fix, already happens)  →  DISTILL (this skill)  →  enforced hook/rule
   raw gotcha appended                  cluster + first-principles     mistake can't recur
```

It runs against the same two files the rest of the learnings system uses: the global
`~/.claude/learnings.md` (cross-project method) and `<projectRoot>/learnings.md` (this codebase).

## The method — five passes, in order

### Pass 0 — See what's due, read only the new lessons

Run the shared status CLI to see which files have an undistilled backlog and how big it is:

```bash
node ~/.claude/hooks/lib/learningsWatermark.mjs --status
```

It prints each due file with its `newCount` (lessons added since the last distill) and the reason
(`threshold` or `stale`). Read those files. Focus on the **new** lessons since the last watermark,
but pull in older ones freely when they belong to the same cluster — consolidation spans the file.

### Pass 1 — Cluster by ROOT CAUSE, not by file or topic

Group the loose lessons by the **underlying mechanism**, not their surface area. Five bullets that
each describe a different symptom of "PowerShell mangles UTF-8" are ONE cluster. A cluster of size 1
is fine — not everything merges. Name each cluster by its suspected root cause in one line.

### Pass 2 — First-principles teardown on each multi-lesson cluster

For every cluster with **2+ lessons** (or one that recurred / cost >30 min), run the
[first-principles](../first-principles/SKILL.md) method — its four forced passes — to find the ONE
irreducible cause beneath the symptoms. The output you want per cluster:

- **The root cause** — the bedrock fact the surface gotchas are all shadows of.
- **Is it a law or a habit?** — if the whole cluster exists because of an inherited convention, the
  fix may be to kill the convention, not to document the symptom.

A single trivial lesson (a one-off, no recurrence, mechanical) skips the teardown — note
"first-principles: skipped, one-off" and leave it as-is.

### Pass 3 — Produce two proposals per cluster

For each cluster, propose **both**:

1. **Consolidation** — rewrite the scattered bullets as ONE distilled lesson stated at the root-cause
   level, with the symptoms as examples under it. Dedupe. This edits the `learnings.md` file directly.
2. **Enforcement (for anything that bit ≥2× or cost >30 min)** — the concrete mechanical guard that
   makes the mistake impossible or auto-surfaces the fix: a **hook** (with `*.test.mjs` + HOOKBOOK row
   + settings.json registration) or a **CLAUDE.md rule**. This is the "improve" — a tidier note is not
   the goal; an enforced invariant is. Cross-check `~/.claude/hooks/HOOKBOOK.md` first: if a hook
   already ALMOST covers it, propose EXTENDING that hook, never a sibling.

If a cluster genuinely can't be caught by a hook, say so explicitly and leave it as a consolidated
note — don't invent a toothless guard.

### Pass 4 — Apply, get sign-off on enforcement, then stamp the watermark

- **Apply the consolidations now** — editing `learnings.md` is safe, reversible, and yours to do.
- **Do NOT auto-build the hooks.** Present the enforcement proposals and get Russell's explicit yes in
  this session before creating any hook (per `~/.claude/CLAUDE.md`: ask before building a hook; never
  spawn an agent). On a yes, build each via the [create-hook](../create-hook/SKILL.md) skill.
- **Stamp the watermark last**, so the SessionStart nudge resets and only fires again on genuinely new
  lessons:

```bash
node ~/.claude/hooks/lib/learningsWatermark.mjs --mark
```

(With no file args it stamps every file in scope; pass explicit paths to stamp just one.)

## Required output — the Distillation block

Produce this compact, scannable block (per Russell's format — no walls):

```markdown
## Distillation: <global | project> learnings — <N> lessons reviewed

**Clusters found:**
| Root cause | Lessons folded in | Enforcement proposed |
|---|---|---|
| <one-line root cause> | <count> | <hook name / CLAUDE.md rule / none — why> |

**Consolidations applied:** <what got rewritten/deduped, in one line each>

**Enforcement proposals (need your yes before I build):**
- <hook or rule> — makes <mistake> impossible because <mechanism>
```

## Guardrails (so it's rigor, not theater)

- **Root cause, not restatement.** A distillation that just reworded the bullets didn't do the work —
  each cluster must name the mechanism beneath the symptoms.
- **Enforcement is the point, not tidiness.** Every cluster that recurred gets an enforcement proposal
  or an explicit "a hook can't catch this because …". A pass that proposes zero hooks on a file full of
  repeat mistakes probably under-clustered.
- **Human-in-the-loop on hooks.** Consolidate freely; never create a hook or spawn an agent without
  Russell's in-session yes.
- **One home per fact.** A lesson that became an enforced hook should point at the hook (or be removed
  from the raw pile) so the same gotcha isn't re-litigated next distill.
- **Stamp only after applying.** The `--mark` resets the backlog; run it at the end, or the nudge lies.
