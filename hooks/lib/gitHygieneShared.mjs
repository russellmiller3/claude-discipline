/**
 * gitHygieneShared — the primitives shared by the git-hygiene hook's worktree and branch passes.
 *
 * Part of the 2026-07-15 consolidation (Russell): clean-worktrees.mjs, clean-merged-worktrees.mjs and
 * delete-merged-branches.mjs were THREE hooks doing ONE idea — "keep the git worktree/branch space clean."
 * Their overlapping git runners, path/mtime/lock helpers, worktree parser, integration-ref resolver, and the
 * archive-before-delete safety were duplicated three ways and drifted. This module is the single home for all of
 * them; git-hygiene.mjs orchestrates, the sibling libs own the worktree and branch passes.
 *
 * Every function here is pure-ish (git subprocess + filesystem stat only) and fail-safe: on any doubt it returns
 * the value that PREVENTS deletion, never the one that permits it. A housekeeping hook must never destroy work.
 */

import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { normalize } from 'node:path';

export const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'release', 'HEAD']);
export const AGENT_BRANCH = /^worktree-agent-/;
// EPHEMERAL working branches meant to be deleted once merged — the background-agent worktree branches AND the
// main agent's own feature/*/fix/* branches (Russell's convention: merge to main, delete the branch).
export const EPHEMERAL_BRANCH = /^(worktree-agent-|feature\/|fix\/)/;
const GIT_TIMEOUT_MS = Number(process.env.GIT_HYGIENE_TIMEOUT_MS || 30000);

// --- git runners: git() returns stdout (throws on non-zero); gitOk() returns a boolean. execFileSync with an
// argv array (never a shell string) avoids cmd.exe % mangling on Windows and never word-splits a branch name.
export function git(args, workingDir) {
  return execFileSync('git', args, {
    cwd: workingDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  });
}

