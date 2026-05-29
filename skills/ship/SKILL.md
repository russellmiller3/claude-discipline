---
name: ship
description: Ship a feature branch end to end — update docs, run the test gate, commit, merge to main, delete the branch, push. Not just a git merge; a full ship discipline with doc and data gates. Use when the user says "ship it", "ship this", or a feature is done and verified.
allowed-tools: Bash, Read, Glob, Grep, Edit, Write, Skill
---

# Ship

Ship the current feature branch: docs current, tests green, committed, merged, pushed. The point of a ship *skill* (vs a bare `git merge`) is that the easy-to-forget steps — docs, data-at-risk, the final narrative — are part of the ritual, not left to memory.

## Step 0: Documentation gate (blocks ship if incomplete)

**The rule: if a feature exists in the code but not in the docs, it doesn't exist for anyone but you.** Every feature ships with docs or it doesn't ship.

If a `docs` / `docs-cascade` skill is installed, invoke it now and let it own the doc surfaces; ship blocks until it reports clean. Otherwise, update your project's documentation surfaces yourself — at minimum: the spec/reference, the user-facing guide, the changelog, and any AI-facing prompt that needs to know the feature exists.

**Ship-only additions** (handle here, after docs are clean):
- **`HANDOFF.md`** — what was done, what's next, key decisions (or invoke the `handoff` skill).
- Project **`CLAUDE.md`** — add any rule that emerged from this branch's work.
- **`learnings.md`** — entries for tricky bugs/patterns from this ship.

## Step 1: Test gate (must pass to continue)

Skip if the branch changed only documentation (`.md` files, no code). Otherwise run the project's full test suite. **If tests fail, stop and fix them — never ship red.** (The `tests-must-pass` hook will block you anyway; fix the cause.)

If the change is observable in a running app, also verify it visually — a green suite is not proof the UI renders.

## Step 2: Data-at-risk gate (must pass to continue)

If the project has valuable runtime data that lives in the working tree — SQLite DBs, trained model bundles, training archives — make sure git sees its true state before any cleanup runs:
- For SQLite in WAL mode, checkpoint first: `sqlite3 <db> "PRAGMA wal_checkpoint(TRUNCATE);"` — otherwise pending rows are invisible to `git status` and a cleanup step can eat them.
- Commit the data, or explicitly decline with a one-line rationale in the commit message. Never let a ship succeed with unstaged data additions silently dropped.

(If the project has no such data, skip this step.)

## Step 3: Commit

Stage the changed files (prefer explicit names over `git add -A`) and commit with a message describing what shipped. End the message with your project's co-author trailer if you use one.

## Step 4: Merge to main

```
git switch main
git merge <feature-branch> --no-ff -m "Merge <feature-branch>"
```

## Step 5: Delete the feature branch

```
git branch -d <feature-branch>
```

## Step 6: Push

```
git push origin main
```

If the push fails on divergence, pull (`--no-rebase --no-edit`) then push again.

## Step 7: Report

Tell the user: what shipped, how many commits, test result, which docs were updated, branch-deleted confirmation.

## Step 8: Big picture

Close with a short "what we accomplished" in plain English (no code jargon): what this unlocks, how it connects to the bigger goal, and the ranked next 2-3 moves.
