import assert from 'node:assert/strict';
import { evaluate, heldOutListSizes, splitTopLevel } from './experiment-statistical-rigor-guard.mjs';

let passed = 0;
function test(name, runCase) { runCase(); passed++; console.log(`  ✓ ${name}`); }

const worker = 'C:/Users/rmill/Desktop/programming/marcus/scripts/exp167d_spawn_judgment_arms.py';

// ---- splitTopLevel -----------------------------------------------------------

test('splitTopLevel counts flat elements', () => {
  assert.deepEqual(splitTopLevel('"a", "b", "c"'), ['"a"', '"b"', '"c"']);
});

test('splitTopLevel does not split inside nested brackets', () => {
  assert.deepEqual(splitTopLevel('{"key": "a", "n": 1}'), ['{"key": "a", "n": 1}']);
});

test('splitTopLevel handles a single element', () => {
  assert.deepEqual(splitTopLevel('QUERY_GARBLED_HELD_OUT'), ['QUERY_GARBLED_HELD_OUT']);
});

test('splitTopLevel handles empty body as zero elements', () => {
  assert.deepEqual(splitTopLevel(''), []);
});

// ---- heldOutListSizes ---------------------------------------------------------

test('finds a HELD_OUT list literal and counts its elements', () => {
  const content = 'HELD_OUT_SOLVABLE = [QUERY_SLICE2_THRESHOLD, QUERY_SLICE2_THRESHOLD_B]\n';
  assert.deepEqual(heldOutListSizes(content), [{ name: 'HELD_OUT_SOLVABLE', count: 2 }]);
});

test('finds a single-element HELD_OUT list', () => {
  const content = 'HELD_OUT_SOLVABLE = [QUERY_SLICE2_THRESHOLD]\n';
  assert.deepEqual(heldOutListSizes(content), [{ name: 'HELD_OUT_SOLVABLE', count: 1 }]);
});

test('finds a tuple-form HELD_OUT literal', () => {
  const content = 'held_out_tokens = ("foo", "bar")\n';
  assert.deepEqual(heldOutListSizes(content), [{ name: 'held_out_tokens', count: 2 }]);
});

test('does not match a derived (non-literal) HELD_OUT name', () => {
  const content = 'HELD_OUT_QUERIES = HELD_OUT_SOLVABLE + HELD_OUT_GARBLED\n';
  assert.deepEqual(heldOutListSizes(content), []);
});

test('counts spread-concatenation lists by literal element count', () => {
  const content = 'HELD_OUT_QUERIES = [*HELD_OUT_SOLVABLE, *HELD_OUT_GARBLED]\n';
  assert.deepEqual(heldOutListSizes(content), [{ name: 'HELD_OUT_QUERIES', count: 2 }]);
});

// ---- true positives (BLOCK) --------------------------------------------------

test('blocks a worker with a single-element HELD_OUT list', () => {
  const content = `import torch
HELD_OUT_SOLVABLE = [QUERY_SLICE2_THRESHOLD]
parser.add_argument("--seed", type=int, default=0)
`;
  const verdict = evaluate({ toolName: 'Write', filePath: worker, content });
  assert.equal(verdict.block, true);
  assert.equal(verdict.reasonKind, 'undersized-held-out');
});

test('blocks a torch CLI worker with no --seed flag', () => {
  const content = `import torch
import argparse
p = argparse.ArgumentParser()
p.add_argument("--steps", type=int, default=1000)
`;
  const verdict = evaluate({ toolName: 'Write', filePath: worker, content });
  assert.equal(verdict.block, true);
  assert.equal(verdict.reasonKind, 'no-seed-flag');
});

test('blocks on Edit too, not just Write', () => {
  const content = `HELD_OUT_GARBLED = [QUERY_GARBLED_HELD_OUT]\n`;
  assert.equal(evaluate({ toolName: 'Edit', filePath: worker, content }).block, true);
});

// ---- true negatives (PASS) ---------------------------------------------------

test('passes the current (fixed) exp167d-style held-out lists', () => {
  const content = `import torch
HELD_OUT_SOLVABLE = [QUERY_SLICE2_THRESHOLD, QUERY_SLICE2_THRESHOLD_B]
HELD_OUT_GARBLED = [QUERY_GARBLED_HELD_OUT, QUERY_GARBLED_HELD_OUT_B]
HELD_OUT_QUERIES = [*HELD_OUT_SOLVABLE, *HELD_OUT_GARBLED]
parser.add_argument("--seed", type=int, default=0)
`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

test('passes a non-torch worker with no --seed (nothing stochastic to seed)', () => {
  const content = `import argparse
p = argparse.ArgumentParser()
p.add_argument("--steps", type=int, default=1000)
`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

test('passes a worker with no HELD_OUT constants and no argparse at all', () => {
  const content = `def run():\n    train_the_model()\n    return {"accuracy": 0.9}\n`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

test('passes a dispatcher (runpod_*) even with a single-element held-out list', () => {
  const dispatcher = 'C:/x/scripts/runpod_exp147.py';
  const content = `HELD_OUT_SOLVABLE = [QUERY_A]\n`;
  assert.equal(evaluate({ toolName: 'Write', filePath: dispatcher, content }).block, false);
});

test('passes a smoke file even with a single-element held-out list', () => {
  const smoke = 'C:/x/scripts/exp147b_mask_smoke.py';
  const content = `HELD_OUT_SOLVABLE = [QUERY_A]\n`;
  assert.equal(evaluate({ toolName: 'Write', filePath: smoke, content }).block, false);
});

test('passes a non-experiment file', () => {
  const helper = 'C:/x/scripts/utils.py';
  const content = `HELD_OUT_SOLVABLE = [QUERY_A]\n`;
  assert.equal(evaluate({ toolName: 'Write', filePath: helper, content }).block, false);
});

test('passes with the override token (undersized case)', () => {
  const content = `# EXPERIMENT_STATS_RIGOR_OK: single-item smoke, no generalization claim
HELD_OUT_SOLVABLE = [QUERY_A]
`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

test('passes with the override token (no-seed case)', () => {
  const content = `# EXPERIMENT_STATS_RIGOR_OK: deterministic, nothing to seed
import torch
p.add_argument("--steps", type=int, default=1000)
`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

// ---- fail-open ----------------------------------------------------------------

test('fails open on empty / missing input', () => {
  assert.equal(evaluate({ toolName: 'Write', filePath: '', content: '' }).block, false);
  assert.equal(evaluate({}).block, false);
});

test('does not fire on Read/Bash (Write|Edit-only)', () => {
  const content = `HELD_OUT_SOLVABLE = [QUERY_A]\n`;
  assert.equal(evaluate({ toolName: 'Read', filePath: worker, content }).block, false);
  assert.equal(evaluate({ toolName: 'Bash', filePath: worker, content }).block, false);
});

console.log(`\n${passed} tests passed`);
