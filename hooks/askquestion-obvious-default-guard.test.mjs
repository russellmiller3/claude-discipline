import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateObviousDefault } from './askquestion-obvious-default-guard.mjs';

test('canonical installer permanently registers the destructive-only question guard', () => {
  const settings = JSON.parse(readFileSync(new URL('../settings.fragment.json', import.meta.url), 'utf8'));
  assert.deepEqual(settings.tier3_opinionated['askquestion-obvious-default-guard'], [
    { event: 'PreToolUse', matcher: 'AskUserQuestion', timeout: 5 },
  ]);
});

// The exact 2026-07-16 failure: two questions whose Recommended option was the do-what-makes-sense answer.
test('BLOCKS the two-question live failure (Build harness / Leave parked, both Recommended)', () => {
  const sequencing = {
    questions: [{
      question: 'How should I sequence Plan 155 from here?',
      options: [
        { label: 'Build free harness (Phases 2-5) (Recommended)', description: 'Free, reversible, the obvious next step.' },
        { label: 'Wait for a paid decision', description: 'Pause here.' },
      ],
    }],
  };
  assert.notEqual(evaluateObviousDefault(sequencing), null);

  const parked = {
    questions: [{
      question: 'The parked librarian_acceptance test — what do you want done?',
      options: [
        { label: 'Leave parked (Recommended)', description: 'The obvious no-op default.' },
        { label: 'Rewrite it now', description: 'More work.' },
      ],
    }],
  };
  assert.notEqual(evaluateObviousDefault(parked), null);
});

// Russell 2026-07-26: paid questions are allowed only when an explicit estimate exceeds the $5 budget gate.
test('ALLOWS an explicit $18 estimate above the budget restriction', () => {
  const paid = {
    questions: [{
      question: 'Kick off the $18 sweep now?',
      options: [
        { label: 'Proceed with the run (Recommended)', description: 'Spend ~$18, get results tonight.' },
        { label: 'Hold', description: 'Wait.' },
      ],
    }],
  };
  assert.equal(evaluateObviousDefault(paid), null);
});

test('BLOCKS vague paid questions and estimates at or below $5', () => {
  for (const question of ['Run the paid sweep?', 'Run the $5 sweep?', 'This costs money. Proceed?']) {
    assert.notEqual(evaluateObviousDefault({ questions: [{ question, options: [] }] }), null);
  }
});

// ALLOW: a destructive/irreversible action is always a real question.
test('ALLOWS a destructive action question', () => {
  const destructive = {
    questions: [{
      question: 'Force-push the rewritten history to origin?',
      options: [
        { label: 'Force-push now (Recommended)', description: 'Overwrite the remote branch.' },
        { label: 'Abort', description: 'Keep the remote as-is.' },
      ],
    }],
  };
  assert.equal(evaluateObviousDefault(destructive), null);
});

test('BLOCKS a genuine design fork and requires best judgment', () => {
  const fork = {
    questions: [{
      question: 'Which storage backend fits better here?',
      options: [
        { label: 'SQLite', description: 'Simple, single-file.' },
        { label: 'Postgres', description: 'Concurrent, heavier.' },
      ],
    }],
  };
  assert.notEqual(evaluateObviousDefault(fork), null);
});

test('BLOCKS a preference question and requires best judgment', () => {
  const palette = {
    questions: [{
      question: 'Which palette for the dashboard?',
      options: [
        { label: 'Teal-sand (Recommended)', description: 'Calm, high contrast.' },
        { label: 'Plum-cream', description: 'Warmer.' },
      ],
    }],
  };
  assert.notEqual(evaluateObviousDefault(palette), null);
});

test('BLOCKS a non-destructive question even when it contains the old override token', () => {
  const overridden = {
    questions: [{
      question: 'Build the harness now? ASKQUESTION_OBVIOUS_OK — genuinely want your read first.',
      options: [
        { label: 'Build it (Recommended)', description: 'Free and reversible.' },
        { label: 'Wait', description: 'Hold.' },
      ],
    }],
  };
  assert.notEqual(evaluateObviousDefault(overridden), null);
});

test('BLOCKS browser-permission, deploy, and external-send questions', () => {
  for (const question of [
    'May I open a fresh Chrome window?',
    'Deploy the Worker now?',
    'Send the finished report to the customer?',
  ]) {
    assert.notEqual(evaluateObviousDefault({ questions: [{ question, options: [] }] }), null);
  }
});

// Non-question shapes never trip it.
test('ALLOWS malformed / empty input (fail-open)', () => {
  assert.equal(evaluateObviousDefault({}), null);
  assert.equal(evaluateObviousDefault({ questions: [] }), null);
  assert.equal(evaluateObviousDefault(null), null);
});
