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

const DEFAULT_BRANCH_CAP = 2;
const DEFAULT_ACTIVE_BRANCH_CAP = 2;

// PostToolUse fires for EVERY shell call; this decides whether the command was a "work just landed" moment.
function isIntegrationCommand(command) {
  const triggerCommand = String(command || '').replace(/\s+/g, ' ').trim();
  const isMerge = /\bgit\s+merge\b/.test(triggerCommand);
  const isPushMain = /\bgit\s+push\b/.test(triggerCommand) && /\bmain\b/.test(triggerCommand);
  return isMerge || isPushMain;
}

function createdBranchName(command) {
  const text = String(command || '').replace(/\s+/g, ' ').trim();
  const patterns = [
    /\bgit\s+switch\s+(?:-c|--create)\s+([^\s]+)/,
    /\bgit\s+checkout\s+-b\s+([^\s]+)/,
    /\bgit\s+worktree\s+add\b[\s\S]*?(?:\s-b\s+|\s--branch(?:=|\s))([^\s]+)/,
    /\bgit\s+branch\s+(?!-)([^\s]+)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function activeBranches({ repoRoot, integrationRefs }) {
  return countDurableBranches({ repoRoot, integrationRefs }).durable.filter((branch) => (
    branch.startsWith('feature/') && !integrationRefs.includes(branch)
  ));
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

  if (eventName === 'PreToolUse' && ['Bash', 'PowerShell'].includes(toolName)) {
    const durable = activeBranches({ repoRoot, integrationRefs });
    const branchCap = Number(env.GIT_HYGIENE_ACTIVE_BRANCH_CAP ?? DEFAULT_ACTIVE_BRANCH_CAP);
    const requestedBranch = createdBranchName(command);
    if (requestedBranch?.startsWith('feature/') && durable.length >= branchCap) {
      return { reason: 'branch-sprawl', eventName, blocked: true, durable, branchCap };
    }
    return { reason: 'pretool-allowed', eventName, durable, branchCap };
  }

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
    outcome.durable = countDurableBranches({ repoRoot, integrationRefs }).durable;
  }
  // What SURVIVED the reap, and how far it has drifted. The cap warning below
  // only fires when there are too MANY branches, so a single branch parked for
  // weeks stayed completely silent: CodeServo had 50 commits of
  // feature/goap-planner sitting 581 behind main and nothing ever said so.
  // Russell, 2026-08-17: "so how does next session learn about branches and
  // whats on them? strucucrually". Read live at session start, never stored —
  // a cached "behind main" count is wrong again the next time main moves.
  if (eventName === 'SessionStart' && outcome.durable.length) {
    const trunk = integrationRefs[0];
    // BOUNDED, found by red-teaming this change: each branch costs three git
    // subprocesses (two rev-list, one log), and a repository that has drifted to
    // fifty branches would spawn a hundred and fifty of them at every session
    // start — on Windows that is seconds, against this hook's 30s ceiling, on
    // the exact path that must never delay a session. The cap is well above the
    // two-branch policy, so it only bites a repo already in trouble; the overflow
    // is reported by count rather than silently dropped.
    const DETAILED_BRANCH_LIMIT = 12;
    outcome.durableOverflow = Math.max(0, outcome.durable.length - DETAILED_BRANCH_LIMIT);
    outcome.durableDetail = outcome.durable.slice(0, DETAILED_BRANCH_LIMIT).map((branch) => {
      const count = (range) => {
        try { return git(['rev-list', '--count', range], repoRoot).trim(); }
        catch { return '?'; }
      };
      let lastCommit = '';
      try {
        lastCommit = git(['log', '-1', '--date=short', '--format=%ad %s', branch], repoRoot).trim().slice(0, 88);
      } catch { /* a branch we cannot read still deserves its name reported */ }
      return {
        branch,
        ahead: count(`${trunk}..${branch}`),
        behind: count(`${branch}..${trunk}`),
        lastCommit,
      };
    });
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

  // What is parked outside the trunk, said out loud at session start even when
  // it is only ONE branch. The cap warning below fires on too MANY branches; a
  // single branch abandoned for weeks slipped under it and stayed invisible.
  if (outcome.eventName === 'SessionStart' && outcome.durableDetail?.length) {
    const parked = outcome.durableDetail.map((entry) => {
      const behind = Number(entry.behind);
      const verdict = Number.isFinite(behind) && behind >= 100
        ? '   <- far behind: rebase and land it, or archive and delete it'
        : '';
      return `- ${entry.branch}  (+${entry.ahead}/-${entry.behind})  ${entry.lastCommit}${verdict}`;
    });
    const overflow = outcome.durableOverflow
      ? `\n- ...and ${outcome.durableOverflow} more branch(es), not detailed`
      : '';
    lines.push(
      `Work parked outside ${outcome.integrationRefs[0]}:\n${parked.join('\n')}${overflow}\n` +
      'A branch far behind is a decision waiting, not a branch. Landing it or deleting it are both fine; leaving it is what costs.',
    );
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

  if (outcome.blocked) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: 'deny',
        permissionDecisionReason: `Branch sprawl guard: ${outcome.durable.join(', ')} already fills the two active branch slots. Merge or remove one before creating another branch.`,
      },
    }));
    process.exit(0);
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
