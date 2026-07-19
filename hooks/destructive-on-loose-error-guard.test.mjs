import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { flagsDestructiveOnLooseError } from './destructive-on-loose-error-guard.mjs';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'destructive-on-loose-error-guard.mjs');

// (a) BLOCKS the exact incident shape.
test('BLOCKS a destroy gated on "still" in str(error)', () => {
  assert.equal(flagsDestructiveOnLooseError('if "still" in str(error):\n    provider.delete_resource(pod_id)'), true);
});
test('BLOCKS the same-line form', () => {
  assert.equal(flagsDestructiveOnLooseError('if "exited" in str(error) or "still" in str(error): provider.delete_resource(p)'), true);
});
test('BLOCKS a JS error.message.includes gating a delete within a few lines', () => {
  assert.equal(flagsDestructiveOnLooseError('if (error.message.includes("crashed")) {\n  await pod.terminate();\n}'), true);
});

// (b) single/loose token still blocks unless the override is present.
test('BLOCKS a single-token substring destroy without the override', () => {
  assert.equal(flagsDestructiveOnLooseError('if "exited" in str(error):\n    delete_pod(pod_id)'), true);
});

// (c) a destructive call NOT gated on an error string is fine (normal teardown).
test('ALLOWS a plain teardown not gated on an error substring', () => {
  assert.equal(flagsDestructiveOnLooseError('def finalize(pod):\n    rescue_results(pod)\n    provider.delete_resource(pod.id)'), false);
});

// (d) a substring-in-error check with NO destructive verb near it (logging) is fine.
test('ALLOWS a substring-in-error check used only for logging', () => {
  assert.equal(flagsDestructiveOnLooseError('if "still" in str(error):\n    log.info("job still attached, waiting")'), false);
});

// (e) the override clears it.
test('ALLOWS with LOOSE_ERROR_DESTROY_OK', () => {
  assert.equal(flagsDestructiveOnLooseError('# LOOSE_ERROR_DESTROY_OK: this function raises exactly one error string\nif "exited" in str(error):\n    delete_pod(pod_id)'), false);
});

// (f) proximity: a destroy far away (>6 lines) from the loose check does not couple.
test('does NOT couple a destroy that is far from the loose check', () => {
  const far = 'if "still" in str(error):\n    pass\n' + 'x = 1\n'.repeat(8) + 'provider.delete_resource(p)';
  assert.equal(flagsDestructiveOnLooseError(far), false);
});

// End-to-end: the hook denies a matching Edit via stdin, fail-open on malformed input.
function runHook(newString, toolName = 'Edit') {
  const input = toolName === 'Write'
    ? { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'x.py', content: newString } }
    : { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'x.py', new_string: newString } };
  const run = spawnSync(process.execPath, [hookPath], { input: JSON.stringify(input), encoding: 'utf8' });
  return run;
}
const denied = (run) => /"permissionDecision"\s*:\s*"deny"/.test(run.stdout || '');

test('end-to-end: DENIES a matching Edit, fails open on malformed input', () => {
  assert.equal(denied(runHook('if "still" in str(error):\n    provider.delete_resource(p)')), true);
  assert.equal(denied(runHook('rescue_results(p)\nprovider.delete_resource(p.id)')), false);
  const malformed = spawnSync(process.execPath, [hookPath], { input: 'not json', encoding: 'utf8' });
  assert.equal(malformed.status, 0);
  assert.equal((malformed.stdout || '').trim(), '');
});
