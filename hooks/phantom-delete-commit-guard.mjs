#!/usr/bin/env node
/**
 * PreToolUse hook — block `git commit` from a PRIMARY checkout whose working tree has gone STALE
 * under a moved ref, before the commit silently REVERTS a sibling agent's landed work.
 *
 * THE INCIDENT (bit 4x on 2026-07-03): a sibling agent's compare-and-swap landing moves
 * refs/heads/main while the primary checkout has that branch checked out. The primary's working
 * tree still holds the OLD content, so `git status` suddenly shows the just-landed files as
 * DELETIONS (they don't exist in the stale tree) or MODIFICATIONS (the stale disk copy is the
 * older content). The next `git commit -am` from the primary happily commits those phantom
 * deletions/modifications — silently reverting the landing. The 4th bite rolled back a 141-line
 * Truth-ledger rewrite as a stale "modification".
 *
 * THE TELL: the deleted/modified paths were never created or edited by THIS session (checked
 * against the session transcript's Write/Edit/MultiEdit/shell-redirect history, same technique as
 * delete-audit-guard.mjs). A session cannot legitimately commit the removal or rewrite of content
 * it never touched from a primary checkout — that is almost always someone else's landed work.
 *
 * WHAT COUNTS AS "IN PLAY" for the commit being attempted:
 *   - deletions: staged (`D `), unstaged (` D`), or added-then-deleted (`AD`) — always;
 *   - modifications: staged (`M` in the index column) — always; unstaged (`M` in the worktree
 *     column) only when the commit sweeps the whole tree in (`-a` / `--all`).
 *
 * SKIPS (never blocks): the repo in play (cwd or `git -C <path>`) is under `.claude/worktrees/`
 * (linked worktrees rebase cleanly — the bug is primary-checkout-specific); the command carries
 * the PHANTOM_DELETE_OK token; env PHANTOM_DELETE_OK=1; the command has no `git commit`.
 *
 * FAIL-OPEN: malformed stdin, missing git, non-repo directory, or no transcript (no provenance
 * evidence → cannot accuse) → exit 0. Never brick a normal commit.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, roleOf, toolUsesOf } from './lib/transcript.mjs';

// ── command anatomy ─────────────────────────────────────────────────────────────────────────────

/** The first sub-command of a compound shell line that is a `git ... commit ...`, or null. */
export function commitSegmentOf(command) {
  if (typeof command !== 'string' || !command) return null;
  const shellSegments = command.split(/&&|\|\||[;|\n]/);
  return shellSegments.find((segment) => /\bgit\b[^\n]*\bcommit\b/i.test(segment)) || null;
}

/** The repo path named by `git -C <path>` in the commit segment, or null when -C is absent. */
export function repoPathOf(commitSegment) {
  const dashCMatch = /(?:^|\s)-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(commitSegment || '');
  if (!dashCMatch) return null;
  return dashCMatch[1] || dashCMatch[2] || dashCMatch[3] || null;
}

/** True when the path sits under a `.claude/worktrees/` linked-worktree home (either separator). */
export const isUnderClaudeWorktrees = (candidatePath) =>
  /[\\/]\.claude[\\/]worktrees(?:[\\/]|$)/i.test(candidatePath || '');

/** Does this commit sweep unstaged tracked changes in (`-a`, `-am`, `--all`)? */
export const stagesWholeTree = (commitSegment) =>
  /(?:^|\s)--all\b/.test(commitSegment || '') ||
  /(?:^|\s)-(?!-)[a-z]*a[a-z]*\b/i.test(commitSegment || '');

// ── porcelain anatomy ───────────────────────────────────────────────────────────────────────────

/**
 * Repo-relative paths the attempted commit puts in play, parsed from `git status --porcelain`:
 * every deletion (either column), every staged modification, and — when the commit uses -a/--all —
 * every unstaged modification too. Renames/copies take the arrow's right side; untracked/added
 * files are additions, not phantoms, and are ignored.
 */
export function changedPathsOf(porcelainText, { includeUnstagedModifications = false } = {}) {
  const inPlayPaths = [];
  for (const statusLine of (porcelainText || '').split('\n')) {
    if (statusLine.length < 4) continue;
    const indexStatus = statusLine[0];
    const worktreeStatus = statusLine[1];
    const isDeletion = indexStatus === 'D' || worktreeStatus === 'D';
    const isStagedModification = indexStatus === 'M';
    const isUnstagedModification = worktreeStatus === 'M';
    if (!isDeletion && !isStagedModification && !(includeUnstagedModifications && isUnstagedModification)) continue;
    let changedPath = statusLine.slice(3);
    if (changedPath.includes(' -> ')) changedPath = changedPath.split(' -> ').pop();
    changedPath = changedPath.replace(/^"|"$/g, '');
    if (changedPath) inPlayPaths.push(changedPath);
  }
  return [...new Set(inPlayPaths)];
}

// ── session provenance (same technique as delete-audit-guard.mjs) ──────────────────────────────

/**
 * Absolute lowercase paths this session created or edited: Write/Edit/MultiEdit/NotebookEdit
 * tool_uses plus shell `>`/`>>` redirect targets. A deletion or modification of one of THESE is
 * the session's own intentional work, never a phantom.
 */
