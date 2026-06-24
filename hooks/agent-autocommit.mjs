#!/usr/bin/env node
/**
 * agent-autocommit — PostToolUse(Write|Edit|MultiEdit|NotebookEdit): AUTO-COMMITS WIP inside a linked git
 * worktree after every file edit. This is the ENFORCEMENT half of the commit-cadence rule: a brief can SAY
 * to commit often, but an agent can still ignore that and die with hours uncommitted. This hook makes the
 * commit happen WITHOUT the agent's cooperation — every edit in an agent worktree is instantly checkpointed
 * to git, so a silent death loses at most the single in-flight edit, never hours.
 *
 * Why: agents should not die and lose work. A prompt instruction is advisory; a hook is enforcement.
 *
 * Scope: ONLY linked worktrees (their absolute git dir lives under .../worktrees/<name>). The PRIMARY worktree
 * (the main session) is never touched — it manages its own commits. Fail-open: a commit error never blocks the
 * edit, and a clean tree is a no-op.
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Pure: where did the edit land? Prefer the edited file's directory; fall back to the event cwd.
export function resolveWorkdir(event) {
  const filePath = event?.tool_input?.file_path || event?.tool_input?.notebook_path || '';
  if (filePath) return dirname(filePath);
  return event?.cwd || process.cwd();
}

// Pure: a linked worktree's git dir lives under .../worktrees/<name>; the primary worktree's does not. This is
// the signal that distinguishes an AGENT worktree from the main session — only the former auto-commits.
export function isLinkedWorktree(absoluteGitDir) {
  return /[\\/]worktrees[\\/]/.test(String(absoluteGitDir || ''));
}

// Pure: commit only when in a linked worktree AND there is something staged-or-unstaged to commit.
export function shouldAutocommit({ absoluteGitDir, porcelainStatus }) {
  return isLinkedWorktree(absoluteGitDir) && Boolean(String(porcelainStatus || '').trim());
}

function git(workdir, gitArgs) {
  return execFileSync('git', ['-C', workdir, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PostToolUse') process.exit(0);
  if (!EDIT_TOOLS.has(event.tool_name || '')) process.exit(0);

  const workdir = resolveWorkdir(event);
  try {
    git(workdir, ['rev-parse', '--is-inside-work-tree']);
    const absoluteGitDir = git(workdir, ['rev-parse', '--absolute-git-dir']);
    if (!isLinkedWorktree(absoluteGitDir)) process.exit(0); // primary worktree (main session) — leave it alone
    const porcelainStatus = git(workdir, ['status', '--porcelain']);
    if (!shouldAutocommit({ absoluteGitDir, porcelainStatus })) process.exit(0);

    git(workdir, ['add', '-A']);
    const tool = event.tool_name || 'edit';
    git(workdir, ['commit', '--no-verify', '-m', `wip(autocommit): checkpoint after ${tool}`]);

    const worktreeRoot = absoluteGitDir.replace(/[\\/]\.git[\\/].*$/, '');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[agent-autocommit] checkpointed WIP in linked worktree (${worktreeRoot}). A silent death now loses at most this one edit.`,
      },
    }));
  } catch {
    // fail-open — never block an edit on a commit problem (detached HEAD, locked index, no repo, etc.)
  }
  process.exit(0);
}

// Only run when executed directly as a hook — importing (e.g. from the test) must NOT block on stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
