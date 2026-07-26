#!/usr/bin/env node
/**
 * Tests for bluf-first-line-guard.
 *
 * Real case that motivated it (2026-07-26): Russell asked "sorry didnt follow. what changes did you
 * make, high level? is anything left? or like should we do rye next or try zinc again?" and the reply
 * opened with a status table. He could not find the answer.
 *
 * The false-positive cases matter at least as much as the true positives — a guard that fires on a
 * good reply gets routed around, and then it protects nothing.
 */
import assert from 'node:assert/strict';
import { analyzeFirstLine, answerBearingLine, askedDirectQuestion } from './bluf-first-line-guard.mjs';

let passed = 0;
let failed = 0;
function test(name, body) {
  try { body(); passed++; process.stdout.write(`  ok   ${name}\n`); }
  catch (error) { failed++; process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`); }
}

process.stdout.write('askedDirectQuestion — when the guard is allowed to fire at all\n');

test('fires on a plain question mark', () => {
  assert.equal(askedDirectQuestion('is anything left?'), true);
});

test('fires on the real message that motivated the hook', () => {
  assert.equal(askedDirectQuestion(
    'sorry didnt follow. what changes did you make, high level? is anything left? or like shou.ld we do rye next or try zinc again?'
  ), true);
});

test('fires on a choice put to us without a question mark', () => {
  assert.equal(askedDirectQuestion('should we do rye next or try zinc again'), true);
  assert.equal(askedDirectQuestion('rye vs servo'), true);
});

test('fires on an interrogative opener with no question mark', () => {
  assert.equal(askedDirectQuestion('what did you change'), true);
});

test('stays silent on a plain instruction — not every turn is a question', () => {
  assert.equal(askedDirectQuestion('red team and pre mortem and then execute'), false);
  assert.equal(askedDirectQuestion('g'), false);
  assert.equal(askedDirectQuestion('ship it'), false);
  assert.equal(askedDirectQuestion('fix the greeting bug'), false);
});

test('stays silent on empty or missing input', () => {
  assert.equal(askedDirectQuestion(''), false);
  assert.equal(askedDirectQuestion(undefined), false);
});

process.stdout.write('\nanswerBearingLine — the compass line is not the answer\n');

test('skips a compass line and judges the line after it', () => {
  const reply = '🧭 **Northstar:** something something — progress.\n\nRye. The injunction kills Servo.';
  assert.equal(answerBearingLine(reply), 'Rye. The injunction kills Servo.');
});

test('skips a bold-text Northstar variant too', () => {
  const reply = '**Northstar:** goal here\n\nYES — deployed.';
  assert.equal(answerBearingLine(reply), 'YES — deployed.');
});

process.stdout.write('\nanalyzeFirstLine — blocks a buried answer\n');

test('blocks a reply that opens with a table (the real failure)', () => {
  const reply = '| Item | State |\n|---|---|\n| Rye | good |';
  assert.equal(analyzeFirstLine(reply).verdict, 'structural');
});

test('blocks a reply that opens with a heading', () => {
  assert.equal(analyzeFirstLine('## What changed\n\nA bunch of things.').verdict, 'structural');
});

test('blocks a reply that opens with a bullet', () => {
  assert.equal(analyzeFirstLine('- Rye is the pick\n- Servo is out').verdict, 'structural');
});

test('blocks throat-clearing instead of an answer', () => {
  assert.equal(analyzeFirstLine('Let me check the current state first.').verdict, 'throat-clearing');
  assert.equal(analyzeFirstLine("Okay, I'll look into that.").verdict, 'throat-clearing');
  assert.equal(analyzeFirstLine("Here's what I found across the codebase.").verdict, 'throat-clearing');
});

test('blocks a first line long enough to bury its own answer', () => {
  const buried = 'I went through the whole plan and the gateway and the prompt policy and after '
    + 'weighing everything carefully the conclusion I reached is that Rye is probably the better option.';
  const analysis = analyzeFirstLine(buried);
  assert.equal(analysis.verdict, 'too-long');
  assert.ok(analysis.words > 25, `expected >25 words, got ${analysis.words}`);
});

process.stdout.write('\nanalyzeFirstLine — must NOT fire on good replies\n');

test('accepts a short verdict-first line', () => {
  assert.equal(analyzeFirstLine('Rye — the injunction kills the Servo path.').verdict, 'ok');
});

test('accepts a YES/NO opener', () => {
  assert.equal(analyzeFirstLine('YES — deployed and green.').verdict, 'ok');
  assert.equal(analyzeFirstLine('NO. Retell exposes no tool timings.').verdict, 'ok');
});

test('accepts a bolded answer — emphasis is not throat-clearing', () => {
  assert.equal(analyzeFirstLine('**Rye, and I am building the poller first.**').verdict, 'ok');
});

test('accepts an answer that leads and is followed by a table', () => {
  const reply = '**Rye.** Servo is barred by the CFAA injunction.\n\n| Item | State |\n|---|---|\n| Rye | pick |';
  assert.equal(analyzeFirstLine(reply).verdict, 'ok');
});

test('accepts an answer after a compass line', () => {
  const reply = '🧭 **Northstar:** calls that work — capped the monologues.\n\nRye. Servo is out on CFAA.';
  assert.equal(analyzeFirstLine(reply).verdict, 'ok');
});

test('does not mistake a sentence merely CONTAINING a stop word for throat-clearing', () => {
  // "Looking" only trips when it OPENS the line; mid-sentence it is ordinary English.
  assert.equal(analyzeFirstLine('Rye wins; I am looking at the poller next.').verdict, 'ok');
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