export function gitOk(args, workingDir) {
  try {
    execFileSync('git', args, { cwd: workingDir, stdio: 'ignore', timeout: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

// --- path helpers (Windows-safe: normalize slashes, lowercase on win32) ---
export function comparablePath(rawPath) {
  const normalized = normalize(String(rawPath || '')).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(leftPath, rightPath) {
  return comparablePath(leftPath) === comparablePath(rightPath);
}

export function isClaudeWorktree(worktreePath) {
  return comparablePath(worktreePath).includes('/.claude/worktrees/');
}

// --- process / lock liveness: never remove a worktree whose recorded agent pid is still alive ---
export function processIsAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (signalError) {
    return Boolean(signalError && signalError.code === 'EPERM');
  }
}

export function lockLooksLive(lockedReason) {
  if (lockedReason === null || lockedReason === undefined) return false; // not locked
  const pidMatch = String(lockedReason).match(/\(pid\s+(\d+)\)/i);
  if (!pidMatch) return true; // locked with no pid we can verify => assume live
  return processIsAlive(Number(pidMatch[1]));
}

// --- time windows: LIVE grace (too fresh to touch) vs STALE window (dead long enough to reap) ---
export function resolveGraceMs(env) {
  const minutes = Number(env.GIT_HYGIENE_GRACE_MIN ?? env.CLEAN_MERGED_WORKTREES_GRACE_MIN ?? 20);
  return Math.max(0, Number.isFinite(minutes) ? minutes : 20) * 60 * 1000;
}

export function resolveStaleMs(env) {
  const hours = Number(env.GIT_HYGIENE_STALE_HOURS ?? env.CLEAN_MERGED_WORKTREES_STALE_HOURS ?? 12);
  return Math.max(0, Number.isFinite(hours) ? hours : 12) * 60 * 60 * 1000;
}

// --- mtime helpers ---
export function safeMtimeMs(targetPath) {
  try { return statSync(targetPath).mtimeMs; } catch { return 0; }
}

export function newestMtimeMs(candidatePaths) {
  let newest = 0;
  for (const candidatePath of candidatePaths) {
    const mtime = safeMtimeMs(candidatePath);
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

// Newest activity mtime for a worktree: working dir + private HEAD + reflog. Deliberately EXCLUDES the index —
// a read-only `git status` refreshes the index stat-cache mtime, which would make a stale tree look fresh.
// 0 when nothing readable. Shared by the recency guard (< grace = LIVE) and the staleness tier (>= stale = DEAD).
export function worktreeActivityMs(worktreePath) {
  try {
    let worktreeGitDir = '';
    try { worktreeGitDir = git(['rev-parse', '--absolute-git-dir'], worktreePath).trim(); } catch { /* gone */ }
    const candidatePaths = [worktreePath];
    if (worktreeGitDir) candidatePaths.push(`${worktreeGitDir}/HEAD`, `${worktreeGitDir}/logs/HEAD`);
    return newestMtimeMs(candidatePaths);
  } catch {
    return 0;
  }
}

// A worktree touched within the grace window is LIVE (just-created or mid-commit). Fail-safe: unreadable => true.
export function worktreeRecentlyActive(worktreePath, graceMs, nowMs) {
  if (graceMs <= 0) return false;
  try {
    const newest = worktreeActivityMs(worktreePath);
    if (!newest) return true;
    return (nowMs - newest) < graceMs;
  } catch {
    return true;
  }
}

// Newest activity mtime for a LOOSE branch (no worktree): its ref file AND per-branch reflog. Reading the reflog
// too survives ref-packing (a packed ref loses its own file mtime). 0 => "can't date it" => callers treat as
// NOT recent AND NOT stale (fail safe: never age-reap a branch we cannot prove is dead).
export function looseRefActivityMs(branch, commonGitDir) {
  if (!commonGitDir) return 0;
  return Math.max(
    safeMtimeMs(`${commonGitDir}/refs/heads/${branch}`),
    safeMtimeMs(`${commonGitDir}/logs/refs/heads/${branch}`),
  );
}

export function looseRefRecentlyActive(branch, commonGitDir, graceMs, nowMs) {
  if (graceMs <= 0) return false;
  const mtime = looseRefActivityMs(branch, commonGitDir);
  if (!mtime) return false;
  return (nowMs - mtime) < graceMs;
}

// Archive a branch tip under refs/reaped/* BEFORE deleting an UNMERGED branch, so its commits stay reachable
// (recoverable until Russell prunes) instead of only surviving in the reflog. Merged branches never call this —
// their commits already live in the integration branch. Returns the ref (or null); best-effort.
export function archiveBranchTip(branch, repoRoot) {
  try {
    const tip = git(['rev-parse', branch], repoRoot).trim();
    if (!tip) return null;
    const safeName = String(branch).replace(/[^A-Za-z0-9._-]/g, '_');
    const archiveRef = `refs/reaped/${safeName}-${tip.slice(0, 8)}`;
    gitOk(['update-ref', archiveRef, tip], repoRoot);
    return archiveRef;
  } catch {
    return null;
  }
}

// --- worktree porcelain parser ---
export function parseWorktreeList(porcelainOutput) {
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

// Resolve the refs we treat as "merged into" targets: the current HEAD branch (the live integration branch the
// agents merge into), main/master if present, plus any explicit refs from the env override.
export function resolveIntegrationRefs(repoRoot, env) {
  const integrationRefs = new Set();
  try {
    const headBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim();
    if (headBranch && headBranch !== 'HEAD' && !AGENT_BRANCH.test(headBranch)) integrationRefs.add(headBranch);
  } catch { /* detached or no HEAD */ }
  for (const candidateRef of ['main', 'master']) {
    if (gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${candidateRef}`], repoRoot)) {
      integrationRefs.add(candidateRef);
    }
  }
  const explicitRefs = String(env.GIT_HYGIENE_INTEGRATION_REFS || env.CLEAN_MERGED_WORKTREES_INTEGRATION_REFS || '')
    .split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const explicitRef of explicitRefs) {
    if (gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${explicitRef}`], repoRoot)) {
      integrationRefs.add(explicitRef);
    }
  }
  return [...integrationRefs];
}

export function isMergedIntoAny(branch, integrationRefs, repoRoot) {
  return integrationRefs.some(
    (integrationRef) => integrationRef !== branch
      && gitOk(['merge-base', '--is-ancestor', branch, integrationRef], repoRoot),
  );
}

// Common git dir (shared refs/reflogs across linked worktrees), absolute. '' on failure.
export function resolveCommonGitDir(repoRoot) {
  try {
    return git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot).trim();
  } catch {
    return '';
  }
}
