// guard-turn-budget — the PreToolUse release valve.
//
// Both directions matter and the second one matters more: a valve that opens too eagerly is not a
// safety feature, it is a silent removal of every guard behind it. So each test that proves the
// valve OPENS is paired with one proving it stays SHUT while the guard is still teaching.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denialsThisTurn, progressedSinceLastDenial, shouldYieldInsteadOfDenying } from './guard-turn-budget.mjs';

const SIGNATURES = ['REPAIR LEASE —', 'EFFICIENCY —', 'SIMPLE EDIT —'];

const denial = (prefix) => ({ isError: true, resultText: `${prefix} the guard objected to this call.` });
const ranOk = (text = 'done') => ({ isError: false, resultText: text });
const realFailure = () => ({ isError: true, resultText: 'TypeError: cannot read property of undefined' });

// ── counting ────────────────────────────────────────────────────────────────────────────────
test('counts only refusals carrying one of this guard\'s own prefixes', () => {
  const tools = [denial('REPAIR LEASE —'), ranOk(), denial('EFFICIENCY —'), realFailure()];
  assert.equal(denialsThisTurn(tools, SIGNATURES), 2);
});

test('a SIBLING guard\'s refusal is not ours and never spends our budget', () => {
  const tools = [
    { isError: true, resultText: 'CHECKPOINT REQUIRED — bank before the next mutation.' },
    { isError: true, resultText: 'BLOCKED — this file is UNTRACKED by git.' },
  ];
  assert.equal(denialsThisTurn(tools, SIGNATURES), 0);
});

test('no signatures configured means nothing is ever counted (fails safe, not open)', () => {
  assert.equal(denialsThisTurn([denial('REPAIR LEASE —')], []), 0);
});

// ── progress resets the budget ──────────────────────────────────────────────────────────────
test('a completed call after the last denial counts as progress', () => {
  const tools = [denial('EFFICIENCY —'), ranOk('read 40 lines')];
  assert.equal(progressedSinceLastDenial(tools, SIGNATURES), true);
});

test('an ERRORED call after the last denial is NOT progress — it proves no legal move exists', () => {
  const tools = [denial('EFFICIENCY —'), realFailure()];
  assert.equal(progressedSinceLastDenial(tools, SIGNATURES), false);
});

test('another denial after the last denial is not progress', () => {
  const tools = [denial('EFFICIENCY —'), denial('REPAIR LEASE —')];
  assert.equal(progressedSinceLastDenial(tools, SIGNATURES), false);
});

// ── the valve, both directions ──────────────────────────────────────────────────────────────
test('SHUT below budget: the guard is still teaching, so it keeps its teeth', () => {
  const tools = [denial('REPAIR LEASE —'), denial('EFFICIENCY —')];
  const verdict = shouldYieldInsteadOfDenying({ completedTools: tools, signatures: SIGNATURES, budget: 3 });
  assert.equal(verdict.yield, false);
  assert.equal(verdict.spent, 2);
});

test('OPEN at budget with nothing completed since: the turn is wedged, stand down', () => {
  const tools = [denial('REPAIR LEASE —'), denial('EFFICIENCY —'), denial('SIMPLE EDIT —')];
  const verdict = shouldYieldInsteadOfDenying({ completedTools: tools, signatures: SIGNATURES, budget: 3 });
  assert.equal(verdict.yield, true);
  assert.equal(verdict.spent, 3);
});

test('SHUT at budget when real work landed after the last denial — the session is not wedged', () => {
  const tools = [denial('REPAIR LEASE —'), denial('EFFICIENCY —'), denial('SIMPLE EDIT —'), ranOk('committed')];
  assert.equal(shouldYieldInsteadOfDenying({ completedTools: tools, signatures: SIGNATURES, budget: 3 }).yield, false);
});

test('OSCILLATION — the exact shape the arbiter\'s same-call breaker cannot see', () => {
  // Every call is DIFFERENT, so a per-call-signature budget never trips; a different detector
  // refuses each one. This is the 2026-08-17 live deadlock, and the per-turn budget is what ends it.
  const tools = [
    { isError: true, resultText: 'REPAIR LEASE — the locked live proof is: node a.mjs' },
    { isError: true, resultText: 'EFFICIENCY — the same action already ran twice' },
    { isError: true, resultText: 'SIMPLE EDIT — unrequested planning' },
  ];
  assert.equal(shouldYieldInsteadOfDenying({ completedTools: tools, signatures: SIGNATURES, budget: 3 }).yield, true);
});

test('a fresh turn with no history never yields — the valve cannot disarm a guard pre-emptively', () => {
  assert.equal(shouldYieldInsteadOfDenying({ completedTools: [], signatures: SIGNATURES, budget: 3 }).yield, false);
});

test('malformed input never yields (fails toward enforcement, not away from it)', () => {
  assert.equal(shouldYieldInsteadOfDenying({ completedTools: null, signatures: SIGNATURES }).yield, false);
  assert.equal(shouldYieldInsteadOfDenying({}).yield, false);
});
