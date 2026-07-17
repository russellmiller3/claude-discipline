import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, hasBackgroundingAmpersand } from './background-orphan-guard.mjs';

// --- hasBackgroundingAmpersand: only a real job-control & counts ---

test('detects a trailing backgrounding &', () => {
  assert.equal(hasBackgroundingAmpersand('python race.py &'), true);
});

test('detects & separating two commands', () => {
  assert.equal(hasBackgroundingAmpersand('python race.py & echo started'), true);
});

test('logical && is NOT backgrounding', () => {
  assert.equal(hasBackgroundingAmpersand('cd scripts && python race.py'), false);
});

test('fd redirection 2>&1 is NOT backgrounding', () => {
  assert.equal(hasBackgroundingAmpersand('python race.py 2>&1 | tee log'), false);
});

test('bash &> redirection is NOT backgrounding', () => {
  assert.equal(hasBackgroundingAmpersand('python race.py &>log'), false);
});

test('an & inside quotes (a URL query) is NOT backgrounding', () => {
  assert.equal(hasBackgroundingAmpersand("curl 'http://x/y?a=1&b=2'"), false);
});

test('$! does not count as backgrounding', () => {
  assert.equal(hasBackgroundingAmpersand('echo $! > pid.txt'), false);
});

test('a plain command has no backgrounding &', () => {
  assert.equal(hasBackgroundingAmpersand('python race.py --seed 11'), false);
});

// --- evaluate: only block when BOTH run_in_background AND a backgrounding & ---

test('BLOCK: run_in_background + trailing &', () => {
  const verdict = evaluate({ command: 'python race.py & echo $!', runInBackground: true });
  assert.equal(verdict.block, true);
});

test('BLOCK: run_in_background + & separating commands', () => {
  const verdict = evaluate({ command: 'a & b', runInBackground: true });
  assert.equal(verdict.block, true);
});

test('ALLOW: run_in_background + no backgrounding &', () => {
  const verdict = evaluate({ command: 'python race.py --seed 11 | tee log', runInBackground: true });
  assert.equal(verdict.block, false);
});

test('ALLOW: inner & but NOT run_in_background (foreground choice)', () => {
  const verdict = evaluate({ command: 'python race.py &', runInBackground: false });
  assert.equal(verdict.block, false);
});

test('ALLOW: run_in_background + only logical &&', () => {
  const verdict = evaluate({ command: 'cd s && python race.py', runInBackground: true });
  assert.equal(verdict.block, false);
});

test('ALLOW: run_in_background + only 2>&1', () => {
  const verdict = evaluate({ command: 'python race.py 2>&1', runInBackground: true });
  assert.equal(verdict.block, false);
});

test('escape: literal token in command lets it through', () => {
  const verdict = evaluate({ command: 'python race.py & # BACKGROUND_ORPHAN_OK', runInBackground: true });
  assert.equal(verdict.block, false);
});

test('escape: token in reply text lets it through', () => {
  const verdict = evaluate({ command: 'python race.py &', runInBackground: true, replyText: 'BACKGROUND_ORPHAN_OK deliberate' });
  assert.equal(verdict.block, false);
});

test('escape: env override', () => {
  const verdict = evaluate({ command: 'python race.py &', runInBackground: true, envOk: true });
  assert.equal(verdict.block, false);
});

test('fails open on malformed input', () => {
  assert.equal(evaluate({}).block, false);
  assert.equal(evaluate({ command: null, runInBackground: true }).block, false);
});
