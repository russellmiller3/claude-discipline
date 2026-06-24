// coverage-claim-guard.test.mjs — run: node --test coverage-claim-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makesAbsoluteClaim, statesRealScope, coverageClaimViolation } from './coverage-claim-guard.mjs';

// ── POSITIVES: differently-worded absolute claims the guard MUST block ──
test('blocks "tested every primitive" (verb → quant → noun)', () => {
  assert.equal(coverageClaimViolation('I tested every primitive in the agent.'), true);
});

test('blocks the real bench mistake: "uses every primitive"', () => {
  assert.equal(coverageClaimViolation('The bench uses every primitive the agent exposes.'), true);
});

test('blocks "every tool is exercised" (quant → noun → verb)', () => {
  assert.equal(coverageClaimViolation('Every tool is exercised by the suite.'), true);
});

test('blocks "full coverage"', () => {
  assert.equal(coverageClaimViolation('Shipped with full coverage across the board.'), true);
});

test('blocks "tested everything"', () => {
  assert.equal(coverageClaimViolation('Done — I tested everything.'), true);
});

test('blocks "exercised all the code paths"', () => {
  assert.equal(coverageClaimViolation('The harness exercised all the code paths.'), true);
});

// ── NEGATIVES: benign phrasings that are NOT coverage claims ──
test('does not block "all tests pass"', () => {
  assert.equal(coverageClaimViolation('All tests pass and the build is clean.'), false);
});

test('does not block "everything works"', () => {
  assert.equal(coverageClaimViolation('Everything works now after the reload.'), false);
});

test('does not block "ran all the tests"', () => {
  assert.equal(coverageClaimViolation('I ran all the tests — 32 green.'), false);
});

test('does not block "fixed all the bugs"', () => {
  assert.equal(coverageClaimViolation('Fixed all the bugs you flagged.'), false);
});

// ── ESCAPES: a claim that ALSO states honest scope must NOT block ──
test('escape: a count of M ("30 of 43") qualifies the claim', () => {
  assert.equal(coverageClaimViolation('Tested every primitive — well, 30 of 43; the rest are live-gated.'), false);
});

test('escape: "except" names what is uncovered', () => {
  assert.equal(coverageClaimViolation('Covered everything except the debugger ops.'), false);
});

test('escape: "uncovered:" listing', () => {
  assert.equal(coverageClaimViolation('Uses every tool. Uncovered: the 4 trigger tools, the search tool.'), false);
});

test('escape: explicit coverage-override token', () => {
  assert.equal(coverageClaimViolation('I tested every primitive. coverage-override: the suite genuinely is exhaustive.'), false);
});

// ── unit checks on the two predicates ──
test('makesAbsoluteClaim is true for a bare claim, false for benign text', () => {
  assert.equal(makesAbsoluteClaim('uses every primitive'), true);
  assert.equal(makesAbsoluteClaim('all tests pass'), false);
});

test('statesRealScope detects N/M and uncovered markers', () => {
  assert.equal(statesRealScope('30/43 covered'), true);
  assert.equal(statesRealScope('uncovered: the rest'), true);
  assert.equal(statesRealScope('looks great'), false);
});
