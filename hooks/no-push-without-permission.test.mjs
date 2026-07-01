#!/usr/bin/env node
/**
 * Tests for no-push-without-permission.mjs.
 *
 * The hook guards a hard-to-undo action (publishing to GitHub), so its block
 * and allow paths both get a hard assertion. Dependency-free:
 *   node no-push-without-permission.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = join(here, 'no-push-without-permission.mjs');

let passed = 0;
let failed = 0;

// Run the hook with a tool event on stdin; return its stdout.
function runHook(event) {
  return execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
}

function bashEvent(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}

// A push is "blocked" when the hook emits a deny decision.
function isBlocked(stdout) {
  if (!stdout.trim()) return false;
  try {
    return JSON.parse(stdout).hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}\n      ${err.message}`);
  }
}

console.log('no-push-without-permission');

test('blocks a plain push to origin main', () => {
  assert.ok(isBlocked(runHook(bashEvent('git push origin main'))));
});

test('blocks a bare `git push`', () => {
  assert.ok(isBlocked(runHook(bashEvent('git push'))));
});

test('blocks a feature-branch push', () => {
  assert.ok(isBlocked(runHook(bashEvent('git push origin feature/x'))));
});

test('ALLOWS a push carrying the PUSH_APPROVED token', () => {
  assert.ok(!isBlocked(runHook(bashEvent('git push origin main   # PUSH_APPROVED'))));
});

test('ignores non-push git commands', () => {
  assert.ok(!isBlocked(runHook(bashEvent('git status'))));
  assert.ok(!isBlocked(runHook(bashEvent('git commit -m wip'))));
});

test('ignores non-Bash tools', () => {
  assert.ok(!isBlocked(runHook({ tool_name: 'Edit', tool_input: { command: 'git push' } })));
});

// 2026-07-01 FALSE-FIRE: "git push" quoted inside a commit MESSAGE / heredoc is not a real push.
test('ALLOWS a commit whose message text mentions git push', () => {
  assert.ok(!isBlocked(runHook(bashEvent(`git commit -m "removed the stale git push origin main instruction"`))));
});

test('ALLOWS a commit whose heredoc body mentions git push', () => {
  const command = `git commit -m "$(cat <<'EOF'\nfix: drop the git push origin main line that contradicted local-only\nEOF\n)"`;
  assert.ok(!isBlocked(runHook(bashEvent(command))));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
