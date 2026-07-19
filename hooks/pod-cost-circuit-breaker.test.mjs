// Tests for pod-cost-circuit-breaker.mjs — a dumb timer that surfaces a paid pod
// which has been up past a threshold with NO fresh job-liveness probe. Red-first.
//
// The mistake (2026-07-17, $13): the full 7B run OOM-crashed minutes in, but the pod
// stayed RUNNING and the status-only monitor looked like "still training" for 3 HOURS
// while 3 pods bled $12.74. That bleed happened across a long autonomous stretch that
// never hit a Stop — so a Stop-only guard wouldn't fire. This fires after EVERY tool
// call: if a paid pod is up and nobody has confirmed the JOB is alive in N minutes, halt.
//
//   node --test hooks/pod-cost-circuit-breaker.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPaidLaunch, probesJobLiveness, isTeardown, evaluate, isInScopedRepo } from './pod-cost-circuit-breaker.mjs';

test('scope: only marcus/legible repos arm the breaker', () => {
  assert.equal(isInScopedRepo('C:\\Users\\rmill\\Desktop\\programming\\marcus'), true);
  assert.equal(isInScopedRepo('C:\\Users\\rmill\\Desktop\\programming\\marcus\\scripts'), true);
  assert.equal(isInScopedRepo('/home/rmill/programming/legible/exp'), true);
  assert.equal(isInScopedRepo('C:\\Users\\rmill\\Desktop\\programming\\Macher'), false);
  assert.equal(isInScopedRepo('/home/rmill/programming/legible-notes'), false); // not a path segment
  assert.equal(isInScopedRepo(undefined), false);
});

const MINUTE = 60 * 1000;
const STALE = 4 * MINUTE;
const CADENCE = 6 * MINUTE;
const opts = { staleMs: STALE, cadenceMs: CADENCE };
const empty = () => ({ launchAt: 0, lastLivenessAt: 0, lastSurfacedAt: 0 });

const LAUNCH = 'python scripts/run_exp154_full_seed.py --seed 7 --decision-epochs 25';
const LIVENESS = 'ssh root@1.2.3.4 "pgrep -f train_exp154 && tail -3 /workspace/jobs/seed-7/nohup.out"';
const POD_STATUS = 'curl -s https://api.runpod.io/graphql -d \'{"query":"{myself{pods{desiredStatus}}}"}\'';
const FINALIZE = 'python runpod_exp154.py finalize --seed 7';
const BENIGN = 'python -m pytest scripts/test_foo.py -q';

// ── detectors ─────────────────────────────────────────────────────────────────
test('isPaidLaunch: a full-seed launch is a paid launch', () => {
  assert.equal(isPaidLaunch(LAUNCH), true);
  assert.equal(isPaidLaunch('modal run experiments/modal_train.py'), true);
});
test('isPaidLaunch: finalize / reads are NOT launches', () => {
  assert.equal(isPaidLaunch(FINALIZE), false);
  assert.equal(isPaidLaunch('cat runpod_exp154.py'), false);
  assert.equal(isPaidLaunch(''), false);
});
test('probesJobLiveness: an ssh pgrep / tail-job-log is a liveness probe', () => {
  assert.equal(probesJobLiveness(LIVENESS), true);
});
test('probesJobLiveness: a pod-STATUS poll is NOT a job-liveness probe', () => {
  assert.equal(probesJobLiveness(POD_STATUS), false);
});
test('isTeardown: finalize and a pod delete are teardowns', () => {
  assert.equal(isTeardown(FINALIZE), true);
  assert.equal(isTeardown('curl -X DELETE https://api.runpod.io/v1/pods/abc'), true);
  assert.equal(isTeardown(BENIGN), false);
});

// ── a paid launch arms the timer (no surface yet) ─────────────────────────────
test('a paid launch records launchAt and does not surface', () => {
  const { surface, nextState } = evaluate({ event: 'PostToolUse', command: LAUNCH, state: empty(), now: 1000, ...opts });
  assert.equal(surface, false);
  assert.equal(nextState.launchAt, 1000);
  assert.equal(nextState.lastLivenessAt, 1000);
});

// ── a benign tool BEFORE the stale window: no surface ─────────────────────────
test('no surface while the pod is fresh (within the stale window)', () => {
  const armed = { launchAt: 1000, lastLivenessAt: 1000, lastSurfacedAt: 0 };
  const { surface } = evaluate({ event: 'PostToolUse', command: BENIGN, state: armed, now: 1000 + STALE - 1, ...opts });
  assert.equal(surface, false);
});

// ── a benign tool AFTER the stale window with no liveness probe: SURFACE ───────
test('SURFACE when the pod has been up past the stale window with no job-liveness probe', () => {
  const armed = { launchAt: 1000, lastLivenessAt: 1000, lastSurfacedAt: 0 };
  const { surface, reason, nextState } = evaluate({ event: 'PostToolUse', command: BENIGN, state: armed, now: 1000 + STALE + 1, ...opts });
  assert.equal(surface, true);
  assert.match(reason, /liveness|alive|bled|\$1[23]|tear|cost/i);
  assert.equal(nextState.lastSurfacedAt, 1000 + STALE + 1);
});

