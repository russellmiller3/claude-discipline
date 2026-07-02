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

// --- ALLOW (2026-07-02 false positive): plain prose about a non-code decision doesn't fire ---
test('allows a HANDOFF note about an old UI color palette (not a code backcompat shim)', () => {
  assert.equal(isDenied({
    filePath: 'HANDOFF.md',
    newString: 'only the widget regressed back to the old rejected palette (the deprecated indigo-on-ivory look) — the two sibling products already ship Cloud correctly.',
  }), false);
});

test('allows a design doc describing a deprecated feature by name, still no code nearby', () => {
  assert.equal(isDenied({
    filePath: 'plans/design-notes.md',
    newString: 'The old warm "machined parchment" identity was deprecated in favor of the cool Cloud palette.',
  }), false);
});

test('still blocks a real backcompat shim written in markdown-adjacent prose (code vocabulary present)', () => {
  assert.equal(isDenied({
    filePath: 'notes.md',
    newString: 'Plan: keep the old API version working for backwards compatibility so existing callers do not break.',
  }), true);
});

test('still blocks a fenced code block in markdown that adds a deprecation warning', () => {
  assert.equal(isDenied({
    filePath: 'docs/CHANGELOG.md',
    newString: '```js\nconsole.warn("deprecated: use newForm instead");\n```',
  }), true);
});
