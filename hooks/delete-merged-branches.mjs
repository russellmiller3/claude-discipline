#!/usr/bin/env node
/**
 * PostToolUse hook — auto-delete local branches once their work is in main.
 *
 * The local-merge flow (~/.claude/CLAUDE.md "Don't Push Branches Until Work Is
 * Done"): cut a branch, do the work, merge to main, delete the branch, push
 * main only. The "delete the branch" step keeps getting forgotten — clear
 * had ~24 local branches, half of them long since merged, and the last
 * handoff literally flagged a "branch-delete loose end."
 *
 * This hook closes that gap. It fires after a Bash/PowerShell tool call that
 * either merged something or pushed main, then sweeps every LOCAL branch whose
 * commits are fully contained in main and removes the now-redundant label.
 *
 * WHAT IT DELETES:
 *   - local branches fully merged into main (proven by `merge-base
 *     --is-ancestor <branch> main` — the authoritative "is it in main?" test)
 *
 * WHAT IT NEVER TOUCHES (belt and suspenders — three independent guards):
 *   - main / master / develop / release           (protected names)
 *   - the branch currently checked out (HEAD)      (current-branch guard)
 *   - any branch checked out in a worktree         (worktree guard + git's own
 *                                                    refusal to delete it)
 *   - branches with commits NOT in main            (the ancestor check fails)
 *   - remote branches / remote-tracking refs        (local-only by design)
 *
 * Because the ancestor check proves the branch's tip is reachable from main,
 * deleting the local label loses nothing — every commit lives on in main.
 *
 * TRIGGER (cheap string check first, so 99% of Bash calls exit instantly):
 *   - the command contains `git merge`, OR
 *   - the command contains `git push` AND mentions `main`
 *
 * Disable for a shell:  BRANCH_AUTODELETE_OFF=1
 *
 * Fail-open on any unexpected error — a housekeeping hook must never wedge CC.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROTECTED = new Set(['main', 'master', 'develop', 'release', 'HEAD']);

// Run git, capture stdout, swallow stderr. Throws on non-zero exit.
function git(args, cwd) {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Run git only for its exit code. true = success (exit 0), false = anything else.
function gitOk(args, cwd) {
  try {
    execSync(`git ${args}`, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The pure core — given a repo dir and the command that just ran, delete the
 * merged-into-main local branches and report what happened. Exported so the
 * test can drive it directly without going through stdin.
 *
 * @returns {{ deleted: string[], skipped: {branch:string,why:string}[],
 *             reason: string, mainRef?: string }}
 */
export function cleanMergedBranches({ cwd, command, env = process.env }) {
  if (env.BRANCH_AUTODELETE_OFF === '1') {
    return { deleted: [], skipped: [], reason: 'disabled' };
  }

  const triggerCommand = String(command || '').replace(/\s+/g, ' ').trim();

  // Trigger only on a merge, or a push that targets main. Everything else is
  // not a "work just landed in main" moment, so do nothing.
  const isMerge = /\bgit\s+merge\b/.test(triggerCommand);
  const isPushMain = /\bgit\s+push\b/.test(triggerCommand) && /\bmain\b/.test(triggerCommand);
  if (!isMerge && !isPushMain) {
    return { deleted: [], skipped: [], reason: 'no-trigger' };
  }

  // Resolve the repo root from the command's working directory.
  let repoRoot;
  try {
    repoRoot = git('rev-parse --show-toplevel', cwd).trim();
  } catch {
    return { deleted: [], skipped: [], reason: 'not-a-repo' };
  }

  // Never clean up in the middle of a merge/rebase — wait for a settled tree.
  if (gitOk('rev-parse --verify -q MERGE_HEAD', repoRoot)) {
    return { deleted: [], skipped: [], reason: 'merge-in-progress' };
  }

  // Pick the integration branch. Prefer main, fall back to master.
  const mainRef = gitOk('show-ref --verify -q refs/heads/main', repoRoot)
    ? 'main'
    : gitOk('show-ref --verify -q refs/heads/master', repoRoot)
      ? 'master'
      : null;
  if (!mainRef) return { deleted: [], skipped: [], reason: 'no-main' };

  // Parse `git branch`. The 1-char marker column tells us everything we need:
  //   "* name"  -> the current branch (never delete)
  //   "+ name"  -> checked out in a worktree (never delete)
  //   "  name"  -> a plain local branch (candidate)
  // Parsing the marker avoids `--format=%(...)`, whose `%` is mangled by
  // cmd.exe on Windows (see CLAUDE.md "Windows Command Hygiene").
  let branchLines;
  try {
    branchLines = git('branch', repoRoot).split('\n');
  } catch {
    return { deleted: [], skipped: [], reason: 'list-failed' };
  }

  const deleted = [];
  const skipped = [];
  for (const branchLine of branchLines) {
    if (!branchLine.trim()) continue;
    const marker = branchLine[0];
    const name = branchLine.slice(1).trim();
    if (!name || name.startsWith('(')) continue; // detached-HEAD entries

    if (PROTECTED.has(name) || name === mainRef) continue;
    if (marker === '*') { skipped.push({ branch: name, why: 'current' }); continue; }
    if (marker === '+') { skipped.push({ branch: name, why: 'worktree' }); continue; }

    // Authoritative test: is every commit on `name` already reachable from
    // main? Exit 0 = yes, fully merged. This is what makes the delete safe.
    if (!gitOk(`merge-base --is-ancestor "${name}" "${mainRef}"`, repoRoot)) {
      continue; // has work not in main — leave it alone
    }

    // Proven merged into main. `-D` is correct here: we verified containment
    // against main directly, so git's HEAD-relative `-d` re-check (which can
    // wrongly refuse when HEAD isn't main) would only get in the way.
    if (gitOk(`branch -D "${name}"`, repoRoot)) {
      deleted.push(name);
    } else {
      skipped.push({ branch: name, why: 'delete-failed' });
    }
  }

  return { deleted, skipped, reason: 'ok', mainRef };
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  // Fire for whichever shell tool ran git.
  if (!['Bash', 'PowerShell'].includes(event.tool_name)) process.exit(0);

  const command = event.tool_input && event.tool_input.command;
  const cwd = event.cwd || process.cwd();

  let cleanup;
  try {
    cleanup = cleanMergedBranches({ cwd, command });
  } catch {
    process.exit(0);
  }

  if (!cleanup.deleted.length) process.exit(0);

  const deletedNames = cleanup.deleted.join(', ');
  const note =
    `🧹 Auto-deleted ${cleanup.deleted.length} local branch(es) fully merged ` +
    `into ${cleanup.mainRef}: ${deletedNames}.\n` +
    `Local labels only — remotes and worktree-checked-out branches were left ` +
    `untouched, and nothing with unmerged work was removed.\n` +
    `(Disable with BRANCH_AUTODELETE_OFF=1.)`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: note,
    },
  }));
  process.exit(0);
}

// Run main() only when invoked directly as a hook — not when the test imports
// this file for the exported cleanMergedBranches(). realpath-compare so
// Windows slash/case differences don't break the guard.
let invokedDirectly = false;
try {
  invokedDirectly =
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) main();
