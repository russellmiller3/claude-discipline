import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedGuardHooks, untestedForFalsePositives } from './hook-negative-case-required.mjs';

const GUARD_WITH_TEETH = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }));`;
const PURE_INJECTOR = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'fyi' } }));`;
const POSITIVE_ONLY_TEST = `test('blocks a bad command', () => { assert.equal(isDenied('x'), true); });`;
const HAS_NEGATIVE_TEST = `test('allows a legit command', () => { assert.equal(isDenied('ok'), false); });`;

function fakeFs(files) {
  return {
    exists: (path) => path in files,
    read: (path) => { if (!(path in files)) throw new Error('nope'); return files[path]; },
  };
}

// --- changedGuardHooks: pulls hook .mjs edits from the session, excludes tests ---
test('changedGuardHooks collects hook source edits and skips *.test.mjs', () => {
  const entries = [{
    type: 'assistant',
    message: { content: [
      { type: 'tool_use', name: 'Write', input: { file_path: 'C:/x/.claude/hooks/foo-guard.mjs' } },
      { type: 'tool_use', name: 'Write', input: { file_path: 'C:/x/.claude/hooks/foo-guard.test.mjs' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/x/src/app.py' } },
    ] },
  }];
  const changed = changedGuardHooks(entries);
  assert.deepEqual(changed, ['C:/x/.claude/hooks/foo-guard.mjs']);
});

// --- the OFFENDER case: a guard with teeth whose test has only positive cases ---
test('flags a guard with teeth whose test has no negative case', () => {
  const files = {
    '/h/foo-guard.mjs': GUARD_WITH_TEETH,
    '/h/foo-guard.test.mjs': POSITIVE_ONLY_TEST,
  };
  const { exists, read } = fakeFs(files);
  const offenders = untestedForFalsePositives(['/h/foo-guard.mjs'], exists, read);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].hasTest, true);
});

// --- ALLOW: a guard whose test DOES have a negative case passes clean ---
test('does not flag a guard whose test has a must-allow case', () => {
  const files = {
    '/h/foo-guard.mjs': GUARD_WITH_TEETH,
    '/h/foo-guard.test.mjs': HAS_NEGATIVE_TEST,
  };
  const { exists, read } = fakeFs(files);
  assert.equal(untestedForFalsePositives(['/h/foo-guard.mjs'], exists, read).length, 0);
});

// --- ALLOW: a pure context-injector (no teeth) can't false-positive-block → never flagged ---
test('does not flag a pure context-injector even with no test', () => {
  const files = { '/h/inject.mjs': PURE_INJECTOR };
  const { exists, read } = fakeFs(files);
  assert.equal(untestedForFalsePositives(['/h/inject.mjs'], exists, read).length, 0);
});

// --- the missing-test-file case is flagged distinctly ---
test('flags a guard with teeth and no test file at all', () => {
  const files = { '/h/foo-guard.mjs': GUARD_WITH_TEETH };
  const { exists, read } = fakeFs(files);
  const offenders = untestedForFalsePositives(['/h/foo-guard.mjs'], exists, read);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].hasTest, false);
});
