#!/usr/bin/env node
/**
 * Tests for git-hygiene.mjs — the consolidated worktree/branch hygiene hook.
 *
 * Proves PARITY with the three hooks it replaced (clean-worktrees, clean-merged-worktrees, delete-merged-branches)
 * PLUS the two new capabilities (proactive merged-branch delete + the >3 durable-branch cap warning) and the
 * staleness tier (reap abandoned unmerged agent trees, archive-before-delete). Every destructive path gets a real
 * throwaway git repo with real worktrees and a hard assertion. Dependency-free:  node git-hygiene.test.mjs
 */

import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { runGitHygiene, formatNote } from './git-hygiene.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = join(here, 'git-hygiene.mjs');

// Reaping tests create worktrees and immediately assert removal, so they run with the live grace DISABLED (0 min)
// — otherwise the freshly-created trees would all be "recently-active" and survive. Staleness tests re-enable a
// real grace explicitly to prove the two windows are independent.
process.env.GIT_HYGIENE_GRACE_MIN = '0';
const STALE_ENV = { ...process.env, GIT_HYGIENE_GRACE_MIN: '20', GIT_HYGIENE_STALE_HOURS: '1' };
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

let passed = 0;
let failed = 0;
const tempDirs = [];

function test(label, runCase) {
  try { runCase(); passed++; console.log(`  ok ${label}`); }
  catch (caseError) { failed++; console.log(`  XX ${label}`); console.log(`      ${caseError.message}`); }
}

function run(command, workingDir) {
  return execSync(command, { cwd: workingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function branchExists(repoRoot, name) {
  try { execSync(`git show-ref --verify -q "refs/heads/${name}"`, { cwd: repoRoot, stdio: 'ignore' }); return true; }
  catch { return false; }
}

function reapedShas(repoRoot) {
  try {
    return run('git for-each-ref --format=%(objectname) refs/reaped/', repoRoot)
      .split(/\r?\n/).map((sha) => sha.trim()).filter(Boolean);
  } catch { return []; }
}

function backdate(paths, ageMs) {
  const when = new Date(Date.now() - ageMs);
  for (const targetPath of paths) { try { utimesSync(targetPath, when, when); } catch { /* may not exist */ } }
}

function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gh-'));
  tempDirs.push(repoRoot);
  run('git init -b main', repoRoot);
  run('git config user.email test@example.com', repoRoot);
  run('git config user.name Test', repoRoot);
  run('git config commit.gpgsign false', repoRoot);
  run('git commit --allow-empty -m initial', repoRoot);
  run('git switch -c integration', repoRoot);
  return repoRoot;
}

function addAgentWorktree(repoRoot, agentId, { merge = true } = {}) {
  const branch = `worktree-agent-${agentId}`;
  const worktreePath = join(repoRoot, '.claude', 'worktrees', `agent-${agentId}`);
  run(`git worktree add -b "${branch}" "${worktreePath}" integration`, repoRoot);
  run('git commit --allow-empty -m "agent work"', worktreePath);
  if (merge) run(`git merge --no-ff -m "merge ${branch}" "${branch}"`, repoRoot);
  return { branch, worktreePath };
}

console.log('git-hygiene');

// ---- WORKTREE REAPING (parity with clean-merged-worktrees) ----
test('Stop: removes a worktree merged into the integration branch', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'merged1', { merge: true });
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(!existsSync(worktreePath), 'merged worktree gone');
  assert.ok(!branchExists(repoRoot, branch), 'merged branch deleted');
  assert.ok(outcome.worktreesRemoved.some((entry) => entry.branch === branch && entry.why === 'merged'), 'reported merged');
});

test('Stop: keeps an UNMERGED fresh agent worktree', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'unmerged1', { merge: false });
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(existsSync(worktreePath), 'unmerged fresh worktree survives');
  assert.ok(branchExists(repoRoot, branch), 'unmerged branch survives');
});

test('Stop: keeps a DIRTY merged worktree (uncommitted work must not be lost)', () => {
  const repoRoot = makeRepo();
  const { worktreePath } = addAgentWorktree(repoRoot, 'dirty1', { merge: true });
  writeFileSync(join(worktreePath, 'dirty.txt'), 'uncommitted');
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(existsSync(worktreePath), 'dirty worktree survives');
});

