// Tests for experiment-name-gloss.mjs — a bare experiment number in a reply to
// Russell must carry a plain-English gloss of what the experiment DOES.
// Red-first: written before the hook.
//
//   node --test hooks/experiment-name-gloss.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bareExperimentMentions, evaluate } from './experiment-name-gloss.mjs';

// ── detection: which mentions lack a gloss ───────────────────────────────────
test('a bare number with no gloss is flagged', () => {
  assert.deepEqual(bareExperimentMentions('exp147e is launching now'), ['exp147e']);
});
test('a glossed mention is NOT flagged', () => {
  const glossed = 'the opaque-value tool run (exp147e) — the tool answer is the only path — is launching';
  assert.deepEqual(bareExperimentMentions(glossed), []);
});
test('a gloss BEFORE the number counts', () => {
  assert.deepEqual(bareExperimentMentions('the variable-tracking first program (exp169a) is training'), []);
});
test('a gloss AFTER the number counts', () => {
  assert.deepEqual(bareExperimentMentions('exp169a, the variable-tracking first program, is training'), []);
});
test('multiple bare numbers are all flagged', () => {
  const mentions = bareExperimentMentions('exp147e finished and exp169a is next');
  assert.equal(mentions.length, 2);
});
test('shorthand without the exp prefix is caught (169a)', () => {
  assert.deepEqual(bareExperimentMentions('169a looks good'), ['169a']);
});
test('a plain number that is not an experiment is ignored', () => {
  assert.deepEqual(bareExperimentMentions('it took 45 seconds and cost $5.30'), []);
});
test('a file path mention is not a chat claim', () => {
  assert.deepEqual(bareExperimentMentions('see scripts/exp147e_opaque_value_tools.py'), []);
});
test('a URL mention is not a chat claim', () => {
  assert.deepEqual(bareExperimentMentions('open http://localhost:8171/docs/exp169a-live.html'), []);
});

// ── evaluate: Stop-time verdict ──────────────────────────────────────────────
test('Stop: BLOCK a reply with a bare experiment number', () => {
  const verdict = evaluate({ replyText: 'exp147e is at step 1950 and looks good' });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /exp147e/);
});
test('Stop: ALLOW a reply that glosses every mention', () => {
  const verdict = evaluate({
    replyText: 'the lying-tool control fix (exp147e) is at step 1950',
  });
  assert.equal(verdict.block, false);
});
test('Stop: ALLOW a reply with no experiment mentions at all', () => {
  assert.equal(evaluate({ replyText: 'tests are green, committed' }).block, false);
});
test('Stop: escape token clears the block', () => {
  const verdict = evaluate({ replyText: 'exp147e done EXPERIMENT_NAME_GLOSS_OK' });
  assert.equal(verdict.block, false);
});
test('Stop: never loops when stop_hook_active', () => {
  const verdict = evaluate({ replyText: 'exp147e done', stopHookActive: true });
  assert.equal(verdict.block, false);
});
test('Stop: env override clears the block', () => {
  assert.equal(evaluate({ replyText: 'exp147e done', envOk: true }).block, false);
});