export function sessionTouchedPaths(sessionEntries) {
  const touchedPaths = new Set();
  for (const entry of sessionEntries || []) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const toolUse of toolUsesOf(entry)) {
      const toolName = toolUse.name || '';
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
        const editedPath = toolUse.input?.file_path || toolUse.input?.notebook_path || toolUse.input?.path || '';
        if (editedPath) { try { touchedPaths.add(resolve(editedPath).toLowerCase()); } catch { /* unresolvable — skip */ } }
      }
      if (toolName === 'Bash' || toolName === 'PowerShell') {
        const shellCommand = toolUse.input?.command || '';
        for (const redirectMatch of shellCommand.matchAll(/(?:^|\s)>{1,2}\s*"?([^\s"|;&]+)"?/g)) {
          try { touchedPaths.add(resolve(redirectMatch[1]).toLowerCase()); } catch { /* unresolvable — skip */ }
        }
      }
    }
  }
  return touchedPaths;
}

// ── plumbing ────────────────────────────────────────────────────────────────────────────────────

/** stdout of a git invocation in `repoDirectory`, or null on any failure (missing git, non-repo). */
function gitOutputOrNull(repoDirectory, ...gitArgs) {
  try {
    const gitProbe = spawnSync('git', ['-C', repoDirectory, ...gitArgs], { encoding: 'utf8' });
    if (gitProbe.error || gitProbe.status !== 0) return null;
    return gitProbe.stdout;
  } catch {
    return null;
  }
}

function main() {
  if (process.env.PHANTOM_DELETE_OK === '1') { process.exit(0); return; }

  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0); return;
  }

  if (event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') { process.exit(0); return; }
  const command = event.tool_input?.command;
  if (typeof command !== 'string' || !command) { process.exit(0); return; }

  // Inline escape token (also covers `PHANTOM_DELETE_OK=1 git commit ...`, which sets the var for
  // the subprocess, not for this hook).
  if (/\bPHANTOM_DELETE_OK\b/.test(command)) { process.exit(0); return; }

  const commitSegment = commitSegmentOf(command);
  if (!commitSegment) { process.exit(0); return; }

  // Repo in play: `git -C <path>` wins; otherwise the tool call's cwd.
  const workingDirectory = event.cwd || process.cwd();
  const namedRepoPath = repoPathOf(commitSegment);
  let repoDirectory;
  try {
    repoDirectory = namedRepoPath
      ? (isAbsolute(namedRepoPath) ? namedRepoPath : resolve(workingDirectory, namedRepoPath))
      : resolve(workingDirectory);
  } catch {
    process.exit(0); return;
  }

  // Linked worktrees under .claude/worktrees/ rebase cleanly — the stale-tree bug is primary-only.
  if (isUnderClaudeWorktrees(repoDirectory)) { process.exit(0); return; }

  // No transcript → no provenance evidence → cannot accuse. Fail open.
  let sessionEntries = [];
  try { sessionEntries = readTranscript(event.transcript_path); } catch { sessionEntries = []; }
  if (!sessionEntries.length) { process.exit(0); return; }

  const porcelainText = gitOutputOrNull(repoDirectory, 'status', '--porcelain');
  if (porcelainText === null) { process.exit(0); return; } // missing git or non-repo — fail open

  let inPlayPaths;
  try {
    inPlayPaths = changedPathsOf(porcelainText, { includeUnstagedModifications: stagesWholeTree(commitSegment) });
  } catch {
    process.exit(0); return;
  }
  if (!inPlayPaths.length) { process.exit(0); return; }

  const repoRootText = gitOutputOrNull(repoDirectory, 'rev-parse', '--show-toplevel');
  if (repoRootText === null) { process.exit(0); return; }
  const repoRoot = repoRootText.trim();
  if (isUnderClaudeWorktrees(repoRoot)) { process.exit(0); return; }

  let phantomPaths;
  try {
    const touchedPaths = sessionTouchedPaths(sessionEntries);
    phantomPaths = inPlayPaths.filter((repoRelativePath) => {
      try {
        return !touchedPaths.has(resolve(repoRoot, repoRelativePath).toLowerCase());
      } catch {
        return false; // unresolvable path — don't accuse what we can't identify
      }
    });
  } catch {
    process.exit(0); return;
  }
  if (!phantomPaths.length) { process.exit(0); return; }

  const reason = [
    'BLOCKED — this commit would bake in PHANTOM deletions/modifications of files this session never touched.',
    '',
    'This checkout\'s working tree looks STALE: a sibling agent\'s landing likely moved this branch\'s ref',
    'underneath it, so the just-landed files now read as deleted or reverted here. Committing them from a',
    'primary checkout silently DESTROYS the landed work (this exact bug reverted landings 4x on 2026-07-03,',
    'including a 141-line Truth-ledger rewrite).',
    '',
    'Phantom paths (deleted/modified on disk, but never created or edited by this session):',
    ...phantomPaths.map((phantomPath) => `  - ${phantomPath}`),
    '',
    'Fix — restore the landed content, then commit only YOUR files by explicit path:',
    `  git checkout HEAD -- ${phantomPaths.map((phantomPath) => `"${phantomPath}"`).join(' ')}`,
    '  git add <only the files you actually changed>   (never -A / -am from a stale tree)',
    '',
    'If these deletions/modifications are genuinely intended, re-run with the escape token:',
    '  PHANTOM_DELETE_OK=1 <command>   (or include the literal token PHANTOM_DELETE_OK anywhere in it)',
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

// Entry-point guard: importing this file (e.g. from its test) must NOT run main(), because main()
// reads stdin (fd 0) and would hang the importer. Compare by BASENAME, not full path — an
// exact-path compare is fragile on Windows (MSYS /c/... vs C:\..., file:// scheme, separator +
// case differences) and would silently never run; see learnings.md 2026-06-28.
function isDirectRun() {
  try {
    return basename(process.argv[1] || '').toLowerCase() === basename(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
}
if (isDirectRun()) {
  try { main(); } catch { process.exit(0); }
}
