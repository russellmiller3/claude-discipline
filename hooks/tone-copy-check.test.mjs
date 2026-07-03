// tone-copy-check.test.mjs — run: node --test ~/.claude/hooks/tone-copy-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeExternalCopy, findCondescension } from './tone-copy-check.mjs';

const CONDESCENDING_ORIGINAL = 'You just raised $21M. That buys runway, not attention. '
  + "You already built the highest-leverage page you have. It's good. "
  + "You've built exactly one.";

const RETONED = 'You just raised $21M — the market is betting on Inngest owning this category. '
  + 'The Inngest vs Temporal page is proof you already know how to win it.';

test('an email file is detected as external copy', () => {
  assert.equal(looksLikeExternalCopy('Zavient/Email to Dan.md'), true);
});

test('a proposal file is detected as external copy', () => {
  assert.equal(looksLikeExternalCopy('Zavient/Inngest - Strategy Proposal.pdf'), true);
});

test('a build script for the proposal (contains "proposal") is detected', () => {
  assert.equal(looksLikeExternalCopy('scratchpad/build_proposal.py'), true);
});

test('an unrelated project file is NOT external copy', () => {
  assert.equal(looksLikeExternalCopy('src/lib/utils.ts'), false);
});

test('a HANDOFF.md is NOT external copy', () => {
  assert.equal(looksLikeExternalCopy('Zavient/HANDOFF.md'), false);
});

test('the original condescending line is caught by EXACTLY-ONE DIMINISHMENT', () => {
  const findings = findCondescension(CONDESCENDING_ORIGINAL);
  assert.ok(findings.some((finding) => finding.label === 'EXACTLY-ONE DIMINISHMENT'));
});

test('the original condescending line is also caught by OBVIOUS-ECONOMICS EXPLAINER', () => {
  const findings = findCondescension(CONDESCENDING_ORIGINAL);
  assert.ok(findings.some((finding) => finding.label === 'OBVIOUS-ECONOMICS EXPLAINER'));
});

test('the retoned replacement copy triggers no findings', () => {
  assert.deepEqual(findCondescension(RETONED), []);
});

test('"you\'ve only built two pages" is caught by ONLY-DIMINISHMENT', () => {
  const findings = findCondescension("Nice work, you've only built two pages so far.");
  assert.ok(findings.some((finding) => finding.label === 'ONLY-DIMINISHMENT'));
});

test('"well, actually" is caught', () => {
  const findings = findCondescension('Well, actually the data shows something different.');
  assert.ok(findings.some((finding) => finding.label === 'WELL-ACTUALLY'));
});

test('"as you probably know" is caught', () => {
  const findings = findCondescension('As you probably know, comparison pages convert well.');
  assert.ok(findings.some((finding) => finding.label === 'AS-YOU-KNOW PRESUMPTION'));
});

test('ordinary confident copy with no condescension shapes triggers nothing', () => {
  const findings = findCondescension(
    'Your Temporal page is proof the motion works. I run that play across your whole competitor set.'
  );
  assert.deepEqual(findings, []);
});

test('"the number one priority" does not false-positive on EXACTLY-ONE (no "built/done/made" verb)', () => {
  const findings = findCondescension('The number one priority for Q3 is shipping the integrations directory.');
  assert.deepEqual(findings.filter((finding) => finding.label === 'EXACTLY-ONE DIMINISHMENT'), []);
});
