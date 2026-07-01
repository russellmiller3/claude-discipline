import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'no-commit-to-main.mjs');

function makeGitRepo(branchName) {
  const repoDirectory = mkdtempSync(join(tmpdir(), 'no-commit-to-main-'));
  const runGit = (gitArguments) => execSync(`git ${gitArguments}`, { cwd: repoDirectory, stdio: 'ignore' });
  runGit('init -q');
  runGit('config user.email test@example.com');
  runGit('config user.name Test');
  writeFileSync(join(repoDirectory, 'readme.txt'), 'hello\n', 'utf8');
  runGit('add readme.txt');
  runGit('commit -q -m init');
  if (branchName && branchName !== 'main' && branchName !== 'master') {
    runGit(`switch -c ${branchName}`);
  }
  return repoDirectory;
}

function runHook(command, repoDirectory, extraEnvironment = {}) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    cwd: repoDirectory,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnvironment },
  });
}

test('blocks git commit while on main', () => {
  const repoDirectory = makeGitRepo('main');
  const hookRun = runHook('git commit -m "oops"', repoDirectory);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /Commit to main blocked/);
});

test('allows git commit on a feature branch', () => {
  const repoDirectory = makeGitRepo('feature/some-task');
  const hookRun = runHook('git commit -m "fine"', repoDirectory);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('allows a non-commit git command on main (e.g. status)', () => {
  const repoDirectory = makeGitRepo('main');
  const hookRun = runHook('git status', repoDirectory);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('inline COMMIT_MAIN_OVERRIDE=1 in the command text passes on main', () => {
  const repoDirectory = makeGitRepo('main');
  const hookRun = runHook('COMMIT_MAIN_OVERRIDE=1 git commit -m "deliberate main commit"', repoDirectory);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('real env var COMMIT_MAIN_OVERRIDE=1 passes on main', () => {
  const repoDirectory = makeGitRepo('main');
  const hookRun = runHook('git commit -m "deliberate"', repoDirectory, { COMMIT_MAIN_OVERRIDE: '1' });

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('a non-Bash tool is ignored entirely', () => {
  const repoDirectory = makeGitRepo('main');
  const hookRun = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'x.txt' } }),
    cwd: repoDirectory,
    encoding: 'utf8',
  });

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

// ── cross-repo targeting: judge the repo the COMMIT runs in, not the session repo ─────────
// (Regression 2026-07-01: session repo on main + `cd <other-repo-on-fix-branch> && git commit`
//  was false-blocked because the hook read the session repo's branch.)

test('allows `cd <other repo on a fix branch> && git commit` while session repo is on main', () => {
  const sessionRepoOnMain = makeGitRepo('main');
  const targetRepoOnBranch = makeGitRepo('fix/kit-sync');
  const command = `cd "${targetRepoOnBranch.replace(/\\/g, '/')}" && git add -A && git commit -m "sync"`;
  const hookRun = runHook(command, sessionRepoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('allows `git -C <other repo on a branch> commit` while session repo is on main', () => {
  const sessionRepoOnMain = makeGitRepo('main');
  const targetRepoOnBranch = makeGitRepo('feature/away');
  const command = `git -C "${targetRepoOnBranch.replace(/\\/g, '/')}" commit -m "fine"`;
  const hookRun = runHook(command, sessionRepoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('still BLOCKS `cd <other repo on main> && git commit` even from a branch session', () => {
  const sessionRepoOnBranch = makeGitRepo('feature/safe');
  const targetRepoOnMain = makeGitRepo('main');
  const command = `cd "${targetRepoOnMain.replace(/\\/g, '/')}" && git commit -m "oops"`;
  const hookRun = runHook(command, sessionRepoOnBranch);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
});

test('allows the branch-then-commit one-liner: `git switch -c fix/x && ... && git commit` on main', () => {
  const repoOnMain = makeGitRepo('main');
  const command = 'git switch -c fix/docs && git add -A && git commit --no-verify -m "docs"';
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('still BLOCKS a chain that switches BACK to main before committing', () => {
  const repoOnBranch = makeGitRepo('feature/wip');
  const command = 'git switch main && git commit -m "sneaky direct-to-main"';
  const hookRun = runHook(command, repoOnBranch);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
});

test('a `checkout -- <file>` restore is NOT treated as a branch switch (still judged by repo branch)', () => {
  const repoOnMain = makeGitRepo('main');
  const command = 'git checkout -- readme.txt && git commit -m "oops on main"';
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
});
