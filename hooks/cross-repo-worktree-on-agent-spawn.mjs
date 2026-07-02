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
  for (const { normalized } of extractAbsolutePathMatches(prompt)) {
    found.add(normalized);
  }
  return [...found];
}

/**
 * Same extraction as `extractAbsolutePaths`, but keeps EVERY occurrence (not deduped)
 * along with its character offset in the original prompt — needed so the read/write
 * intent check below can look at the text immediately around each specific mention,
 * not just "was this path mentioned anywhere."
 */
function extractAbsolutePathMatches(prompt) {
  const matches = [];
  const windowsPaths = prompt.matchAll(/[A-Za-z]:[\\/][^\s`'"<>|]+/g);
  const msysPaths = prompt.matchAll(/\/[a-zA-Z]\/[Uu]sers\/[^\s`'"<>|]+/g);
  for (const m of [...windowsPaths, ...msysPaths]) {
    const raw = m[0].replace(/[.,;:)\]]+$/, '');
    matches.push({ normalized: normalizePath(raw), index: m.index });
  }
  return matches;
}

// ---- Read/write intent carve-out (2026-07-02) ----
//
// A sibling-path mention is READ-ONLY intent if a read cue sits near it and no write
// cue sits near it. Mirrors the NEGATION_WINDOW / isNegatedImmediatelyBefore shape in
// live-ui-focus-guard.mjs: a bounded character window around a match, scanned for a
// cue phrase, to distinguish "what this text really means" from "what it merely
// mentions." Here the distinction is read-cue vs write-cue proximity to a path, not
// negation.
const INTENT_WINDOW = 120;
const READ_CUE = /\b(read|references?|read-only|for reference|see|per)\b/i;
const WRITE_CUE = /\b(edit|write(?:s|ing)? to|modify|modifies|commit|checkout|create|build\b[^.]{0,40}\bin\b|git\s+(?!worktree\s+add))\b/i;

/** Case-insensitive, slash-normalized check for Russell's docs-only shared reference dir. */
const CONTEXT_DIR = 'c:/users/rmill/desktop/programming/context';
function isContextDirPath(normalizedPath) {
  return normalizedPath === CONTEXT_DIR || normalizedPath.startsWith(CONTEXT_DIR + '/');
}

// Clause boundary: a sentence/clause separator that plausibly ends the thought
// governing a path mention. Bounds the window so a write verb governing a LATER,
// unrelated clause (e.g. "...for reference, then build X in <other-repo>...") doesn't
// bleed backward and false-positive an earlier read-only mention.
const CLAUSE_BOUNDARY = /[.;\n]|,\s+then\b/i;

/** Slice `prompt` to the clause containing `index`, bounded by CLAUSE_BOUNDARY, then
 * further bounded to INTENT_WINDOW chars on each side of `index`. */
function clauseWindowAround(prompt, index) {
  const before = prompt.slice(Math.max(0, index - INTENT_WINDOW), index);
  const after = prompt.slice(index, Math.min(prompt.length, index + INTENT_WINDOW));

  const boundaryBefore = [...before.matchAll(new RegExp(CLAUSE_BOUNDARY, 'g'))].pop();
  const clauseStart = boundaryBefore ? boundaryBefore.index + boundaryBefore[0].length : 0;

  const boundaryAfter = after.match(CLAUSE_BOUNDARY);
  const clauseEnd = boundaryAfter ? boundaryAfter.index : after.length;

  return before.slice(clauseStart) + after.slice(0, clauseEnd);
}

/**
 * Is this specific occurrence of a sibling path (at `index` in `prompt`) read-only
 * intent? Looks at the clause containing the mention (bounded to INTENT_WINDOW chars
 * each side, and clamped at sentence/clause boundaries so a write verb governing a
 * DIFFERENT, later clause doesn't bleed backward) for a read cue and a write cue.
 *
 * - Paths under programming/context/ (Russell's documented docs-only shared reference
 *   dir — see ~/.claude/CLAUDE.md "Shared Context") get a STRONGER prior: read-only
 *   UNLESS a write cue is in that clause. Default flips to safe-unless-proven-otherwise
 *   because that directory is never a target other agents branch/commit into.
 * - Any other sibling repo needs an explicit read cue in the clause AND no write cue
 *   in it — deny-unless-proven-read-only stays the default.
 */
function isReadOnlyMention(prompt, index, normalizedPath) {
  const clause = clauseWindowAround(prompt, index);

  const hasWriteCue = WRITE_CUE.test(clause);
  if (hasWriteCue) return false;

  if (isContextDirPath(normalizedPath)) return true; // safe-unless-proven-otherwise
  return READ_CUE.test(clause); // deny-unless-proven-read-only
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
  // Match "worktree add" robustly: bare `git worktree add` AND the `git -C <path>
  // worktree add` form (the `-C <path>` between git and worktree broke the old
  // `git\s+worktree` regex — a false-negative that blocked a correct brief).
  if (/\bworktree\s+add\b/i.test(prompt)) return null;
  if (/\bFOREGROUND_OK\b/.test(prompt)) return null; // read-only: no tree to clobber
  if (/\bCROSS_REPO_WORKTREE_RUSSELL_OK\b/.test(prompt)) return null;

  if (!sessionRepoRoot) return null; // can't tell what's "cross" — fail open
  const sessionRoot = normalizePath(sessionRepoRoot);
  const parentDir = normalizePath(dirname(sessionRoot));

  // Find every sibling-repo path MENTION the brief contains: an absolute path under
  // the session repo's PARENT dir, but not under the session repo itself, whose first
  // segment resolves to a real git repo. Keep position data (not deduped) so the
  // read/write intent check can look at the text around each specific mention.
  const siblingMentions = [];
  for (const { normalized: targetPath, index } of extractAbsolutePathMatches(prompt)) {
    if (targetPath === sessionRoot) continue;
    if (targetPath.startsWith(sessionRoot + '/')) continue; // inside the session repo
    if (!targetPath.startsWith(parentDir + '/')) continue; // not a sibling under parent
    const afterParent = targetPath.slice(parentDir.length + 1);
    const siblingName = afterParent.split('/')[0];
    if (!siblingName) continue;
    const siblingRoot = join(parentDir, siblingName);
    if (siblingName === basename(sessionRoot)) continue;
    if (!isGitRepo(siblingRoot)) continue;
    siblingMentions.push({ targetPath, index, siblingName });
  }

  if (siblingMentions.length === 0) return null;

  // Read-only carve-out: if EVERY sibling-repo mention in the brief is read-only
  // intent (per isReadOnlyMention — a read cue near it, no write cue near it, or it's
  // under programming/context/ with no write cue near it), allow without requiring
  // worktree add. A single mixed/ambiguous/write-signaled mention anywhere falls
  // through to the existing deny behavior — conservative by design.
  const allReadOnly = siblingMentions.every(({ index, targetPath }) =>
    isReadOnlyMention(prompt, index, targetPath),
  );
  if (allReadOnly) return null;

  for (const { siblingName } of siblingMentions) {
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
