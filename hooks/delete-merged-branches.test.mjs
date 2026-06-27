#!/usr/bin/env node
/**
 * Tests for delete-merged-branches.mjs.
 *
 * Branch deletion is destructive-adjacent, so every safety guard gets a
 * throwaway git repo and a hard assertion: merged branches go, but the
 * current branch, worktree-checked-out branches, and anything with unmerged
 * work all survive. Dependency-free — `node delete-merged-branches.test.mjs`.
 */

import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { cleanMergedBranches } from './delete-merged-branches.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = join(here, 'delete-merged-branches.mjs');

let passed = 0;
let failed = 0;
const tempDirs = [];

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      ${err.message}`);
  }
}

// Run a shell line inside a repo, returning trimmed stdout.
function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function branchExists(repo, name) {
  try {
    execSync(`git show-ref --verify -q "refs/heads/${name}"`, { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Fresh repo with a single commit on `main`.
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'bdh-'));
  tempDirs.push(repo);
  run('git init -b main', repo);
  run('git config user.email test@example.com', repo);
  run('git config user.name Test', repo);
  run('git config commit.gpgsign false', repo);
  run('git commit --allow-empty -m initial', repo);
  return repo;
}

// Branch off main, add a commit there. Leaves HEAD on the new branch.
function commitOnBranch(repo, name) {
  run(`git switch -c "${name}"`, repo);
  run(`git commit --allow-empty -m "work on ${name}"`, repo);
}

// Branch, commit, then merge it back into main. Leaves HEAD on main, branch merged.
function mergeIntoMain(repo, name) {
  commitOnBranch(repo, name);
  run('git switch main', repo);
  run(`git merge --no-ff -m "merge ${name}" "${name}"`, repo);
}

console.log('delete-merged-branches');

test('deletes a branch merged into main, keeps an unmerged one', () => {
  const repo = makeRepo();
  mergeIntoMain(repo, 'feature/merged');
  commitOnBranch(repo, 'feature/unmerged');
  run('git switch main', repo);

  const outcome = cleanMergedBranches({ cwd: repo, command: 'git merge --no-ff feature/merged' });

  assert.ok(outcome.deleted.includes('feature/merged'), 'merged branch should be deleted');
  assert.ok(!branchExists(repo, 'feature/merged'), 'merged branch gone from repo');
  assert.ok(branchExists(repo, 'feature/unmerged'), 'unmerged branch must survive');
  assert.ok(branchExists(repo, 'main'), 'main must survive');
});

test('does nothing on a command that is not a merge or push-to-main', () => {
  const repo = makeRepo();
  mergeIntoMain(repo, 'feature/merged');
  run('git switch main', repo);

  const outcome = cleanMergedBranches({ cwd: repo, command: 'git status' });

  assert.deepStrictEqual(outcome.deleted, [], 'no deletions without a trigger');
  assert.strictEqual(outcome.reason, 'no-trigger');
  assert.ok(branchExists(repo, 'feature/merged'), 'merged branch untouched without trigger');
});

test('never deletes the current branch, even when merged', () => {
  const repo = makeRepo();
  // feature/cur is merged into main, but we sit ON it when the hook runs.
  mergeIntoMain(repo, 'feature/cur');
  run('git switch feature/cur', repo);

  const outcome = cleanMergedBranches({ cwd: repo, command: 'git merge whatever' });

  assert.ok(branchExists(repo, 'feature/cur'), 'current branch must survive');
  assert.ok(outcome.skipped.some(s => s.branch === 'feature/cur' && s.why === 'current'));
});

test('never deletes a branch checked out in a worktree', () => {
  const repo = makeRepo();
  mergeIntoMain(repo, 'feature/wt');
  run('git switch main', repo);

  // Check the merged branch out in a sibling worktree.
  const worktreeDir = repo + '-wt';
  mkdirSync(dirname(worktreeDir), { recursive: true });
  run(`git worktree add "${worktreeDir}" feature/wt`, repo);
  tempDirs.push(worktreeDir);

  const outcome = cleanMergedBranches({ cwd: repo, command: 'git merge feature/wt' });

  assert.ok(branchExists(repo, 'feature/wt'), 'worktree branch must survive');
  assert.ok(outcome.skipped.some(s => s.branch === 'feature/wt' && s.why === 'worktree'));

  run(`git worktree remove --force "${worktreeDir}"`, repo);
});

test('push-to-main also triggers cleanup', () => {
  const repo = makeRepo();
  mergeIntoMain(repo, 'feature/shipped');
  run('git switch main', repo);

  const outcome = cleanMergedBranches({ cwd: repo, command: 'git push origin main' });

  assert.ok(outcome.deleted.includes('feature/shipped'), 'push-to-main should clean merged branches');
});

test('a plain `git push` (no main) does not trigger', () => {
  const repo = makeRepo();
  mergeIntoMain(repo, 'feature/merged');
  run('git switch main', repo);

  const outcome = cleanMergedBranches({ cwd: repo, command: 'git push origin feature/x' });

  assert.strictEqual(outcome.reason, 'no-trigger');
  assert.ok(branchExists(repo, 'feature/merged'));
});

test('BRANCH_AUTODELETE_OFF=1 disables all deletion', () => {
  const repo = makeRepo();
  mergeIntoMain(repo, 'feature/merged');
  run('git switch main', repo);

  const outcome = cleanMergedBranches({
    cwd: repo,
    command: 'git merge feature/merged',
    env: { BRANCH_AUTODELETE_OFF: '1' },
  });

  assert.strictEqual(outcome.reason, 'disabled');
  assert.ok(branchExists(repo, 'feature/merged'), 'disabled => nothing deleted');
});

test('fails open outside a git repo', () => {
  const loose = mkdtempSync(join(tmpdir(), 'bdh-norepo-'));
  tempDirs.push(loose);

  const outcome = cleanMergedBranches({ cwd: loose, command: 'git merge x' });

  assert.strictEqual(outcome.reason, 'not-a-repo');
  assert.deepStrictEqual(outcome.deleted, []);
});

test('end-to-end through stdin: deletes and emits additionalContext', () => {
  const repo = makeRepo();
  mergeIntoMain(repo, 'feature/e2e');
  run('git switch main', repo);

  const event = JSON.stringify({
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: 'git merge --no-ff feature/e2e' },
  });
  const stdout = execFileSync(process.execPath, [hookPath], { input: event, encoding: 'utf8' });

  const emitted = JSON.parse(stdout);
  assert.match(emitted.hookSpecificOutput.additionalContext, /feature\/e2e/);
  assert.strictEqual(emitted.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(!branchExists(repo, 'feature/e2e'), 'branch deleted via the real hook process');
});

// Cleanup temp dirs.
for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows can hold a lock briefly; harmless for a temp dir. */
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
