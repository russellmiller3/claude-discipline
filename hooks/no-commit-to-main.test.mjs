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
