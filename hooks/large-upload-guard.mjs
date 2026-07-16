#!/usr/bin/env node
// =============================================================================
// large-upload-guard — BLOCK an scp/rsync upload of a file/dir bigger than the
//                      cap, so a bloated payload fails LOUD & FREE before it
//                      crawls a paid remote link for half an hour.
// =============================================================================
//
// Russell's rule (2026-07-15): after a code deploy silently ballooned to ~590MB
// (300MB of committed CodeServo telemetry artifacts + 199MB of git history) and
// crawled a paid pod upload at 0.12 MB/s for ~30 min before anyone noticed it
// was bloat — "add a hook so this mistake is never made again globally."
//
// A code deploy is single-digit MB. Hundreds of MB over scp/rsync is almost
// always a bug (committed artifacts, full git history, a stray model/dataset).
// This catches it at the command, before the transfer starts.
//
// Fires on PreToolUse(Bash) when the command runs scp or rsync. It stats every
// token that EXISTS on the local disk (option flags and remote host:path targets
// don't stat locally, so they're skipped) and DENIES if any local file — or the
// recursive size of any local dir — exceeds CAP_BYTES.
//
// Bypass (a genuinely large, intended upload — model weights, a dataset):
//   set LARGE_UPLOAD_OK=1, or put the token LARGE_UPLOAD_OK anywhere in the command.
// The teeth: PreToolUse permissionDecision 'deny' — it blocks, it does not advise.
// =============================================================================

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAP_BYTES = 25 * 1024 * 1024; // 25 MB
const RUNS_UPLOAD = /(^|[;&|]|\s)(scp|rsync)\s/;
const OVERRIDE = /LARGE_UPLOAD_OK/;

// Directory walk is bounded so a guard never becomes the slow thing it guards.
const MAX_WALK_ENTRIES = 20000;

/** Recursive byte size of a path (file or dir), bounded; returns bytes seen. */
export function pathSizeBytes(target, budget = { entries: MAX_WALK_ENTRIES }) {
  let stats;
  try { stats = statSync(target); } catch { return 0; }
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;
  let total = 0;
  let children;
  try { children = readdirSync(target); } catch { return total; }
  for (const child of children) {
    if (budget.entries-- <= 0) break;
    total += pathSizeBytes(join(target, child), budget);
    if (total > CAP_BYTES) return total; // early-out: already over, no need to keep walking
  }
  return total;
}

/** Strip one layer of surrounding quotes from a shell token. */
function unquote(token) {
  if (token.length >= 2) {
    const first = token[0];
    if ((first === '"' || first === "'") && token[token.length - 1] === first) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/** Split a command line into shell segments (so `echo "scp"` never looks like an scp call). */
function commandSegments(command) {
  return command.split(/\|\||&&|[;&|\n]/);
}

/** Tokenize one segment into argv, dropping leading `VAR=value` env assignments. */
function segmentArgv(segment) {
  const argv = [];
  let sawCommandWord = false;
  for (const rawToken of segment.trim().split(/\s+/)) {
    if (!rawToken) continue;
    const token = unquote(rawToken);
    if (!sawCommandWord && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // env prefix
    sawCommandWord = true;
    argv.push(token);
  }
  return argv;
}

/** A scp/rsync remote endpoint `[user@]host:path` — NOT a Windows drive path (`C:/…`). */
export function isRemoteTarget(token) {
  if (/^[A-Za-z]:[\\/]/.test(token)) return false;            // C:\ or C:/ — local drive
  return /^(?:[^@\s]+@)?[^:\s/]+:/.test(token);               // host:… or user@host:…
}

/**
 * The first LOCAL SOURCE path of a real scp/rsync UPLOAD whose size exceeds
 * CAP_BYTES, or null. Direction matters: only an upload (local source -> REMOTE
 * dest) is capped. A download (remote source -> local dest) sends nothing up and
 * passes; a non-transfer command (du/tail/git) or a bare mention of "scp" in a
 * string is not an invocation and passes.
 */
export function oversizeUpload(command) {
  for (const segment of commandSegments(command)) {
    const argv = segmentArgv(segment);
    if (!argv.length) continue;
    if (argv[0] !== 'scp' && argv[0] !== 'rsync') continue;   // must be the command word
    const operands = argv.slice(1).filter((token) => !token.startsWith('-'));
    if (operands.length < 2) continue;                        // need at least source + dest
    const destination = operands[operands.length - 1];
    if (!isRemoteTarget(destination)) continue;               // local dest => download/local copy, not an upload
    for (const source of operands.slice(0, -1)) {
      if (isRemoteTarget(source)) continue;                   // remote source is not local bytes
      let exists = true;
      try { statSync(source); } catch { exists = false; }
      if (!exists) continue;                                  // flag values / missing paths
      const bytes = pathSizeBytes(source);
      if (bytes > CAP_BYTES) return { path: source, bytes };
    }
  }
  return null;
}

function denial(hit) {
  const megabytes = (hit.bytes / 1024 / 1024).toFixed(1);
  return `BLOCKED — about to upload ${megabytes}MB over scp/rsync (cap ${CAP_BYTES / 1024 / 1024}MB).

  ${hit.path}  →  ${megabytes}MB

A code/deploy payload this large is almost always a bug — committed artifacts
(telemetry dumps, result JSONL), full git history, or a stray model/dataset.
Uploading it crawls a slow/paid remote link for many minutes. Fix the payload
before it leaves your machine:
  - Exclude generated artifacts from the bundle (docs/evidence, runs, *.jsonl,
    telemetry HTML) — the remote runs SOURCE, not evidence.
  - Ship a shallow/source-only git bundle, not full history.
  - Confirm you are not shipping model weights or a dataset by accident.

If this large upload is genuinely intended (model weights, a real dataset),
bypass: set LARGE_UPLOAD_OK=1, or put LARGE_UPLOAD_OK in the command.`;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); return; }

  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') { process.exit(0); return; }
  if ((event.tool_name || '') !== 'Bash') { process.exit(0); return; }

  const command = (event.tool_input || {}).command || '';
  if (!command || !RUNS_UPLOAD.test(command)) { process.exit(0); return; }
  if (process.env.LARGE_UPLOAD_OK === '1' || OVERRIDE.test(command)) { process.exit(0); return; }

  const hit = oversizeUpload(command);
  if (!hit) { process.exit(0); return; }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial(hit),
    },
  }));
  process.exit(0);
}

// Entry-point guard (basename compare — robust on Windows/MSYS) so importing
// this for tests does not execute main() (which reads stdin and would hang).
const invoked = (process.argv[1] || '').replace(/\\/g, '/').split('/').pop();
const self = fileURLToPath(import.meta.url).replace(/\\/g, '/').split('/').pop();
if (invoked === self) main();
