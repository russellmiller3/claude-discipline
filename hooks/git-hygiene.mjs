#!/usr/bin/env node
/**
 * git-hygiene — ONE hook for the whole idea of "keep the git worktree/branch space clean."
 *
 * Consolidates three hooks that had drifted apart (Russell, 2026-07-15 — "one hook per idea, and prevent the
 * sprawl at its root"):
 *   - clean-worktrees.mjs         (SessionEnd: reap merged worktrees, sqlite backup, orphan dirs)
 *   - clean-merged-worktrees.mjs  (Stop: reap merged + STALE-unmerged worktrees, sweep loose branches)
 *   - delete-merged-branches.mjs  (PostToolUse: delete local + remote branches merged into main)
 * ...plus two new capabilities Russell asked for: proactive merged-branch deletion (not only after a git command)
 * and a >3 DURABLE-branch cap warning.
 *
 * ONE core, event-routed:
 *   Stop         → reap worktrees (merged + stale) · delete merged local branches · warn if >3 durable branches
 *   SessionStart → same as Stop (catches cross-session leftovers a dead session left behind)
 *   SessionEnd   → same, plus a sqlite/db BACKUP before each worktree removal
 *   PostToolUse  → after a `git merge` / `git push main`: delete merged LOCAL + REMOTE branches immediately
 *
 * Prevention-at-root: an UNMERGED agent tree/branch gone quiet past the dead-tree window is reaped (its tip first
 * archived to refs/reaped/*), so a dead fork is no longer immortal just because it never merged.
 *
 * Fail-open on ANY error. Disable all: GIT_HYGIENE_OFF=1. Dry run: GIT_HYGIENE_DRY_RUN=1 (or --dry-run).
 * Windows: dead-tree window GIT_HYGIENE_STALE_HOURS (default 12), live grace GIT_HYGIENE_GRACE_MIN (default 20),
 * branch cap GIT_HYGIENE_BRANCH_CAP (default 3). Legacy CLEAN_MERGED_WORKTREES_* / BRANCH_PRUNE_* names still read.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  git, gitOk, resolveGraceMs, resolveStaleMs, resolveIntegrationRefs, resolveCommonGitDir,
} from './lib/gitHygieneShared.mjs';
import { reapWorktrees } from './lib/gitHygieneWorktrees.mjs';
import { pruneMergedLocalBranches, pruneMergedRemoteBranches, countDurableBranches, sweepSiblingReposLocalBranches } from './lib/gitHygieneBranches.mjs';

const DEFAULT_BRANCH_CAP = 3;

// PostToolUse fires for EVERY shell call; this decides whether the command was a "work just landed" moment.
function isIntegrationCommand(command) {
  const triggerCommand = String(command || '').replace(/\s+/g, ' ').trim();
  const isMerge = /\bgit\s+merge\b/.test(triggerCommand);
  const isPushMain = /\bgit\s+push\b/.test(triggerCommand) && /\bmain\b/.test(triggerCommand);
  return isMerge || isPushMain;
}

/**
 * The event-routed core. Pure-ish (git + fs); returns a structured outcome the formatter turns into a note.
 * Exported so the test drives it against a temp repo without stdin.
 */
export function runGitHygiene({ commandCwd, eventName, toolName, command, env = process.env, dryRun = false, nowMs = Date.now() }) {
  if (env.GIT_HYGIENE_OFF === '1') return { reason: 'disabled', eventName };

  // PostToolUse gate first — cheap string check before any git call, so 99% of shell calls exit instantly.
  if (eventName === 'PostToolUse') {
    if (!['Bash', 'PowerShell'].includes(toolName)) return { reason: 'not-shell', eventName };
    if (!isIntegrationCommand(command)) return { reason: 'no-trigger', eventName };
  }

  let repoRoot;
  try { repoRoot = git(['rev-parse', '--show-toplevel'], commandCwd).trim(); }
  catch { return { reason: 'not-a-repo', eventName }; }

  // Never clean up mid-merge/rebase — wait for a settled tree.
  if (gitOk(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], repoRoot)) return { reason: 'merge-in-progress', eventName };

  const commonGitDir = resolveCommonGitDir(repoRoot);
  let mainWorktree = repoRoot;
  try {
    const mainCheckout = git(['rev-parse', '--show-toplevel'], (commonGitDir.replace(/\/\.git$/, '') || repoRoot)).trim();
    if (mainCheckout) mainWorktree = mainCheckout;
  } catch { /* fall back to repoRoot */ }

  const integrationRefs = resolveIntegrationRefs(repoRoot, env);
  if (!integrationRefs.length) return { reason: 'no-integration-ref', eventName };

  const graceMs = resolveGraceMs(env);
  const staleMs = resolveStaleMs(env);

  const outcome = {
    reason: 'ok', eventName, integrationRefs, dryRun,
    worktreesRemoved: [], branchesDeleted: [], siblingBranchesDeleted: [], remoteDeleted: [], orphanDirs: [], durable: [], branchCap: DEFAULT_BRANCH_CAP,
  };

  const wantWorktreeReap = ['Stop', 'SessionStart', 'SessionEnd'].includes(eventName);
  const wantBranchPrune = ['Stop', 'SessionStart', 'SessionEnd', 'PostToolUse'].includes(eventName);
  // A session touches sibling repos too (runner, Logger, ...); the merged-branch reaper
  // must sweep them, not just cwd. On at session boundaries; GIT_HYGIENE_SIBLING_SWEEP=0 disables.
  const wantSiblingSweep = env.GIT_HYGIENE_SIBLING_SWEEP !== '0' && ['Stop', 'SessionStart', 'SessionEnd'].includes(eventName);
  const wantRemotePrune = eventName === 'PostToolUse';
  const wantSqliteBackup = eventName === 'SessionEnd';
  const wantCapWarn = ['Stop', 'SessionStart'].includes(eventName);

  if (wantWorktreeReap) {
    const worktreePass = reapWorktrees({ repoRoot, mainWorktree, integrationRefs, dryRun, graceMs, staleMs, nowMs, backupSqlite: wantSqliteBackup });
    outcome.worktreesRemoved = worktreePass.removed;
    outcome.orphanDirs = worktreePass.orphanDirs;
  }
  if (wantBranchPrune) {
    const localPass = pruneMergedLocalBranches({ repoRoot, integrationRefs, commonGitDir, dryRun, graceMs, staleMs, nowMs });
    outcome.branchesDeleted = localPass.deleted;
  }
  if (wantSiblingSweep) {
    try {
      const siblingPass = sweepSiblingReposLocalBranches({ repoRoot, env, dryRun, graceMs, staleMs, nowMs });
      outcome.siblingBranchesDeleted = siblingPass.deleted;
    } catch { /* a sibling failure must never mask the primary result */ }
  }
  if (wantRemotePrune) {
    try {
      const remotePass = pruneMergedRemoteBranches({ repoRoot, env, dryRun, graceMs, nowMs });
      outcome.remoteDeleted = remotePass.deleted || [];
      outcome.remote = remotePass;
    } catch { /* a remote failure must never mask the local result */ }
  }
  if (wantCapWarn) {
    outcome.branchCap = Number(env.GIT_HYGIENE_BRANCH_CAP ?? DEFAULT_BRANCH_CAP);
    outcome.durable = countDurableBranches({ repoRoot }).durable;
  }
  return outcome;
}

