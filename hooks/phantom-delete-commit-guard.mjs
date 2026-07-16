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
 * THE TELL (REDESIGNED 2026-07-16 — see "lots of issues" below): a path is phantom when it is BOTH
 * (a) untouched by THIS session (Write/Edit/MultiEdit/shell-redirect/rm history, same technique as
 * delete-audit-guard.mjs) AND (b) its current content is a REVERT — it exactly matches this path's
 * OWN blob at some ANCESTOR commit of HEAD (historicalMatchCommit). (b) is the actual signature of
 * the bug: a stale checkout's disk still holds OLD, already-recorded content while HEAD moved on.
 *
 * WHY "untouched by session" ALONE WAS WRONG (the recurring false-positive family, worst on
 * 2026-07-16): Russell's dominant workflow is "read HANDOFF.md, continue a prior session's WIP,
 * commit it" — files modified BEFORE this session started are, by definition, never in ITS
 * transcript, yet committing them is exactly the ask. The old rule ("untouched ⇒ phantom") blocked
 * that constantly, forcing PHANTOM_DELETE_OK=1 on ordinary, correct commits. The new second
 * condition fixes it without reopening the real bug: inherited WIP is NOVEL content (it was never
 * a git blob before), so it never historically-matches and is never phantom. A genuine stale-CAS
 * revert's content, by construction, is OLD content the repo already recorded — it always matches
 * an ancestor, so it still blocks. Untouched + novel now correctly passes; untouched + a revert to
 * history still blocks.
 *
 * WHAT COUNTS AS "IN PLAY" for the commit being attempted (2026-07-04 false-positive rework):
 *   - staged deletions (`D` in the index column) and staged modifications (`M` in the index
 *     column) — always;
 *   - unstaged deletions/modifications (worktree column) — only when the command will sweep them
 *     in: the commit takes `-a`/`--all`, or an earlier chain segment stages the WHOLE TREE
 *     (`git add -A`/`--all`/`-u`/`.`/`<dir>/`, `git rm -r <dir>`). An EXPLICIT-file add
 *     (`git add my-doc.md`) stages ONLY the named file, so it does NOT put unrelated unstaged
 *     changes in play (2026-07-06 false-positive: an explicit-path doc commit was blocked because
 *     the tree also held an unrelated unstaged HANDOFF.md edit + runs/.tmp_msg.txt deletion). A
 *     plain `git commit` (incl. `--allow-empty`) with an empty staged diff commits zero paths and
 *     must NEVER block.
 *   - a deletion additionally must name a path TRACKED IN THE COMMIT REPO'S OWN HEAD: a file HEAD
 *     never contained (added-then-deleted, or landed only on some other branch/main) cannot be
 *     deleted by this commit, so it is never a phantom.
 *
 * THE REPO IN PLAY: `git -C <path>` on the commit segment wins; else the LAST `cd <path>` chain
 * segment before the commit (`cd <worktree> && git add -A && git commit` runs in the worktree —
 * judging event.cwd instead false-blocked a salvage agent's linked-worktree commits 3 ways on
 * 2026-07-04, incl. a `--allow-empty` from a clean tree); else the tool call's cwd.
 *
 * SKIPS (never blocks): the repo in play is under a linked-worktree home — `.claude/worktrees/`,
 * `.worktrees/`, or `.claude-worktrees/` (linked worktrees rebase cleanly — the bug is
 * primary-checkout-specific); the command carries the PHANTOM_DELETE_OK
 * token; env PHANTOM_DELETE_OK=1; no GENUINE `git ... commit` invocation (2026-07-04 fix: "git
 * commit" inside a quoted prose argument, `git log --grep "commit"`, or "commit" as a filename
 * substring like `phantom-delete-commit-guard.mjs` do NOT count — git must BE the segment's
 * command with `commit` as a bare unquoted word). MSYS `/c/...` cd / -C paths normalize on Windows.
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

/** Quoted spans blanked out so prose can't fool detection (2026-07-04 genuine-invocation fix). */
const maskQuotedSpans = (text) => (text || '').replace(/"[^"]*"|'[^']*'/g, ' ');

/** git global options that consume the NEXT token as their value (separate-token form; the
 *  `--opt=value` form is a single token and needs no special casing). */
const VALUE_TAKING_GIT_GLOBAL_OPTIONS = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix',
  '--exec-path', '--config-env', '--attr-source',
]);

