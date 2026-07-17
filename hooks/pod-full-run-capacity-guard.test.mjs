// Tests for pod-full-run-capacity-guard.mjs — a FULL-training paid launch is BLOCKED
// unless a full-SHAPE capacity smoke already ran this session (or an override token).
// Red-first: written before the hook. The $13 exp154 OOM (2026-07-17) is the case:
// a one-example WIRING smoke (61/79GB) passed, but the full run OOM'd — a wiring smoke
// proves the mechanism, NOT the card's capacity.
//
//   node --test hooks/pod-full-run-capacity-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFullTrainingLaunch, isCapacitySmoke, evaluate } from './pod-full-run-capacity-guard.mjs';

// ── transcript builders (compose into serial / mixed-tool / parallel sequences) ──
const bash = (command) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] });
const monitor = () => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Monitor', input: {} }] });
const read = (path) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: path } }] });
const say = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

// The exp154 full 7B run: both bundles, 25 decision epochs. THIS is what OOM'd.
const FULL = 'python scripts/run_exp154_full_seed.py --seed 7 --decision-epochs 25 --artifact-root /w/a';
const FULL_LAUNCH = 'python runpod_exp154.py launch --decision-epochs 25 --seed 11';
const FULL_MODAL = 'modal run experiments/modal_train_7b.py --decision-epochs 25';
// Full SHAPE, ~10 steps: OOMs in 2 min for pennies, or proves the card holds it.
const CAP_SMOKE = 'python scripts/run_exp154_full_seed.py --seed 7 --capacity-smoke --max-steps 10';
// One example: proves WIRING, not capacity. This is the smoke that under-measured.
const WIRING = 'python scripts/train_qwen_overfit_smoke.py --one-example --max-steps 1';

// ── isCapacitySmoke: recognizes the full-shape ×10-step smoke ─────────────────
test('isCapacitySmoke: --capacity-smoke flag is a capacity smoke', () => {
  assert.equal(isCapacitySmoke(CAP_SMOKE), true);
});
test('isCapacitySmoke: the full run is NOT a capacity smoke', () => {
  assert.equal(isCapacitySmoke(FULL), false);
});
test('isCapacitySmoke: a one-example wiring smoke is NOT a capacity smoke', () => {
  assert.equal(isCapacitySmoke(WIRING), false);
});
test('isCapacitySmoke: malformed input fails safe', () => {
  assert.equal(isCapacitySmoke(''), false);
  assert.equal(isCapacitySmoke(null), false);
});

// ── isFullTrainingLaunch: precise, no false positives ─────────────────────────
test('isFullTrainingLaunch: full-seed script by name is a full launch', () => {
  assert.equal(isFullTrainingLaunch(FULL), true);
});
test('isFullTrainingLaunch: launch with --decision-epochs 25 is a full launch', () => {
  assert.equal(isFullTrainingLaunch(FULL_LAUNCH), true);
});
test('isFullTrainingLaunch: modal run with full epochs is a full launch', () => {
  assert.equal(isFullTrainingLaunch(FULL_MODAL), true);
});
test('isFullTrainingLaunch: --decision-epochs 2 (smoke-level) is NOT full', () => {
  assert.equal(isFullTrainingLaunch('python runpod_exp154.py launch --decision-epochs 2'), false);
});
test('isFullTrainingLaunch: --decision-epochs 3 IS full (past threshold)', () => {
  assert.equal(isFullTrainingLaunch('python runpod_exp154.py launch --decision-epochs 3'), true);
});
test('isFullTrainingLaunch: the capacity smoke itself is NOT a full launch', () => {
  assert.equal(isFullTrainingLaunch(CAP_SMOKE), false);
});
test('isFullTrainingLaunch: a one-example wiring smoke is NOT a full launch', () => {
  assert.equal(isFullTrainingLaunch(WIRING), false);
});
test('isFullTrainingLaunch: finalize / help / dry-run / reads are NOT full launches', () => {
  assert.equal(isFullTrainingLaunch('python runpod_exp154.py finalize'), false);
  assert.equal(isFullTrainingLaunch('python runpod_exp154.py launch --help'), false);
  assert.equal(isFullTrainingLaunch('python run_exp154_full_seed.py --dry-run'), false);
  assert.equal(isFullTrainingLaunch('cat scripts/run_exp154_full_seed.py'), false);
  assert.equal(isFullTrainingLaunch('grep launch runpod_exp154.py'), false);
});
test('isFullTrainingLaunch: a bare launch with no full-training marker does NOT fire', () => {
  // exp153 1.5B proven launches carry no --decision-epochs / full-seed marker → not this guard's job.
  assert.equal(isFullTrainingLaunch('python runpod_exp153.py launch --rows'), false);
});
test('isFullTrainingLaunch: malformed / empty input fails safe', () => {
  assert.equal(isFullTrainingLaunch(''), false);
  assert.equal(isFullTrainingLaunch(null), false);
  assert.equal(isFullTrainingLaunch(undefined), false);
});

