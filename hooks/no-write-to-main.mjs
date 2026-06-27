#!/usr/bin/env node
/**
 * no-write-to-main — PreToolUse (Bash)
 *
 * Blocks Bash commands that write non-doc files to the repo while on the
 * main/master branch. Fills the gap that worktree-default-for-edits.mjs
 * leaves: Write/Edit tools are blocked there, but `cp`, `mv`, shell
 * redirects, and python/node file writes bypass it entirely.
 *
 * Rule: code changes reach main ONLY via branch → merge, never by writing
 * directly to the primary checkout on main. Doc files (.md etc.) are
 * allowed — handoff updates, plan files, READMEs are fine to write on main.
 *
 * Allowed:  cp file.md plans/              (doc target)
 * Blocked:  cp file.js src/lib/            (code target on main)
 * Blocked:  mv tmp.svelte src/components/  (code target on main)
 * Blocked:  python write_plan.py > src/lib/parser.js  (redirect to code file)
 *
 * Override: WRITE_MAIN_OVERRIDE=1
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, isAbsolute, resolve } from 'node:path';

// Extensions that are doc-safe to write directly on main
const DOC_EXTENSIONS = new Set([
  '.md', '.mdx', '.markdown', '.txt', '.rst', '.org'
]);

// Extensions that are code — writing these on main is blocked
const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.svelte',
  '.css', '.scss', '.less', '.html', '.htm',
  '.json', '.yaml', '.yml', '.toml',
  '.py', '.sh', '.bash', '.zsh', '.ps1',
  '.sql', '.graphql', '.prisma',
]);

function isCodePath(pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return false;
  const ext = extname(pathStr).toLowerCase();
  if (!ext) return false; // no extension — unknown, don't block
  return CODE_EXTENSIONS.has(ext);
}

function isDocPath(pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return false;
  const ext = extname(pathStr).toLowerCase();
  return DOC_EXTENSIONS.has(ext);
}

// Canonical form for cross-platform path comparison:
//   /c/Users\X  ->  c:/users/x   |   C:\Users\X  ->  c:/users/x
function normalizePath(pathStr) {
  let canonical = String(pathStr).replace(/\\/g, '/');
  canonical = canonical.replace(/^\/([a-zA-Z])\//, (_, drive) => `${drive.toLowerCase()}:/`);
  canonical = canonical.replace(/^([a-zA-Z]):\//, (_, drive) => `${drive.toLowerCase()}:/`);
  return canonical.toLowerCase().replace(/\/+$/, '');
}

// This guard only governs writes that land INSIDE the repo on main. A throwaway
// write to /tmp or AppData/Local/Temp is not "writing code to main" — allow it.
// If the repo root can't be determined, treat the target as inside (fail closed).
function isInsideRepo(target, cwd, repoRoot) {
  if (!repoRoot) return true;
  const looksAbsolute = isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/');
  const absoluteTarget = looksAbsolute ? target : resolve(cwd || process.cwd(), target);
  const normalizedTarget = normalizePath(absoluteTarget);
  const normalizedRoot = normalizePath(repoRoot);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

/**
 * Extract potential write targets from a Bash command string.
 * Returns array of { pattern, target } objects.
 */
function extractWriteTargets(command) {
  const targets = [];

  // cp source dest  (last positional argument is destination)
  // handles: cp foo.js src/lib/  or  cp foo.js src/lib/foo.js
  const cpMatch = command.match(/\bcp\s+(?:-[rRfpn]+\s+)*(\S+)\s+(\S+)/);
  if (cpMatch) targets.push({ pattern: 'cp', target: cpMatch[2] });

  // mv source dest
  const mvMatch = command.match(/\bmv\s+(?:-[fn]+\s+)*(\S+)\s+(\S+)/);
  if (mvMatch) targets.push({ pattern: 'mv', target: mvMatch[2] });

  // shell redirect:  command > file  or  command >> file
  // strip quoted strings first to avoid false positives inside heredocs
  const noQuotes = command.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  const redirectMatches = [...noQuotes.matchAll(/>{1,2}\s*(\S+)/g)];
  for (const m of redirectMatches) {
    const target = m[1].replace(/[";]/g, '');
    if (target && !target.startsWith('-')) targets.push({ pattern: 'redirect', target });
  }

  // tee file  (writes to file while also writing to stdout)
  const teeMatch = command.match(/\btee\s+(?:-a\s+)?(\S+)/);
  if (teeMatch) targets.push({ pattern: 'tee', target: teeMatch[1] });

  return targets;
}

function main() {
  if (process.env.WRITE_MAIN_OVERRIDE === '1') process.exit(0);

  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }

  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName && eventName !== 'PreToolUse') { process.exit(0); return; }

  if (event.tool_name !== 'Bash') { process.exit(0); return; }

  const command = (event.tool_input && event.tool_input.command) || '';
  if (typeof command !== 'string' || !command.trim()) { process.exit(0); return; }

  // Check inline override prefix
  if (/\bWRITE_MAIN_OVERRIDE=1\b/.test(command)) { process.exit(0); return; }

  // Check current branch
  let branch;
  try {
    branch = execSync('git branch --show-current', {
      encoding: 'utf8',
      cwd: event.cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    process.exit(0); // fail open — no git repo or other error
    return;
  }

  if (branch !== 'main' && branch !== 'master') { process.exit(0); return; }

  // Repo root — so we only block writes that land INSIDE the repo (not /tmp etc.)
  let repoRoot;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      cwd: event.cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    repoRoot = '';
  }

  // We're on main — block only code files that resolve inside the repo
  const targets = extractWriteTargets(command);
  const blockedTarget = targets.find(
    t => isCodePath(t.target) && isInsideRepo(t.target, event.cwd || process.cwd(), repoRoot)
  );

  if (!blockedTarget) { process.exit(0); return; }

  const reason = [
    `BLOCKED: you're on ${branch}. To write code, switch to a feature branch first:`,
    '',
    '  git switch -c feature/<task>      (or: git switch <existing-feature-branch>)',
    '',
    'THIS is the fix — not WRITE_MAIN_OVERRIDE, not rerouting to /tmp. Cut the',
    'branch, then re-run your write. Code reaches main ONLY via branch → merge.',
    '',
    `(Tried to write ${blockedTarget.target} via ${blockedTarget.pattern} while on ${branch}.)`,
    '',
    'Allowed on main without a branch: doc files (.md/.txt) and non-repo paths (/tmp, AppData temp).',
    'Override (rare — deliberate repo maintenance only): WRITE_MAIN_OVERRIDE=1',
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
