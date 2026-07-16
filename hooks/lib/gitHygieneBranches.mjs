/**
 * gitHygieneBranches — the branch pass of the git-hygiene hook.
 *
 * Three jobs, all "keep the branch space clean":
 *   1. pruneMergedLocalBranches — delete any LOCAL branch whose work is already in main (Russell's literal ask:
 *      "delete branches whose work is on main"); ephemeral worktree-agent-*, feature/*, fix/* branches also delete
 *      when merged into the current integration branch. An UNMERGED but stale worktree-agent-* loose branch is
 *      archived to refs/reaped/* and reaped (the staleness tier, loose-branch half).
 *   2. pruneMergedRemoteBranches — delete origin branches merged into origin/main, then drop stale tracking refs.
 *   3. countDurableBranches — the >3 DURABLE-branch cap signal (warn only; the orchestrator emits the nudge).
 *
 * Consolidated 2026-07-15 from delete-merged-branches.mjs (local + remote merged deletion) + the loose-branch
 * staleness sweep + the new branch-cap guard. Never deletes the current branch, a worktree branch, a protected
 * name, or anything with commits not proven contained in an integration ref.
 */

import {
  PROTECTED_BRANCHES, AGENT_BRANCH, EPHEMERAL_BRANCH,
  git, gitOk, isMergedIntoAny, archiveBranchTip, resolveGraceMs,
  safeMtimeMs, looseRefActivityMs, looseRefRecentlyActive, comparablePath,
} from './gitHygieneShared.mjs';

