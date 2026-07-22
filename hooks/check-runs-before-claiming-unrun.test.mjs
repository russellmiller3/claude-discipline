/**
 * Tests for check-runs-before-claiming-unrun.mjs
 *
 * The bug this hook prevents (twice in one session, 2026-07-21):
 *   1. Claimed "exp149b seeds 1-2 still open (~$3)" -- all three seeds had landed.
 *   2. Claimed "the scrambled-tool control never landed (CUDA-OOM), ~$0.50 to
 *      close" -- it HAD run and had FAILED its key gate, which is far worse than
 *      a gap and was about to be told to a buyer.
 * Both came from quoting a frozen plan doc instead of checking runs/ on disk.
 *
 * Run: node --test check-runs-before-claiming-unrun.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './check-runs-before-claiming-unrun.mjs';

// A fake "runs/" listing: what exists on disk.
const RUNS_ON_DISK = [
  'exp149b-full-seed0', 'exp149b-full-seed1', 'exp149b-full-seed2',
  'exp147c-scrambled-seed0', 'exp148d-full-seed0', 'exp153', 'exp152',
];

const opts = { runsIndex: RUNS_ON_DISK };

// ---- DENY: the exact two mistakes from 2026-07-21 -------------------------

test('DENY: claims a control never landed when its run dir exists', () => {
  const verdict = evaluate({
    toolName: 'Write',
    filePath: 'docs/LAB-BRIEF-NDA.html',
    content: 'The exp147c scrambled-tool control never landed (CUDA-OOM). ~$0.50 to close.',
  }, opts);
  assert.equal(verdict.block, true);
  assert.equal(verdict.experiment, 'exp147c');
});

test('DENY: claims seeds are still open when their run dirs exist', () => {
  const verdict = evaluate({
    toolName: 'Edit',
    filePath: 'Marcus-Truth.md',
    new_string: '| exp149b seeds 1-2 | ~$3 | still open, takes P4 from 1 seed to 3 |',
  }, opts);
  assert.equal(verdict.block, true);
  assert.equal(verdict.experiment, 'exp149b');
});

test('DENY: "not started" phrasing is caught too', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: 'HANDOFF.md',
    content: 'exp153 is not started yet.',
  }, opts);
  assert.equal(verdict.block, true);
});

test('DENY: "no result" phrasing is caught too', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: 'docs/x-METHODS.md',
    content: 'There is no result for exp152 on disk.',
  }, opts);
  assert.equal(verdict.block, true);
});

// ---- ALLOW (must-not-over-fire) -------------------------------------------

test('allows an unrun claim when the experiment genuinely has NO run dir', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: 'HANDOFF.md',
    content: 'exp999 has not started — no worker written yet.',
  }, opts);
  assert.equal(verdict.block, false);
});

test('allows describing a run that DID happen, with a result', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: 'Marcus-Truth.md',
    content: 'exp147c scrambled control RAN and failed its key gate: routing 1.00/0.97.',
  }, opts);
  assert.equal(verdict.block, false);
});

test('allows an unrun claim about a FUTURE experiment sharing a prefix', () => {
  // exp147c exists on disk; exp147z does not. Must not match by prefix.
  const verdict = evaluate({
    toolName: 'Write', filePath: 'HANDOFF.md',
    content: 'exp147z has never been run.',
  }, opts);
  assert.equal(verdict.block, false);
});

test('allows unrelated prose that merely contains the words', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: 'README.md',
    content: 'The scheduler has not started any sub-agents in this diagram.',
  }, opts);
  assert.equal(verdict.block, false);
});

test('allows a NON-doc file even with matching text', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: 'scripts/exp147c_qwen_tools.py',
    content: '# exp149b never landed in this branch',
  }, opts);
  assert.equal(verdict.block, false);
});

test('allows when the runs-verified escape token is present', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: 'Marcus-Truth.md',
    content: 'exp149b seeds 1-2 never landed. runs-verified: checked runs/, only seed0 present.',
  }, opts);
  assert.equal(verdict.block, false);
});

test('does not fire on non-Write/Edit tools', () => {
  const verdict = evaluate({
    toolName: 'Read', filePath: 'Marcus-Truth.md',
    content: 'exp149b never landed',
  }, opts);
  assert.equal(verdict.block, false);
});

test('fails open on empty or malformed input', () => {
  assert.equal(evaluate({}, opts).block, false);
  assert.equal(evaluate({ toolName: 'Write' }, opts).block, false);
  assert.equal(evaluate({ toolName: 'Write', filePath: 'a.md', content: '' }, opts).block, false);
});

test('fails open when the runs index cannot be read', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: 'Marcus-Truth.md',
    content: 'exp149b never landed.',
  }, { runsIndex: null });
  assert.equal(verdict.block, false);
});
