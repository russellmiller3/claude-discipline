#!/usr/bin/env node
/**
 * PreToolUse hook — block `git push` to non-main remote branches.
 *
 * Russell's rule (2026-05-04): default flow is do the work locally,
 * merge to main, delete the branch, push main only. Pushing every
 * feature branch as you go clutters the remote, runs the pre-push
 * hooks N times where 1 would do, and creates a "did this ship?"
 * question every time someone looks at GitHub.
 *
 * What this hook blocks:
 *   git push -u origin feature/foo
 *   git push origin feature/foo
 *   git push origin docs/bar
 *   git push origin fix/baz
 *   git push origin HEAD                       (when on a feature branch)
 *   git push                                   (when on a feature branch
 *                                                with --set-upstream config)
 *
 * What this hook ALLOWS:
 *   git push origin main                       (the canonical ship)
 *   git push origin HEAD:main                  (publishing the branch as main)
 *   git push --tags                            (release tags)
 *   git push origin --delete feature/foo       (cleanup of merged branches)
 *
 * Override: set PUSH_BRANCH_OVERRIDE=1 in the env when the work is
 * genuinely WIP that needs handoff or backup. The override is per-shell;
 * it doesn't persist across sessions.
 *
 * Fail-open on any unexpected error — never permanently block CC.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

function main() {
  if (process.env.PUSH_BRANCH_OVERRIDE === '1') process.exit(0);

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

  // Honor an INLINE `PUSH_BRANCH_OVERRIDE=1 git push …` prefix. A PreToolUse hook runs BEFORE the shell
  // executes, so an env-var prefix on the command never reaches this process's `process.env` — the
  // documented escape hatch was unreachable from any Bash tool call. Read it off the command string
  // instead (also accepts it after a `;`/`&&`/`|` separator). (2026-07-18)
  if (/(?:^|[;&|]\s*)PUSH_BRANCH_OVERRIDE=1\s+/.test(c)) process.exit(0);

  // Only fire on `git push`. If the command is unrelated, allow.
  if (!/\bgit\s+push\b/.test(c)) process.exit(0);

  // Allow `git push --delete <branch>` / `git push origin :<branch>` —
  // those are CLEANING UP the remote, which is what we want.
  if (/\bgit\s+push\b.*\B--delete\b/.test(c)) process.exit(0);
  if (/\bgit\s+push\b.*\borigin\s+:[A-Za-z0-9._/\-]+/.test(c)) process.exit(0);

  // Allow tag pushes (`git push --tags` or `git push origin v1.2.3`).
  if (/\bgit\s+push\b.*\B--tags\b/.test(c)) process.exit(0);

  // Allow pushes that explicitly target main, on ANY remote/destination --
  // not just the literal word `origin`. A same-machine merge-into-main push
  // (e.g. `git push <local-worktree-path> HEAD:main`, used to fast-forward
  // a branch checked out in another worktree) is exactly the "publish as
  // main" case this hook means to allow; requiring the literal `origin`
  // token false-positived on that (2026-07-02). Patterns after the
  // destination token: `<dest> main`, `<dest> HEAD:main`,
  // `<dest> refs/heads/main`, `<dest> <anything>:main`.
  if (/\bgit\s+push\s+\S+\s+(?:[^\s]+:)?main\b/.test(c)) process.exit(0);
  if (/\bgit\s+push\s+\S+\s+refs\/heads\/main\b/.test(c)) process.exit(0);

  // Determine the current branch. If we can't, fail open (don't block on
  // git brokenness).
  let branch;
  try {
    branch = execSync('git branch --show-current', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    process.exit(0);
  }

  // If we're on main and pushing without an explicit refspec, that's
  // a `git push origin main` equivalent — let it through.
  if (branch === 'main') {
    // `git push` while on main pushes the upstream of main, which is
    // origin/main. Safe.
    process.exit(0);
  }

  // At this point: command is `git push` and we're on a non-main branch
  // (or the refspec explicitly targets a non-main branch). Block.
  const reason =
    `🚫 Push blocked — pushing a non-main branch.\n\n` +
    `Russell's rule (2026-05-04, ~/.claude/CLAUDE.md "Don't Push Branches Until Work Is Done"):\n` +
    `default flow is do the work locally, merge to main, delete the branch, push main only.\n` +
    `Pushing every feature branch clutters the remote and re-runs the pre-push hooks for nothing.\n\n` +
    `Current branch: ${branch || '<unknown>'}\n` +
    `Detected command: ${c.slice(0, 120)}${c.length > 120 ? '…' : ''}\n\n` +
    `Recommended sequence:\n` +
    `  git switch main\n` +
    `  git merge --ff-only ${branch || '<feature-branch>'}\n` +
    `  git branch -d ${branch || '<feature-branch>'}\n` +
    `  git push origin main\n\n` +
    `If this push is genuinely WIP that needs handoff or remote backup, set\n` +
    `  PUSH_BRANCH_OVERRIDE=1\n` +
    `in env and retry. Document the rationale in the commit / handoff so the\n` +
    `next session knows why the branch is on the remote.`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

main();
