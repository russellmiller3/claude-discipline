// Tests for experiment-propagation-required.mjs — when an experiment RESULT lands,
// the ledger surfaces must move in the SAME session: METHODS doc, truth ledger,
// NDA brief, priority board. Red-first: written before the hook.
//
//   node --test hooks/experiment-propagation-required.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landedResultSlugs, missingSurfaces, evaluate } from './experiment-propagation-required.mjs';

// ── transcript builders ──────────────────────────────────────────────────────
const bash = (command) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] });
const write = (filePath) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: filePath } }] });
const edit = (filePath) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: filePath } }] });
const say = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

// ── landedResultSlugs: which experiments produced a result this session ──────
test('a result file read counts as a landed result', () => {
  assert.deepEqual(landedResultSlugs([bash('cat runs/exp147e/results/opaque-seed0-results.jsonl')]), ['exp147e']);
});
test('a per-seed result json counts', () => {
  assert.deepEqual(landedResultSlugs([bash('py -3 -c "json.load(open(\'runs/exp169a/marcus-seed0.json\'))"')]), ['exp169a']);
});
test('a plain script edit does NOT count as a landed result', () => {
  assert.deepEqual(landedResultSlugs([write('scripts/exp147e_opaque_value_tools.py')]), []);
});
test('reading a plan does NOT count', () => {
  assert.deepEqual(landedResultSlugs([bash('cat plans/169-first-programs.md')]), []);
});
test('multiple experiments are all detected', () => {
  const slugs = landedResultSlugs([
    bash('cat runs/exp147e/results/x-results.jsonl'),
    bash('cat runs/exp169a/marcus-seed1.json'),
  ]);
  assert.equal(slugs.length, 2);
});

// ── missingSurfaces: which ledger surfaces were NOT touched ──────────────────
test('nothing touched -> all four surfaces missing', () => {
  const missing = missingSurfaces([], 'exp147e');
  assert.equal(missing.length, 4);
});
test('METHODS doc for the right experiment counts', () => {
  const missing = missingSurfaces([write('docs/exp147e-opaque-value-tools-METHODS.md')], 'exp147e');
  assert.ok(!missing.includes('METHODS doc'));
});
test('a METHODS doc for a DIFFERENT experiment does not count', () => {
  const missing = missingSurfaces([write('docs/exp169a-variable-tracking-METHODS.md')], 'exp147e');
  assert.ok(missing.includes('METHODS doc'));
});
test('truth ledger edit counts', () => {
  const missing = missingSurfaces([edit('Marcus-Truth.md')], 'exp147e');
  assert.ok(!missing.includes('truth ledger'));
});
test('NDA brief edit counts', () => {
  const missing = missingSurfaces([edit('docs/LAB-BRIEF-NDA.html')], 'exp147e');
  assert.ok(!missing.includes('NDA brief'));
});
test('priority board edit counts', () => {
  const missing = missingSurfaces([edit('docs/LAB-PRIORITY-BOARD.html')], 'exp147e');
  assert.ok(!missing.includes('priority board'));
});
test('all four touched -> nothing missing', () => {
  const missing = missingSurfaces([
    write('docs/exp147e-opaque-value-tools-METHODS.md'),
    edit('Marcus-Truth.md'),
    edit('docs/LAB-BRIEF-NDA.html'),
    edit('docs/LAB-PRIORITY-BOARD.html'),
  ], 'exp147e');
  assert.deepEqual(missing, []);
});

// ── evaluate: Stop-time verdict ──────────────────────────────────────────────
test('Stop: BLOCK when a result landed and no surface moved', () => {
  const verdict = evaluate({ entries: [bash('cat runs/exp147e/results/a-results.jsonl')] });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /exp147e/);
});
test('Stop: ALLOW when every surface moved', () => {
  const verdict = evaluate({ entries: [
    bash('cat runs/exp147e/results/a-results.jsonl'),
    write('docs/exp147e-tools-METHODS.md'),
    edit('Marcus-Truth.md'),
    edit('docs/LAB-BRIEF-NDA.html'),
    edit('docs/LAB-PRIORITY-BOARD.html'),
  ] });
  assert.equal(verdict.block, false);
});
test('Stop: ALLOW when no result landed at all', () => {
  assert.equal(evaluate({ entries: [write('scripts/exp147e_worker.py')] }).block, false);
});
test('Stop: escape token clears the block', () => {
  const verdict = evaluate({
    entries: [bash('cat runs/exp147e/results/a-results.jsonl')],
    replyText: 'still training EXPERIMENT_PROPAGATION_OK',
  });
  assert.equal(verdict.block, false);
});
test('Stop: never loops when stop_hook_active', () => {
  const verdict = evaluate({
    entries: [bash('cat runs/exp147e/results/a-results.jsonl')],
    stopHookActive: true,
  });
  assert.equal(verdict.block, false);
});
test('Stop: env override clears the block', () => {
  const verdict = evaluate({
    entries: [bash('cat runs/exp147e/results/a-results.jsonl')],
    envOk: true,
  });
  assert.equal(verdict.block, false);
});
test('the block message names every missing surface', () => {
  const verdict = evaluate({ entries: [
    bash('cat runs/exp147e/results/a-results.jsonl'),
    write('docs/exp147e-tools-METHODS.md'),
  ] });
  // Assert on the "still missing:" line, not the whole message — the WHY
  // narrative legitimately mentions METHODS docs while explaining the failure.
  const missingLine = verdict.reason.split('\n').find((line) => line.includes('still missing:'));
  assert.match(missingLine, /truth ledger/i);
  assert.match(missingLine, /NDA brief/i);
  assert.match(missingLine, /priority board/i);
  assert.doesNotMatch(missingLine, /METHODS doc/);
});
