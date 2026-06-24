#!/usr/bin/env node
/**
 * clean-merged-worktrees — Stop hook with TEETH: auto-removes a spent
 * background-agent worktree the moment its branch is provably merged.
 *
 * ROOT CAUSE this fixes: hooks that only test merge into `main`/`master` miss the
 *   common case — background agents merge their work into an INTEGRATION branch
 *   (e.g. `feature/big-epic`), never directly into main. So a main-only cleanup
 *   classifies every agent worktree as "unmerged" and skips it forever. The copies
 *   accumulate until a recursive test runner scans dozens of worktree copies and
 *   the suite explodes into thousands of duplicated lines.
 *
 * THE FIX: this hook proves "merged" against a set of integration refs — the
 * current HEAD branch (the live integration branch the agents merge into), plus
 * main/master — and (1) auto-removes any merged worktree under `.claude/worktrees/`,
 * AND (2) sweeps any merged loose branch with no worktree. It deletes EITHER the
 * moment it's merged, whether a subagent's `worktree-agent-*` branch or the main
 * agent's own `feature/*`/`fix/*` branch (merge → delete). Teeth: it actually runs
 * `git worktree remove --force` and `git branch -D`; it does not advise.
 *
 * SAFETY RAILS (belt + suspenders — never deletes live work):
 *   - worktree removal: only worktrees under `.claude/worktrees/`
 *   - only EPHEMERAL branches: `worktree-agent-*`, `feature/*`, `fix/*`
 *   - never the current checkout / the main checkout / a checked-out branch
 *   - never a locked worktree whose recorded agent pid is still alive
 *   - never a dirty worktree (uncommitted work would be lost)
 *   - never a branch NOT provably merged into an integration ref
 *   - never main/master/develop/release or the integration branch itself
 *
 * Disable for a session:  CLEAN_MERGED_WORKTREES_OFF=1
 * Dry run (report only):   CLEAN_MERGED_WORKTREES_DRY_RUN=1  (or --dry-run)
 * Extra integration refs:  CLEAN_MERGED_WORKTREES_INTEGRATION_REFS="feature/x,feature/y"
 *
 * Fail-open on any error — a housekeeping hook must never wedge the session.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalize } from 'node:path';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'release', 'HEAD']);
const AGENT_BRANCH = /^worktree-agent-/;
// EPHEMERAL working branches that are MEANT to be deleted once merged — both the background-agent worktree
// branches AND the main agent's own `feature/*` / `fix/*` branches (the "merge to main locally, delete branch,
// done" convention). The sweep below removes any of these the moment they're provably merged. Protected
// branches (main/master/develop/release), the current branch, and the integration ref are always excluded.
const EPHEMERAL_BRANCH = /^(worktree-agent-|feature\/|fix\/)/;
const REMOVE_TIMEOUT_MS = Number(process.env.CLEAN_MERGED_WORKTREE_TIMEOUT_MS || 20000);

function git(gitArgs, workingDir) {
  return execFileSync('git', gitArgs, {
    cwd: workingDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: REMOVE_TIMEOUT_MS,
  });
}

function gitOk(gitArgs, workingDir) {
  try {
    execFileSync('git', gitArgs, { cwd: workingDir, stdio: 'ignore', timeout: REMOVE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function comparablePath(rawPath) {
  const normalized = normalize(String(rawPath || '')).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(leftPath, rightPath) {
  return comparablePath(leftPath) === comparablePath(rightPath);
}

function isClaudeWorktree(worktreePath) {
  return comparablePath(worktreePath).includes('/.claude/worktrees/');
}

function processIsAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (signalError) {
    return Boolean(signalError && signalError.code === 'EPERM');
  }
}

function lockLooksLive(lockedReason) {
  if (lockedReason === null || lockedReason === undefined) return false; // not locked
  const pidMatch = String(lockedReason).match(/\(pid\s+(\d+)\)/i);
  if (!pidMatch) return true; // locked with no pid we can verify => assume live
  return processIsAlive(Number(pidMatch[1]));
}

function parseWorktreeList(porcelainOutput) {
  const worktrees = [];
  let currentWorktree = null;
  for (const rawLine of String(porcelainOutput).split(/\r?\n/)) {
    if (!rawLine.trim()) {
      if (currentWorktree) { worktrees.push(currentWorktree); currentWorktree = null; }
      continue;
    }
    if (rawLine.startsWith('worktree ')) {
      if (currentWorktree) worktrees.push(currentWorktree);
      currentWorktree = { path: rawLine.slice('worktree '.length).trim(), branch: null, locked: null };
      continue;
    }
    if (!currentWorktree) continue;
    if (rawLine.startsWith('branch ')) {
      currentWorktree.branch = rawLine.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (rawLine === 'locked' || rawLine.startsWith('locked ')) {
      currentWorktree.locked = rawLine.slice('locked'.length).trim();
    }
  }
  if (currentWorktree) worktrees.push(currentWorktree);
  return worktrees;
}

// Resolve the integration refs we treat as "merged into" targets: the current
// HEAD branch (the live integration branch the agents merge into), plus
// main/master if present, plus any explicit refs from the env override.
function resolveIntegrationRefs(repoRoot, env) {
  const integrationRefs = new Set();
  try {
    const headBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim();
    if (headBranch && headBranch !== 'HEAD' && !AGENT_BRANCH.test(headBranch)) {
      integrationRefs.add(headBranch);
    }
  } catch { /* detached or no HEAD — fall through */ }
  for (const candidateRef of ['main', 'master']) {
    if (gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${candidateRef}`], repoRoot)) {
      integrationRefs.add(candidateRef);
    }
  }
  const explicitRefs = String(env.CLEAN_MERGED_WORKTREES_INTEGRATION_REFS || '')
    .split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const explicitRef of explicitRefs) {
    if (gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${explicitRef}`], repoRoot)) {
      integrationRefs.add(explicitRef);
    }
  }
  return [...integrationRefs];
}

