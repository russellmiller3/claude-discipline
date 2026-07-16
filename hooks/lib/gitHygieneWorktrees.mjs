/**
 * gitHygieneWorktrees — the worktree pass of the git-hygiene hook.
 *
 * Reaps spent background-agent worktrees under .claude/worktrees/: MERGED trees (their work is in an integration
 * ref) go immediately; UNMERGED trees gone quiet past the stale window (provably abandoned) go too, but their tip
 * is archived to refs/reaped/* first so nothing is lost. Also carries the two SessionEnd-only extras that used to
 * live in clean-worktrees.mjs: a best-effort sqlite/db BACKUP before removal, and removal of empty orphan folders
 * left under .claude/worktrees/. Branch-label deletion for LOOSE branches (no worktree) lives in the branch pass.
 *
 * Consolidated 2026-07-15 from clean-merged-worktrees.mjs (reap + staleness) + clean-worktrees.mjs (sqlite backup
 * + orphan dirs). Every guard is fail-safe: on any doubt, the tree SURVIVES.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PROTECTED_BRANCHES, EPHEMERAL_BRANCH,
  git, gitOk, samePath, isClaudeWorktree, lockLooksLive,
  worktreeActivityMs, worktreeRecentlyActive, archiveBranchTip,
  parseWorktreeList, isMergedIntoAny, comparablePath,
} from './gitHygieneShared.mjs';

const REMOVE_TIMEOUT_MS = Number(process.env.GIT_HYGIENE_REMOVE_TIMEOUT_MS || 20000);

// A tree is dirty if `git status --porcelain` reports anything but sqlite WAL/SHM churn (runtime noise).
// Can't tell => treat as dirty (never delete uncommitted work).
export function isDirty(worktreePath) {
  try {
    return git(['status', '--porcelain'], worktreePath)
      .split(/\r?\n/)
      .filter((statusLine) => statusLine.trim())
      .filter((statusLine) => !/\.sqlite-(wal|shm)$/.test(statusLine))
      .length > 0;
  } catch {
    return true;
  }
}

function collectFiles(startPath, shouldKeepFile) {
  const matchingFiles = [];
  function visitDirectory(directoryPath) {
    let directoryEntries = [];
    try { directoryEntries = readdirSync(directoryPath, { withFileTypes: true }); } catch { return; }
    for (const directoryEntry of directoryEntries) {
      if (directoryEntry.name === 'node_modules' || directoryEntry.name === '.git') continue;
      const entryPath = join(directoryPath, directoryEntry.name);
      if (directoryEntry.isDirectory()) visitDirectory(entryPath);
      else if (directoryEntry.isFile() && shouldKeepFile(entryPath)) matchingFiles.push(entryPath);
    }
  }
  visitDirectory(startPath);
  return matchingFiles;
}

// Best-effort WAL checkpoint so a backed-up .sqlite is self-contained. sqlite3 may be absent — the dirty check
// still catches any WAL/SHM that stays visible to git.
function checkpointSqliteFiles(worktreePath) {
  for (const sqlitePath of collectFiles(worktreePath, (filePath) => filePath.endsWith('.sqlite'))) {
    try { execFileSync('sqlite3', [sqlitePath, 'PRAGMA wal_checkpoint(TRUNCATE);'], { stdio: 'ignore' }); } catch { /* absent */ }
  }
}

// Copy every .sqlite/.db under the worktree into a timestamped tmp backup before we remove the tree. Belt and
// suspenders: a failed copy must never wedge the hook. nowMs makes the folder name deterministic for tests.
function backupValuableFiles(worktreePath, nowMs) {
  const stamp = new Date(nowMs).toISOString().replace(/[^\d]/g, '').slice(0, 14);
  const backupPath = join(tmpdir(), 'worktree-backups', `${basename(worktreePath)}-${stamp}`);
  const valuableFiles = collectFiles(worktreePath, (filePath) => {
    if (filePath.endsWith('-wal') || filePath.endsWith('-shm')) return false;
    return filePath.endsWith('.sqlite') || filePath.endsWith('.db');
  });
  if (!valuableFiles.length) return null;
  mkdirSync(backupPath, { recursive: true });
  for (const sourcePath of valuableFiles) {
    const destinationPath = join(backupPath, relative(worktreePath, sourcePath));
    mkdirSync(dirname(destinationPath), { recursive: true });
    try { copyFileSync(sourcePath, destinationPath); } catch { /* best-effort */ }
  }
  return backupPath;
}

