#!/usr/bin/env node
// THE ANCHOR — Goal / Task / Doing now at the top of every working message.
//
// Russell, 2026-08-16, verbatim: "I need you to always speak in terms of the higher level goal, as
// a global rule. otherwise I lose my place." That day the standard went into the every-turn
// injection and NOTHING checked it, which made it advice. Advice is exactly what got ignored --
// two replies later he wrote "FOLLOW MY NARRATIVE RULE" in capitals. An injected rule with no
// detector is a suggestion. These tests are what turn it into a gate.
//
// Lives beside compass-line-guard.test.mjs rather than inside it: that file is a sealed, hermetic
// suite for the roadmap-cadence rules, and this is a different claim about the same guard.
//
// Run: node --test compass-anchor.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNarrativeAnchor, compassViolations } from './compass-line-guard.mjs';

const anchored = '**Goal:** Hear Macher\'s voice\n**Task:** Fix the calendar turn\n'
  + '**Doing now:**\n- 🔍 reading the adapter\n- 🧪 writing the failing test';

test('a reply carrying all three lines passes', () => {
  assert.equal(hasNarrativeAnchor(anchored), true);
});

test('plain, heading and quoted forms all pass — shape, not decoration', () => {
  assert.equal(hasNarrativeAnchor('Goal: ship it\nTask: the thing\nDoing now:\n- 🔧 working'), true);
  assert.equal(hasNarrativeAnchor('## Goal: ship it\n## Task: the thing\n## Doing now:\n- 🔧 x'), true);
  assert.equal(hasNarrativeAnchor('> Goal: ship it\n> Task: the thing\n> Doing now:\n> - 🔧 x'), true);
});

test('any ONE missing line fails — all three are load-bearing', () => {
  assert.equal(hasNarrativeAnchor('**Goal:** x\n**Task:** y\n- 🔧 no doing-now header'), false);
  assert.equal(hasNarrativeAnchor('**Goal:** x\n**Doing now:**\n- 🔧 no task'), false);
  assert.equal(hasNarrativeAnchor('**Task:** y\n**Doing now:**\n- 🔧 no goal'), false);
});

test('an ordinary prose reply fails — the exact case that kept slipping through', () => {
  assert.equal(hasNarrativeAnchor(
    'Found it. The cap was 128 tokens, which starved the tool call.\n\nFixing it now.'
  ), false);
  assert.equal(hasNarrativeAnchor(''), false);
  assert.equal(hasNarrativeAnchor(null), false);
});

test('the labels must sit near the TOP — an anchor he has to scroll to is not an anchor', () => {
  const buried = `${Array(12).fill('some prose line').join('\n')}\nGoal: x\nTask: y\nDoing now:\n- 🔧 z`;
  assert.equal(hasNarrativeAnchor(buried), false);
});

test('prose merely CONTAINING the words is not an anchor', () => {
  assert.equal(hasNarrativeAnchor(
    'My goal: to be clearer. The task: fix it. What I am doing now: reading code.'
  ), false, 'the labels must begin their own lines, never appear mid-sentence');
});

// --- the guard actually reports it, not just the helper ----------------------------------------

const turn = (text) => [{ message: { role: 'assistant', content: [{ type: 'text', text }] } }];

test('compassViolations REPORTS a missing anchor', () => {
  const found = compassViolations({
    turnEntries: turn('Fixed it. The cap was too small.'),
    entries: turn('Fixed it. The cap was too small.'),
    reply: 'Fixed it. The cap was too small.',
  });
  assert.ok(found.some((violation) => /anchor/i.test(violation.kind)),
    'an unanchored reply must produce a violation, not pass silently');
});

test('compassViolations stays QUIET about the anchor when it is present', () => {
  const found = compassViolations({ turnEntries: turn(anchored), entries: turn(anchored), reply: anchored });
  assert.equal(found.some((violation) => /anchor/i.test(violation.kind)), false);
});

test('a tool-only turn with no text reply is never anchored-checked', () => {
  assert.deepEqual(compassViolations({ turnEntries: turn(''), entries: [], reply: '' }), []);
});
