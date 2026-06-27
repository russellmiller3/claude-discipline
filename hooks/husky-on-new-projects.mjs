#!/usr/bin/env node
/**
 * SessionStart hook — nudge to set up husky on any Node + git project that lacks it.
 *
 * The rule: ALWAYS set up husky on new projects, so the test gate
 * actually runs on commit. Trigger: a watcher commit this session sailed through with
 * tests left UNRUN because the project had no git hooks. husky makes the gate real — git runs
 * it whether the committer is the agent or a human.
 *
 * Fires once per session. If cwd is a Node project (package.json) inside a git repo but
 * has no husky (no .husky/ dir, no husky dep, no husky prepare script), it injects a
 * reminder. Otherwise silent. Fail-open on any error — never break session start.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

function projectHasHusky(projectDir) {
  // 1) a .husky directory (where the hook scripts live)
  const huskyDir = pathJoin(projectDir, '.husky');
  try { if (existsSync(huskyDir) && statSync(huskyDir).isDirectory()) return true; } catch { /* ignore */ }
  // 2) husky as a dependency, or a prepare script that runs husky
  try {
    const manifest = JSON.parse(readFileSync(pathJoin(projectDir, 'package.json'), 'utf8'));
    const allDeps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
    if (allDeps.husky) return true;
    const prepareScript = manifest.scripts && manifest.scripts.prepare;
    if (prepareScript && /husky/.test(prepareScript)) return true;
  } catch { /* unreadable package.json — caller already gated on its existence */ }
  return false;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  const projectDir = payload.cwd || process.cwd();

  // Scope: only Node projects inside a git repo. Don't nag anywhere else.
  const isNodeProject = existsSync(pathJoin(projectDir, 'package.json'));
  const isGitRepo = existsSync(pathJoin(projectDir, '.git'));
  if (!isNodeProject || !isGitRepo) process.exit(0);
  if (projectHasHusky(projectDir)) process.exit(0);

  const message = `HUSKY MISSING — this Node project has no git hooks, so commits and pushes run NOTHING (no test gate). The rule: always set up husky on new projects.

Wire it before the next commit:
  npm i -D husky
  npx husky init
  # then put the test gate in .husky/pre-commit, e.g.:  npm test

Until husky is wired, a "green" commit proves nothing — the tests never ran. (This rule exists because a watcher commit shipped 2026-06-01 with tests unrun.)`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
