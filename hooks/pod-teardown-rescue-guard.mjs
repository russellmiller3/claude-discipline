#!/usr/bin/env node
// =============================================================================
// POD-TEARDOWN-RESCUE-GUARD — rescue results BEFORE you kill the pod that holds them.
// =============================================================================
//
// new-hook-category: Benchmark / long-run discipline (pod lifecycle) — nearest existing
// is experiment-monitor-required (monitor BEFORE launch) and pod-full-run-capacity-guard
// (capacity BEFORE launch). NEITHER guards the TEARDOWN end: a raw pod delete throwing
// away results that were never pulled home.
//
// THE MISTAKE (2026-07-17): twice I killed pods with a raw `DELETE /v1/pods/{id}`,
// bypassing the rescue-gated teardown. The first kill was a run 5-25 min from its
// verdict — if any seed had already finished its on-pod race, that race JSONL was
// thrown away with the pod. A pod delete is IRREVERSIBLE: any completed result on it
// is gone forever the instant it's deleted.
//
// THE RULE: before ANY experiment-pod teardown, rescue every result that already exists.
// A raw pod DELETE is BLOCKED unless one of:
//   1. Results were pulled home first (a prior scp/rsync/sftp of a *race*.jsonl /
//      results dir / checkpoint / archive this session), OR
//   2. Explicit override: KILL_WITHOUT_RESCUE_OK: <why> in the command or reply (e.g.
//      "OOM, job died pre-output — nothing to save"), OR POD_TEARDOWN_RESCUE_OK=1 env.
//
// TEETH: PreToolUse permissionDecision 'deny'. Detection is precise (see isPodTeardown):
// fires only on an actual pod-delete verb (REST DELETE .../pods/, runpodctl remove pod,
// a launcher --delete-pod/terminate), NEVER on `finalize` (which rescues then deletes via
// the guarded path), reads, or a non-pod delete (`rm file`). FAILS OPEN. basename entry-guard.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, toolUsesOf, lastAssistantText } from './lib/transcript.mjs';

const ENV_OVERRIDE = 'POD_TEARDOWN_RESCUE_OK';
const ESCAPE_TOKEN = /\bKILL_WITHOUT_RESCUE_OK\b/;

// A pod-delete verb: a REST DELETE against .../pods/{id}; a runpodctl remove pod; a
// launcher/CLI pod-terminate. Curl's `-X DELETE` and a bare `DELETE ... /pods/` both count.
const POD_DELETE_PATTERNS = [
  /(?:-X\s*)?\bDELETE\b[\s\S]*\/pods?\//i,               // REST DELETE .../pods/{id}
  /\brunpodctl\s+(?:remove|stop|terminate)\s+pods?\b/i,  // runpodctl remove/stop/terminate pod
  /\brunpod\w*\b[\s\S]*(?:--delete-pod|--terminate-pod|\bpodTerminate\b|\bterminatePod\b)/i, // launcher/graphql terminate
  /--delete-pod\b|--terminate-pod\b/i,                   // an explicit delete-pod flag anywhere
];

// finalize rescues-then-deletes through the guarded path — never treat it as a raw teardown.
const NOT_A_TEARDOWN = /\bfinalize\b/i;
// plain reads/inspection that merely MENTION a delete verb (grep/cat a launcher file)
const READ_VERB = /^\s*(?:cat|grep|rg|less|head|tail|bat|ls|find|echo)\b/i;

// A result rescue: pulling the pod's results home before killing it. scp/rsync/sftp of a
// race JSONL, a results/archive/checkpoint dir, or any .jsonl.
const RESULT_RESCUE_RE = /\b(?:scp|rsync|sftp)\b[\s\S]*(?:race[\w-]*\.jsonl|results?|checkpoint|archive|\.jsonl)\b/i;

/** True when a Bash command pulls results home (a rescue that satisfies the guard). */
export function isResultRescue(command) {
  if (!command || typeof command !== 'string') return false;
  return RESULT_RESCUE_RE.test(command);
}

/**
 * True when a Bash command tears down (deletes/kills) an experiment pod — the
 * irreversible act that must be rescue-gated. Excludes finalize (guarded path),
 * reads, and non-pod deletes.
 */
export function isPodTeardown(command) {
  if (!command || typeof command !== 'string') return false;
  if (NOT_A_TEARDOWN.test(command)) return false;
  if (READ_VERB.test(command)) return false;
  return POD_DELETE_PATTERNS.some((pattern) => pattern.test(command));
}

// Flatten a transcript to its Bash tool-use commands, in order.
function bashCommandsInOrder(entries) {
  const commands = [];
  for (const entry of entries || []) {
    for (const block of toolUsesOf(entry)) {
      if ((block?.name || '') === 'Bash') commands.push(block?.input?.command || '');
    }
  }
  return commands;
}

const DENY_REASON = `POD TEARDOWN BLOCKED — you're about to DELETE an experiment pod but nothing was rescued first.

A pod delete is IRREVERSIBLE. Any completed result on it — a finished race JSONL, a checkpoint,
a training receipt — is gone forever the instant the pod is deleted (the exp154 near-loss,
2026-07-17: a raw DELETE of a run minutes from its verdict).

Before killing it, in order:
  1. PROBE what's on the pod: SSH + list the results dir / jobs/<seed>/ (is there a race.jsonl?).
  2. RESCUE it: scp/rsync the pod's *race*.jsonl / results dir / checkpoint home.
  3. THEN delete (or just run finalize, which rescues-then-deletes through the guarded path).

If the run genuinely has NOTHING to save (e.g. the job OOM-crashed before any output, confirmed by
a liveness/log probe), add the token to your reply or command:
  KILL_WITHOUT_RESCUE_OK: <why, e.g. "OOM pre-output, job log shows no race started">
Or set ${ENV_OVERRIDE}=1.`;

/**
 * PURE core. `entries` is the parsed transcript (array). Returns { block, mode?, reason? }.
 * Never throws on malformed input. PreToolUse only.
 */
export function evaluate({ event, command = '', entries = [], replyText = '', envOk = false } = {}) {
  if (envOk) return { block: false };
  if (ESCAPE_TOKEN.test(command || '') || ESCAPE_TOKEN.test(replyText || '')) return { block: false };
  if (event !== 'PreToolUse') return { block: false };
  if (!isPodTeardown(command)) return { block: false };

  const rescuedFirst = bashCommandsInOrder(entries).some((priorCommand) => isResultRescue(priorCommand));
  if (rescuedFirst) return { block: false };

  return { block: true, mode: 'deny', reason: DENY_REASON };
}

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') process.exit(0);
    const payload = readPayload();
    const event = payload.hook_event_name || payload.hookEventName || '';
    if (event !== 'PreToolUse') process.exit(0);
    const transcriptPath = payload.transcript_path || payload.transcriptPath || '';
    const entries = readTranscript(transcriptPath);
    const replyText = lastAssistantText(entries);
    const command = (payload.tool_input || {}).command || '';
    const verdict = evaluate({ event, command, entries, replyText });
    if (!verdict.block) process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate command
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
