#!/usr/bin/env node
/**
 * Tests for no-feature-branch-push. Spawns the hook as a real subprocess (it reads
 * stdin + shells out to `git branch --show-current`), asserting on its stdout JSON
 * decision. Run: node --test no-feature-branch-push.test.mjs
 *
 * Regression case (2026-07-02): `git push <local-worktree-path> HEAD:main` -- a
 * same-machine push that fast-forwards `main` in ANOTHER worktree (used by the
 * squash-merge protocol when `main` is checked out elsewhere) -- was false-positive
 * BLOCKED because the old regex required the literal token `origin` before the
 * refspec. The hook's own docstring already says `git push origin HEAD:main` should
 * be ALLOWED; a non-origin remote/path targeting `:main` is the same case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// A self-contained scratch git repo checked out on a NON-main branch, so the block path engages without
// depending on a machine-specific feature worktree. name-by-use-override: `cwd` is spawnSync's keyword.
function makeFeatureRepo() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'push-guard-'));
  const git = (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  git(['commit', '-q', '--allow-empty', '-m', 'init']);
  git(['branch', '-M', 'main']);
  git(['checkout', '-q', '-b', 'feature/some-work']);
  git(['remote', 'add', 'origin', 'https://example.com/x.git']);       // a NETWORK remote (should block)
  git(['remote', 'add', 'upstream', 'git@github.com:me/x.git']);        // another network remote (should block)
  const mirror = mkdtempSync(path.join(tmpdir(), 'push-mirror-')) + '/backup.git';
  spawnSync('git', ['init', '--bare', '-q', mirror]);
  git(['remote', 'add', 'seagate', mirror]);                            // a LOCAL bare backup mirror (should ALLOW)
  return repoRoot;
}

const HOOK_PATH = fileURLToPath(new URL('./no-feature-branch-push.mjs', import.meta.url));
// The hook's own decision hinges on `git branch --show-current` in the working directory it
// runs from -- it must NOT be `main` (a repo on main short-circuits to "allow", by the hook's
// own `if (branch === 'main') process.exit(0)`). `~/.claude` itself is checked out on main, so
// the block-path tests below need a repo checked out on a non-main branch to actually engage
// the rule they're testing.
// name-by-use-override: `cwd` below is the literal Node.js child_process spawn option keyword
// (the interface `spawnSync` accepts), not a local we get to rename.
const HOOK_REPO_ROOT = path.resolve(path.dirname(HOOK_PATH), '..', '..');

function runHook(command, { cwd = HOOK_REPO_ROOT, env = {} } = {}) {
  const event = { tool_name: 'Bash', tool_input: { command } };
  const child = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, PUSH_BRANCH_OVERRIDE: undefined, ...env },
  });
  return child;
}

// name-by-use-override: `cwd` below is the literal Node.js child_process spawn option
// keyword (the interface `spawnSync` accepts), not a local we get to rename.
function currentBranch(cwd) {
  const child = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
  return (child.stdout || '').trim();
}

function isBlocked(stdout) {
  if (!stdout || !stdout.trim()) return false;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  return parsed?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('allows `git push origin main` (the canonical ship)', () => {
  const child = runHook('git push origin main');
  assert.equal(isBlocked(child.stdout), false);
});

test('allows `git push origin HEAD:main`', () => {
  const child = runHook('git push origin HEAD:main');
  assert.equal(isBlocked(child.stdout), false);
});

test('allows a non-origin local path pushing HEAD:main (regression: same-machine ff-merge)', () => {
  const child = runHook('git push "C:/Users/rmill/Desktop/programming/skaffen-desktop" HEAD:main');
  assert.equal(isBlocked(child.stdout), false);
});

test('allows a non-origin local path pushing explicit `main`', () => {
  const child = runHook('git push /some/local/repo main');
  assert.equal(isBlocked(child.stdout), false);
});

test('allows a non-origin remote pushing refs/heads/main', () => {
  const child = runHook('git push upstream refs/heads/main');
  assert.equal(isBlocked(child.stdout), false);
});

test('allows `git push --delete origin feature/foo` (cleanup)', () => {
  const child = runHook('git push origin --delete feature/foo');
  assert.equal(isBlocked(child.stdout), false);
});

test('allows `git push --tags`', () => {
  const child = runHook('git push --tags');
  assert.equal(isBlocked(child.stdout), false);
});

test('ignores non-push commands entirely', () => {
  const child = runHook('git status');
  assert.equal(isBlocked(child.stdout), false);
});

test('PUSH_BRANCH_OVERRIDE=1 always allows', () => {
  const child = runHook('git push origin some-feature-branch', {
    env: { PUSH_BRANCH_OVERRIDE: '1' },
  });
  assert.equal(isBlocked(child.stdout), false);
});

// 2026-07-18 BUG: the documented escape `PUSH_BRANCH_OVERRIDE=1 git push …` was UNREACHABLE — a
// PreToolUse hook runs before the shell, so an inline env prefix never reaches process.env. The hook
// must honor the override token from the COMMAND STRING.
test('inline PUSH_BRANCH_OVERRIDE=1 prefix on the command allows the push (escape hatch reachable)', () => {
  const repoRoot = makeFeatureRepo();
  try {
    // Control: without the override, a feature-branch push to origin is blocked.
    assert.equal(isBlocked(runHook('git push origin feature/some-work', { cwd: repoRoot }).stdout), true, 'control: feature push should block');
    // With the inline override prefix, it is allowed.
    assert.equal(isBlocked(runHook('PUSH_BRANCH_OVERRIDE=1 git push origin feature/some-work', { cwd: repoRoot }).stdout), false, 'inline override must be honored');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// The block-path tests need a working directory checked out on a non-main branch (the hook
// short-circuits to "allow" on main). Look for one of this session's own feature worktrees;
// skip gracefully (never false-pass) if none is found on this machine.
const FEATURE_WORKTREE_CANDIDATES = [
  'C:/Users/rmill/Desktop/programming/skaffen-desktop-feat/google-workspace-tools',
  'C:/Users/rmill/Desktop/programming/skaffen-desktop-feat/api-discovery-tools',
];
const nonMainWorktree = FEATURE_WORKTREE_CANDIDATES.find((candidate) => {
  const branch = currentBranch(candidate);
  return branch && branch !== 'main';
});

test('still blocks pushing a named feature branch to origin (the actual rule)', (t) => {
  if (!nonMainWorktree) {
    t.skip('no non-main feature worktree found on this machine to exercise the block path');
    return;
  }
  const child = runHook('git push origin feature/some-work', { cwd: nonMainWorktree });
  assert.equal(isBlocked(child.stdout), true);
});

// 2026-07-18 fix #2: a LOCAL-filesystem backup mirror is a backup, not remote clutter — the
// "backup after every commit" rule mandates it. Pushing a feature branch to a local-path remote (a
// resolved local `git remote get-url`, or a literal path) is ALLOWED; a NETWORK remote still blocks.
test('ALLOWS a feature-branch push to a local backup-mirror remote (seagate -> local bare)', () => {
  const repoRoot = makeFeatureRepo();
  try {
    assert.equal(isBlocked(runHook('git push seagate feature/some-work', { cwd: repoRoot }).stdout), false, 'local mirror is a backup, allowed');
    // A literal local path as the push target is also allowed.
    assert.equal(isBlocked(runHook('git push /some/local/repo feature/some-work', { cwd: repoRoot }).stdout), false, 'a literal local path is a backup, allowed');
    // But a NETWORK non-origin remote still blocks.
    assert.equal(isBlocked(runHook('git push upstream feature/some-work', { cwd: repoRoot }).stdout), true, 'a network remote still clutters — blocked');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
