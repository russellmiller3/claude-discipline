#!/usr/bin/env node
// =============================================================================
// EXPERIMENT-RUNNER-LOGGER-REREAD — UserPromptSubmit: force-surface Runner +
//   Logger's ownership the MOMENT experiment-build intent appears (FRONT door).
// =============================================================================
//
// new-hook-category: Reuse-before-build surfacing — nearest existing is check-runner-logger-before-build (same Runner/Logger concern) but that fires at WRITE time and is satisfied by a self-asserted token; it never FORCES a reread and never fires when the build is delegated to an agent (main thread skips the Write path). This is the FRONT door — surface the libs when experiment work STARTS; that one is the BACK door (deny a Write that hand-rolled plumbing).
//
// Russell 2026-07-19: "did experiment hook make you reread runner and logger so
// you dont build custom work into experiment? if not, do that." Mirrors the
// proven design-md-check pattern (force-load context/design.md on style edits):
// on experiment-build intent, INJECT the ownership rule as unavoidable context
// so the reread is real, not an honor-system token. Fires ONCE per session.
//
// Fail-open: never break the prompt flow.
// =============================================================================

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Experiment-BUILD intent (not merely mentioning an experiment). Each pattern targets a phrasing that
// precedes writing worker/training code — the moment a reread must happen to shape the design.
const INTENT_PATTERNS = [
  /\bbuild\b[^.\n]*\bworker\b/i,
  /\bport\b[^.\n]*\bexp\d/i,
  /\bline\s+up\b[^.\n]*\b(gpu|runs?|experiments?|tests?)\b/i,
  /\bscale\b[^.\n]*\b(1\.5b|7b|13b|70b)\b/i,
  /\btraining\s+worker\b/i,
  /\bnew\s+experiment\b/i,
  /\b(build|write|implement|port|scale|wire)\b[^.\n]*\bexp\d+\w*/i,
  /\b(runpod_exp|modal_)\w*\.py\b/i,
];

export function experimentBuildIntent(prompt) {
  const promptText = String(prompt || '');
  return INTENT_PATTERNS.some((pattern) => pattern.test(promptText));
}

const RUNNER_README = 'C:/Users/rmill/Desktop/programming/runner/README.md';
const LOGGER_README = 'C:/Users/rmill/Desktop/programming/Logger/README.md';

export function buildReminder() {
  return `
<!-- experiment-runner-logger-reread: experiment-build intent detected -->
<!-- BEFORE writing ANY experiment/worker code this turn, OPEN and reread both, per CLAUDE.md
     "Check Runner + Logger BEFORE building ANY infra":
       - ${RUNNER_README}  (Ownership rule: retry-with-backoff, JSONL resume, bounded concurrency,
         Control-Tower pulses, TelemetryRecorder, AND TrainingLifecycle — paid-pod identity,
         checkpoint rescue, verified off-machine publication, guarded teardown)
       - ${LOGGER_README}  (ALL structured logging — one validated+redacted event shape)
     The experiment worker is DOMAIN GLUE ONLY (the mask, heads, gates, the science). Retry, resume,
     concurrency, pulses, telemetry, and the paid-pod lifecycle belong to Runner + the launcher;
     structured logging belongs to Logger. Do NOT hand-roll any of it. Reading the API from how a
     sibling imports it is NOT checking — ls + read the README + grep the repo for the capability. -->
`;
}

// Per-session dedup: fire once per session_id. Env-overridable dir for tests.
function stateDir() {
  return process.env.EXP_REREAD_STATE_DIR || join(homedir(), '.claude', 'state', 'experiment-reread-fired');
}
function alreadyFiredThisSession(sessionId) {
  if (!sessionId) return false;
  const marker = join(stateDir(), String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_') + '.marker');
  if (existsSync(marker)) return true;
  try { mkdirSync(stateDir(), { recursive: true }); writeFileSync(marker, '1'); } catch { /* best-effort */ }
  return false;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'UserPromptSubmit') process.exit(0);
  if (!experimentBuildIntent(event.prompt)) process.exit(0);
  if (alreadyFiredThisSession(event.session_id || event.sessionId)) process.exit(0);
  process.stdout.write(buildReminder());
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