// --- glob helpers for the remote allow/deny lists (only `*`, anchored) ---
function globToRegExp(glob) {
  const escaped = String(glob).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
function parseGlobList(rawList) {
  return String(rawList || '').split(',').map((entry) => entry.trim()).filter(Boolean).map(globToRegExp);
}
function matchesAny(name, patterns) {
  return patterns.some((pattern) => pattern.test(name));
}

// Main/master subset of the integration refs — the authoritative "work is on main" target for NON-ephemeral
// branches (an ordinary branch is only deleted when its work reached main, not merely the current feature branch).
function mainRefsOf(integrationRefs) {
  return integrationRefs.filter((ref) => ref === 'main' || ref === 'master');
}

/**
 * Delete local branches whose work is already integrated, plus reap stale loose agent branches.
 * @returns {{ deleted: object[], skipped: object[] }}
 */
export function pruneMergedLocalBranches({ repoRoot, integrationRefs, commonGitDir, dryRun, graceMs, staleMs, nowMs }) {
  const deleted = [];
  const skipped = [];
  const mainRefs = mainRefsOf(integrationRefs);

  let branchLines;
  try { branchLines = git(['branch'], repoRoot).split('\n'); }
  catch { return { deleted, skipped }; }

  for (const branchLine of branchLines) {
    if (!branchLine.trim()) continue;
    const marker = branchLine[0];                 // '*' current, '+' worktree, ' ' plain
    const name = branchLine.slice(1).trim();
    if (!name || name.startsWith('(')) continue;  // detached-HEAD entries
    if (PROTECTED_BRANCHES.has(name)) continue;
    if (marker === '*') { skipped.push({ branch: name, why: 'current' }); continue; }
    if (marker === '+') { skipped.push({ branch: name, why: 'worktree' }); continue; }

    // Ephemeral branches delete when merged into ANY integration ref (incl. the current feature branch — the
    // agent-worktree pattern); ordinary branches only when their work reached main/master.
    const merged = EPHEMERAL_BRANCH.test(name)
      ? isMergedIntoAny(name, integrationRefs, repoRoot)
      : isMergedIntoAny(name, mainRefs, repoRoot);

    if (merged) {
      if (dryRun) { deleted.push({ branch: name, dryRun: true, why: 'merged' }); continue; }
      if (gitOk(['branch', '-D', name], repoRoot)) deleted.push({ branch: name, why: 'merged' });
      else skipped.push({ branch: name, why: 'delete-failed' });
      continue;
    }

    // STALENESS TIER (loose-branch half): only unambiguously-agent worktree-agent-* branches age-reap — NEVER a
    // paused feature/*/fix/* branch. Skip a freshly-touched one (a live agent's label). Archive the tip first.
    if (AGENT_BRANCH.test(name) && staleMs > 0 && !looseRefRecentlyActive(name, commonGitDir, graceMs, nowMs)) {
      const activityMs = looseRefActivityMs(name, commonGitDir);
      if (activityMs > 0 && (nowMs - activityMs) >= staleMs) {
        if (dryRun) { deleted.push({ branch: name, dryRun: true, why: 'stale-unmerged' }); continue; }
        archiveBranchTip(name, repoRoot);
        if (gitOk(['branch', '-D', name], repoRoot)) deleted.push({ branch: name, why: 'stale-unmerged' });
        else skipped.push({ branch: name, why: 'delete-failed' });
        continue;
      }
    }
    skipped.push({ branch: name, why: 'unmerged' });
  }
  return { deleted, skipped };
}

/**
 * Prune origin branches fully merged into origin/main, then drop stale tracking refs. Every rail must pass before
 * a `git push origin --delete` runs; remote deletion is destructive, so "when in doubt, DON'T delete."
 */
export function pruneMergedRemoteBranches({ repoRoot, env = process.env, dryRun = false, runner = { git, gitOk }, graceMs, nowMs = Date.now() }) {
  const { git: gitRun, gitOk: gitCheck } = runner; // injectable so the destructive path is testable against a mock
  const graceWindowMs = graceMs ?? resolveGraceMs(env);

  if (env.GIT_HYGIENE_REMOTE_OFF === '1' || env.BRANCH_PRUNE_REMOTE_OFF === '1') {
    return { deleted: [], skipped: [], reason: 'remote-disabled' };
  }
  const remote = (env.GIT_HYGIENE_REMOTE || env.BRANCH_PRUNE_REMOTE || 'origin').trim() || 'origin';

  let configuredRemotes;
  try { configuredRemotes = gitRun(['remote'], repoRoot).split('\n').map((remoteName) => remoteName.trim()).filter(Boolean); }
  catch { return { deleted: [], skipped: [], reason: 'remote-list-failed' }; }
  if (!configuredRemotes.includes(remote)) return { deleted: [], skipped: [], reason: 'no-remote' };

  const remoteMainRef = gitCheck(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/main`], repoRoot)
    ? `${remote}/main`
    : gitCheck(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/master`], repoRoot)
      ? `${remote}/master` : null;
  if (!remoteMainRef) return { deleted: [], skipped: [], reason: 'no-remote-main' };

  const allowlist = parseGlobList(env.GIT_HYGIENE_ALLOWLIST || env.BRANCH_PRUNE_ALLOWLIST);
  const denylist = parseGlobList(env.GIT_HYGIENE_DENYLIST || env.BRANCH_PRUNE_DENYLIST);
  let commonGitDir = '';
  try { commonGitDir = gitRun(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot).trim(); } catch { /* recency fails safe */ }

  const worktreeBranches = new Set();
  try {
    for (const porcelainLine of gitRun(['worktree', 'list', '--porcelain'], repoRoot).split(/\r?\n/)) {
      if (porcelainLine.startsWith('branch ')) worktreeBranches.add(porcelainLine.slice('branch '.length).trim().replace(/^refs\/heads\//, ''));
    }
  } catch { /* per-branch rails still apply */ }

  let mergedLines;
  try { mergedLines = gitRun(['branch', '-r', '--merged', remoteMainRef], repoRoot).split('\n'); }
  catch { return { deleted: [], skipped: [], reason: 'remote-list-failed' }; }

  const deleted = [];
  const skipped = [];
  for (const rawLine of mergedLines) {
    const entry = rawLine.trim();
    if (!entry || entry.includes('->') || !entry.startsWith(`${remote}/`)) continue;
    const branch = entry.slice(remote.length + 1);
    const trackingRef = `${remote}/${branch}`;
    if (trackingRef === remoteMainRef) continue;
    if (PROTECTED_BRANCHES.has(branch) || branch === 'HEAD') { skipped.push({ branch, why: 'protected' }); continue; }
    if (matchesAny(branch, denylist)) { skipped.push({ branch, why: 'denylist' }); continue; }
    if (allowlist.length && !matchesAny(branch, allowlist)) { skipped.push({ branch, why: 'not-allowlisted' }); continue; }
    if (worktreeBranches.has(branch)) { skipped.push({ branch, why: 'worktree' }); continue; }
    if (graceWindowMs > 0) {
      if (!commonGitDir) { skipped.push({ branch, why: 'recency-unverifiable' }); continue; }
      const refMtime = safeMtimeMs(`${commonGitDir}/refs/remotes/${remote}/${branch}`);
      const reflogMtime = safeMtimeMs(`${commonGitDir}/logs/refs/remotes/${remote}/${branch}`);
      const newestMtime = Math.max(refMtime, reflogMtime);
      if (newestMtime && (nowMs - newestMtime) < graceWindowMs) { skipped.push({ branch, why: 'recently-active' }); continue; }
    }
    if (!gitCheck(['merge-base', '--is-ancestor', trackingRef, remoteMainRef], repoRoot)) { skipped.push({ branch, why: 'unmerged' }); continue; }
    if (dryRun) { deleted.push({ branch, dryRun: true }); continue; }
    if (gitCheck(['push', remote, '--delete', branch], repoRoot)) deleted.push({ branch });
    else skipped.push({ branch, why: 'delete-failed' });
  }
  if (!dryRun) gitCheck(['remote', 'prune', remote], repoRoot);
  return { deleted, skipped, reason: 'ok', remote, remoteMainRef };
}

/**
 * Count DURABLE local branches — those likely to survive the session, per Russell's rule (unlimited in-flight
 * AGENTS, cap only session-surviving branches at 3). Excludes main/master/protected, worktree-agent-* branches,
 * and any branch checked out in a .claude/worktrees/ agent worktree. Returns the list so the caller can warn.
 */
export function countDurableBranches({ repoRoot }) {
  let branchLines;
  try { branchLines = git(['for-each-ref', '--format=%(refname:short)\t%(worktreepath)', 'refs/heads/'], repoRoot).split(/\r?\n/); }
  catch { return { durable: [] }; }
  const durable = [];
  for (const branchLine of branchLines) {
    if (!branchLine.trim()) continue;
    const [name, worktreePath = ''] = branchLine.split('\t');
    if (!name || PROTECTED_BRANCHES.has(name)) continue;
    if (AGENT_BRANCH.test(name)) continue;                                                          // ephemeral agent label
    if (worktreePath && comparablePath(worktreePath).includes('/.claude/worktrees/')) continue;     // in an agent worktree
    durable.push(name);
  }
  return { durable };
}
