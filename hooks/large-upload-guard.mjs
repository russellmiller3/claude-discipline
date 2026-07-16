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

/**
 * The first local path in the command whose size exceeds CAP_BYTES, or null.
 * Only tokens that exist on the LOCAL disk are checked — remote host:path
 * targets and option flags don't stat locally and are skipped naturally.
 */
export function oversizeUpload(command) {
  for (const rawToken of command.split(/\s+/)) {
    const token = unquote(rawToken);
    if (!token || token.startsWith('-')) continue;
    let exists = true;
    try { statSync(token); } catch { exists = false; }
    if (!exists) continue;
    const bytes = pathSizeBytes(token);
    if (bytes > CAP_BYTES) return { path: token, bytes };
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
