#!/usr/bin/env bash
# safe-merge-to-main.sh — the ONE way any agent lands work onto a repo's main branch.
#
# Why this exists (2026-07-02, skaffen-desktop): every background Agent gets its own
# git worktree, but a worktree only isolates the WORKING TREE + index — refs/heads/main
# lives in the one shared .git directory across every worktree of a repo. When an agent
# lands its work with a raw `git update-ref refs/heads/main <sha>` (or `git branch -f
# main`/`git checkout -B main <sha>`) instead of a real `git merge --ff-only`, git's
# built-in fast-forward safety check never runs. Three separate agents did exactly this
# in one session, each unknowingly overwriting a sibling agent's just-landed commit —
# recoverable (nothing is ever truly deleted, the old tip stays reachable via reflog)
# but each incident cost 20-40 minutes of archaeology + manual re-merge.
#
# This script is the fix: a real mutex (an atomic `mkdir` lock — portable, works on the
# same filesystem on Windows/Git-Bash and Linux) around the whole rebase-test-land
# sequence. Landing uses `git update-ref refs/heads/main <new> <old>` — the THREE-ARG
# form, which is a compare-and-swap: git refuses the write unless refs/heads/main's
# CURRENT value still equals <old> at the moment of the write. This is deliberately
# NOT `git checkout main && git merge --ff-only`, because `main` is almost always
# checked out somewhere else already (the primary working directory) and git refuses
# to check out a branch that's checked out in another worktree. The compare-and-swap
# gives the same fast-forward-only safety (verified via `merge-base --is-ancestor`
# immediately before the swap) without ever needing to touch main's own checkout. If
# two agents race, the second one's compare-and-swap fails loudly (exit 5) instead of
# silently overwriting the first — it re-rebases onto the new tip and retries.
#
# Usage:
#   safe-merge-to-main.sh <repo-path> <branch-to-land> [test-command...]
#
# Example:
#   safe-merge-to-main.sh C:/Users/rmill/Desktop/programming/skaffen-desktop \
#     worktree-agent-abc123 \
#     "PYTHONPATH=src py -m pytest -m 'not integration' -q --rootdir ."
#
# Exit codes: 0 = landed. 1 = usage error (bad path, or $REPO doesn't have $BRANCH
# checked out). 2 = lock timeout (another merge in flight too long — inspect, don't
# force). 3 = rebase produced conflicts (resolve by hand in $REPO, `rebase --continue`,
# THEN re-run this script — never fall back to a plumbing ref write to route around
# this). 4 = test command failed after rebase (fix forward, never land broken code).
# 5 = main moved since the rebase (another agent landed first) — just re-run this
# script, it rebases onto the new tip and retries. This is the EXPECTED shape of a
# race, not a bug — the whole point is that it fails loudly here instead of silently
# discarding work.
#
# This script NEVER needs COMMIT_MAIN_OVERRIDE=1 or any other guard bypass: it is
# itself the sanctioned path those guards exist to funnel agents toward.
#
# KNOWN SIDE EFFECT (2026-07-02, discovered right after first production use): landing
# via update-ref moves refs/heads/main WITHOUT ever checking anything out, so if the
# PRIMARY working directory has `main` checked out (the common case), its on-disk files
# now lag behind its own HEAD -- `git status` there shows a pile of confusing "modified"/
# "deleted" files that are actually just staleness, not real uncommitted work. This is
# harmless (nothing is lost, it's the working tree catching up) but looks alarming. Fix
# in the primary directory: `git status --short` to eyeball it looks like plain
# staleness (not someone's genuine WIP), then `git checkout -- .` to sync it to HEAD.

set -euo pipefail

REPO="${1:?usage: safe-merge-to-main.sh <repo-path> <branch-to-land> [test-command...]}"
BRANCH="${2:?usage: safe-merge-to-main.sh <repo-path> <branch-to-land> [test-command...]}"
shift 2 || true
TEST_CMD="${*:-}"

if [ ! -d "$REPO/.git" ] && [ ! -f "$REPO/.git" ]; then
  echo "safe-merge-to-main: '$REPO' is not a git repo (no .git)" >&2
  exit 1
fi

