#!/usr/bin/env node
/**
 * PreToolUse hook — block a destructive shell command (delete or rename-away) that targets a
 * file the assistant did NOT create this session, pending explicit confirmation.
 *
 * THE INCIDENT (2026-07-03): Russell manually renamed a load-bearing doc
 * (LEDGER-SOURCE-OF-TRUTH.md -> Truth-ledger.md). The assistant found the "stray" old-named file,
 * judged it a glitch because the content was byte-identical to the new file, and `rm`'d it —
 * destroying Russell's intentional rename. The missing reflex: a destructive op on a file the
 * assistant did not create is NOT safe to auto-resolve just because it "looks redundant." It might
 * be the user's in-progress work.
 *
 * Scope: rm/rmdir (Unix), del/Remove-Item/rd (Windows), `mv`/Move-Item that renames a file AWAY
 * (source stops existing under its old name) or clobbers an existing destination, `git rm`,
 * `git clean` (see dangerous-bash-guard for the -f gate — this hook only cares about named targets
 * `git clean <path>`), `git checkout -- <path>` / `git restore <path>` (discards tracked edits).
 * `>` truncation is explicitly OUT of scope (too noisy — dangerous-bash-guard and normal git diff
 * review already catch most truncation accidents).
 *
 * BLOCK when the target (a) exists on disk, AND (b) was not created/written by the assistant this
 * session (checked against the session transcript's Write/Edit/MultiEdit/Bash-heredoc history, OR
 * the file's mtime falling after session start — see below), AND (c) isn't an obvious
 * scratch/derived artifact (SCRATCH_PATH_PATTERNS below).
 *
 * FALSE POSITIVE FIXED (2026-07-03, same day as the original ship): the transcript check alone
 * only sees files the assistant created via the Write/Edit/MultiEdit tools or a shell heredoc/
 * redirect. A background subprocess pool the assistant spawned (e.g. a python training pool
 * writing diag_*.jsonl/.log/.json run outputs) creates files that NEVER appear as a tool call in
 * the transcript — the assistant only ever sees them as directory listings. The live incident: the
 * assistant `mv`'d its own ~90-minutes-earlier training-run output files into a quarantine folder;
 * the hook blocked because the transcript had no Write/Edit for them, and — critically — the mtime
 * fallback was WIRED TO ONLY RUN WHEN NO TRANSCRIPT EXISTS AT ALL. Since a transcript DID exist
 * (just an incomplete one for this file), the mtime check never ran and the hook false-positived.
 * Fix: mtime-after-session-start is now checked as an ADDITIONAL, independent path to "created this
 * session" whenever a transcript exists but doesn't otherwise account for the file — not just as a
 * total fallback for a missing transcript. Session start, when a transcript is present, is taken as
 * the timestamp of the transcript's first entry (a much better anchor than process-uptime, which
 * only describes the hook's OWN short-lived process, not the actual session).
 *
 * Escape hatches: put USER_DELETE_OK anywhere in the command (after Russell has explicitly said
 * yes to the delete), or DELETE_AUDIT_OVERRIDE=1 in the environment.
 *
 * Fail-open: any parse error, missing transcript, or unexpected shape → exit 0 (never brick a
 * normal delete). This hook trades a few false negatives for zero false bricks.
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, roleOf, toolUsesOf } from './lib/transcript.mjs';

// ── obvious scratch / derived artifacts — never worth an audit prompt ──────────────────────────
const SCRATCH_PATH_PATTERNS = [
  /\.log$/i,
  /\.tmp$/i,
  /\.bak$/i,
  /\.ckpt$/i,
  /[\\/]node_modules[\\/]/i,
  /[\\/]dist[\\/]/i,
  /[\\/]__pycache__[\\/]/i,
  /[\\/]\.claude[\\/]worktrees[\\/]/i,
  /[\\/]gate1?_logs?[\\/]/i,     // gate1_logs/ and similar run-log dirs
  /[\\/]\.git[\\/]/i,            // internal git plumbing files, not user docs
];

// A path is "scratch" if it matches a pattern above OR sits under the OS temp dir.
function isScratchPath(candidatePath) {
  if (!candidatePath) return true; // nothing to audit
  const normalizedPath = candidatePath.replace(/^["']|["']$/g, '');
  if (SCRATCH_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath))) return true;
  try {
    const absolutePath = isAbsolute(normalizedPath) ? resolve(normalizedPath) : resolve(process.cwd(), normalizedPath);
    const osTempDir = resolve(tmpdir());
    if (absolutePath.toLowerCase().startsWith(osTempDir.toLowerCase())) return true;
  } catch { /* fall through — not scratch by path resolution */ }
  return false;
}