// ── PreToolUse: DENY a full launch with no capacity smoke ─────────────────────
test('PreToolUse: DENY full launch when no capacity smoke ran this session', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: FULL, entries: [] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
  assert.match(verdict.reason, /capacity smoke/i);
});

// ── PreToolUse: ALLOW when a capacity smoke preceded the full launch ───────────
test('PreToolUse: ALLOW full launch when a capacity smoke ran first', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: FULL, entries: [bash(CAP_SMOKE)] });
  assert.equal(verdict.block, false);
});
test('PreToolUse: ALLOW after a realistic serial+mixed sequence (read, smoke, monitor, launch)', () => {
  const entries = [read('scripts/run_exp154_full_seed.py'), bash(CAP_SMOKE), monitor(), bash('ls runs/')];
  const verdict = evaluate({ event: 'PreToolUse', command: FULL_LAUNCH, entries });
  assert.equal(verdict.block, false);
});

// ── PreToolUse: a WIRING smoke does NOT satisfy the capacity requirement ───────
test('PreToolUse: DENY full launch when only a WIRING smoke ran (wiring != capacity)', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: FULL, entries: [bash(WIRING)] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
});

// ── PreToolUse: never fires on the capacity smoke itself / finalize / reads ────
test('PreToolUse: does NOT fire when the command IS the capacity smoke', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: CAP_SMOKE, entries: [] });
  assert.equal(verdict.block, false);
});
test('PreToolUse: does NOT fire on finalize / read', () => {
  assert.equal(evaluate({ event: 'PreToolUse', command: 'python runpod_exp154.py finalize', entries: [] }).block, false);
  assert.equal(evaluate({ event: 'PreToolUse', command: 'cat runpod_exp154.py', entries: [] }).block, false);
});

// ── Escape hatches ────────────────────────────────────────────────────────────
test('escape: CAPACITY_SMOKE_OK token in the command lets the launch through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: FULL + ' # CAPACITY_SMOKE_OK: H200 holds 126/141GB', entries: [] });
  assert.equal(verdict.block, false);
});
test('escape: CAPACITY_SMOKE_OK token in the reply lets the launch through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: FULL, entries: [], replyText: 'CAPACITY_SMOKE_OK: verified on H200 earlier today' });
  assert.equal(verdict.block, false);
});
test('escape: env override lets the launch through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: FULL, entries: [], envOk: true });
  assert.equal(verdict.block, false);
});

// ── Fail open on malformed payload / unrelated events ─────────────────────────
test('fails open on malformed/empty evaluate input', () => {
  assert.equal(evaluate({}).block, false);
  assert.equal(evaluate({ event: 'PreToolUse' }).block, false);
  assert.equal(evaluate({ event: 'PreToolUse', command: null, entries: null }).block, false);
});
test('does not fire on unrelated events (Stop / PostToolUse)', () => {
  assert.equal(evaluate({ event: 'Stop', command: FULL, entries: [] }).block, false);
  assert.equal(evaluate({ event: 'PostToolUse', command: FULL, entries: [] }).block, false);
});
