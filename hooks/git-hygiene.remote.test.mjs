#!/usr/bin/env node
/**
 * Tests for the REMOTE-branch pruning in git-hygiene (ported from branch-prune-remote.test.mjs during the
 * 2026-07-15 consolidation). Remote deletion is destructive AND touches a server, so these drive the pure core
 * with a MOCK git runner — they NEVER hit a real remote. The mock answers read-only queries from an in-memory
 * fixture and RECORDS every `push --delete` / `remote prune` so we assert exactly what would be deleted (and that
 * protected / unmerged / worktree-checked-out / recently-active ones are spared).  Run:  node git-hygiene.remote.test.mjs
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

import { pruneMergedRemoteBranches } from './lib/gitHygieneBranches.mjs';

let passed = 0;
let failed = 0;
function test(label, runCase) {
  try { runCase(); passed++; console.log(`  ok ${label}`); }
  catch (caseError) { failed++; console.log(`  XX ${label}`); console.log(`      ${caseError.message}`); }
}

// Mock git runner from a fixture describing the remote world; captures every mutating command's argv.
function makeMockRunner(fixture) {
  const {
    remotes = ['origin'],
    remoteMainRefExists = true,
    remoteMasterRefExists = false,
    mergedRemoteBranches = [],
    unmergedRemoteBranches = [],
    worktreePorcelain = '',
    commonGitDir = '/fake/.git',
  } = fixture;

  const pushDeletes = [];
  const prunedRemotes = [];
  const argsToKey = (args) => args.join(' ');

  function git(args) {
    const key = argsToKey(args);
    if (key === 'remote') return remotes.join('\n') + '\n';
    if (key === 'rev-parse --path-format=absolute --git-common-dir') return commonGitDir + '\n';
    if (args[0] === 'branch' && args.includes('-r') && args.includes('--merged')) {
      return ['  origin/HEAD -> origin/main', '  origin/main', ...mergedRemoteBranches.map((branch) => `  origin/${branch}`)].join('\n') + '\n';
    }
    if (args[0] === 'worktree' && args[1] === 'list') return worktreePorcelain;
    throw new Error(`mock git: unexpected query: ${key}`);
  }

  function gitOk(args) {
    const key = argsToKey(args);
    if (key === 'show-ref --verify --quiet refs/remotes/origin/main') return remoteMainRefExists;
    if (key === 'show-ref --verify --quiet refs/remotes/origin/master') return remoteMasterRefExists;
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      const branch = args[2].replace(/^origin\//, '');
      if (unmergedRemoteBranches.includes(branch)) return false;
      if (mergedRemoteBranches.includes(branch)) return true;
      return false;
    }
    if (args[0] === 'push' && args.includes('--delete')) { pushDeletes.push(args[args.length - 1]); return true; }
    if (args[0] === 'remote' && args[1] === 'prune') { prunedRemotes.push(args[2]); return true; }
    throw new Error(`mock gitOk: unexpected command: ${key}`);
  }

  return { runner: { git, gitOk }, pushDeletes, prunedRemotes };
}

const deletedNames = (outcome) => outcome.deleted.map((entry) => entry.branch).sort();
const NO_GRACE = { GIT_HYGIENE_GRACE_MIN: '0' };

console.log('git-hygiene.remote');

test('a merged remote branch IS deleted (push --delete + remote prune called)', () => {
  const { runner, pushDeletes, prunedRemotes } = makeMockRunner({ mergedRemoteBranches: ['feature/done', 'fix/old-bug'] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE } });
  assert.strictEqual(outcome.reason, 'ok');
  assert.deepStrictEqual(pushDeletes.sort(), ['feature/done', 'fix/old-bug'].sort());
  assert.deepStrictEqual(deletedNames(outcome), ['feature/done', 'fix/old-bug'].sort());
  assert.ok(prunedRemotes.includes('origin'), 'remote prune runs');
});

test('an UNMERGED remote branch is NEVER deleted (ancestor rail)', () => {
  const { runner, pushDeletes } = makeMockRunner({ mergedRemoteBranches: ['feature/leaked'], unmergedRemoteBranches: ['feature/leaked'] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE } });
  assert.deepStrictEqual(pushDeletes, []);
  assert.ok(outcome.skipped.some((skip) => skip.branch === 'feature/leaked' && skip.why === 'unmerged'));
});

test('origin/main and origin/HEAD are NEVER deleted', () => {
  const { runner, pushDeletes } = makeMockRunner({ mergedRemoteBranches: [] });
  pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE } });
  assert.deepStrictEqual(pushDeletes, []);
});

test('protected names (master/develop/release) on the remote are NEVER deleted', () => {
  const { runner, pushDeletes } = makeMockRunner({ mergedRemoteBranches: ['master', 'develop', 'release', 'feature/ok'] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE } });
  assert.deepStrictEqual(pushDeletes, ['feature/ok']);
  for (const protectedName of ['master', 'develop', 'release']) {
    assert.ok(outcome.skipped.some((skip) => skip.branch === protectedName && skip.why === 'protected'));
  }
});

test('a denylist pattern protects matching remote branches', () => {
  const { runner, pushDeletes } = makeMockRunner({ mergedRemoteBranches: ['release/1.2', 'feature/ok'] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE, BRANCH_PRUNE_DENYLIST: 'release/*' } });
  assert.deepStrictEqual(pushDeletes, ['feature/ok']);
  assert.ok(outcome.skipped.some((skip) => skip.branch === 'release/1.2' && skip.why === 'denylist'));
});

test('an allowlist restricts deletion to matching remote branches only', () => {
  const { runner, pushDeletes } = makeMockRunner({ mergedRemoteBranches: ['feature/ok', 'chore/skip-me'] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE, BRANCH_PRUNE_ALLOWLIST: 'feature/*' } });
  assert.deepStrictEqual(pushDeletes, ['feature/ok']);
  assert.ok(outcome.skipped.some((skip) => skip.branch === 'chore/skip-me' && skip.why === 'not-allowlisted'));
});

test('a remote branch checked out in a live worktree is NEVER deleted', () => {
  const worktreePorcelain = [
    'worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
    'worktree /repo-wt', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/feature/live', '',
  ].join('\n');
  const { runner, pushDeletes } = makeMockRunner({ mergedRemoteBranches: ['feature/live', 'feature/dead'], worktreePorcelain });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE } });
  assert.deepStrictEqual(pushDeletes, ['feature/dead']);
  assert.ok(outcome.skipped.some((skip) => skip.branch === 'feature/live' && skip.why === 'worktree'));
});

test('a recently-active remote tracking ref is NEVER deleted (recency guard)', () => {
  const gitDir = mkdtempSync(join(tmpdir(), 'ghr-gitdir-'));
  mkdirSync(join(gitDir, 'refs', 'remotes', 'origin', 'feature'), { recursive: true });
  const refFile = join(gitDir, 'refs', 'remotes', 'origin', 'feature', 'fresh');
  execSync(process.platform === 'win32' ? `type nul > "${refFile}"` : `: > "${refFile}"`, { shell: true });
  const now = Date.now();
  utimesSync(refFile, new Date(now), new Date(now));
  const { runner, pushDeletes } = makeMockRunner({ mergedRemoteBranches: ['feature/fresh'], commonGitDir: gitDir.replace(/\\/g, '/') });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { GIT_HYGIENE_GRACE_MIN: '20' }, nowMs: now });
  assert.deepStrictEqual(pushDeletes, []);
  assert.ok(outcome.skipped.some((skip) => skip.branch === 'feature/fresh' && skip.why === 'recently-active'));
  rmSync(gitDir, { recursive: true, force: true });
});

test('GIT_HYGIENE_REMOTE_OFF=1 disables remote deletion', () => {
  const { runner, pushDeletes } = makeMockRunner({ mergedRemoteBranches: ['feature/done'] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE, GIT_HYGIENE_REMOTE_OFF: '1' } });
  assert.strictEqual(outcome.reason, 'remote-disabled');
  assert.deepStrictEqual(pushDeletes, []);
});

test('legacy BRANCH_PRUNE_REMOTE_OFF=1 still disables remote deletion', () => {
  const { runner, pushDeletes } = makeMockRunner({ mergedRemoteBranches: ['feature/done'] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE, BRANCH_PRUNE_REMOTE_OFF: '1' } });
  assert.strictEqual(outcome.reason, 'remote-disabled');
  assert.deepStrictEqual(pushDeletes, []);
});

test('dry-run reports the deletions but calls no push --delete', () => {
  const { runner, pushDeletes, prunedRemotes } = makeMockRunner({ mergedRemoteBranches: ['feature/done', 'fix/thing'] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE }, dryRun: true });
  assert.deepStrictEqual(pushDeletes, []);
  assert.deepStrictEqual(prunedRemotes, []);
  assert.deepStrictEqual(deletedNames(outcome), ['feature/done', 'fix/thing'].sort());
  assert.ok(outcome.deleted.every((entry) => entry.dryRun === true));
});

test('no remote configured => no-op (local-only repo)', () => {
  const { runner, pushDeletes } = makeMockRunner({ remotes: [] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE } });
  assert.strictEqual(outcome.reason, 'no-remote');
  assert.deepStrictEqual(pushDeletes, []);
});

test('no origin/main tracking ref => no-op (nothing authoritative to prove against)', () => {
  const { runner, pushDeletes } = makeMockRunner({ remoteMainRefExists: false, remoteMasterRefExists: false, mergedRemoteBranches: ['feature/done'] });
  const outcome = pruneMergedRemoteBranches({ repoRoot: '/repo', runner, env: { ...NO_GRACE } });
  assert.strictEqual(outcome.reason, 'no-remote-main');
  assert.deepStrictEqual(pushDeletes, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