// ── extracting candidate delete/rename targets from a shell command line ──────────────────────
// Strips a leading/trailing quote off a bare token.
const unquote = (token) => (token || '').replace(/^["']|["']$/g, '');

// Splits a command's argument tail into tokens, skipping flags (leading -/--/ or Windows /x).
function argTokens(argumentTail) {
  const rawTokens = argumentTail.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return rawTokens.map(unquote).filter((token) => token && !/^-/.test(token) && !/^\/[a-z]$/i.test(token));
}

// Returns the list of file-path targets a destructive command names, or [] if this command isn't
// one of the covered destructive verbs.
function destructiveTargets(command) {
  const targets = [];

  // Unix rm / rmdir (any flags).
  let verbMatch = /\b(?:rm|rmdir)\b([^\n;|&]*)/i.exec(command);
  if (verbMatch) targets.push(...argTokens(verbMatch[1]));

  // Windows del / erase / rd (cmd.exe) — flags are /s /q /f etc.
  verbMatch = /\b(?:del|erase|rd)\b([^\n;|&]*)/i.exec(command);
  if (verbMatch) targets.push(...argTokens(verbMatch[1]));

  // PowerShell Remove-Item (and ri alias).
  verbMatch = /\b(?:Remove-Item|ri)\b([^\n;|&]*)/i.exec(command);
  if (verbMatch) targets.push(...argTokens(verbMatch[1]).filter((token) => !/^\$/.test(token)));

  // mv / Move-Item — the SOURCE is the thing being renamed away; that's the audit target (the old
  // name stops existing). The destination only matters if it already exists (a clobber), which is
  // checked by the caller via existsSync on each returned target.
  verbMatch = /\b(?:mv|Move-Item)\b([^\n;|&]*)/i.exec(command);
  if (verbMatch) {
    const moveTokens = argTokens(verbMatch[1]).filter((token) => !/^-/.test(token));
    // First non-flag token is the source; include the destination too (clobber case handled by
    // existence + "not created this session" check downstream — a brand-new destination the
    // assistant is about to create is not yet on disk, so it naturally won't trip the guard).
    if (moveTokens.length) targets.push(moveTokens[0]);
    if (moveTokens.length > 1) targets.push(moveTokens[moveTokens.length - 1]);
  }

  // git rm <path>
  verbMatch = /\bgit\s+rm\b([^\n;|&]*)/i.exec(command);
  if (verbMatch) targets.push(...argTokens(verbMatch[1]));

  // git clean with an explicit path argument (not a bare `git clean -fdx`, which dangerous-bash-guard owns).
  verbMatch = /\bgit\s+clean\b([^\n;|&]*)/i.exec(command);
  if (verbMatch) {
    const cleanTokens = argTokens(verbMatch[1]);
    targets.push(...cleanTokens.filter((token) => token !== '.'));
  }

  // git checkout -- <path> / git restore <path> — discards tracked working-tree edits.
  verbMatch = /\bgit\s+checkout\s+--\s+([^\n;|&]*)/i.exec(command);
  if (verbMatch) targets.push(...argTokens(verbMatch[1]));
  verbMatch = /\bgit\s+restore\b(?!\s+--staged\b)([^\n;|&]*)/i.exec(command);
  if (verbMatch) targets.push(...argTokens(verbMatch[1]));

  return [...new Set(targets)].filter(Boolean);
}

// Never-block verbs that superficially look destructive but aren't file-content-destroying.
const isBenignGitBranchDelete = (command) => /\bgit\s+branch\s+(?:-d|-D|--delete)\b/i.test(command);

// ── session-provenance check: did the assistant CREATE this path during this session? ─────────
const editedPathOf = (toolUse) => toolUse.input?.file_path || toolUse.input?.path || '';

// Basenames/paths the assistant wrote/edited (Write, Edit, MultiEdit) OR created via a heredoc/
// redirect in a Bash/PowerShell command, anywhere in the session transcript.
export function sessionCreatedPaths(sessionEntries) {
  const createdPaths = new Set();
  for (const entry of sessionEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const toolUse of toolUsesOf(entry)) {
      const toolName = toolUse.name || '';
      if (toolName === 'Write') {
        const writtenPath = editedPathOf(toolUse);
        if (writtenPath) createdPaths.add(resolve(writtenPath).toLowerCase());
      }
      if (toolName === 'Bash' || toolName === 'PowerShell') {
        const shellCommand = toolUse.input?.command || '';
        // `> path` / `New-Item path` / `Out-File path` style creation inside a shell command.
        for (const redirectMatch of shellCommand.matchAll(/(?:^|\s)>{1,2}\s*"?([^\s"|;&]+)"?/g)) {
          try { createdPaths.add(resolve(redirectMatch[1]).toLowerCase()); } catch { /* ignore */ }
        }
      }
    }
  }
  return createdPaths;
}

