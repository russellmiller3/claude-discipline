---
name: docs-cascade
description: After shipping a feature, update every documentation surface so the feature is visible to users, to future sessions, and to any AI prompt that needs to know it exists. Use when the user says "update docs", "doc cascade", "sync the docs", or before declaring a feature done. Config-driven — point it at your project's doc surfaces.
user_invocable: true
---

# Docs Cascade

**Announce:** "Syncing the doc surfaces to match what was just built."

## The rule

**If a feature exists in the code but not in the docs, it doesn't exist** — not for new users, not for the next session, not for any AI that writes against your project. A feature isn't done when it works; it's done when every surface that should mention it does.

This skill is deliberately generic. Most projects' documentation lives in a *set* of surfaces that drift out of sync one ship at a time. Define that set once (below), then run this skill after every feature.

## Step 0: Narrate what was built

Before touching files, write a short narrative (in chat, not in files): what shipped this session (`git log --oneline -15`), why each piece matters to the user, and what's different now vs before. Explain significance, not a changelog — "you can now export a styled PDF of any report," not "added `exportPdf()`."

## Step 1: Define your doc surfaces (the config)

List the surfaces this project keeps in sync. A typical set — adapt to your repo:

| Surface | Example file | Update when |
|---------|-------------|-------------|
| **Spec / reference** | `intent.md`, `SPEC.md`, `API.md` | new capability, syntax, endpoint, or type |
| **User guide / tutorial** | `USER-GUIDE.md`, `docs/guide.md` | any user-facing feature — add a worked example |
| **Changelog** | `CHANGELOG.md` | every ship (newest at top, dated) |
| **Capability inventory** | `FEATURES.md` | new user-visible feature (so you don't build it twice) |
| **AI / agent prompt** | `system-prompt.md`, `AI-INSTRUCTIONS.md` | anything an AI in your product must know to use the feature |
| **Roadmap** | `ROADMAP.md` | mark the item done; trim it from "next" |
| **Marketing** | `landing/*.html` | feature appears in demos or hero copy |
| **FAQ** | `FAQ.md` | new subsystem -> "where does X live / how do I Y" |

> Record YOUR project's real list at the top of the project `CLAUDE.md` (a "Documentation Cascade" section). Then this skill just walks that list.

## Step 2: Find the gaps

Read the source of truth for what's actually implemented (your parser/router/handlers/exports), then read each doc surface and find where the new feature is missing.

## Step 3: Update each surface

For each gap: add the feature in that surface's existing style — syntax + a runnable example for references, a worked teaching example for guides, a row for inventories, a dated entry for the changelog. Match each file's existing format; don't impose a new one.

**Blocking surfaces:** treat the user guide and any shipped AI prompt as ship-blockers. A feature with no guide example won't be learned; a feature missing from the AI prompt means your in-product assistant gives stale guidance.

## Step 4: Verify

- [ ] Nothing in the code lacks a doc entry.
- [ ] No doc entry references something that doesn't exist.
- [ ] Spot-check 2-3 examples actually run.
- [ ] Counts/stats (test count, feature count) are current.

## Step 5: Commit

Commit docs-only: `docs: sync all surfaces with current state`. Change NO code files in this skill — docs only. Don't document features that don't exist yet; don't remove docs for features that still do.
