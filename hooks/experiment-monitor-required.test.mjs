// Tests for experiment-monitor-required.mjs — a live Monitor must exist BEFORE an
// experiment/pod/training LAUNCH runs. Red-first: written before the hook.
//
//   node --test hooks/experiment-monitor-required.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLaunchCommand, evaluate } from './experiment-monitor-required.mjs';

// ── transcript builders ──────────────────────────────────────────────────────
const bash = (command) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] });
const monitor = () => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Monitor', input: {} }] });
const say = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const LAUNCH = 'python runpod_exp153.py launch --rows --gate';
const LINK = 'watch it live: http://localhost:8153/docs/exp153-3seed-live.html';
// a refresher/feeder that streams interim trial data home (Russell 2026-07-17)
const stream = () => bash('python scripts/exp153_live_refresher.py --pull runs/exp153_live.jsonl');

// ── isLaunchCommand: precise detection, no false positives ───────────────────
test('isLaunchCommand: runpod launch is a launch', () => {
  assert.equal(isLaunchCommand('python runpod_exp153.py launch --rows'), true);
});
test('isLaunchCommand: modal run is a launch', () => {
  assert.equal(isLaunchCommand('modal run experiments/modal_train.py'), true);
});
test('isLaunchCommand: python modal_*.py is a launch', () => {
  assert.equal(isLaunchCommand('python jobs/modal_sweep.py --seeds 5'), true);
});
test('isLaunchCommand: finalize is NOT a launch', () => {
  assert.equal(isLaunchCommand('python runpod_exp153.py finalize'), false);
});
test('isLaunchCommand: --help is NOT a launch', () => {
  assert.equal(isLaunchCommand('modal run modal_train.py --help'), false);
  assert.equal(isLaunchCommand('python runpod_exp153.py launch -h'), false);
});
test('isLaunchCommand: --dry-run / --smoke / --check / --list are NOT launches', () => {
  assert.equal(isLaunchCommand('python runpod_exp153.py launch --dry-run'), false);
  assert.equal(isLaunchCommand('python runpod_exp153.py launch --smoke'), false);
  assert.equal(isLaunchCommand('modal run modal_train.py --check'), false);
  assert.equal(isLaunchCommand('python runpod_exp153.py launch --list'), false);
});
test('isLaunchCommand: reading/grepping a launcher file is NOT a launch', () => {
  assert.equal(isLaunchCommand('cat runpod_exp153.py'), false);
  assert.equal(isLaunchCommand('grep launch runpod_exp153.py'), false);
});
test('isLaunchCommand: malformed / empty input fails safe (not a launch)', () => {
  assert.equal(isLaunchCommand(''), false);
  assert.equal(isLaunchCommand(null), false);
  assert.equal(isLaunchCommand(undefined), false);
});

// ── PreToolUse: DENY a launch with no prior Monitor ──────────────────────────
test('PreToolUse: DENY launch when no Monitor exists yet', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
  assert.match(verdict.reason, /Monitor/);
});

// ── PreToolUse: ALLOW a launch when a Monitor AND an interim stream precede it ─
test('PreToolUse: ALLOW launch when a Monitor + interim stream precede it', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [monitor(), stream()] });
  assert.equal(verdict.block, false);
});

// ── PreToolUse: DENY a launch that has a Monitor but NO interim stream ─────────
test('PreToolUse: DENY launch with a Monitor but no live interim stream', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [monitor()] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
  assert.match(verdict.reason, /interim|stream|trial data/i);
});

// ── PreToolUse: do NOT fire on non-launch commands (finalize/help/reads) ──────
test('PreToolUse: does NOT fire on finalize even with no Monitor', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: 'python runpod_exp153.py finalize', entries: [] });
  assert.equal(verdict.block, false);
});
test('PreToolUse: does NOT fire on a plain file read', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: 'cat runpod_exp153.py', entries: [] });
  assert.equal(verdict.block, false);
});

// ── Stop backstop: block launch-then-no-monitor ──────────────────────────────
test('Stop: BLOCK when a launch happened and no Monitor followed it', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH)] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
});
test('Stop: ALLOW when a Monitor follows the last launch AND a watch link was given', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), stream(), say(LINK)] });
  assert.equal(verdict.block, false);
});

// ── Stop backstop: a Monitor must come with a LINK Russell can open ───────────
test('Stop: BLOCK when launch + Monitor but NO watch link was given', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor()] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
  assert.match(verdict.reason, /link/i);
});
test('Stop: ALLOW with a localhost link', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), stream(), say('open http://127.0.0.1:8153/docs/x.html')] });
  assert.equal(verdict.block, false);
});
test('Stop: ALLOW with a *-live.html watch page reference', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), stream(), say('see docs/exp153-race-live.html')] });
  assert.equal(verdict.block, false);
});
test('Stop: no-link block does NOT fire when there was no launch', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash('ls'), monitor()] });
  assert.equal(verdict.block, false);
});
test('Stop: BLOCK when the last Monitor precedes the last launch (stale monitor)', () => {
  const verdict = evaluate({ event: 'Stop', entries: [monitor(), bash(LAUNCH)] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
});
test('Stop: ALLOW when no launch happened this session', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash('ls -la'), monitor()] });
  assert.equal(verdict.block, false);
});
test('Stop: never loops when stop_hook_active', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH)], stopHookActive: true });
  assert.equal(verdict.block, false);
});

// ── Escape hatches ───────────────────────────────────────────────────────────
test('escape: env override lets a monitorless launch through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [], envOk: true });
  assert.equal(verdict.block, false);
});
test('escape: literal token in the reply lets a monitorless launch through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [], replyText: 'skipping: EXPERIMENT_MONITOR_REQUIRED_OK for a smoke test' });
  assert.equal(verdict.block, false);
});

// ── Fail open on malformed payload ───────────────────────────────────────────
test('fails open on malformed/empty evaluate input', () => {
  assert.equal(evaluate({}).block, false);
  assert.equal(evaluate({ event: 'PreToolUse' }).block, false);
  assert.equal(evaluate({ event: 'Stop' }).block, false);
  assert.equal(evaluate({ event: 'PreToolUse', command: null, entries: null }).block, false);
});
test('does not fire on unrelated events', () => {
  assert.equal(evaluate({ event: 'PostToolUse', command: LAUNCH, entries: [] }).block, false);
});


// ── Stop: BLOCK a launch+monitor+link that never streamed interim trial data ──
test('Stop: BLOCK when launch+monitor+link but no interim stream at Stop', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), say(LINK)] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
  assert.match(verdict.reason, /interim|stream|trial data/i);
});