// Was `targetPath` created (Write) or edited (Edit/MultiEdit, implying it already existed and the
// assistant is actively working on it this session) by the assistant this session?
export function wasCreatedThisSession(targetPath, sessionEntries) {
  let absoluteTargetPath;
  try { absoluteTargetPath = resolve(targetPath).toLowerCase(); } catch { return false; }
  const createdPaths = sessionCreatedPaths(sessionEntries);
  if (createdPaths.has(absoluteTargetPath)) return true;
  // Edit/MultiEdit on this exact path also counts as "assistant is actively steering this file" —
  // deleting/renaming a file mid-edit by the assistant's own hand this session is not the blind
  // spot this hook targets.
  for (const entry of sessionEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const toolUse of toolUsesOf(entry)) {
      if (!['Edit', 'MultiEdit'].includes(toolUse.name || '')) continue;
      const editedPath = editedPathOf(toolUse);
      if (!editedPath) continue;
      try { if (resolve(editedPath).toLowerCase() === absoluteTargetPath) return true; } catch { /* ignore */ }
    }
  }
  return false;
}

// Evidence path #2: a file whose mtime falls AFTER session start is proof it was created or
// rewritten DURING this session by SOMETHING the assistant was running — even if that something
// was a background subprocess (a spawned training pool, a build watcher, etc.) whose file writes
// never surface as a Write/Edit tool_use in the transcript. This is independent of, and additional
// to, the transcript-based check — it is NOT a "no transcript available" fallback, because the
// blind spot it covers (background-process file creation) exists just as much when a transcript IS
// present as when it's absent.
function newerThanSessionStart(targetPath, sessionStartMs) {
  if (typeof sessionStartMs !== 'number') return false;
  try {
    const fileStats = statSync(targetPath);
    return fileStats.mtimeMs > sessionStartMs;
  } catch { return false; }
}

// Best session-start anchor available: the timestamp of the transcript's first entry (covers the
// whole session, not just this hook's own short-lived process). Falls back to process-uptime-based
// "when did this node process start" only when the transcript has no usable timestamp — that
// fallback describes the HOOK's lifetime, not the session's, so it under-covers on purpose (a
// narrower window is safe: it only makes the mtime check MORE conservative, never less).
function resolveSessionStartMs(sessionEntries) {
  for (const entry of sessionEntries || []) {
    const entryTimestamp = entry?.timestamp;
    if (!entryTimestamp) continue;
    const parsedMs = Date.parse(entryTimestamp);
    if (!Number.isNaN(parsedMs)) return parsedMs;
  }
  return Date.now() - process.uptime() * 1000;
}

