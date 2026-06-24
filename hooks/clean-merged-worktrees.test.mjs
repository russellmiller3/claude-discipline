#!/usr/bin/env node
/**
 * Tests for clean-merged-worktrees.mjs.
 *
 * The hook is destructive (it removes worktrees + deletes branches), so every
 * guard gets a throwaway git repo with real linked worktrees and a hard
 * assertion. The TEETH test is the headline: a worktree-agent branch merged into
 * the INTEGRATION branch (NOT main) is physically removed — the exact case a
 * main-only hook skips forever. Dependency-free:
 *   node clean-merged-worktrees.test.mjs
 */

import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { cleanMergedWorktrees } from './clean-merged-worktrees.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = join(here, 'clean-merged-worktrees.mjs');

let passed = 0;
let failed = 0;
const tempDirs = [];

function test(label, runCase) {
  try {
    runCase();
    passed++;
    console.log(`  ok ${label}`);
  } catch (caseError) {
    failed++;
    console.log(`  XX ${label}`);
    console.log(`      ${caseError.message}`);
  }
}

function run(command, workingDir) {
  return execSync(command, { cwd: workingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function branchExists(repoRoot, name) {
  try {
    execSync(`git show-ref --verify -q "refs/heads/${name}"`, { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Fresh repo: one commit on main, then an `integration` branch off it. HEAD ends
// on `integration` (mirrors an agent worktree running off the integration branch).
function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cmw-'));
  tempDirs.push(repoRoot);
  run('git init -b main', repoRoot);
  run('git config user.email test@example.com', repoRoot);
  run('git config user.name Test', repoRoot);
  run('git config commit.gpgsign false', repoRoot);
  run('git commit --allow-empty -m initial', repoRoot);
  run('git switch -c integration', repoRoot);
  return repoRoot;
}

// Create a worktree-agent branch + linked worktree under .claude/worktrees/,
// give it a commit, then (optionally) merge it into the integration branch.
function addAgentWorktree(repoRoot, agentId, { merge = true } = {}) {
  const branch = `worktree-agent-${agentId}`;
  const worktreePath = join(repoRoot, '.claude', 'worktrees', `agent-${agentId}`);
  run(`git worktree add -b "${branch}" "${worktreePath}" integration`, repoRoot);
  run('git commit --allow-empty -m "agent work"', worktreePath);
  if (merge) {
    // Merge the agent branch into integration (HEAD is on integration in repoRoot).
    run(`git merge --no-ff -m "merge ${branch}" "${branch}"`, repoRoot);
  }
  return { branch, worktreePath };
}

console.log('clean-merged-worktrees');

// THE TEETH: merged into the INTEGRATION branch (never main) => physically removed.
test('removes a worktree merged into the integration branch (a main-only hook skips this)', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'aaa111', { merge: true });
  assert.ok(existsSync(worktreePath), 'precondition: worktree dir exists');
  assert.ok(branchExists(repoRoot, branch), 'precondition: agent branch exists');

  const outcome = cleanMergedWorktrees({ commandCwd: repoRoot });

  assert.ok(
    outcome.removed.some((removedWorktree) => removedWorktree.branch === branch),
    'merged agent worktree removed',
  );
  assert.ok(!existsSync(worktreePath), 'worktree directory physically gone');
  assert.ok(!branchExists(repoRoot, branch), 'agent branch label deleted');
  // proves the integration branch (not just main) drove the merge decision
  assert.ok(outcome.integrationRefs.includes('integration'), 'integration branch is a merge target');
});

test('keeps an UNMERGED agent worktree', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'bbb222', { merge: false });

  const outcome = cleanMergedWorktrees({ commandCwd: repoRoot });

  assert.ok(existsSync(worktreePath), 'unmerged worktree must survive');
  assert.ok(branchExists(repoRoot, branch), 'unmerged branch must survive');
  assert.ok(outcome.skipped.some((skip) => skip.why === 'unmerged'), 'reported as unmerged');
});

test('never removes the main checkout or the integration branch', () => {
  const repoRoot = makeRepo();
  addAgentWorktree(repoRoot, 'ccc333', { merge: true });

  cleanMergedWorktrees({ commandCwd: repoRoot });

  assert.ok(existsSync(repoRoot), 'main checkout untouched');
  assert.ok(branchExists(repoRoot, 'integration'), 'integration branch survives');
  assert.ok(branchExists(repoRoot, 'main'), 'main survives');
});

test('keeps a DIRTY merged worktree (uncommitted work must not be lost)', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'ddd444', { merge: true });
  // Leave an untracked file so `git status --porcelain` reports the tree dirty.
  writeFileSync(join(worktreePath, 'dirty.txt'), 'uncommitted');

  const outcome = cleanMergedWorktrees({ commandCwd: repoRoot });

  assert.ok(existsSync(worktreePath), 'dirty worktree must survive');
  assert.ok(outcome.skipped.some((skip) => skip.why === 'dirty'), 'reported as dirty');
  assert.ok(branchExists(repoRoot, branch), 'branch of dirty worktree survives');
});