// Turn the outcome into a human note (or null when nothing worth surfacing happened).
export function formatNote(outcome) {
  if (!outcome || outcome.reason !== 'ok') return null;
  const lines = [];
  const verb = outcome.dryRun ? 'Would remove' : 'Removed';

  const reapLines = [
    ...outcome.worktreesRemoved.map((entry) => {
      const tag = entry.why === 'stale-unmerged' ? '  [stale-unmerged → tip archived to refs/reaped/*]' : '';
      return `- ${entry.branch}  (worktree ${entry.path})${tag}`;
    }),
    ...outcome.branchesDeleted.map((entry) => {
      const tag = entry.why === 'stale-unmerged' ? '  [stale-unmerged → tip archived to refs/reaped/*]' : '';
      return `- ${entry.branch}  (branch)${tag}`;
    }),
    ...outcome.remoteDeleted.map((entry) => `- ${entry.branch}  (remote branch)`),
  ];
  if (reapLines.length) {
    const staleCount = [...outcome.worktreesRemoved, ...outcome.branchesDeleted].filter((entry) => entry.why === 'stale-unmerged').length;
    lines.push(`git-hygiene: ${verb} ${reapLines.length} spent worktree/branch(es):\n${reapLines.join('\n')}`);
    if (staleCount) {
      lines.push(
        `${staleCount} were UNMERGED but abandoned — their tips are preserved under refs/reaped/* (nothing lost). ` +
        `Recover: git branch <name> <ref>  (list: git for-each-ref refs/reaped/).`,
      );
    }
  }
  if (outcome.orphanDirs?.length) lines.push(`Removed ${outcome.orphanDirs.length} empty orphan worktree folder(s).`);

  if (outcome.siblingBranchesDeleted?.length) {
    const siblingLines = outcome.siblingBranchesDeleted.map((entry) => `- ${entry.repo}: ${entry.branch}  (merged branch in sibling repo)`);
    lines.push(`git-hygiene: ${verb} ${siblingLines.length} merged branch(es) in sibling repo(s):\n${siblingLines.join('\n')}`);
  }

  // Branch-cap WARNING (Russell's choice: warn on Stop, never hard-block).
  if (outcome.durable.length > outcome.branchCap) {
    lines.push(
      `⚠ ${outcome.durable.length} durable local branches (cap ${outcome.branchCap}): ${outcome.durable.join(', ')}. ` +
      `Merge the done ones to main and delete them, or fold WIP together — keep session-surviving branches ≤${outcome.branchCap}. ` +
      `(In-flight agent worktrees don't count.)`,
    );
  }

  if (!lines.length) return null;
  lines.push('(git-hygiene — disable all: GIT_HYGIENE_OFF=1; dry-run: GIT_HYGIENE_DRY_RUN=1.)');
  return lines.join('\n');
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

  const eventName = event.hook_event_name || 'Stop';
  const dryRun = process.env.GIT_HYGIENE_DRY_RUN === '1' || process.argv.includes('--dry-run');

  let outcome;
  try {
    outcome = runGitHygiene({
      commandCwd: event.cwd || process.cwd(),
      eventName,
      toolName: event.tool_name,
      command: event.tool_input && event.tool_input.command,
      dryRun,
    });
  } catch {
    process.exit(0); // fail open — never wedge Claude
  }

  const note = formatNote(outcome);
  if (!note) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: note },
  }));
  process.exit(0);
}

// Run main() only when invoked directly as a hook — importing this file from the test must not block on stdin.
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) main();