// Pure classifier: should this target BLOCK the command? Exported for direct unit testing.
export function shouldBlockTarget(targetPath, { sessionEntries, sessionStartMs, workingDirectory }) {
  if (isScratchPath(targetPath)) return false;
  const absoluteTargetPath = isAbsolute(targetPath) ? targetPath : resolve(workingDirectory || process.cwd(), targetPath);
  if (!existsSync(absoluteTargetPath)) return false; // nothing there to destroy
  if (isScratchPath(absoluteTargetPath)) return false;

  if (sessionEntries && sessionEntries.length) {
    if (wasCreatedThisSession(absoluteTargetPath, sessionEntries)) return false;
    // Transcript exists but has no Write/Edit record for this exact file — could genuinely be a
    // pre-session file, OR could be a file a background process the assistant spawned wrote to
    // mid-session (never visible as a tool call). mtime-after-session-start disambiguates: only a
    // file actually touched DURING this session can have a newer-than-session-start mtime.
    const effectiveSessionStartMs = typeof sessionStartMs === 'number' ? sessionStartMs : resolveSessionStartMs(sessionEntries);
    if (newerThanSessionStart(absoluteTargetPath, effectiveSessionStartMs)) return false;
    return true; // exists, not scratch, transcript says assistant never touched it, mtime predates session → block
  }
  // No transcript available — mtime heuristic is the ONLY evidence.
  if (typeof sessionStartMs === 'number') {
    if (newerThanSessionStart(absoluteTargetPath, sessionStartMs)) return false;
    return true;
  }
  // No transcript AND no session-start reference: can't prove provenance either way — fail open.
  return false;
}

function main() {
  if (process.env.DELETE_AUDIT_OVERRIDE === '1') { process.exit(0); return; }

  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0); return;
  }

  if (event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') { process.exit(0); return; }
  const command = event.tool_input?.command;
  if (typeof command !== 'string' || !command) { process.exit(0); return; }

  if (/\bUSER_DELETE_OK\b/.test(command)) { process.exit(0); return; }
  if (isBenignGitBranchDelete(command)) { process.exit(0); return; }

  let targets;
  try {
    targets = destructiveTargets(command);
  } catch {
    process.exit(0); return;
  }
  if (!targets.length) { process.exit(0); return; }

  const workingDirectory = event.cwd || process.cwd();
  let sessionEntries = [];
  try { sessionEntries = readTranscript(event.transcript_path); } catch { sessionEntries = []; }

  // Anchor session start to the transcript's own first timestamp when we have one — that's the
  // real session window. Only fall back to this hook process's own uptime (a much narrower,
  // more conservative window) when no transcript is available at all.
  const sessionStartMs = resolveSessionStartMs(sessionEntries);

  let flaggedTarget = null;
  try {
    flaggedTarget = targets.find((target) => shouldBlockTarget(target, { sessionEntries, sessionStartMs, workingDirectory }));
  } catch {
    process.exit(0); return;
  }
  if (!flaggedTarget) { process.exit(0); return; }

  const reason = [
    'BLOCKED — this file predates the session or was not created by the assistant. It may be the USER\'S work.',
    '',
    `  Target: ${flaggedTarget}`,
    `  Command: ${command.slice(0, 160)}${command.length > 160 ? '...' : ''}`,
    '',
    'A destructive op (delete/rename-away) on a file the assistant did not create this session must be',
    'confirmed before it runs — this is exactly the class of mistake that destroyed Russell\'s manual',
    'rename of LEDGER-SOURCE-OF-TRUTH.md on 2026-07-03: a "stray duplicate" turned out to be his',
    'intentional edit, and it got deleted.',
    '',
    'Before proceeding: confirm with Russell (AskUserQuestion) that this delete/rename is intended.',
    'Once he says yes, re-run the SAME command with USER_DELETE_OK added, e.g.:',
    '  USER_DELETE_OK=1 <command>   (or just include the literal token USER_DELETE_OK anywhere in it)',
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
// reads stdin (fd 0) and would hang the test. Compare by BASENAME, not full path: an exact-path
// compare is fragile on Windows (MSYS `/c/...` vs `C:\...`, file:// scheme, separator + case
// differences), which would make this guard silently never run — see learnings.md 2026-06-28.
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
