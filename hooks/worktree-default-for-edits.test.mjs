#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'worktree-default-for-edits.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'worktree-edit-guard-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'guard@example.test');
  git(root, 'config', 'user.name', 'Guard Test');
  writeFileSync(join(root, 'owned.txt'), 'base\n');
  git(root, 'add', 'owned.txt');
  git(root, 'commit', '-m', 'base');
  return root;
}

function runHook({ cwd, toolName = 'Edit', filePath, command, environment = {} }) {
  const toolInput = command === undefined
    ? { file_path: filePath }
    : { command };
  return spawnSync(process.execPath, [hookPath], {
    cwd,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      cwd,
    }),
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function assertDenied(result, pattern = /Branch \+ worktree required/) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, pattern);
}

function assertAllowed(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
}

test('denies an edit on a feature branch in the primary checkout', () => {
  const root = makeRepo();
  git(root, 'switch', '-c', 'feature/primary-is-not-isolated');
  assertDenied(runHook({ cwd: root, filePath: join(root, 'owned.txt') }));
});

test('denies an edit on main in the primary checkout', () => {
  const root = makeRepo();
  assertDenied(runHook({ cwd: root, filePath: join(root, 'owned.txt') }));
});

test('allows an edit on a feature branch in a linked worktree', () => {
  const root = makeRepo();
  const linked = join(dirname(root), `${root.split(/[\\/]/).pop()}-linked`);
  git(root, 'worktree', 'add', linked, '-b', 'feature/isolated');
  assertAllowed(runHook({ cwd: linked, filePath: join(linked, 'owned.txt') }));
});

test('denies a detached linked worktree because work also needs a branch', () => {
  const root = makeRepo();
  const linked = join(dirname(root), `${root.split(/[\\/]/).pop()}-detached`);
  git(root, 'worktree', 'add', '--detach', linked, 'HEAD');
  assertDenied(runHook({ cwd: linked, filePath: join(linked, 'owned.txt') }), /detached HEAD/);
});

test('denies main even when main is checked out in a linked worktree', () => {
  const root = makeRepo();
  git(root, 'switch', '-c', 'feature/primary-anchor');
  const linked = join(dirname(root), `${root.split(/[\\/]/).pop()}-main`);
  git(root, 'worktree', 'add', linked, 'main');
  assertDenied(runHook({ cwd: linked, filePath: join(linked, 'owned.txt') }), /main/);
});

test('the old environment bypass no longer disables enforcement', () => {
  const root = makeRepo();
  git(root, 'switch', '-c', 'feature/no-bypass');
  assertDenied(runHook({
    cwd: root,
    filePath: join(root, 'owned.txt'),
    environment: { WORKTREE_EDIT_OVERRIDE: '1' },
  }));
});

test('apply_patch is denied when any patched file is in a primary checkout', () => {
  const root = makeRepo();
  git(root, 'switch', '-c', 'feature/patch-primary');
  const command = [
    '*** Begin Patch',
    `*** Update File: ${join(root, 'owned.txt')}`,
    '@@',
    '-base',
    '+changed',
    '*** End Patch',
  ].join('\n');
  assertDenied(runHook({ cwd: root, toolName: 'apply_patch', command }));
});

test('apply_patch is allowed for a feature branch in a linked worktree', () => {
  const root = makeRepo();
  const linked = join(dirname(root), `${root.split(/[\\/]/).pop()}-patch-linked`);
  git(root, 'worktree', 'add', linked, '-b', 'fix/patch-isolated');
  const command = [
    '*** Begin Patch',
    `*** Update File: ${join(linked, 'owned.txt')}`,
    '@@',
    '-base',
    '+changed',
    '*** End Patch',
  ].join('\n');
  assertAllowed(runHook({ cwd: linked, toolName: 'apply_patch', command }));
});

test('allows edits outside any git repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'worktree-edit-nonrepo-'));
  const nested = join(root, 'nested');
  mkdirSync(nested);
  assertAllowed(runHook({ cwd: nested, filePath: join(nested, 'notes.txt') }));
});
