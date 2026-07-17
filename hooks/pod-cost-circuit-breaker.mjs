#!/usr/bin/env node
// =============================================================================
// POD-COST-CIRCUIT-BREAKER — a dumb timer that HALTS a paid pod bleeding undetected.
// =============================================================================
//
// new-hook-category: Benchmark / long-run discipline (pod lifecycle) — the mid-turn
// backstop to experiment-monitor-required's job-liveness check. That one fires at Stop;
// this one fires after EVERY tool call, so a bleed is caught within a turn, not at its end.
//
// THE MISTAKE (2026-07-17, ~$13): the full 7B run OOM-crashed minutes in, but the pod stayed
// RUNNING (pod alive != job alive) and the status-only monitor looked like "still training" for
// 3 HOURS while 3 pods bled $12.74 — all across a long AUTONOMOUS stretch that never hit a Stop.
// A Stop-only guard can't catch that; the fix is a dumb wall-clock timer that fires mid-turn.
//
// THE RULE: once a paid launch is up, SOMETHING must confirm the JOB is alive (a real
// job-liveness probe, not a pod-status poll) at least every ~4 min. If the pod has been up past
// that with no fresh probe, HALT and make the operator probe-or-tear-down. A pod-`desiredStatus`
// poll does NOT reset the clock — that status-only signal is exactly what bled the $13.
//
// NOTE ON HOME: the handoff suggested extending agent-monitor-cadence, but that hook is gated on
// background AGENTS and keyed to the pulse log — a paid pod is neither. This is the correct,
// lower-risk home: a small pod-focused timer that reuses none of that agent-branch machinery.
//
// TEETH: PostToolUse decision 'block' (throttled to once per ~6 min). State in a small JSON file.
// Escape: POD_COST_BREAKER_OK=1 env, or the token POD_COST_BREAKER_OK in the reply/command.
// Uses Date.now() (a live wall clock, like agent-monitor-cadence). FAILS OPEN. basename entry-guard.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ENV_OVERRIDE = 'POD_COST_BREAKER_OK';
const ESCAPE_TOKEN = /\bPOD_COST_BREAKER_OK\b/;
const STATE_FILE = process.env.POD_COST_BREAKER_STATE || resolve(homedir(), '.claude', 'state', 'pod-cost-breaker.json');
const STALE_MS = Number(process.env.POD_COST_STALE_MS ?? 4 * 60 * 1000);   // no job-liveness probe in 4 min → halt
const CADENCE_MS = Number(process.env.POD_COST_CADENCE_MS ?? 6 * 60 * 1000); // re-surface the same bleed at most every 6 min

// A paid launch: a runpod launcher `launch`, a `modal run`, a python modal_*.py, or a full-seed launcher.
const PAID_LAUNCH_PATTERNS = [
  /runpod_\w*\.py\b[\s\S]*\blaunch\b/,
  /\bmodal\s+run\b/,
  /\b(?:python[0-9.]*|py)\b[\s\S]*\bmodal_\w*\.py\b/,
  /\b(?:python[0-9.]*|py)\b[\s\S]*run_\w*_full_seed\.py/,
];
const NOT_A_LAUNCH = /\bfinalize\b|--help\b|(?:^|\s)-h(?:\s|$)|--dry-run\b|--check\b|--list\b|--smoke\b/;

// A JOB-liveness probe (NOT a pod-status poll). Same signal as experiment-monitor-required.
const JOB_LIVENESS_RE = /\bssh\b[\s\S]*(?:\bps\b|pgrep|pkill\s*-0|nvidia-smi|tail[\s\S]*(?:nohup|stdout|job|\.log))|job[_-]?liveness|hang[_-]?detect(?:or|ion)?|log[_-]?freshness|process[_-]?alive|job[_-]?alive|no[_ -]update[_ -]in/i;

// A teardown that ends the pod's cost: finalize (guarded rescue-then-delete) or a pod delete.
const TEARDOWN_RE = /\bfinalize\b|(?:-X\s*)?\bDELETE\b[\s\S]*\/pods?\/|\brunpodctl\s+(?:remove|stop|terminate)\s+pods?\b|--delete-pod\b|--terminate-pod\b|\bpodTerminate\b/i;

export function isPaidLaunch(command) {
  if (!command || typeof command !== 'string') return false;
  if (NOT_A_LAUNCH.test(command)) return false;
  return PAID_LAUNCH_PATTERNS.some((pattern) => pattern.test(command));
}

export function probesJobLiveness(command) {
  if (!command || typeof command !== 'string') return false;
  return JOB_LIVENESS_RE.test(command);
}

export function isTeardown(command) {
  if (!command || typeof command !== 'string') return false;
  return TEARDOWN_RE.test(command);
}