/**
 * True when this shell segment actually INVOKES `git ... commit`: git is the segment's command
 * (optionally behind env-var assignments or a path to the binary), and `commit` is the RESOLVED
 * SUBCOMMAND — the first non-option token after git's global options. Three live false positives
 * the quoted-span mask killed (2026-07-04): `node agent-brief.mjs --mission "...git commit..."`
 * (prose in a quoted argument), `git log --grep "commit"` (quoted argument to a real git command),
 * and `git checkout main -- phantom-delete-commit-guard.mjs` ("commit" as a FILENAME substring).
 * Subcommand RESOLUTION added same day (fp2 salvage): the word-anywhere check still armed on
 * UNQUOTED arguments (`git log --grep commit`) — now only the subcommand position counts.
 * Quoted spans become a placeholder token here (not a bare gap like maskQuotedSpans) so
 * `git -C "path with spaces" commit` still parses as `-C` + value + `commit` and stays vetted.
 */
export function isGenuineCommitSegment(segment) {
  const maskedSegment = (segment || '').replace(/"[^"]*"|'[^']*'/g, ' __quoted__ ');
  const gitInvocation = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*[\\/])?git(?:\.exe)?\s([^\n]*)$/i.exec(maskedSegment);
  if (!gitInvocation) return false;
  const argumentTokens = gitInvocation[1].trim().split(/\s+/);
  for (let tokenIndex = 0; tokenIndex < argumentTokens.length; tokenIndex++) {
    const token = argumentTokens[tokenIndex];
    if (!token) continue;
    if (VALUE_TAKING_GIT_GLOBAL_OPTIONS.has(token)) { tokenIndex++; continue; }
    if (token.startsWith('-')) continue;
    return token.toLowerCase() === 'commit';
  }
  return false;
}

/** The first sub-command of a compound shell line that genuinely invokes `git ... commit`, or null. */
export function commitSegmentOf(command) {
  if (typeof command !== 'string' || !command) return null;
  const shellSegments = command.split(/&&|\|\||[;|\n]/);
  return shellSegments.find(isGenuineCommitSegment) || null;
}

/** `/c/Users/...` (MSYS / Git-Bash form, the live MODE 1 repro used it) → `C:/Users/...` on
 *  Windows; unchanged elsewhere. Keeps resolve() from mangling it into <cwd-drive>:\c\Users. */
export function msysToWindowsPath(rawPath) {
  if (process.platform !== 'win32') return rawPath;
  const msysDriveMatch = /^\/([a-zA-Z])(\/.*)?$/.exec(rawPath || '');
  return msysDriveMatch ? `${msysDriveMatch[1].toUpperCase()}:${msysDriveMatch[2] || '/'}` : rawPath;
}

/** The repo path named by `git -C <path>` in the commit segment, or null when -C is absent. */
export function repoPathOf(commitSegment) {
  const dashCMatch = /(?:^|\s)-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(commitSegment || '');
  if (!dashCMatch) return null;
  return dashCMatch[1] || dashCMatch[2] || dashCMatch[3] || null;
}

/**
 * True when the path sits under a git LINKED-WORKTREE home (either separator, case-insensitive).
 * Recognizes ALL THREE dot-prefixed conventions repos use for linked worktrees:
 *   - `.claude/worktrees/` (the ledger convention),
 *   - `.worktrees/`        (the ~/.claude repo + others),
 *   - `.claude-worktrees/` (the ~/.claude repo + others).
 * Linked worktrees rebase cleanly, so the stale-primary-checkout bug this guard exists for cannot
 * happen in them — they are always skipped. Anchored on the DOT-PREFIXED forms so a real primary
 * checkout in a normal project directory literally named `worktrees` (no dot prefix) is NOT skipped
 * (2026-07-07 false-positive: the `.worktrees/`-only-blind skip bit two agents + the orchestrator,
 * forcing PHANTOM_DELETE_OK=1 overrides on legit commits from `.worktrees/`/`.claude-worktrees/`).
 */
export const isUnderLinkedWorktree = (candidatePath) =>
  /[\\/](?:\.claude[\\/]worktrees|\.worktrees|\.claude-worktrees)(?:[\\/]|$)/i.test(candidatePath || '');

/** Does this commit sweep unstaged tracked changes in (`-a`, `-am`, `--all`)? Quoted spans are
 *  masked first so a commit MESSAGE mentioning `--all` doesn't count (same quoted-prose trap as
 *  the genuine-invocation fix, 2026-07-04). */