test('disabled via CLEAN_MERGED_WORKTREES_OFF=1 removes nothing', () => {
  const repoRoot = makeRepo();
  const { worktreePath } = addAgentWorktree(repoRoot, 'eee555', { merge: true });

  const outcome = cleanMergedWorktrees({ commandCwd: repoRoot, env: { CLEAN_MERGED_WORKTREES_OFF: '1' } });

  assert.strictEqual(outcome.reason, 'disabled');
  assert.ok(existsSync(worktreePath), 'disabled => worktree survives');
});

test('dry run reports but does not remove', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'fff666', { merge: true });

  const outcome = cleanMergedWorktrees({ commandCwd: repoRoot, dryRun: true });

  assert.ok(
    outcome.removed.some((removedWorktree) => removedWorktree.branch === branch && removedWorktree.dryRun),
    'dry run reports the candidate',
  );
  assert.ok(existsSync(worktreePath), 'dry run leaves the worktree on disk');
  assert.ok(branchExists(repoRoot, branch), 'dry run leaves the branch');
});

test('removes a merged feature/* worktree too (broadened beyond worktree-agent-*)', () => {
  const repoRoot = makeRepo();
  // A plain feature worktree under .claude/worktrees — now an EPHEMERAL branch, deleted once merged.
  const branch = 'feature/done-in-worktree';
  const worktreePath = join(repoRoot, '.claude', 'worktrees', 'done-in-worktree');
  run(`git worktree add -b "${branch}" "${worktreePath}" integration`, repoRoot);
  run('git commit --allow-empty -m work', worktreePath);
  run(`git merge --no-ff -m "merge ${branch}" "${branch}"`, repoRoot);

  const outcome = cleanMergedWorktrees({ commandCwd: repoRoot });

  assert.ok(!existsSync(worktreePath), 'merged feature worktree removed');
  assert.ok(!branchExists(repoRoot, branch), 'merged feature branch deleted');
  assert.ok(outcome.removed.some((entry) => entry.branch === branch), 'reported removed');
});

test('sweeps a loose merged feature/* branch that has NO worktree (main-agent branch)', () => {
  const repoRoot = makeRepo();
  // The main agent's own pattern: a feature branch, committed + merged back, never given a worktree.
  run('git switch -c feature/done-loose', repoRoot);
  run('git commit --allow-empty -m "feature work"', repoRoot);
  run('git switch integration', repoRoot);
  run('git merge --no-ff -m "merge feature/done-loose" feature/done-loose', repoRoot);
  assert.ok(branchExists(repoRoot, 'feature/done-loose'), 'precondition: branch exists');

  const outcome = cleanMergedWorktrees({ commandCwd: repoRoot });

  assert.ok(!branchExists(repoRoot, 'feature/done-loose'), 'merged loose feature branch deleted');
  assert.ok(outcome.removed.some((entry) => entry.branch === 'feature/done-loose' && !entry.path), 'reported as a branch removal');
});

test('keeps a loose UNMERGED feature/* branch', () => {
  const repoRoot = makeRepo();
  run('git switch -c feature/wip-loose', repoRoot);
  run('git commit --allow-empty -m "wip"', repoRoot);
  run('git switch integration', repoRoot); // feature/wip-loose is NOT merged into integration

  const outcome = cleanMergedWorktrees({ commandCwd: repoRoot });

  assert.ok(branchExists(repoRoot, 'feature/wip-loose'), 'unmerged loose branch must survive');
  assert.ok(outcome.skipped.some((skip) => skip.branch === 'feature/wip-loose' && skip.why === 'unmerged'), 'reported unmerged');
});

test('fails open outside a git repo', () => {
  const looseDir = mkdtempSync(join(tmpdir(), 'cmw-norepo-'));
  tempDirs.push(looseDir);

  const outcome = cleanMergedWorktrees({ commandCwd: looseDir });

  assert.strictEqual(outcome.reason, 'not-a-repo');
  assert.deepStrictEqual(outcome.removed, []);
});

test('end-to-end through stdin: removes and emits additionalContext', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'ggg777', { merge: true });

  const event = JSON.stringify({ hook_event_name: 'Stop', cwd: repoRoot });
  const stdout = execFileSync(process.execPath, [hookPath], { input: event, encoding: 'utf8' });

  const emitted = JSON.parse(stdout);
  assert.match(emitted.hookSpecificOutput.additionalContext, new RegExp(branch));
  assert.strictEqual(emitted.hookSpecificOutput.hookEventName, 'Stop');
  assert.ok(!existsSync(worktreePath), 'worktree removed via the real hook process');
  assert.ok(!branchExists(repoRoot, branch), 'branch deleted via the real hook process');
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
