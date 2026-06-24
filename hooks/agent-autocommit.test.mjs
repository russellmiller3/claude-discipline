#!/usr/bin/env node
/**
 * Tests for agent-autocommit. The side-effecting git calls are integration territory; what matters to pin is
 * the DECISION logic: only linked (agent) worktrees commit, only when dirty, the primary worktree is never
 * touched, and the workdir is resolved from the edited file. Run: node --test agent-autocommit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkdir, isLinkedWorktree, shouldAutocommit } from './agent-autocommit.mjs';

test('isLinkedWorktree: true only when the git dir is under .../worktrees/<name>', () => {
  assert.equal(isLinkedWorktree('/home/u/proj/.git/worktrees/agent-7'), true);
  assert.equal(isLinkedWorktree('C:\\Users\\r\\proj\\.git\\worktrees\\agent-7'), true); // windows separators
  assert.equal(isLinkedWorktree('/home/u/proj/.git'), false);                            // primary worktree
  assert.equal(isLinkedWorktree('C:\\Users\\r\\proj\\.git'), false);
  assert.equal(isLinkedWorktree(''), false);
  assert.equal(isLinkedWorktree(undefined), false);
});

test('shouldAutocommit: linked worktree AND dirty tree', () => {
  const linked = '/p/.git/worktrees/a1';
  const primary = '/p/.git';
  assert.equal(shouldAutocommit({ absoluteGitDir: linked, porcelainStatus: ' M foo.html\n' }), true);  // commit
  assert.equal(shouldAutocommit({ absoluteGitDir: linked, porcelainStatus: '' }), false);              // clean → skip
  assert.equal(shouldAutocommit({ absoluteGitDir: linked, porcelainStatus: '   \n' }), false);         // whitespace → skip
  assert.equal(shouldAutocommit({ absoluteGitDir: primary, porcelainStatus: ' M foo.html\n' }), false); // main session → never
});

test('resolveWorkdir: prefers the edited file directory, falls back to cwd', () => {
  assert.equal(resolveWorkdir({ tool_input: { file_path: '/p/wt/docs/x.html' } }), '/p/wt/docs');
  assert.equal(resolveWorkdir({ tool_input: { notebook_path: '/p/wt/n.ipynb' } }), '/p/wt');
  assert.equal(resolveWorkdir({ cwd: '/p/fallback' }), '/p/fallback');
});