function isMergedIntoAny(branch, integrationRefs, repoRoot) {
  return integrationRefs.some(
    (integrationRef) =>
      integrationRef !== branch &&
      gitOk(['merge-base', '--is-ancestor', branch, integrationRef], repoRoot),
  );
}

function isDirty(worktreePath) {
  try {
    return git(['status', '--porcelain'], worktreePath)
      .split(/\r?\n/)
      .filter((statusLine) => statusLine.trim())
      // sqlite WAL/SHM churn is runtime noise, not real uncommitted work
      .filter((statusLine) => !/\.sqlite-(wal|shm)$/.test(statusLine))
      .length > 0;
  } catch {
    return true; // can't tell => treat as dirty, don't delete
  }
}

// Sweep loose merged branches that have NO worktree of their own — the main agent's `feature/*`/`fix/*` branches
// it merged and left behind (the worktree loop only sees branches that own a worktree). Same teeth, same rails:
// only EPHEMERAL branches, never the current branch / a protected branch / an integration ref / an unmerged branch
// / one still checked out in a worktree (those are the worktree loop's job).
function sweepLooseMergedBranches({ repoRoot, integrationRefs, currentBranch, worktreeBranches, dryRun }) {
  const removed = [];
  const skipped = [];
  let branchListing;
  try {
    branchListing = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repoRoot);
  } catch {
    return { removed, skipped };
  }
  for (const branch of branchListing.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    if (!EPHEMERAL_BRANCH.test(branch)) continue; // only the disposable working branches
    if (branch === currentBranch || PROTECTED_BRANCHES.has(branch) || integrationRefs.includes(branch)) continue;
    if (worktreeBranches.has(branch)) continue; // owns a worktree → handled (or guarded) by the worktree loop
    if (!isMergedIntoAny(branch, integrationRefs, repoRoot)) {
      skipped.push({ branch, why: 'unmerged' });
      continue;
    }
    if (dryRun) { removed.push({ branch, dryRun: true }); continue; }
    // -d would refuse a branch git thinks is unmerged-vs-upstream; we already proved it merged into an
    // integration ref, so -D is the correct, safe drop of the now-redundant label.
    if (gitOk(['branch', '-D', branch], repoRoot)) removed.push({ branch });
    else skipped.push({ branch, why: 'delete-failed' });
  }
  return { removed, skipped };
}

/**
 * Pure core: remove every provably-merged background-agent worktree (and its
 * branch), AND sweep loose merged feature/fix branches with no worktree.
 * Exported so the test can drive it against a temp repo without stdin.
 *
 * @returns {{ removed: object[], skipped: object[],
 *             integrationRefs: string[], reason: string }}
 */