const REASON = (upMinutes) => `PAID POD BLEEDING UNCHECKED — a paid run has been up ~${upMinutes} min and nobody has confirmed the JOB is alive.

The $13 lesson (exp154, 2026-07-17): the run OOM-crashed minutes in, but the pod stayed RUNNING and a
status-only monitor showed "still training" for 3 HOURS while 3 pods bled $12.74 doing nothing. A pod
being UP is not the job being ALIVE.

STOP and do ONE of these now:
  1. PROBE the job: ssh the pod and \`pgrep -f <trainer>\` / \`nvidia-smi\`, or tail the remote job log and
     confirm its mtime is moving. If it's alive, you've reset the clock.
  2. If the job is DEAD (no process, log frozen): rescue any results, then tear the pod down — don't let it bill.
A pod-\`desiredStatus\`/\`get pod\` poll does NOT count — that is exactly the blind spot that bled the $13.

Escape (a genuine reason the timer is wrong): ${ENV_OVERRIDE} in your reply, or ${ENV_OVERRIDE}=1.`;

/**
 * PURE core. Given the current tool event/command, the prior state, and the clock, return
 * { surface, reason?, nextState }. Never throws. PostToolUse only.
 * state = { launchAt, lastLivenessAt, lastSurfacedAt } (ms; 0 = unset / no active pod).
 */
export function evaluate({ event, command = '', state, now, staleMs = STALE_MS, cadenceMs = CADENCE_MS } = {}) {
  const safeState = {
    launchAt: Number(state?.launchAt) || 0,
    lastLivenessAt: Number(state?.lastLivenessAt) || 0,
    lastSurfacedAt: Number(state?.lastSurfacedAt) || 0,
  };
  const clock = Number(now);
  if (event !== 'PostToolUse' || !Number.isFinite(clock)) return { surface: false, nextState: safeState };

  const commandText = typeof command === 'string' ? command : '';

  // A teardown ends the pod's cost — disarm the timer.
  if (isTeardown(commandText)) {
    return { surface: false, nextState: { launchAt: 0, lastLivenessAt: 0, lastSurfacedAt: 0 } };
  }
  // A fresh paid launch arms the timer (and is itself fresh).
  if (isPaidLaunch(commandText)) {
    return { surface: false, nextState: { launchAt: clock, lastLivenessAt: clock, lastSurfacedAt: 0 } };
  }
  // A real job-liveness probe resets the freshness clock.
  if (probesJobLiveness(commandText)) {
    return { surface: false, nextState: { ...safeState, lastLivenessAt: clock } };
  }
  // Any other tool: if a pod is up and it's gone stale (no fresh probe), surface — throttled.
  if (!safeState.launchAt) return { surface: false, nextState: safeState };
  const lastFresh = Math.max(safeState.launchAt, safeState.lastLivenessAt);
  const idleMs = clock - lastFresh;
  if (idleMs <= staleMs) return { surface: false, nextState: safeState };
  // Throttle only once a surface has actually happened (lastSurfacedAt === 0 → never surfaced → let it fire).
  if (safeState.lastSurfacedAt && clock - safeState.lastSurfacedAt < cadenceMs) return { surface: false, nextState: safeState };

  const upMinutes = Math.round((clock - safeState.launchAt) / 60000);
  return { surface: true, reason: REASON(upMinutes), nextState: { ...safeState, lastSurfacedAt: clock } };
}

const EMPTY_STATE = { launchAt: 0, lastLivenessAt: 0, lastSurfacedAt: 0 };

function readState() {
  if (!existsSync(STATE_FILE)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      launchAt: Number(parsed?.launchAt) || 0,
      lastLivenessAt: Number(parsed?.lastLivenessAt) || 0,
      lastSurfacedAt: Number(parsed?.lastSurfacedAt) || 0,
    };
  } catch { return { ...EMPTY_STATE }; }
}

function writeState(nextState) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(nextState), 'utf8');
  } catch { /* fail open */ }
}

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') process.exit(0);
    const payload = readPayload();
    const event = payload.hook_event_name || payload.hookEventName || '';
    if (event !== 'PostToolUse') process.exit(0);
    const command = (payload.tool_input || {}).command || '';
    const replyText = payload.reply_text || '';
    if (ESCAPE_TOKEN.test(command) || ESCAPE_TOKEN.test(replyText)) process.exit(0);

    const { surface, reason, nextState } = evaluate({ event, command, state: readState(), now: Date.now() });
    writeState(nextState);
    if (!surface) process.exit(0);
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    // Drain naturally — an immediate exit can truncate buffered stdout on a pipe.
  } catch {
    process.exit(0); // fail open — never brick a tool call
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
