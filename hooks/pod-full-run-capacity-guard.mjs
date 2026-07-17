#!/usr/bin/env node
// =============================================================================
// POD-FULL-RUN-CAPACITY-GUARD — a FULL-training paid launch needs a full-SHAPE
// capacity smoke FIRST. A one-example WIRING smoke does NOT predict full-run VRAM.
// =============================================================================
//
// new-hook-category: Benchmark / long-run discipline — nearest existing is
// experiment-monitor-required (it requires a live Monitor before a launch) and
// pod-launch-durability-guard (fires on WRITING launcher code). NEITHER checks that
// the target card can actually HOLD the full training shape — the gap that cost $13.
//
// THE MISTAKE (2026-07-17, exp154, ~$13 wasted): the ~$1 WIRING smoke memorized ONE
// example at 61/79GB and I stamped it "GO". The FULL run trains the whole curriculum
// × 25 decision epochs across BOTH bundles (in-layer + two-forward) + races — its
// AdamW optimizer state + activations exceeded 80GB and it OOM-crashed minutes in.
// A one-example smoke proves WIRING, not CAPACITY.
//
// THE RULE: a FULL-training paid launch is BLOCKED unless a full-SHAPE capacity smoke
// ran this session — the REAL training shape (full batch, both arms' peak memory, real
// optimizer state) for ~10 steps: it OOMs in ~2 min for pennies, or proves the card
// holds it. A VRAM estimate is NOT sufficient (activation memory is the hard part; a
// hook can't verify a hand calc is correct).
//
// TEETH: PreToolUse permissionDecision 'deny'. Detection is precise (see
// isFullTrainingLaunch) so the wiring smoke / capacity smoke / finalize / help / reads
// never false-fire. Escape: CAPACITY_SMOKE_OK: <evidence> token in the command or reply,
// or POD_CAPACITY_GUARD_OK=1 in env. FAILS OPEN on any error. basename entry-guard.
//
// HONEST LIMIT: the hook verifies a capacity smoke RAN, not that the operator read its
// result correctly. Pair with the cost circuit-breaker (a dumb timer) so a mis-read that
// still OOMs is caught within ~1 min, not 3 hours.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, toolUsesOf, lastAssistantText } from './lib/transcript.mjs';

const ENV_OVERRIDE = 'POD_CAPACITY_GUARD_OK';
const ESCAPE_TOKEN = /\bCAPACITY_SMOKE_OK\b/;

// A capacity smoke = the FULL training shape run for a HANDFUL of steps. Marked with an
// explicit --capacity-smoke flag so detection is unambiguous (the runpod-run skill emits it).
const CAPACITY_SMOKE_RE = /--capacity[_-]?smoke\b|\bcapacity[_-]?smoke\b/i;

// A launch invocation: a runpod launcher run with `launch`; a `modal run`; a python run
// of a modal_*.py job; or a python run of a run_*_full_seed.py full-seed launcher.
// Forward order (file THEN launch) so `grep launch runpod_x.py` — which searches the file —
// never counts as a launch.
const RUNPOD_LAUNCH = /runpod_\w*\.py\b[\s\S]*\blaunch\b/;
const MODAL_RUN = /\bmodal\s+run\b/;
const PYTHON_MODAL = /\b(?:python[0-9.]*|py)\b[\s\S]*\bmodal_\w*\.py\b/;
const FULL_SEED_SCRIPT = /\b(?:python[0-9.]*|py)\b[\s\S]*run_\w*_full_seed\.py/;

// Not a spend-and-train run: help, dry runs, listings, and finalize/teardown.
const NOT_A_LAUNCH = /\bfinalize\b|--help\b|(?:^|\s)-h(?:\s|$)|--dry-run\b|--check\b|--list\b/;

// A full run trains many decision epochs; a smoke uses ~1-2. Past this = full training.
const SMOKE_EPOCH_MAX = 2;
const DECISION_EPOCHS_RE = /--decision[_-]epochs[=\s]+(\d+)/;
// A full-seed marker: the full-seed launcher name, or an explicit full-seed flag.
const FULL_SEED_MARKER = /full[_-]seed/i;

function isLaunchInvocation(command) {
  return RUNPOD_LAUNCH.test(command) || MODAL_RUN.test(command) || PYTHON_MODAL.test(command) || FULL_SEED_SCRIPT.test(command);
}

// Does the command indicate FULL training (not a smoke-scale run)?
function indicatesFullTraining(command) {
  if (FULL_SEED_MARKER.test(command)) return true;
  const epochsMatch = command.match(DECISION_EPOCHS_RE);
  if (epochsMatch && Number(epochsMatch[1]) > SMOKE_EPOCH_MAX) return true;
  return false;
}

/** True when a Bash command is the full-shape capacity smoke (the allowed evidence). */
export function isCapacitySmoke(command) {
  if (!command || typeof command !== 'string') return false;
  return CAPACITY_SMOKE_RE.test(command);
}

/**
 * True when a Bash command STARTS a FULL-training paid run — the thing that must be
 * capacity-proven first. Excludes the capacity smoke itself, one-example wiring smokes,
 * finalize/help/dry-run/list, and plain reads, so only a real full launch fires.
 */
export function isFullTrainingLaunch(command) {
  if (!command || typeof command !== 'string') return false;
  if (NOT_A_LAUNCH.test(command)) return false;
  if (isCapacitySmoke(command)) return false;   // running the smoke is never "the full run"
  if (!isLaunchInvocation(command)) return false;
  return indicatesFullTraining(command);
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

const DENY_REASON = `FULL-TRAINING LAUNCH BLOCKED — no full-shape CAPACITY smoke ran this session.

The mistake this stops (exp154, 2026-07-17, $13 wasted): a one-example WIRING smoke memorized
ONE example at 61/79GB and passed "GO" — but the FULL run (whole curriculum × 25 epochs, BOTH
bundles + races) OOM-crashed on the 80GB card. A wiring smoke proves the MECHANISM, not CAPACITY.

Before this paid launch, run a full-SHAPE CAPACITY smoke on the TARGET card:
  - the REAL training shape (full batch, both arms' peak memory, real AdamW optimizer state)
  - for ~10 steps — it OOMs in ~2 min for pennies, or proves the card holds it.
  - mark it with --capacity-smoke so this guard sees it.

A VRAM estimate is NOT enough — activation memory is the hard part and a hook can't verify a calc.
If you already ran one (e.g. earlier today on the same card), add the token to your reply/command:
  CAPACITY_SMOKE_OK: <card + observed peak, e.g. "H200 141GB, peaked 126GB, no OOM">
Or set ${ENV_OVERRIDE}=1.`;

/**
 * PURE core. `entries` is the parsed transcript (array). Returns { block, mode?, reason? }.
 * Never throws on malformed input. PreToolUse only.
 */
export function evaluate({ event, command = '', entries = [], replyText = '', envOk = false } = {}) {
  if (envOk) return { block: false };
  if (ESCAPE_TOKEN.test(command || '') || ESCAPE_TOKEN.test(replyText || '')) return { block: false };
  if (event !== 'PreToolUse') return { block: false };
  if (!isFullTrainingLaunch(command)) return { block: false };

  const priorCapacitySmoke = bashCommandsInOrder(entries).some((priorCommand) => isCapacitySmoke(priorCommand));
  if (priorCapacitySmoke) return { block: false };

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