// Remove empty leftover folders directly under .claude/worktrees/ that no live worktree registration owns.
export function removeEmptyOrphanClaudeDirs({ repoRoot, knownWorktreePaths, dryRun }) {
  const claudeWorktreeRoot = join(repoRoot, '.claude', 'worktrees');
  if (!existsSync(claudeWorktreeRoot)) return [];
  const knownPaths = new Set(knownWorktreePaths.map(comparablePath));
  let childEntries = [];
  try { childEntries = readdirSync(claudeWorktreeRoot, { withFileTypes: true }); } catch { return []; }
  const removedOrphans = [];
  for (const childEntry of childEntries) {
    if (!childEntry.isDirectory()) continue;
    const orphanPath = join(claudeWorktreeRoot, childEntry.name);
    if (knownPaths.has(comparablePath(orphanPath))) continue;
    if (collectFiles(orphanPath, () => true).length) continue; // only truly empty leftovers
    if (!dryRun) { try { rmSync(orphanPath, { recursive: true, force: true }); } catch { continue; } }
    removedOrphans.push(orphanPath);
  }
  return removedOrphans;
}

/**
 * Reap spent worktrees under .claude/worktrees/. Returns { removed, skipped, orphanDirs }.
 * `backupSqlite` (SessionEnd) copies .sqlite/.db out first. `staleMs<=0` disables the age tier.
 */
export function reapWorktrees({ repoRoot, mainWorktree, integrationRefs, dryRun, graceMs, staleMs, nowMs, backupSqlite = false }) {
  const removed = [];
  const skipped = [];
  const worktreeBranches = new Set();

  let porcelainOutput;
  try { porcelainOutput = git(['worktree', 'list', '--porcelain'], repoRoot); }
  catch { return { removed, skipped, worktreeBranches, orphanDirs: [] }; }

  const worktrees = parseWorktreeList(porcelainOutput);
  const orphanDirs = removeEmptyOrphanClaudeDirs({ repoRoot, knownWorktreePaths: worktrees.map((w) => w.path), dryRun });

  for (const worktree of worktrees) {
    if (worktree.branch) worktreeBranches.add(worktree.branch);
    if (samePath(worktree.path, repoRoot) || samePath(worktree.path, mainWorktree)) { skipped.push({ path: worktree.path, why: 'current-or-main' }); continue; }
    if (!isClaudeWorktree(worktree.path)) { skipped.push({ path: worktree.path, why: 'not-claude-worktree' }); continue; }
    if (!worktree.branch || !EPHEMERAL_BRANCH.test(worktree.branch)) { skipped.push({ path: worktree.path, why: 'not-ephemeral-branch' }); continue; }
    if (PROTECTED_BRANCHES.has(worktree.branch) || integrationRefs.includes(worktree.branch)) { skipped.push({ path: worktree.path, why: 'protected-branch' }); continue; }
    if (lockLooksLive(worktree.locked)) { skipped.push({ path: worktree.path, why: 'locked-live' }); continue; }

    let worktreeDirExists = false;
    try { worktreeDirExists = existsSync(worktree.path) && statSync(worktree.path).isDirectory(); } catch { worktreeDirExists = false; }
    if (worktreeDirExists && isDirty(worktree.path)) { skipped.push({ path: worktree.path, why: 'dirty' }); continue; }
    if (worktreeDirExists && worktreeRecentlyActive(worktree.path, graceMs, nowMs)) { skipped.push({ path: worktree.path, why: 'recently-active' }); continue; }

    let removalReason = 'merged';
    if (!isMergedIntoAny(worktree.branch, integrationRefs, repoRoot)) {
      // STALENESS TIER: an unmerged agent tree quiet past the dead-tree window is provably abandoned. Reap it,
      // but archive the tip first — its commits are in no integration ref.
      const activityMs = worktreeDirExists ? worktreeActivityMs(worktree.path) : 0;
      const worktreeStale = staleMs > 0 && activityMs > 0 && (nowMs - activityMs) >= staleMs;
      if (!worktreeStale) { skipped.push({ path: worktree.path, why: 'unmerged' }); continue; }
      removalReason = 'stale-unmerged';
      if (!dryRun) archiveBranchTip(worktree.branch, repoRoot);
    }

    if (dryRun) { removed.push({ path: worktree.path, branch: worktree.branch, dryRun: true, why: removalReason }); continue; }

    if (backupSqlite && worktreeDirExists) { checkpointSqliteFiles(worktree.path); backupValuableFiles(worktree.path, nowMs); }

    const worktreeGone = gitOk(['worktree', 'remove', '--force', '--force', worktree.path], repoRoot);
    const branchGone = gitOk(['branch', '-D', worktree.branch], repoRoot);
    if (worktreeGone || branchGone) {
      gitOk(['worktree', 'prune'], repoRoot);
      removed.push({ path: worktree.path, branch: worktree.branch, worktreeGone, branchGone, why: removalReason });
    } else {
      skipped.push({ path: worktree.path, why: 'remove-failed' });
    }
  }

  return { removed, skipped, worktreeBranches, orphanDirs };
}
