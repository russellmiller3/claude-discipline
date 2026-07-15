// Tests for smoke-script-bounds-guard's pure primitives and its end-to-end
// PreToolUse deny/allow behavior. Run: node --test smoke-script-bounds-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { hasExplicitSmallBound, isSmokeScript } from './smoke-script-bounds-guard.mjs';

const hookPath = join(fileURLToPath(new URL('.', import.meta.url)), 'smoke-script-bounds-guard.mjs');

function runHook(filePath, content) {
  const run = spawnSync('node', [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: filePath, content },
    }),
    encoding: 'utf8',
  });
  return run.stdout || '';
}

function isDenied(hookStdout) {
  return /"permissionDecision"\s*:\s*"deny"/.test(hookStdout);
}

test('isSmokeScript matches filenames containing "smoke" with a code extension', () => {
  assert.equal(isSmokeScript('scripts/smoke_exp150_deranged.py'), true);
  assert.equal(isSmokeScript('scripts/exp150-smoke.mjs'), true);
  assert.equal(isSmokeScript('SMOKE_test.sh'), true);
});

test('isSmokeScript ignores non-smoke names and non-code extensions', () => {
  assert.equal(isSmokeScript('scripts/run_exp150.py'), false);
  assert.equal(isSmokeScript('docs/smoke-plan.md'), false);
  assert.equal(isSmokeScript(''), false);
});

test('the motivating incident: MAX_EPOCHS = 2 alone is NOT evidence of a small bound', () => {
  const source = `
MAX_EPOCHS = 2
train_writer_seed(seed=1337, checkpoint_root=root, device_name="cpu", resume=False)
`;
  assert.equal(hasExplicitSmallBound(source), false);
});

test('a bounded slice on the actual batch list IS evidence', () => {
  const source = `
oracle_epoch_batches = lambda *, epoch: _real(epoch=epoch)[:2]
train_writer_seed(seed=1337)
`;
  assert.equal(hasExplicitSmallBound(source), true);
});

test('a plain small slice anywhere counts', () => {
  assert.equal(hasExplicitSmallBound('rows = all_rows[:5]\ntrain(rows)'), true);
});

test('a --steps or max_epochs flag/counter alone does NOT count, even with a small number', () => {
  assert.equal(hasExplicitSmallBound('subprocess.run(["py", "run.py", "--steps", "2"])'), false);
  assert.equal(hasExplicitSmallBound('command = "run.py --max-epochs 1"'), false);
  assert.equal(hasExplicitSmallBound('max_epochs = 1'), false);
});

test('a large slice bound does not count (not actually small)', () => {
  assert.equal(hasExplicitSmallBound('rows = all_rows[:5000]'), false);
});

test('an explicit wall-clock self-guard counts even with no small literal', () => {
  assert.equal(hasExplicitSmallBound('if time.monotonic() - started > max_seconds: break'), true);
});

test('end-to-end: DENIES a real smoke script shaped exactly like the motivating incident', () => {
  const hookDecision = runHook('scripts/smoke_exp150_deranged.py', 'MAX_EPOCHS = 2\ntrain_writer_seed(seed=1337)\n');
  assert.equal(isDenied(hookDecision), true);
  assert.match(hookDecision, /SMOKE SCRIPT HAS NO VISIBLE SMALL BOUND/);
});

test('end-to-end ALLOW: a smoke script with a real bounded slice is not denied', () => {
  const hookDecision = runHook(
    'scripts/smoke_exp150_deranged.py',
    'oracle_epoch_batches = lambda *, epoch: _real(epoch=epoch)[:2]\ntrain_writer_seed(seed=1337)\n',
  );
  assert.equal(hookDecision, '');
});

test('end-to-end ALLOW: an ordinary non-smoke script is never inspected, regardless of content', () => {
  const hookDecision = runHook('scripts/run_exp150.py', 'MAX_EPOCHS = 100\ntrain_writer_seed(seed=1337)\n');
  assert.equal(hookDecision, '');
});

test('end-to-end ALLOW: a smoke MARKDOWN plan is not code, so it is never inspected', () => {
  const hookDecision = runHook('plans/151-gpu-smoke-plan.md', 'MAX_EPOCHS = 2\n');
  assert.equal(hookDecision, '');
});

test('end-to-end ALLOW: SMOKE_BOUNDS_GUARD_OVERRIDE=1 lets an unbounded smoke script through', () => {
  const run = spawnSync('node', [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'scripts/smoke_exp150_deranged.py', content: 'MAX_EPOCHS = 2\n' },
    }),
    encoding: 'utf8',
    env: { ...process.env, SMOKE_BOUNDS_GUARD_OVERRIDE: '1' },
  });
  assert.equal(run.stdout || '', '');
});