export function cleanMergedWorktrees({ commandCwd, env = process.env, dryRun = false }) {
  if (env.CLEAN_MERGED_WORKTREES_OFF === '1') {
    return { removed: [], skipped: [], integrationRefs: [], reason: 'disabled' };
  }

  let repoRoot;
  try {
    repoRoot = git(['rev-parse', '--show-toplevel'], commandCwd).trim();
  } catch {
    return { removed: [], skipped: [], integrationRefs: [], reason: 'not-a-repo' };
  }

  // The main worktree (whichever holds the common git dir) must never be removed,
  // even though repo-wide ops can run from any linked worktree.
  let mainWorktree = repoRoot;
  try {
    const commonGitDir = git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot,
    ).trim();
    const mainCheckout = git(
      ['rev-parse', '--show-toplevel'], commonGitDir.replace(/\/\.git$/, '') || repoRoot,
    ).trim();
    if (mainCheckout) mainWorktree = mainCheckout;
  } catch { /* fall back to repoRoot */ }

  const integrationRefs = resolveIntegrationRefs(repoRoot, env);
  if (!integrationRefs.length) {
    return { removed: [], skipped: [], integrationRefs: [], reason: 'no-integration-ref' };
  }

  let porcelainOutput;
  try {
    porcelainOutput = git(['worktree', 'list', '--porcelain'], repoRoot);
  } catch {
    return { removed: [], skipped: [], integrationRefs, reason: 'list-failed' };
  }

  const removed = [];
  const skipped = [];
  const worktreeBranches = new Set();

  for (const worktree of parseWorktreeList(porcelainOutput)) {
    if (worktree.branch) worktreeBranches.add(worktree.branch); // so the loose-branch sweep skips these
    if (samePath(worktree.path, repoRoot) || samePath(worktree.path, mainWorktree)) {
      skipped.push({ path: worktree.path, why: 'current-or-main' });
      continue;
    }
    if (!isClaudeWorktree(worktree.path)) {
      skipped.push({ path: worktree.path, why: 'not-claude-worktree' });
      continue;
    }
    if (!worktree.branch || !EPHEMERAL_BRANCH.test(worktree.branch)) {
      skipped.push({ path: worktree.path, why: 'not-ephemeral-branch' });
      continue;
    }
    if (PROTECTED_BRANCHES.has(worktree.branch) || integrationRefs.includes(worktree.branch)) {
      skipped.push({ path: worktree.path, why: 'protected-branch' });
      continue;
    }
    if (lockLooksLive(worktree.locked)) {
      skipped.push({ path: worktree.path, why: 'locked-live' });
      continue;
    }
    let worktreeDirExists = false;
    try {
      worktreeDirExists = existsSync(worktree.path) && statSync(worktree.path).isDirectory();
    } catch {
      worktreeDirExists = false;
    }
    if (worktreeDirExists && isDirty(worktree.path)) {
      skipped.push({ path: worktree.path, why: 'dirty' });
      continue;
    }
    if (!isMergedIntoAny(worktree.branch, integrationRefs, repoRoot)) {
      skipped.push({ path: worktree.path, why: 'unmerged' });
      continue;
    }

    if (dryRun) {
      removed.push({ path: worktree.path, branch: worktree.branch, dryRun: true });
      continue;
    }

    // TEETH 1: physically remove the worktree (double --force handles untracked
    // dist/build artifacts and a worktree on a non-current branch).
    const worktreeGone = gitOk(
      ['worktree', 'remove', '--force', '--force', worktree.path],
      repoRoot,
    );
    // TEETH 2: delete the now-redundant branch label. Even if the dir removal
    // hit a file lock, the branch is provably merged, so dropping the label is
    // safe and stops the branch from masking re-creation.
    const branchGone = gitOk(['branch', '-D', worktree.branch], repoRoot);

    if (worktreeGone || branchGone) {
      // prune any stale registration left behind by a locked dir
      gitOk(['worktree', 'prune'], repoRoot);
      removed.push({ path: worktree.path, branch: worktree.branch, worktreeGone, branchGone });
    } else {
      skipped.push({ path: worktree.path, why: 'remove-failed' });
    }
  }

  // Then sweep loose merged branches that never had a worktree (the main agent's own feature/fix branches).
  let currentBranch = '';
  try { currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim(); } catch { /* detached */ }
  const branchSweep = sweepLooseMergedBranches({ repoRoot, integrationRefs, currentBranch, worktreeBranches, dryRun });
  removed.push(...branchSweep.removed);
  skipped.push(...branchSweep.skipped);

  return { removed, skipped, integrationRefs, reason: 'ok' };
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

  const commandCwd = event.cwd || process.cwd();
  const dryRun =
    process.env.CLEAN_MERGED_WORKTREES_DRY_RUN === '1' || process.argv.includes('--dry-run');

  let outcome;
  try {
    outcome = cleanMergedWorktrees({ commandCwd, dryRun });
  } catch {
    process.exit(0); // fail open — never wedge the session
  }

  if (!outcome.removed.length) process.exit(0);

  const removedLines = outcome.removed
    .map((entry) => (entry.path ? `- ${entry.branch}  (worktree ${entry.path})` : `- ${entry.branch}  (branch)`))
    .join('\n');
  const verb = dryRun ? 'Would auto-remove' : 'Auto-removed';
  const note =
    `${verb} ${outcome.removed.length} merged branch/worktree(s) ` +
    `(merged into: ${outcome.integrationRefs.join(', ')}):\n${removedLines}\n` +
    `These were spent copies/labels whose work is already in the integration branch; ` +
    `leaving worktrees around makes a recursive test runner scan duplicate trees. ` +
    `(Disable with CLEAN_MERGED_WORKTREES_OFF=1.)`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: note,
    },
  }));
  process.exit(0);
}

// Run main() only when invoked directly as a hook — importing this file from the
// test must NOT block on stdin or perform side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