// ── a job-liveness probe RESETS freshness ─────────────────────────────────────
test('a job-liveness probe resets the freshness clock (no surface after)', () => {
  const armed = { launchAt: 1000, lastLivenessAt: 1000, lastSurfacedAt: 0 };
  const probed = evaluate({ event: 'PostToolUse', command: LIVENESS, state: armed, now: 1000 + STALE - 10, ...opts }).nextState;
  assert.equal(probed.lastLivenessAt, 1000 + STALE - 10);
  const { surface } = evaluate({ event: 'PostToolUse', command: BENIGN, state: probed, now: 1000 + STALE + 5, ...opts });
  assert.equal(surface, false); // fresh probe means the clock restarted
});

// ── a pod-STATUS poll does NOT reset freshness (the $13 blind spot) ────────────
test('a pod-STATUS poll does NOT count as liveness — still surfaces when stale', () => {
  const armed = { launchAt: 1000, lastLivenessAt: 1000, lastSurfacedAt: 0 };
  const polled = evaluate({ event: 'PostToolUse', command: POD_STATUS, state: armed, now: 1000 + 60000, ...opts }).nextState;
  const { surface } = evaluate({ event: 'PostToolUse', command: BENIGN, state: polled, now: 1000 + STALE + 5, ...opts });
  assert.equal(surface, true);
});

// ── teardown clears the timer ─────────────────────────────────────────────────
test('teardown/finalize clears launchAt (no surface after)', () => {
  const armed = { launchAt: 1000, lastLivenessAt: 1000, lastSurfacedAt: 0 };
  const done = evaluate({ event: 'PostToolUse', command: FINALIZE, state: armed, now: 2000, ...opts }).nextState;
  assert.equal(done.launchAt, 0);
  const { surface } = evaluate({ event: 'PostToolUse', command: BENIGN, state: done, now: 2000 + STALE + 100, ...opts });
  assert.equal(surface, false);
});

// ── throttle: re-surface at most once per cadence ─────────────────────────────
test('throttle: does not re-surface within the cadence window', () => {
  const armed = { launchAt: 1000, lastLivenessAt: 1000, lastSurfacedAt: 0 };
  const first = evaluate({ event: 'PostToolUse', command: BENIGN, state: armed, now: 1000 + STALE + 1, ...opts });
  assert.equal(first.surface, true);
  const second = evaluate({ event: 'PostToolUse', command: BENIGN, state: first.nextState, now: 1000 + STALE + CADENCE - 10, ...opts });
  assert.equal(second.surface, false); // within cadence → suppressed
});

// ── no active pod / wrong event / malformed → no surface ──────────────────────
test('no surface when no pod is active', () => {
  const { surface } = evaluate({ event: 'PostToolUse', command: BENIGN, state: empty(), now: 999999, ...opts });
  assert.equal(surface, false);
});
test('does not fire on non-PostToolUse events', () => {
  const armed = { launchAt: 1000, lastLivenessAt: 1000, lastSurfacedAt: 0 };
  assert.equal(evaluate({ event: 'Stop', command: BENIGN, state: armed, now: 1000 + STALE + 1, ...opts }).surface, false);
});
test('fails safe on malformed input', () => {
  assert.equal(evaluate({}).surface, false);
  assert.equal(evaluate({ event: 'PostToolUse', command: null, state: null, now: null }).surface, false);
});

// ── INTEGRATION must-not-over-fire: the real hook process stays SILENT on legit input ──
// (proves the deny hook allows innocent Bash commands, not just that it blocks the bad ones)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'pod-cost-circuit-breaker.mjs');
const TEST_STATE = join(HERE, '.pcb-test-state.json');
function runHook(command, extraEnv) {
  try { rmSync(TEST_STATE, { force: true }); } catch { /* fresh state */ }
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, POD_COST_BREAKER_STATE: TEST_STATE, ...(extraEnv || {}) },
  });
  return ((proc.stdout || '') + (proc.stderr || '')).trim();
}
test('integration: allows an innocent Bash command with no pod armed (does not over-fire)', () => {
  assert.equal(runHook('git status --short'), ''); // no launch in state → nothing to block → silent
});
test('integration: allows the paid launch itself (arms the timer, no block)', () => {
  assert.equal(runHook('python scripts/run_exp154_full_seed.py --decision-epochs 25'), '');
});
test('integration: env override keeps it silent', () => {
  assert.equal(runHook('git status', { POD_COST_BREAKER_OK: '1' }), '');
  try { rmSync(TEST_STATE, { force: true }); } catch { /* cleanup */ }
});

test('integration: unscoped repo stays silent even with an armed+stale pod (the Macher false-positive fix)', () => {
  const armedStale = join(HERE, '.pcb-scope-state.json');
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  writeFileSync(armedStale, JSON.stringify({ launchAt: tenMinutesAgo, lastLivenessAt: tenMinutesAgo, lastSurfacedAt: 0 }));
  const spawnWith = (workingDirectory) => spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd: workingDirectory, tool_input: { command: 'git status' } }),
    encoding: 'utf8',
    env: { ...process.env, POD_COST_BREAKER_STATE: armedStale },
  });
  const macher = spawnWith('C:\\Users\\rmill\\Desktop\\programming\\Macher');
  assert.equal(((macher.stdout || '') + (macher.stderr || '')).trim(), ''); // scoped-out → silent
  const marcus = spawnWith('C:\\Users\\rmill\\Desktop\\programming\\marcus');
  assert.match(((marcus.stdout || '') + (marcus.stderr || '')).trim(), /PAID POD BLEEDING/); // in-scope → blocks
  try { rmSync(armedStale, { force: true }); } catch { /* cleanup */ }
});