export const stagesWholeTree = (commitSegment) =>
  /(?:^|\s)--all\b/.test(maskQuotedSpans(commitSegment)) ||
  /(?:^|\s)-(?!-)[a-z]*a[a-z]*\b/i.test(maskQuotedSpans(commitSegment));

/**
 * The directory the commit segment actually runs in, BEFORE any `git -C` is applied: the LAST
 * `cd <path>` chain segment preceding the commit (relative paths resolve against the session cwd),
 * or the session cwd when no cd precedes it. Mirrors no-commit-to-main.mjs's mid-chain-cd fix
 * (9992c33): judging event.cwd while the command cd's into a linked worktree audits the WRONG
 * repo — that false-blocked a salvage agent 3 ways on 2026-07-04.
 */
export function effectiveCwdOf(command, commitSegment, sessionCwd) {
  const commitIndex = command.indexOf(commitSegment);
  const beforeCommit = commitIndex <= 0 ? '' : command.slice(0, commitIndex);
  const cdMatches = [...beforeCommit.matchAll(/(?:^|&&|\|\||;|\n)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/g)];
  if (!cdMatches.length) return sessionCwd;
  const lastCd = cdMatches[cdMatches.length - 1];
  const cdTarget = msysToWindowsPath(lastCd[1] || lastCd[2] || lastCd[3]);
  try {
    return isAbsolute(cdTarget) ? cdTarget : resolve(sessionCwd, cdTarget);
  } catch {
    return sessionCwd;
  }
}

/**
 * Does this `git add`/`git rm` segment stage the WHOLE TREE (so it sweeps in unstaged changes to
 * files OTHER than the ones it names)? True for the tree-wide forms — `-A`, `--all`, `-u`,
 * `--update`, a bare `.` / `*` pathspec, or a directory pathspec (ends in `/`). FALSE for an
 * explicit-file add (`git add my-doc.md`, `git add a.md b.md`), which stages ONLY the files it
 * names and leaves every other unstaged worktree change out of the commit.
 *
 * THE FALSE POSITIVE this distinction fixes (reproduced twice, 2026-07-06): `git add <one-file> &&
 * git commit` was blocked because the working tree also held UNRELATED unstaged changes (a
 * pre-existing HANDOFF.md edit, a runs/.tmp_msg.txt deletion) the session never touched. Treating a
 * targeted add as a whole-tree sweep counted those loose changes as in-play — but they were never
 * staged, so they were never in the commit. A path token counts as "explicit file" unless it is a
 * whole-tree selector; when in doubt (a bare word that could be a directory) we only sweep for the
 * unambiguous tree-wide forms, so a stale `git add -A`/`git add .` disaster still blocks.
 */
export function stagesWholeTreeAdd(addSegment) {
  const masked = maskQuotedSpans(addSegment);
  // `git add -A` / `--all` / `-u` / `--update`, or `-A`/`-u` bundled in a short-flag cluster.
  if (/(?:^|\s)(?:--all|--update)\b/.test(masked)) return true;
  if (/(?:^|\s)-(?!-)[A-Za-z]*[Au][A-Za-z]*\b/.test(masked)) return true;
  // A bare `.` / `*` / `:/` pathspec sweeps the WHOLE tree. A DIRECTORY pathspec (`app/`) does NOT — it stages
  // only files UNDER that directory, so it is a SCOPED add (pendingAddPathspecs handles it), never a whole-tree
  // sweep. Treating a directory as whole-tree was the 2026-07-15 false positive: `git add app/ file` was blocked
  // on an unrelated worktree modification to a file OUTSIDE app/ that the add would never stage.
  const argsAfterSubcommand = masked.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*[\\/])?git(?:\.exe)?\s+/i, '');
  for (const token of argsAfterSubcommand.trim().split(/\s+/)) {
    if (!token || token === 'add' || token === 'rm' || token.startsWith('-')) continue;
    if (token === '.' || token === '*' || token === ':/') return true;
  }
  return false;
}

/**
 * Will unstaged worktree changes to files the commit doesn't explicitly stage be part of it? Yes
 * when the commit itself takes `-a`/`--all`, or when an earlier chain segment stages the WHOLE TREE
 * (`git add -A` / `git add .` / `git rm -r <dir>` — at hook time those haven't run yet, so their
 * targets still read as unstaged in porcelain). An explicit-file `git add foo.md` stages only the
 * files it names, so it does NOT flip this on — the staged-index scan already covers those files.
 */