test('Stop: never removes the main checkout or the integration branch', () => {
  const repoRoot = makeRepo();
  addAgentWorktree(repoRoot, 'safe1', { merge: true });
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(existsSync(repoRoot), 'main checkout untouched');
  assert.ok(branchExists(repoRoot, 'integration'), 'integration survives');
  assert.ok(branchExists(repoRoot, 'main'), 'main survives');
});

// ---- STALENESS TIER (the immortal-fork fix) ----
test('Stop: STALE unmerged agent worktree is reaped AND its tip archived to refs/reaped/*', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'stalewt', { merge: false });
  const tip = run(`git rev-parse ${branch}`, repoRoot);
  const worktreeGitDir = run('git rev-parse --absolute-git-dir', worktreePath);
  backdate([worktreePath, worktreeGitDir, join(worktreeGitDir, 'HEAD'), join(worktreeGitDir, 'logs', 'HEAD')], TWO_HOURS_MS);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: STALE_ENV });
  assert.ok(!existsSync(worktreePath), 'stale unmerged worktree removed');
  assert.ok(outcome.worktreesRemoved.some((entry) => entry.branch === branch && entry.why === 'stale-unmerged'), 'reported stale-unmerged');
  assert.ok(reapedShas(repoRoot).includes(tip), 'tip archived (nothing lost)');
});

test('Stop: a live (recently-active) worktree survives the grace window', () => {
  const repoRoot = makeRepo();
  const branch = 'worktree-agent-live1';
  const worktreePath = join(repoRoot, '.claude', 'worktrees', 'agent-live1');
  run(`git worktree add -b "${branch}" "${worktreePath}" integration`, repoRoot); // 0 commits => trivially "merged"
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: STALE_ENV });
  assert.ok(existsSync(worktreePath), 'live worktree survives');
  assert.ok(branchExists(repoRoot, branch), 'live branch survives');
});

// ---- LOCAL BRANCH DELETION (parity with delete-merged-branches) ----
test('Stop: deletes a loose branch whose work is on main', () => {
  const repoRoot = makeRepo();
  run('git switch main', repoRoot);
  run('git switch -c done-on-main', repoRoot);
  run('git commit --allow-empty -m "done"', repoRoot);
  run('git switch main', repoRoot);
  run('git merge --no-ff -m "merge done-on-main" done-on-main', repoRoot);
  run('git switch integration', repoRoot);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(!branchExists(repoRoot, 'done-on-main'), 'branch whose work is on main deleted');
  assert.ok(outcome.branchesDeleted.some((entry) => entry.branch === 'done-on-main'), 'reported deleted');
});

test('Stop: keeps a loose UNMERGED feature/* branch', () => {
  const repoRoot = makeRepo();
  run('git switch -c feature/wip', repoRoot);
  run('git commit --allow-empty -m wip', repoRoot);
  run('git switch integration', repoRoot);
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(branchExists(repoRoot, 'feature/wip'), 'unmerged feature branch survives');
});

test('Stop: STALE loose worktree-agent-* branch is reaped + archived; a stale feature/* SURVIVES', () => {
  const repoRoot = makeRepo();
  run('git switch -c worktree-agent-loose', repoRoot);
  run('git commit --allow-empty -m "agent wip"', repoRoot);
  const agentTip = run('git rev-parse worktree-agent-loose', repoRoot);
  run('git switch -c feature/paused', repoRoot);
  run('git commit --allow-empty -m "paused"', repoRoot);
  run('git switch integration', repoRoot);
  const commonGitDir = run('git rev-parse --absolute-git-dir', repoRoot);
  backdate([
    join(commonGitDir, 'refs', 'heads', 'worktree-agent-loose'),
    join(commonGitDir, 'logs', 'refs', 'heads', 'worktree-agent-loose'),
    join(commonGitDir, 'refs', 'heads', 'feature', 'paused'),
    join(commonGitDir, 'logs', 'refs', 'heads', 'feature', 'paused'),
  ], TWO_HOURS_MS);
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: STALE_ENV });
  assert.ok(!branchExists(repoRoot, 'worktree-agent-loose'), 'stale loose agent branch reaped');
  assert.ok(reapedShas(repoRoot).includes(agentTip), 'agent branch tip archived');
  assert.ok(branchExists(repoRoot, 'feature/paused'), 'stale feature/* branch SURVIVES (never age-reaped)');
});

