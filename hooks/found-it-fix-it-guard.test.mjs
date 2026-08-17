/**
 * The failure this guard exists for, and the ordinary sentences it must ignore.
 *
 * The real reply that triggered the rule (2026-08-17): a red test was found,
 * diagnosed as pre-existing, and handed off with "but it's a separate concern
 * from what I'm working on." Russell: "No. Never. If you see something, it's
 * your problem, and you're going to fucking fix it, not pass the buck."
 *
 * A guard that fires on any use of the phrase would be useless — engineers say
 * "separation of concerns" constantly — so the FALSE-POSITIVE cases below carry
 * as much weight as the true ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findBuckPassing } from './found-it-fix-it-guard.mjs';

test('fires on the exact reply that caused the rule', () => {
  const reply = 'My two tests pass. The single failure is a registration test '
    + 'that was already red before my change, but it\'s a separate concern from '
    + 'what I\'m working on.';
  assert.ok(findBuckPassing(reply), 'the originating buck-pass must be caught');
});

test('fires on "pre-existing, not mine"', () => {
  const reply = 'That suite is red. It is pre-existing and therefore not mine.';
  assert.ok(findBuckPassing(reply));
});

test('fires on deferring a found bug to a later session', () => {
  const reply = 'Found a regression in the parser. Leaving it for the next session.';
  assert.ok(findBuckPassing(reply));
});

test('fires on "not caused by my change"', () => {
  const reply = 'The build breaks on Windows. Not caused by my change.';
  assert.ok(findBuckPassing(reply));
});

test('stays quiet when the defect is FIXED in the same turn', () => {
  const reply = 'That test was red for an unrelated reason — a stale assertion. '
    + 'Fixed it, 30 passed, 0 failed.';
  assert.equal(findBuckPassing(reply), null, 'naming a bug you fixed is the goal, not the failure');
});

test('stays quiet on ordinary separation-of-concerns design talk', () => {
  const reply = 'Caching is a separate concern from parsing, so it lives in its '
    + 'own module and the parser stays pure.';
  assert.equal(findBuckPassing(reply), null, 'design vocabulary must not trip this');
});

test('stays quiet when the deferral is one Russell actually allows', () => {
  const reply = 'The migration would be irreversible and drop the receipts table, '
    + 'so that broken column stays until you say otherwise.';
  assert.equal(findBuckPassing(reply), null, 'a named destructive risk is a legitimate deferral');
});

test('stays quiet when the deferral is a real budget ceiling', () => {
  const reply = 'Re-running the failed sweep to fix that would cost about $40, '
    + 'over the standing ceiling.';
  assert.equal(findBuckPassing(reply), null);
});

test('stays quiet on an empty or absent reply', () => {
  assert.equal(findBuckPassing(''), null);
  assert.equal(findBuckPassing(undefined), null);
});

test('stays quiet on disowning language with NO defect named', () => {
  // "Out of scope for this" about a feature request is scope discipline, which
  // Russell explicitly wants — it is only buck-passing when a defect is in play.
  const reply = 'Adding dark mode is out of scope for this change; the ask was the login form.';
  assert.equal(findBuckPassing(reply), null);
});

test('committing UNRELATED work is not evidence the defect was handled', () => {
  // The escape found by red-teaming this hook: almost every working reply says
  // "committed" or "landed" about something, so accepting those as proof of
  // handling let the buck-pass straight through.
  const reply = 'Committed the docs and landed the branch. The failing suite is '
    + 'a separate issue.';
  assert.ok(
    findBuckPassing(reply),
    'proof that OTHER work shipped must not excuse disowning the defect',
  );
});

test('DOCUMENTING the rule does not trip it', () => {
  // Found by red-teaming this hook: explaining it quotes its own trigger words
  // beside a defect word, so the clearer the explanation the more certainly it
  // fired. ross-perot-guard hit the identical trap in 2026-06-25.
  const reply = 'The guard blocks phrases like `is a separate issue` when the '
    + 'reply also names something `broken`. Here is the shape it catches:\n'
    + '```\nThe suite is broken. That is a separate issue.\n```\n'
    + 'Everything else passes through untouched.';
  assert.equal(
    findBuckPassing(reply),
    null,
    'quoted triggers in code spans and fences must not fire the guard',
  );
});

test('the refusal quotes the offending phrase back', () => {
  const quote = findBuckPassing('The suite is broken. That is a separate issue.');
  assert.match(String(quote), /separate issue/i, 'the operator must see which sentence tripped it');
});
