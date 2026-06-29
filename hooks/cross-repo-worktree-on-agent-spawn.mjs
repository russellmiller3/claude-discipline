#!/usr/bin/env node
/**
 * cross-repo-worktree-on-agent-spawn — gate hook that DENIES an Agent spawn which
 * tells the agent to work in a DIFFERENT (sibling) repo by absolute path but does
 * not have that agent set up its OWN git worktree there.
 *
 * Why this rule exists (2026-06-29):
 * The Agent tool's `isolation: "worktree"` param isolates the SESSION's repo — the
 * one the cwd lives in. When a brief instead tells the agent to operate on a SIBLING
 * repo by absolute path (e.g. a claude-voice session driving skaffen-desktop), the
 * isolation param creates a worktree of the WRONG repo, so the sibling repo's single
 * working tree is shared by every such agent. Three parallel phase agents then each
 * ran `git checkout -b` in that ONE shared skaffen-desktop checkout and reset HEAD
 * under each other — commits landed on the wrong branch. It recovered only by luck
 * (the branches happened to stack). The correct isolation for a sibling repo is for
 * the agent to `git worktree add` its OWN worktree inside that repo.
 *
 * So: if the brief references a sibling repo AND lacks `git worktree add`, DENY.
 * `isolation: "worktree"` does NOT satisfy this — it isolates the wrong repo.
 *
 * Teeth: permissionDecision:'deny'. Escapes: the brief contains `git worktree add`
 * (the real fix), FOREGROUND_OK (read-only, writes nothing → no tree to clobber),
 * or CROSS_REPO_WORKTREE_RUSSELL_OK (Russell's explicit approval; never self-grant).
 *
 * Fail-open on any unexpected error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Normalize a path to lowercase forward-slash form for comparison. */
function normalizePath(rawPath) {
  return rawPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Pull absolute filesystem paths out of a prompt (Windows `C:\...` and MSYS
 * `/c/...` forms), returned normalized. Strips common trailing punctuation/quotes.
 */
export function extractAbsolutePaths(prompt) {
  const found = new Set();
  const windowsPaths = prompt.match(/[A-Za-z]:[\\/][^\s`'"<>|]+/g) || [];
  const msysPaths = prompt.match(/\/[a-zA-Z]\/[Uu]sers\/[^\s`'"<>|]+/g) || [];
  for (const candidate of [...windowsPaths, ...msysPaths]) {
    found.add(normalizePath(candidate.replace(/[.,;:)\]]+$/, '')));
  }
  return [...found];
}

/**
 * Decide on one PreToolUse Agent event. Returns a deny-decision object, or null to
 * allow. Pure: callers inject `sessionRepoRoot` (normalized) and `isGitRepo(path)`.
 */
export function decideCrossRepoGate(event, { sessionRepoRoot, isGitRepo }) {
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') return null;
  if ((event.tool_name || '') !== 'Agent') return null;

  const input = event.tool_input || {};
  const prompt = input.prompt || '';
  const description = input.description || '(unnamed)';

  // The real fix is present, or an explicit escape — allow.
  if (/git\s+worktree\s+add/i.test(prompt)) return null;
  if (/\bFOREGROUND_OK\b/.test(prompt)) return null; // read-only: no tree to clobber
  if (/\bCROSS_REPO_WORKTREE_RUSSELL_OK\b/.test(prompt)) return null;

  if (!sessionRepoRoot) return null; // can't tell what's "cross" — fail open
  const sessionRoot = normalizePath(sessionRepoRoot);
  const parentDir = normalizePath(dirname(sessionRoot));

  // Find a sibling repo the brief points the agent at: an absolute path under the
  // session repo's PARENT dir, but not under the session repo itself, whose first
  // segment resolves to a real git repo.
  for (const targetPath of extractAbsolutePaths(prompt)) {
    if (targetPath === sessionRoot) continue;
    if (targetPath.startsWith(sessionRoot + '/')) continue; // inside the session repo
    if (!targetPath.startsWith(parentDir + '/')) continue; // not a sibling under parent
    const afterParent = targetPath.slice(parentDir.length + 1);
    const siblingName = afterParent.split('/')[0];
    if (!siblingName) continue;
    const siblingRoot = join(parentDir, siblingName);
    if (siblingName === basename(sessionRoot)) continue;
    if (!isGitRepo(siblingRoot)) continue;

    const reason = `Agent spawn BLOCKED — "${description}" works in a SIBLING repo (${siblingName}) by absolute path but never sets up its own git worktree there.

Russell's rule (2026-06-29): the Agent tool's isolation:"worktree" isolates the SESSION repo, NOT a sibling repo the brief drives by absolute path — so every such agent shares the sibling repo's single working tree and their \`git checkout -b\` calls reset HEAD under each other (commits land on the wrong branch). The correct isolation is for the agent to create its OWN worktree in the target repo.

Fix: put worktree setup IN the brief — tell the agent to FIRST run \`git worktree add <dir> -b <branch> <base>\` inside ${siblingName} and do ALL work there.
Escapes: FOREGROUND_OK (read-only, writes nothing) · CROSS_REPO_WORKTREE_RUSSELL_OK (Russell approved; never self-grant).`;

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  return null;
}

/** Walk up from a starting dir to the nearest ancestor containing a `.git`. */
export function findRepoRoot(startDir) {
  let current = startDir;
  while (current) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }
  const startDir = event.cwd || process.cwd();
  const sessionRepoRoot = findRepoRoot(startDir);
  const decision = decideCrossRepoGate(event, {
    sessionRepoRoot,
    isGitRepo: (candidate) => existsSync(join(candidate, '.git')),
  });
  if (decision) process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

// Entry-point guard by BASENAME (Windows path forms differ between import.meta.url
// and argv[1]; basename is stable) so the test can import without running main().
const invokedAsScript =
  process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1]);
if (invokedAsScript) main();