// ---- BRANCH CAP (new) ----
test('Stop: warns when durable branches exceed the cap', () => {
  const repoRoot = makeRepo();
  for (const suffix of ['a', 'b', 'c', 'd']) {
    run(`git switch -c feature/${suffix}`, repoRoot);
    run(`git commit --allow-empty -m ${suffix}`, repoRoot);
  }
  run('git switch integration', repoRoot);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(outcome.durable.length > outcome.branchCap, `durable ${outcome.durable.length} > cap ${outcome.branchCap}`);
  assert.match(formatNote(outcome) || '', /durable local branches/);
});

test('Stop: agent worktree branches do NOT count toward the durable cap', () => {
  const repoRoot = makeRepo();
  addAgentWorktree(repoRoot, 'capagent', { merge: false });
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: STALE_ENV });
  assert.ok(!outcome.durable.some((name) => name.startsWith('worktree-agent-')), 'agent branch excluded from durable set');
});

// ---- EVENT ROUTING ----
test('PostToolUse: a non-git command does nothing (no-trigger)', () => {
  const repoRoot = makeRepo();
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'PostToolUse', toolName: 'Bash', command: 'ls -la' });
  assert.strictEqual(outcome.reason, 'no-trigger');
});

test('PostToolUse after a git merge: deletes merged local branches', () => {
  const repoRoot = makeRepo();
  run('git switch main', repoRoot);
  run('git switch -c shipped', repoRoot);
  run('git commit --allow-empty -m shipped', repoRoot);
  run('git switch main', repoRoot);
  run('git merge --no-ff -m "merge shipped" shipped', repoRoot);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'PostToolUse', toolName: 'Bash', command: 'git merge --no-ff shipped' });
  assert.ok(!branchExists(repoRoot, 'shipped'), 'merged branch deleted on PostToolUse');
  assert.ok(outcome.branchesDeleted.some((entry) => entry.branch === 'shipped'), 'reported');
});

test('SessionEnd: reaps a merged worktree even with a sqlite file present', () => {
  const repoRoot = makeRepo();
  const { worktreePath } = addAgentWorktree(repoRoot, 'sess1', { merge: true });
  writeFileSync(join(worktreePath, 'data.sqlite'), 'x'); // committed? no — but it's the only change and would make it dirty
  run('git add -A', worktreePath);
  run('git commit -m "add db"', worktreePath);
  run('git merge --no-ff -m remerge worktree-agent-sess1', repoRoot);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'SessionEnd' });
  assert.ok(!existsSync(worktreePath), 'SessionEnd reaped the merged worktree');
  assert.strictEqual(outcome.eventName, 'SessionEnd');
});

// ---- SAFETY ----
test('GIT_HYGIENE_OFF=1 disables everything', () => {
  const repoRoot = makeRepo();
  const { worktreePath } = addAgentWorktree(repoRoot, 'off1', { merge: true });
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: { GIT_HYGIENE_OFF: '1' } });
  assert.strictEqual(outcome.reason, 'disabled');
  assert.ok(existsSync(worktreePath), 'disabled => worktree survives');
});

test('fails open outside a git repo', () => {
  const looseDir = mkdtempSync(join(tmpdir(), 'gh-norepo-'));
  tempDirs.push(looseDir);
  const outcome = runGitHygiene({ commandCwd: looseDir, eventName: 'Stop' });
  assert.strictEqual(outcome.reason, 'not-a-repo');
});

test('dry run reports but removes nothing', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'dry1', { merge: true });
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', dryRun: true });
  assert.ok(existsSync(worktreePath), 'dry run leaves worktree');
  assert.ok(branchExists(repoRoot, branch), 'dry run leaves branch');
  assert.ok(outcome.worktreesRemoved.some((entry) => entry.dryRun), 'dry run reports the candidate');
});

test('end-to-end through stdin: reaps and emits additionalContext', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'e2e1', { merge: true });
  const event = JSON.stringify({ hook_event_name: 'Stop', cwd: repoRoot });
  const stdout = execFileSync(process.execPath, [hookPath], { input: event, encoding: 'utf8', env: { ...process.env, GIT_HYGIENE_GRACE_MIN: '0' } });
  const emitted = JSON.parse(stdout);
  assert.match(emitted.hookSpecificOutput.additionalContext, new RegExp(branch));
  assert.strictEqual(emitted.hookSpecificOutput.hookEventName, 'Stop');
  assert.ok(!existsSync(worktreePath), 'worktree removed via the real hook process');
});

// Cleanup temp dirs.
for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows lock; harmless for a temp dir */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