export function sweepsUnstagedChanges(command, commitSegment) {
  if (stagesWholeTree(commitSegment)) return true;
  const commitIndex = command.indexOf(commitSegment);
  const beforeCommit = commitIndex <= 0 ? '' : command.slice(0, commitIndex);
  const addSegments = beforeCommit.split(/&&|\|\||[;|\n]/);
  return addSegments.some((segment) =>
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*[\\/])?git(?:\.exe)?\s+[^\n]*\b(?:add|rm)\b/.test(maskQuotedSpans(segment))
    && stagesWholeTreeAdd(segment));
}

/**
 * What worktree changes will the pending `git add`/commit put in play, and scoped to WHICH paths? Returns
 * `{ wholeTree, pathspecs }`:
 *   - `wholeTree: true` when the commit takes `-a`/`--all`, or an add segment is a whole-tree selector
 *     (`-A`/`--all`/`-u`/`--update`/bare `.`/`*`/`:/`) — every worktree change is in play (the disaster case).
 *   - otherwise `pathspecs` is the explicit list of files/dirs the `git add`/`git rm` segments name; ONLY worktree
 *     changes UNDER one of those pathspecs are in play. `git add app/ file.md` stages files under app/ + file.md,
 *     never an unrelated worktree change elsewhere — that whole-tree over-inclusion was the 2026-07-15 false
 *     positive (a `git add <dir> <file>` commit blocked on an unstaged additive edit to a file OUTSIDE the dir).
 * A plain `git commit` with no add and no `-a` yields `{ wholeTree:false, pathspecs:[] }` — nothing swept in.
 */
export function pendingAddPathspecs(command, commitSegment) {
  if (stagesWholeTree(commitSegment)) return { wholeTree: true, pathspecs: [] };
  const commitIndex = command.indexOf(commitSegment);
  const beforeCommit = commitIndex <= 0 ? '' : command.slice(0, commitIndex);
  const pathspecs = [];
  let wholeTree = false;
  for (const segment of beforeCommit.split(/&&|\|\||[;|\n]/)) {
    if (!/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*[\\/])?git(?:\.exe)?\s+[^\n]*\b(?:add|rm)\b/.test(maskQuotedSpans(segment))) continue;
    if (stagesWholeTreeAdd(segment)) { wholeTree = true; continue; }
    // Explicit pathspecs: every non-flag token after the add/rm subcommand (quotes respected for spaced paths).
    let seenSubcommand = false;
    for (const quotedOrBareMatch of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
      const token = quotedOrBareMatch[1] ?? quotedOrBareMatch[2] ?? quotedOrBareMatch[3];
      if (!token) continue;
      if (!seenSubcommand) { if (token === 'add' || token === 'rm') seenSubcommand = true; continue; }
      if (token.startsWith('-')) continue; // flags (--force, -f, --chmod=…) are not pathspecs
      pathspecs.push(token.replace(/[\\/]+$/, ''));
    }
  }
  return { wholeTree, pathspecs };
}

// ── porcelain anatomy ───────────────────────────────────────────────────────────────────────────

/**
 * Repo-relative paths the attempted commit puts in play, parsed from `git status --porcelain` and
 * split by kind. Staged changes (index column) always count; unstaged ones (worktree column) only
 * when `includeUnstaged` says the command will sweep them in — a plain `git commit` with an empty
 * staged diff puts NOTHING in play. Renames/copies take the arrow's right side; untracked/added
 * files are additions, not phantoms, and are ignored.
 */
/** True when a repo-relative porcelain path is covered by one of the pending-add pathspecs (the exact file, or
 *  anything inside a named directory). Slash-normalized so Windows backslashes match forward-slash pathspecs. */
function pathUnderScope(changedPath, scopeList) {
  const normalizedPath = changedPath.replace(/\\/g, '/');
  return scopeList.some((pathspec) => {
    const normalizedSpec = pathspec.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalizedPath === normalizedSpec || normalizedPath.startsWith(normalizedSpec + '/');
  });
}

