import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'no-backcompat.mjs');

function isDenied({ filePath = 'notes.md', newString }) {
  const hookRun = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: filePath, new_string: newString },
    }),
    encoding: 'utf8',
  });
  return /"permissionDecision"\s*:\s*"deny"/.test(hookRun.stdout || '');
}

// --- ALLOW (the 2026-07-01 false-fire): documenting the guard BY NAME is not a violation ---
test('allows a doc row that names the no-backcompat hook', () => {
  assert.equal(isDenied({ newString: '| `no-backcompat` | PreToolUse | Blocks direct commits to main; branch first |' }), false);
});

test('allows prose that references the BACKCOMPAT_OVERRIDE token', () => {
  assert.equal(isDenied({ newString: 'Escape hatch: set BACKCOMPAT_OVERRIDE=1 only when Russell says so.' }), false);
});

// --- ALLOW: editing the guard's OWN source/test must never self-block ---
test('allows an edit to the guard\'s own source file', () => {
  assert.equal(isDenied({ filePath: 'C:/x/hooks/no-backcompat.mjs', newString: 'const PATTERN = /deprecation warning/;' }), false);
});

// --- BLOCK: a real Claude-introduced backcompat path still fires ---
test('blocks language keeping an old form for backwards compatibility', () => {
  assert.equal(isDenied({ filePath: 'parser.js', newString: '// keep the old syntax for backwards compatibility\nif (legacy) parseOld();' }), true);
});

test('blocks adding a deprecation warning', () => {
  assert.equal(isDenied({ filePath: 'api.js', newString: 'console.warn("deprecated: use newForm instead");' }), true);
});