GITDIR="$(git -C "$REPO" rev-parse --git-common-dir)"
# git-common-dir may be relative to $REPO; resolve it absolute so the lock path is stable
case "$GITDIR" in
  /*|?:*) : ;;  # already absolute (unix or Windows drive-letter form)
  *) GITDIR="$REPO/$GITDIR" ;;
esac
LOCK="$GITDIR/safe-merge-to-main.lock"

# --- acquire the mutex: atomic mkdir, retry with backoff, give up after ~2 minutes ---
ACQUIRED=0
for i in $(seq 1 40); do
  if mkdir "$LOCK" 2>/dev/null; then
    ACQUIRED=1
    break
  fi
  sleep 3
done
if [ "$ACQUIRED" -ne 1 ]; then
  echo "safe-merge-to-main: could not acquire lock at $LOCK after ~2min — another merge is stuck or very slow. Inspect $LOCK, do NOT delete it blindly (check what's using it first)." >&2
  exit 2
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

echo "safe-merge-to-main: lock acquired ($LOCK)"

# --- rebase the landing branch onto CURRENT main, inside the repo's OWN worktree/checkout ---
# We operate via `git -C` so this never depends on which directory the caller's shell is in,
# and never touches whatever branch the primary working directory happens to have checked out.
CURRENT_MAIN="$(git -C "$REPO" rev-parse main)"
echo "safe-merge-to-main: current main = $CURRENT_MAIN"

if ! git -C "$REPO" merge-base --is-ancestor "$CURRENT_MAIN" "$BRANCH" 2>/dev/null; then
  echo "safe-merge-to-main: '$BRANCH' does not already contain current main — rebasing onto it"
  if ! git -C "$REPO" rebase "$CURRENT_MAIN" "$BRANCH"; then
    echo "safe-merge-to-main: rebase produced conflicts. Resolve them by hand in the repo" >&2
    echo "  (git -C \"$REPO\" status), then 'git -C \"$REPO\" rebase --continue', then re-run" >&2
    echo "  this script. Do NOT abandon this for a raw ref write." >&2
    exit 3
  fi
fi

# --- run the caller's test command against the rebased branch, if one was given ---
# $REPO must be a worktree that ALREADY has $BRANCH checked out (the agent's own worktree —
# never the primary working directory, never a worktree with `main` checked out). This
# script deliberately never runs `checkout` at all: no worktree's HEAD is ever touched.
if [ -n "$TEST_CMD" ]; then
  ACTUAL_BRANCH="$(git -C "$REPO" symbolic-ref --short -q HEAD || echo DETACHED)"
  if [ "$ACTUAL_BRANCH" != "$BRANCH" ]; then
    echo "safe-merge-to-main: '$REPO' has '$ACTUAL_BRANCH' checked out, not '$BRANCH'." >&2
    echo "  Pass the path to the worktree that already has '$BRANCH' checked out." >&2
    exit 1
  fi
  echo "safe-merge-to-main: running test command: $TEST_CMD"
  if ! ( cd "$REPO" && eval "$TEST_CMD" ); then
    echo "safe-merge-to-main: test command failed on rebased '$BRANCH' — NOT merging broken code." >&2
    exit 4
  fi
fi

# --- land it: compare-and-swap the main ref, never an unconditional write ---
# Re-read main's tip NOW (inside the lock, right before the swap) in case it moved
# during the rebase/test steps above -- OLD_MAIN_NOW is the exact value the CAS below
# requires to still be true, closing the race window completely.
OLD_MAIN_NOW="$(git -C "$REPO" rev-parse main)"
NEW_TIP="$(git -C "$REPO" rev-parse "$BRANCH")"
if ! git -C "$REPO" merge-base --is-ancestor "$OLD_MAIN_NOW" "$NEW_TIP"; then
  echo "safe-merge-to-main: '$BRANCH' is not a fast-forward of main's CURRENT tip ($OLD_MAIN_NOW)." >&2
  echo "  main moved since the rebase above. Re-run this script; it will rebase onto the new tip." >&2
  exit 5
fi
echo "safe-merge-to-main: compare-and-swap main: $OLD_MAIN_NOW -> $NEW_TIP"
if ! git -C "$REPO" update-ref refs/heads/main "$NEW_TIP" "$OLD_MAIN_NOW"; then
  echo "safe-merge-to-main: update-ref refused the swap -- main's value changed at the last instant" >&2
  echo "  (should be impossible while holding the lock; investigate). Re-run this script." >&2
  exit 5
fi

echo "safe-merge-to-main: main is now $NEW_TIP — landed cleanly, lock releasing."
