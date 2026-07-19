import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, 'entry-point-guard.mjs');
const { findBrokenEntryGuard } = await import(pathToFileURL(hookPath).href);

function runHook(filePath, content) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: filePath, content } }),
    encoding: 'utf8',
  });
}
function denied(hookRun) {
  try { return JSON.parse(hookRun.stdout).hookSpecificOutput?.permissionDecision === 'deny'; } catch { return false; }
}

// ---- pure detector: BROKEN (always-false on Windows) forms ----
test('flags the file:// concat form (the watchtower daemon bug)', () => {
  assert.ok(findBrokenEntryGuard('if (import.meta.url === `file://${process.argv[1]}`) main();'));
});
test('flags the raw import.meta.url === process.argv[1] form', () => {
  assert.ok(findBrokenEntryGuard('if (import.meta.url === process.argv[1]) main();'));
});
test('flags the reversed raw form', () => {
  assert.ok(findBrokenEntryGuard('if (process.argv[1] === import.meta.url) main();'));
});

// ---- pure detector: must ALLOW the correct/working forms (no false positives) ----
test('allows the robust basename form', () => {
  assert.equal(findBrokenEntryGuard("if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) main();"), null);
});
test('allows the harness-safe fileURLToPath form', () => {
  assert.equal(findBrokenEntryGuard('if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();'), null);
});
test('allows the endsWith-normalized form', () => {
  assert.equal(findBrokenEntryGuard("if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\\\/g, '/').split('/').pop())) main();"), null);
});
test('allows a file with neither token', () => {
  assert.equal(findBrokenEntryGuard('export function add(a, b) { return a + b; }'), null);
});

// ---- hook end-to-end ----
test('hook DENIES a Write introducing the broken form', () => {
  const hookRun = runHook('C:/x/daemon.mjs', 'if (import.meta.url === `file://${process.argv[1]}`) run();');
  assert.equal(hookRun.status, 0);
  assert.ok(denied(hookRun));
  assert.match(hookRun.stdout, /basename/);
});
test('hook ALLOWS a Write using the basename form', () => {
  const hookRun = runHook('C:/x/daemon.mjs', 'if (basename(process.argv[1] || "") === basename(fileURLToPath(import.meta.url))) run();');
  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});
test('hook ignores non-.mjs and .test.mjs files (fixtures legitimately hold bad patterns)', () => {
  const broken = 'if (import.meta.url === process.argv[1]) run();';
  assert.equal(runHook('C:/x/notes.md', broken).stdout, '');
  assert.equal(runHook('C:/x/foo.test.mjs', broken).stdout, '');
});
test('hook allows override token', () => {
  const hookRun = runHook('C:/x/daemon.mjs', 'if (import.meta.url === process.argv[1]) run(); // ENTRY_POINT_GUARD_OK');
  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});
