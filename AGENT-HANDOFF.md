# AGENT-HANDOFF — concurrent-commit-guard (claude-discipline mirror)

## GOAL
Mirror the concurrency check added to `~/.claude/hooks/no-commit-to-main.mjs` into this sibling
public repo. See `~/.claude/claude-hooks-concurrent-commit-guard/AGENT-HANDOFF.md` for the full
incident writeup and design rationale — this file only covers what's specific to this repo.

## DONE
- Copied the extended `hooks/no-commit-to-main.mjs` from the hooks-repo worktree, with ONE
  intentional diff: the deny message points at `scripts/safe-merge-to-main.sh` (repo-relative)
  instead of `~/.claude/scripts/safe-merge-to-main.sh` — matches this repo's existing convention
  (its own `unsafe-main-ref-write-guard.mjs` deny message already uses the repo-relative form
  here vs the `~/.claude/` form in the personal hooks repo).
- Mirrored the same 10 new tests into `hooks/no-commit-to-main.test.mjs` (18 total).
- Verified: `node --test no-commit-to-main.test.mjs` -> 18/18 pass.
- Updated `docs/HOOKBOOK.md`'s `no-commit-to-main` entry (dated 2026-07-02, incident reference,
  test count now 18).
- Updated `README.md`'s hook table row for `no-commit-to-main` with a one-line pointer to the
  new concurrency behavior. This repo has no "Recent changes" section in README (HOOKBOOK.md +
  the table are its documentation convention) — confirmed via grep before deciding not to add one.

## NEXT
- Full suite (`node --test`, all hook files) running in background via Monitor — confirm green
  before merge.
- Once green: squash WIP autocommits into one real commit, `git switch main && git merge
  --ff-only feat/concurrent-commit-guard`, delete branch, remove worktree. Do NOT push (not
  authorized this session).
- No new hook file created here either — nothing to register anywhere.

## BLOCKER
None currently. Waiting on full-suite test confirmation (async, in progress).

STATUS: IN PROGRESS
