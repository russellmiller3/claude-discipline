#!/usr/bin/env node
/**
 * PreToolUse hook — block git commit directly to main or master.
 *
 * Fills the gap between:
 *   - worktree-default-for-edits.mjs (blocks file edits in primary checkout)
 *   - no-feature-branch-push.mjs (blocks pushing non-main branches)
 *
 * This hook closes the remaining escape hatch: you could create a worktree
 * but name it after main, or checkout main in the worktree before committing.
 * Any `git commit` on main/master is blocked here.
 *
 * Allows: git commit on any branch other than main/master
 * Blocks: git commit (any flags) when current branch is main or master
 * Override: COMMIT_MAIN_OVERRIDE=1
 *
 * --- Concurrency check (added 2026-07-02, real incident) ---
 * A plain `git commit ... COMMIT_MAIN_OVERRIDE=1` is a compare-nothing write: it never
 * checks whether main moved since it was last read (unlike safe-merge-to-main.sh's
 * three-arg CAS). An orchestrator used this override for what looked like a "safe,
 * doc-only" README/HANDOFF commit while a background agent's safe-merge-to-main.sh
 * landing raced in at nearly the same moment. The override commit's parent was stale by
 * exactly one commit; the result silently became a 991-line regression (deleted a
 * just-shipped feature, its tests, and its screenshots).
 *
 * A solo doc-only override commit with nothing else running is genuinely safe — this
 * hook does NOT block that case. It only escalates when `git worktree list` (against the
 * repo the commit actually targets) shows another worktree beyond the primary checkout
 * that is currently LOCKED — the marker background agents' worktrees carry while active.
 * That signals a background agent may be mid-landing right now, so the plain override
 * commit is denied in favor of safe-merge-to-main.sh (or CONCURRENT_COMMIT_OK=1 for a
 * deliberate, supervised exception).
 *
 * Override for the no-concurrency case: COMMIT_MAIN_OVERRIDE=1 (unchanged)
 * Override for the concurrency-detected case: CONCURRENT_COMMIT_OK=1 (new, additive —
 * both tokens must be present to force a commit while a locked worktree exists)
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// The command may target ANOTHER repo than the session cwd: `cd <kit> && git commit ...`
// or `git -C <kit> commit ...`. Resolve the directory the commit actually runs in —
// checking the session repo's directory false-blocked a commit on another repo's fix
// branch just because the SESSION repo sat on main (2026-07-01). Shared by the branch
// check and the concurrency check below so both judge the same target repo.
function effectiveDirectory(normalizedCommand, sessionDirectory) {
  const cdPrefixMatch = normalizedCommand.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/);
  if (cdPrefixMatch) return cdPrefixMatch[1] || cdPrefixMatch[2] || cdPrefixMatch[3];
  const dashCMatch = normalizedCommand.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (dashCMatch) return dashCMatch[1] || dashCMatch[2] || dashCMatch[3];
  return sessionDirectory;
}

// Is there another worktree of this repo, besides the primary checkout, that is
// currently locked? That's the signal a background agent may be mid-landing. Fails
// open (returns false = "no concurrency detected") on ANY git error — a `git worktree
// list` plumbing hiccup must never block a legitimate commit.
function hasLockedConcurrentWorktree(targetDirectory) {
  let worktreeListOutput;
  try {
    worktreeListOutput = execSync('git worktree list --porcelain', {
      encoding: 'utf8',
      cwd: targetDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return false; // fail open
  }

  const worktreeEntries = worktreeListOutput.split(/\n\n+/).filter((entryText) => entryText.trim());
  // First entry is always the primary checkout (listed first by git); every subsequent
  // entry is a linked worktree — those are the ones a background agent would be using.
  return worktreeEntries.slice(1).some((entryText) => /^locked\b/m.test(entryText));
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  if (event.tool_name !== 'Bash') process.exit(0);

  const command = (event.tool_input && event.tool_input.command) || '';
  if (typeof command !== 'string') process.exit(0);

  const c = command.replace(/\s+/g, ' ').trim();

  // Only fire on git commit
  if (!/\bgit\s+commit\b/.test(c)) process.exit(0);

  const targetDirectory = effectiveDirectory(c, event.cwd || process.cwd());

  // Inline env-var prefix like `COMMIT_MAIN_OVERRIDE=1 git commit ...` sets the var
  // for the git subprocess but not for this hook process. Detect both the inline form
  // and the real env var, so the two forms behave identically below.
  const overridePresent = process.env.COMMIT_MAIN_OVERRIDE === '1' || /\bCOMMIT_MAIN_OVERRIDE=1\b/.test(c);
  const concurrentOkPresent = process.env.CONCURRENT_COMMIT_OK === '1' || /\bCONCURRENT_COMMIT_OK=1\b/.test(c);

  if (overridePresent) {
    // Solo override (no concurrency): behave exactly as before — allow immediately,
    // stay fast, don't even shell out to `git worktree list` for the common case.
    if (concurrentOkPresent || !hasLockedConcurrentWorktree(targetDirectory)) {
      process.exit(0);
    }

    const concurrencyReason = [
      'Commit to main blocked (concurrency detected).',
      '',
      `Command: ${c.slice(0, 120)}${c.length > 120 ? '...' : ''}`,
      '',
      'COMMIT_MAIN_OVERRIDE=1 is present, but another worktree of this repo is currently',
      'LOCKED — that marker means a background agent may be mid-landing right now. A plain',
      '`git commit` never checks whether main moved since it was last read (unlike',
      'safe-merge-to-main.sh, which lands via a compare-and-swap). Racing a plain override',
      'commit against an in-flight agent landing is exactly how a 991-line regression',
      'silently landed (a just-shipped feature, its tests, and its screenshots got deleted',
      "because the override commit's parent was stale by one commit).",
      '',
      'Fix — use the sanctioned landing script instead:',
      '  scripts/safe-merge-to-main.sh <repo-path> <your-branch> "<test-command>"',
      '',
      'Or wait for the other agent(s) to finish (check `git worktree list` for `locked`',
      'entries), then retry.',
      '',
      'Override ONLY if you have verified the locked worktree is genuinely inert/about to',
      'be torn down and this commit is still safe:',
      '  CONCURRENT_COMMIT_OK=1',
    ].join('\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: concurrencyReason,
      },
    }));
    process.exit(0);
  }

  // A chained branch switch BEFORE the commit changes where the commit lands:
  // `git switch -c fix/x && git add ... && git commit` never touches main. Honor the LAST
  // explicit branch switch preceding the first `git commit` (only `switch` and `checkout -b`
  // — a plain `checkout <target>` may be a file restore, not a branch change). Without this,
  // the standard branch-then-commit one-liner was false-blocked (2026-07-01).
  let branch;
  const commandBeforeCommit = c.slice(0, c.search(/\bgit\s+commit\b/));
  const branchSwitches = [...commandBeforeCommit.matchAll(
    /\bgit\s+(?:switch\s+(?:-[cC]\s+)?|checkout\s+-[bB]\s+)(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/g
  )].map((match) => (match[1] || match[2] || match[3] || '').trim()).filter((name) => name && !name.startsWith('-'));
  if (branchSwitches.length) {
    branch = branchSwitches[branchSwitches.length - 1];
  } else {
    try {
      branch = execSync('git branch --show-current', {
        encoding: 'utf8',
        cwd: targetDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      process.exit(0); // fail open — don't block on git errors (incl. a bad cd path: git itself will error)
    }
  }

  if (branch !== 'main' && branch !== 'master') process.exit(0);

  const reason = [
    'Commit to main blocked.',
    '',
    `Current branch: ${branch}`,
    `Command: ${c.slice(0, 120)}${c.length > 120 ? '...' : ''}`,
    '',
    "Rule: never commit directly to main. Always work on a feature/ or fix/ branch.",
    '',
    'To create a branch and commit:',
    '  git switch -c feature/<task>',
    '  git commit ...',
    '',
    'When done, merge back:',
    '  git switch main',
    '  git merge --ff-only feature/<task>',
    '  git branch -d feature/<task>',
    '  git push origin main',
    '',
    'Override for deliberate main commits (version bumps, doc-only, repo maintenance):',
    '  COMMIT_MAIN_OVERRIDE=1',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

main();