export function changedPathsOf(porcelainText, { unstagedScope } = {}) {
  const includeAllUnstaged = unstagedScope === 'all';
  const scopeList = Array.isArray(unstagedScope) ? unstagedScope : [];
  const deletionPaths = [];
  const modificationPaths = [];
  for (const statusLine of (porcelainText || '').split('\n')) {
    if (statusLine.length < 4) continue;
    const indexStatus = statusLine[0];
    const worktreeStatus = statusLine[1];
    let changedPath = statusLine.slice(3);
    if (changedPath.includes(' -> ')) changedPath = changedPath.split(' -> ').pop();
    changedPath = changedPath.replace(/^"|"$/g, '');
    if (!changedPath) continue;
    // Staged (index column) changes are ALWAYS in play. Unstaged (worktree column) changes count only when the
    // pending add sweeps them in: a whole-tree add ('all'), or an explicit pathspec that covers THIS path. A
    // worktree change the commit won't stage (outside the scope) is not in play and must not block.
    const unstagedInPlay = includeAllUnstaged || pathUnderScope(changedPath, scopeList);
    const isDeletion = indexStatus === 'D' || (unstagedInPlay && worktreeStatus === 'D');
    const isModification = indexStatus === 'M' || (unstagedInPlay && worktreeStatus === 'M');
    if (!isDeletion && !isModification) continue;
    (isDeletion ? deletionPaths : modificationPaths).push(changedPath);
  }
  return { deletions: [...new Set(deletionPaths)], modifications: [...new Set(modificationPaths)] };
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
        // An explicit deletion command (rm/git rm/del/Remove-Item) is this session's own
        // intentional work on that path too — not just writes count as "touched."
        for (const deleteMatch of shellCommand.matchAll(/(?:^|[&;|]|\s)(?:rm|git\s+rm|del|Remove-Item)\s+(?:-{1,2}[A-Za-z-]+\s+)*"?([^\s"|;&]+)"?/gi)) {
          const deletedTarget = deleteMatch[1];
          if (!deletedTarget || deletedTarget.startsWith('-')) continue;
          try { touchedPaths.add(resolve(deletedTarget).toLowerCase()); } catch { /* unresolvable — skip */ }
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

/**
 * Of `candidatePaths`, the ones tracked in the repo's HEAD tree. A deletion can only revert landed
 * work if THIS repo's own HEAD tracks the path — a file HEAD never contained (added-then-deleted,
 * or tracked only on main/another branch) cannot be deleted by this commit. No HEAD yet or a
 * failing ls-tree yields [] — a path we cannot prove tracked is never accused.
 */
function headTrackedPaths(repoDirectory, candidatePaths) {
  if (!candidatePaths.length) return [];
  const lsTreeText = gitOutputOrNull(repoDirectory, 'ls-tree', '--name-only', 'HEAD', '--', ...candidatePaths);
  if (lsTreeText === null) return [];
  const trackedSet = new Set(lsTreeText.split('\n').map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean));
  return candidatePaths.filter((candidatePath) => trackedSet.has(candidatePath));
}

/**
 * Batched blob-hash lookup: for each of `commitShas`, the blob hash of `repoRelativePath` at that
 * commit, if it exists there. ONE `git cat-file --batch-check` call resolves the whole list — avoids
 * spawning a subprocess per (commit, path) pair, which would be too slow in a PreToolUse hook for a
 * file with a long history (HANDOFF.md changes almost every session).
 */
function blobHashesAt(repoDirectory, commitShas, repoRelativePath) {
  if (!commitShas.length) return new Map();
  const batchCheckInput = commitShas.map((sha) => `${sha}:${repoRelativePath}`).join('\n') + '\n';
  let batchCheckResult;
  try {
    batchCheckResult = spawnSync('git', ['-C', repoDirectory, 'cat-file', '--batch-check=%(objectname)'], { input: batchCheckInput, encoding: 'utf8' });
  } catch {
    return new Map();
  }
  if (!batchCheckResult || batchCheckResult.error || batchCheckResult.status !== 0) return new Map();
  const batchCheckLines = (batchCheckResult.stdout || '').split('\n');
  const blobHashBySha = new Map();
  commitShas.forEach((sha, index) => {
    const line = (batchCheckLines[index] || '').trim();
    if (/^[0-9a-f]{40}$/i.test(line)) blobHashBySha.set(sha, line);
  });
  return blobHashBySha;
}

/** Commits reachable from HEAD that touched `repoRelativePath`, newest first, capped for performance
 *  — proving "existed at SOME point" only needs a generous cap, not full history. */
