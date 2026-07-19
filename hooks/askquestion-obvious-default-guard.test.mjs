import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateObviousDefault } from './askquestion-obvious-default-guard.mjs';

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

// ALLOW: a paid decision genuinely needs Russell's go (cost-autonomy > $5).
test('ALLOWS a paid >$15 run decision even with a Recommended proceed option', () => {
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

// ALLOW: a genuine design fork with no Recommended option.
test('ALLOWS a genuine design fork with no Recommended option', () => {
  const fork = {
    questions: [{
      question: 'Which storage backend fits better here?',
      options: [
        { label: 'SQLite', description: 'Simple, single-file.' },
        { label: 'Postgres', description: 'Concurrent, heavier.' },
      ],
    }],
  };
  assert.equal(evaluateObviousDefault(fork), null);
});

// ALLOW: a Recommended PREFERENCE call with no proceed/no-op verb is a real taste question.
test('ALLOWS a Recommended preference (palette) with no proceed verb', () => {
  const palette = {
    questions: [{
      question: 'Which palette for the dashboard?',
      options: [
        { label: 'Teal-sand (Recommended)', description: 'Calm, high contrast.' },
        { label: 'Plum-cream', description: 'Warmer.' },
      ],
    }],
  };
  assert.equal(evaluateObviousDefault(palette), null);
});

// ALLOW: the explicit override token in the question text.
test('ALLOWS when the override token is present', () => {
  const overridden = {
    questions: [{
      question: 'Build the harness now? ASKQUESTION_OBVIOUS_OK — genuinely want your read first.',
      options: [
        { label: 'Build it (Recommended)', description: 'Free and reversible.' },
        { label: 'Wait', description: 'Hold.' },
      ],
    }],
  };
  assert.equal(evaluateObviousDefault(overridden), null);
});

// Non-question shapes never trip it.
test('ALLOWS malformed / empty input (fail-open)', () => {
  assert.equal(evaluateObviousDefault({}), null);
  assert.equal(evaluateObviousDefault({ questions: [] }), null);
  assert.equal(evaluateObviousDefault(null), null);
});
