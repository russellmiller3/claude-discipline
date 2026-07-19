import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { flagsDestructiveByDefault } from './destructive-safe-by-default-guard.mjs';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'destructive-safe-by-default-guard.mjs');

// (a) the exact incident: a "check" script that lists then deletes ALL pods unconditionally.
test('BLOCKS a script that loops delete_resource over all listed pods with no confirm flag', () => {
  const content = [
    'pods = list_pods()',
    'print("LIVE PODS:", [p.id for p in pods])',
    'for p in pods:',
    '    provider.delete_resource(p.id)',
  ].join('\n');
  assert.equal(flagsDestructiveByDefault(content), true);
});
test('BLOCKS an unconditional rm -rf / rmtree', () => {
  assert.equal(flagsDestructiveByDefault('import shutil\nshutil.rmtree(target_dir)'), true);
  assert.equal(flagsDestructiveByDefault('rm -rf "$WORKDIR"'), true);
});

// (b) ALLOWS the same destroy when gated behind an explicit confirm flag.
test('ALLOWS a delete gated behind an explicit --confirm-delete flag', () => {
  const content = [
    'import sys',
    'pods = list_pods()',
    'if "--confirm-delete" in sys.argv:',
    '    for p in pods:',
    '        provider.delete_resource(p.id)',
    'else:',
    '    print("LIVE PODS (dry-run):", [p.id for p in pods])',
  ].join('\n');
  assert.equal(flagsDestructiveByDefault(content), false);
});
test('ALLOWS a delete gated behind --yes / --force / CONFIRM env', () => {
  assert.equal(flagsDestructiveByDefault('if args.yes:\n    pod.delete()'), false);
  assert.equal(flagsDestructiveByDefault('if "--force" in sys.argv:\n    shutil.rmtree(d)'), false);
  assert.equal(flagsDestructiveByDefault('if os.environ.get("CONFIRM") == "1":\n    os.remove(f)'), false);
});

// (c) a pure list/read script is fine.
test('ALLOWS a pure list/read script (no destructive op)', () => {
  const content = 'pods = list_pods()\nprint("LIVE PODS:", [p.id for p in pods])';
  assert.equal(flagsDestructiveByDefault(content), false);
});

// (d) the override clears it.
test('ALLOWS with destructive-default-ok', () => {
  const content = '# destructive-default-ok: throwaway test fixture teardown\nfor p in pods:\n    p.delete()';
  assert.equal(flagsDestructiveByDefault(content), false);
});

// End-to-end + (e) fail-open.
function runHook(content, toolName = 'Write') {
  const input = toolName === 'Write'
    ? { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'teardown_check.py', content } }
    : { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'teardown_check.py', new_string: content } };
  return spawnSync(process.execPath, [hookPath], { input: JSON.stringify(input), encoding: 'utf8' });
}
const denied = (run) => /"permissionDecision"\s*:\s*"deny"/.test(run.stdout || '');

test('end-to-end: DENIES the delete-all script, ALLOWS the gated one', () => {
  assert.equal(denied(runHook('for p in list_pods():\n    provider.delete_resource(p.id)')), true);
  assert.equal(denied(runHook('if "--confirm-delete" in sys.argv:\n    provider.delete_resource(p.id)')), false);
});
test('(e) fail-open on malformed input', () => {
  const run = spawnSync(process.execPath, [hookPath], { input: 'not json', encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal((run.stdout || '').trim(), '');
});