function commitsTouchingPath(repoDirectory, repoRelativePath, cap = 200) {
  const logText = gitOutputOrNull(repoDirectory, 'log', '-n', String(cap), '--format=%H', 'HEAD', '--', repoRelativePath);
  if (logText === null) return [];
  return logText.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Blob hash of `repoRelativePath` as it sits in the INDEX right now (a prior `git add` already
 *  ran), or null if the index has no entry for it. */
function stagedBlobHash(repoDirectory, repoRelativePath) {
  const revParseOutput = gitOutputOrNull(repoDirectory, 'rev-parse', `:${repoRelativePath}`);
  if (revParseOutput === null) return null;
  const blobHash = revParseOutput.trim();
  return /^[0-9a-f]{40}$/i.test(blobHash) ? blobHash : null;
}

/** Blob hash of `repoRelativePath`'s CURRENT WORKING-TREE file, or null if it doesn't exist on disk. */
function workingTreeBlobHash(repoDirectory, repoRelativePath) {
  const hashObjectOutput = gitOutputOrNull(repoDirectory, 'hash-object', '--', repoRelativePath);
  if (hashObjectOutput === null) return null;
  const blobHash = hashObjectOutput.trim();
  return /^[0-9a-f]{40}$/i.test(blobHash) ? blobHash : null;
}

/**
 * THE CORE FIX (2026-07-16): does this MODIFIED path's current content (staged if already `git
 * add`-ed, else the working-tree file) exactly match its OWN content at some ANCESTOR commit of
 * HEAD? If so, committing it reverts that path to old, already-recorded content — the actual
 * signature of the stale-checkout bug. If the content matches nothing in the path's own history, it
 * cannot be a revert — it is necessarily NOVEL, and must never block regardless of session
 * provenance. Returns the matching ancestor sha, or null when the content is novel.
 */
export function historicalMatchCommit(repoDirectory, repoRelativePath) {
  // Working-tree content wins: for a MODIFIED (still-present-on-disk) path, disk is what `-a`/a
  // fresh `git add` will actually capture. The index can otherwise still hold an UNCHANGED blob
  // (identical to HEAD) at the moment this hook runs, before the pending add/`-a` has executed —
  // checking that stale index entry first would trivially "match" HEAD and miss novel disk content
  // entirely (the bug this ordering fixes, 2026-07-16). Only fall back to the index when the file is
  // gone from disk (already staged-but-since-deleted outside a normal `git rm`, an edge case).
  const currentBlobHash = workingTreeBlobHash(repoDirectory, repoRelativePath) || stagedBlobHash(repoDirectory, repoRelativePath);
  if (!currentBlobHash) return null;
  const candidateCommits = commitsTouchingPath(repoDirectory, repoRelativePath);
  const blobHashBySha = blobHashesAt(repoDirectory, candidateCommits, repoRelativePath);
  for (const sha of candidateCommits) {
    if (blobHashBySha.get(sha) === currentBlobHash) return sha;
  }
  return null;
}

/** Is `repoRelativePath` absent from `commitSha`'s tree? Used to corroborate a co-occurring
 *  DELETION against the same stale sync-point a historically-matched MODIFICATION already pinned
 *  down — if that commit also lacked the deleted path, the checkout being frozen there explains
 *  the deletion too, not just the modification. */
function pathAbsentAt(repoDirectory, commitSha, repoRelativePath) {
  const blobHashBySha = blobHashesAt(repoDirectory, [commitSha], repoRelativePath);
  return !blobHashBySha.has(commitSha);
}

/**
 * Parse `git diff [--cached] --numstat` into `{ purelyAdditive, largeDeletions }`. A purely-additive path
 * (deleted == 0, added > 0) is an APPEND — it can never revert landed work, so it is never a phantom. A large
 * deletion (deleted >= threshold) is the git-add-sweep hazard. Binary files (`-`/`-` counts) are neither.
 */
export function parseNumstat(numstatText, largeDeletionThreshold) {
  const purelyAdditive = [];
  const largeDeletions = [];
  for (const numstatLine of (numstatText || '').split('\n')) {
    const parts = numstatLine.split('\t');
    if (parts.length < 3) continue;
    const added = parseInt(parts[0], 10);
    const deleted = parseInt(parts[1], 10);
    const filePath = parts.slice(2).join('\t').replace(/^"|"$/g, '');
    if (Number.isFinite(added) && Number.isFinite(deleted) && deleted === 0 && added > 0) purelyAdditive.push(filePath);
    if (Number.isFinite(deleted) && deleted >= largeDeletionThreshold) largeDeletions.push(filePath);
  }
  return { purelyAdditive, largeDeletions };
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

  // Repo in play: `git -C <path>` wins; else the last `cd <path>` before the commit; else the
  // tool call's cwd. A relative -C resolves against wherever the cd chain has landed.
  const workingDirectory = event.cwd || process.cwd();
  let repoDirectory;
  try {
    const effectiveCwd = effectiveCwdOf(command, commitSegment, workingDirectory);
    const namedRepoPath = msysToWindowsPath(repoPathOf(commitSegment));
    repoDirectory = namedRepoPath
      ? (isAbsolute(namedRepoPath) ? namedRepoPath : resolve(effectiveCwd, namedRepoPath))
      : resolve(effectiveCwd);
  } catch {
    process.exit(0); return;
  }

  // Linked worktrees (.claude/worktrees/, .worktrees/, .claude-worktrees/) rebase cleanly — the
  // stale-tree bug is primary-checkout-only.
  if (isUnderLinkedWorktree(repoDirectory)) { process.exit(0); return; }

  // No transcript → no provenance evidence → cannot accuse. Fail open.
  let sessionEntries = [];
  try { sessionEntries = readTranscript(event.transcript_path); } catch { sessionEntries = []; }
  if (!sessionEntries.length) { process.exit(0); return; }

  const porcelainText = gitOutputOrNull(repoDirectory, 'status', '--porcelain');
  if (porcelainText === null) { process.exit(0); return; } // missing git or non-repo — fail open

  let headTrackedDeletionPaths;
  let modificationPaths;
  try {
    // Scope the unstaged worktree changes to what the pending `git add` will actually stage: a whole-tree add
    // ('all') sweeps everything; an explicit-path add scopes to its named files/dirs; a plain commit sweeps
    // nothing. A worktree change the commit won't stage must never count as a phantom (2026-07-15 fix).
    const { wholeTree, pathspecs } = pendingAddPathspecs(command, commitSegment);
    const { deletions, modifications } = changedPathsOf(porcelainText, {
      unstagedScope: wholeTree ? 'all' : pathspecs,
    });
    // Deletions must additionally be tracked in THIS repo's own HEAD — a commit cannot delete a
    // path its HEAD never contained (added-then-deleted, or landed only on another branch/main).
    headTrackedDeletionPaths = headTrackedPaths(repoDirectory, deletions);
    modificationPaths = modifications;
  } catch {
    process.exit(0); return;
  }
  const inPlayPaths = [...headTrackedDeletionPaths, ...modificationPaths];
  if (!inPlayPaths.length) { process.exit(0); return; }

  const repoRootText = gitOutputOrNull(repoDirectory, 'rev-parse', '--show-toplevel');
  if (repoRootText === null) { process.exit(0); return; }
  const repoRoot = repoRootText.trim();
  if (isUnderLinkedWorktree(repoRoot)) { process.exit(0); return; }

  // ── LARGE DELETION CHECK (2026-07-05: git add sweep incident) ──────────────────────────────
  // A `git add <dir>` can sweep in files with massive content loss that were modified by a prior
  // session but never committed. The commit then silently deletes 1000+ lines from core docs.
  // Check staged files for large deletions regardless of the porcelain path check above — this
  // catches the case where files are ALREADY staged (by a prior git add) before the commit runs.
  const LARGE_DELETION_THRESHOLD = 50; // lines
  // Purely-additive paths (0 deleted lines) are appends — never a revert — and are exempt from the phantom check;
  // large deletions (>=50 lines) are the git-add-sweep hazard. Read BOTH the staged (--cached) and unstaged
  // (worktree) numstat: a `git add <dir>` in the SAME command hasn't run at hook time, so a file it will sweep in
  // is still UNSTAGED and only shows in the worktree numstat (2026-07-15). Large-deletion detection stays on the
  // staged set — an unstaged large deletion under a scoped add is already caught as an in-play deletion above.
  const stagedNumstat = parseNumstat(gitOutputOrNull(repoDirectory, 'diff', '--cached', '--numstat'), LARGE_DELETION_THRESHOLD);
  const worktreeNumstat = parseNumstat(gitOutputOrNull(repoDirectory, 'diff', '--numstat'), LARGE_DELETION_THRESHOLD);
  const purelyAdditivePaths = new Set([...stagedNumstat.purelyAdditive, ...worktreeNumstat.purelyAdditive]);
  const largeDeletionPaths = stagedNumstat.largeDeletions;

  let phantomPaths;
  try {
    const touchedPaths = sessionTouchedPaths(sessionEntries);
    const isUntouched = (repoRelativePath) => {
      try {
        return !touchedPaths.has(resolve(repoRoot, repoRelativePath).toLowerCase());
      } catch {
        return false; // unresolvable path — don't accuse what we can't identify
      }
    };

    // ── MODIFICATIONS: phantom only when untouched by session AND the current content is a REVERT
    // to some ancestor commit's already-recorded blob (2026-07-16 fix). Content that matches
    // NOTHING in the path's own history cannot be reverting anyone's landed work — it is novel —
    // and must never block, regardless of session provenance. This is what makes committing
    // legitimate PRIOR-SESSION WIP (read HANDOFF.md, continue, commit) safe: inherited edits are
    // real new content, never a match against history.
    const untouchedModifications = modificationPaths.filter(
      (repoRelativePath) => isUntouched(repoRelativePath) && !purelyAdditivePaths.has(repoRelativePath));
    const modificationSyncPoints = new Map(); // path -> matching ancestor sha, for deletion corroboration below
    const phantomModifications = untouchedModifications.filter((repoRelativePath) => {
      const matchingAncestorSha = historicalMatchCommit(repoDirectory, repoRelativePath);
      if (matchingAncestorSha) modificationSyncPoints.set(repoRelativePath, matchingAncestorSha);
      return Boolean(matchingAncestorSha);
    });

    // ── DELETIONS: phantom when untouched by session — UNLESS a co-occurring phantom modification
    // already pinned down a specific stale sync-point commit, AND that same commit ALSO lacks this
    // path (corroboration: "the checkout is frozen before this file existed too," not just before
    // the modified file's current content). With no corroborating modification, keep the
    // conservative fallback (block) — a pure-deletion commit gives no independent evidence the
    // checkout is merely stale rather than an intentional removal.
    const phantomDeletions = headTrackedDeletionPaths.filter((repoRelativePath) => {
      if (!isUntouched(repoRelativePath)) return false;
      for (const syncPointSha of modificationSyncPoints.values()) {
        if (pathAbsentAt(repoDirectory, syncPointSha, repoRelativePath)) return false; // corroborated staleness
      }
      return true;
    });

    phantomPaths = [...phantomDeletions, ...phantomModifications];

    // Large-deletion sweep check (2026-07-05 incident): the SAME historical-match requirement now
    // applies — an untouched large deletion is only phantom when it's a revert to old recorded
    // content, not a genuine (if large) rewrite that happens to be untouched by this session.
    for (const largePath of largeDeletionPaths) {
      if (phantomPaths.includes(largePath) || !isUntouched(largePath)) continue;
      if (historicalMatchCommit(repoDirectory, largePath)) phantomPaths.push(largePath);
    }
  } catch {
    process.exit(0); return;
  }
  if (!phantomPaths.length) { process.exit(0); return; }

  const reason = [
    'BLOCKED — this commit would bake in PHANTOM deletions/modifications: a REVERT to content this',
    'repo already recorded, on paths this session never touched.',
    '',
    'This checkout\'s working tree looks STALE: a sibling agent\'s landing likely moved this branch\'s ref',
    'underneath it, so the just-landed files now read as deleted or reverted here. Committing them from a',
    'primary checkout silently DESTROYS the landed work (this exact bug reverted landings 4x on 2026-07-03,',
    'including a 141-line Truth-ledger rewrite).',
    '',
    'OR: a `git add <dir>` swept in files with large content loss (>50 lines deleted) from a prior',
    'session\'s uncommitted WIP (2026-07-05 incident: git add plans/ swept in RESULTS.md, METHODS.md,',
    'Truth-ledger.md with 1000+ line deletions each — silently destroying core docs).',
    '',
    '(2026-07-16: committing genuinely NEW content this session inherited from a PRIOR session\'s WIP',
    'is fine and does NOT trip this — only a path whose content exactly matches an OLDER commit blocks.)',
    '',
    'Phantom paths (revert to already-recorded content, never created or edited by this session):',
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
