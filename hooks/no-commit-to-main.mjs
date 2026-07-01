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
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

function main() {
  if (process.env.COMMIT_MAIN_OVERRIDE === '1') process.exit(0);

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

  // Inline env-var prefix like `COMMIT_MAIN_OVERRIDE=1 git commit ...` sets the var
  // for the git subprocess but not for this hook process. Allow it explicitly.
  if (/\bCOMMIT_MAIN_OVERRIDE=1\b/.test(c)) process.exit(0);

  // Only fire on git commit
  if (!/\bgit\s+commit\b/.test(c)) process.exit(0);

  // The command may target ANOTHER repo than the session cwd: `cd <kit> && git commit ...`
  // or `git -C <kit> commit ...`. Check the branch of the repo the commit actually runs in —
  // checking the session repo's branch false-blocked a commit on another repo's fix branch
  // just because the SESSION repo sat on main (2026-07-01).
  function effectiveDirectory(normalizedCommand, sessionDirectory) {
    const cdPrefixMatch = normalizedCommand.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/);
    if (cdPrefixMatch) return cdPrefixMatch[1] || cdPrefixMatch[2] || cdPrefixMatch[3];
    const dashCMatch = normalizedCommand.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    if (dashCMatch) return dashCMatch[1] || dashCMatch[2] || dashCMatch[3];
    return sessionDirectory;
  }

  let branch;
  try {
    branch = execSync('git branch --show-current', {
      encoding: 'utf8',
      cwd: effectiveDirectory(c, event.cwd || process.cwd()),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    process.exit(0); // fail open — don't block on git errors (incl. a bad cd path: git itself will error)
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
