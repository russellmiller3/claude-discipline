import assert from 'node:assert/strict';
import { evaluate, collectArmNames } from './experiment-ablation-required.mjs';

let passed = 0;
function test(name, runCase) { runCase(); passed++; console.log(`  ✓ ${name}`); }

const worker = 'C:/Users/rmill/Desktop/programming/marcus/scripts/exp147b_qwen_substrate.py';

// ---- true positives (BLOCK) -------------------------------------------------

test('blocks a worker whose --mask-mode choices are all treatments', () => {
  const content = `import argparse
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mask-mode", default="structured", choices=["structured", "strict"])
`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, true);
});

test('blocks a worker with an arms=[...] list of only treatments', () => {
  const content = `arms = [
    {"key": "walled-substrate", "label": "Walled"},
    {"key": "strict-cont", "label": "Continuous"},
]
`;
  const verdict = evaluate({ toolName: 'Write', filePath: worker, content });
  assert.equal(verdict.block, true);
  assert.ok(verdict.armNames.includes('walled-substrate'));
});

// ---- true negatives (PASS) --------------------------------------------------

test('passes when a control arm is present (no-wall)', () => {
  const content = `p.add_argument("--mask-mode", choices=["structured", "no-wall"])`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

test('passes exp147a-style arms with ablation controls', () => {
  const content = `p.add_argument("--mask-mode", choices=["structured", "no-wall", "random", "single-agent"])`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

test('passes a worker with NO enumerated arm set (nothing to judge)', () => {
  const content = `def run():\n    train_the_model()\n    return {"accuracy": 0.9}\n`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

test('passes a dispatcher (runpod_*) even with treatment-only choices', () => {
  const dispatcher = 'C:/x/scripts/runpod_exp147.py';
  const content = `p.add_argument("--arm", choices=["strict", "strict-cont", "substrate"])`;
  assert.equal(evaluate({ toolName: 'Write', filePath: dispatcher, content }).block, false);
});

test('passes a smoke file even with treatment-only choices', () => {
  const smoke = 'C:/x/scripts/exp147b_mask_smoke.py';
  const content = `p.add_argument("--mode", choices=["strict", "cont"])`;
  assert.equal(evaluate({ toolName: 'Write', filePath: smoke, content }).block, false);
});

test('passes a non-experiment file', () => {
  const helper = 'C:/x/scripts/utils.py';
  const content = `p.add_argument("--mode", choices=["a", "b"])`;
  assert.equal(evaluate({ toolName: 'Write', filePath: helper, content }).block, false);
});

test('passes with the override token', () => {
  const content = `# EXPERIMENT_ABLATION_REQUIRED_OK: pure measurement, no causal claim
p.add_argument("--mode", choices=["fast", "slow"])`;
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

test('ignores a --device choices list (not an arm arg)', () => {
  // --device is not an experimental arm; its choices shouldn't count OR trigger.
  const content = `p.add_argument("--device", choices=["cuda", "cpu"])`;
  assert.equal(collectArmNames(content).length, 0);
  assert.equal(evaluate({ toolName: 'Write', filePath: worker, content }).block, false);
});

// ---- fail-open --------------------------------------------------------------

test('fails open on empty / missing input', () => {
  assert.equal(evaluate({ toolName: 'Write', filePath: '', content: '' }).block, false);
  assert.equal(evaluate({}).block, false);
});

test('does not fire on Edit (Write-only)', () => {
  const content = `p.add_argument("--mask-mode", choices=["structured"])`;
  assert.equal(evaluate({ toolName: 'Edit', filePath: worker, content }).block, false);
});

console.log(`\n${passed} tests passed`);
