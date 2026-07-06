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

// ── concurrency check: COMMIT_MAIN_OVERRIDE=1 must not race a background agent's ──────────
// safe-merge-to-main.sh landing (a real incident: a plain override commit's stale parent
// silently produced a 991-line regression while another agent's landing raced in).

function addWorktree(repoDirectory, branchName) {
  const worktreeDirectory = mkdtempSync(join(tmpdir(), 'no-commit-to-main-wt-'));
  execSync(`git worktree add "${worktreeDirectory.replace(/\\/g, '/')}" -b ${branchName}`, {
    cwd: repoDirectory,
    stdio: 'ignore',
  });
  return worktreeDirectory;
}

function lockWorktree(repoDirectory, worktreeDirectory, reason = 'agent active') {
  execSync(`git worktree lock "${worktreeDirectory.replace(/\\/g, '/')}" --reason "${reason}"`, {
    cwd: repoDirectory,
    stdio: 'ignore',
  });
}

test('COMMIT_MAIN_OVERRIDE=1 on main is DENIED when another worktree is locked (concurrent agent)', () => {
  const repoOnMain = makeGitRepo('main');
  const agentWorktree = addWorktree(repoOnMain, 'agent/in-flight');
  lockWorktree(repoOnMain, agentWorktree);

  const hookRun = runHook('COMMIT_MAIN_OVERRIDE=1 git commit -m "doc-only update"', repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /concurrency detected/i);
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /safe-merge-to-main\.sh/);
});

test('COMMIT_MAIN_OVERRIDE=1 on main is ALLOWED when the other worktree is present but NOT locked', () => {
  const repoOnMain = makeGitRepo('main');
  addWorktree(repoOnMain, 'agent/finished'); // present, never locked (idle/already done)

  const hookRun = runHook('COMMIT_MAIN_OVERRIDE=1 git commit -m "doc-only update"', repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('CONCURRENT_COMMIT_OK=1 alongside COMMIT_MAIN_OVERRIDE=1 is ALLOWED even with a locked worktree', () => {
  const repoOnMain = makeGitRepo('main');
  const agentWorktree = addWorktree(repoOnMain, 'agent/in-flight-2');
  lockWorktree(repoOnMain, agentWorktree);

  const hookRun = runHook(
    'COMMIT_MAIN_OVERRIDE=1 CONCURRENT_COMMIT_OK=1 git commit -m "verified safe"',
    repoOnMain
  );

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('CONCURRENT_COMMIT_OK=1 as a real env var (not inline) also honors the override with a locked worktree', () => {
  const repoOnMain = makeGitRepo('main');
  const agentWorktree = addWorktree(repoOnMain, 'agent/in-flight-3');
  lockWorktree(repoOnMain, agentWorktree);

  const hookRun = runHook('git commit -m "verified safe"', repoOnMain, {
    COMMIT_MAIN_OVERRIDE: '1',
    CONCURRENT_COMMIT_OK: '1',
  });

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('COMMIT_MAIN_OVERRIDE=1 in a genuinely solo repo (no other worktrees at all) is ALLOWED, unaffected', () => {
  const repoOnMain = makeGitRepo('main'); // no addWorktree call — only the primary checkout exists

  const hookRun = runHook('COMMIT_MAIN_OVERRIDE=1 git commit -m "solo doc update"', repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('fails open (ALLOWS) when `git worktree list` errors — never block on a plumbing hiccup', () => {
  // Point the hook at a directory that has no real git repository, so `git worktree
  // list` (run by the concurrency check) fails.
  const notARepoDirectory = mkdtempSync(join(tmpdir(), 'no-commit-to-main-not-a-repo-'));

  const hookRun = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'COMMIT_MAIN_OVERRIDE=1 git commit -m "whatever"' },
    }),
    cwd: notARepoDirectory,
    encoding: 'utf8',
    env: { ...process.env },
  });

  // Outside a repo, `git branch --show-current` inside the non-override path would also
  // fail open — but here the override IS present, so the only path that runs is the
  // concurrency check, whose `git worktree list` call fails identically. Either way this
  // must never deny: fail open on plumbing errors.
  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

// ── 2026-07-06 quoted-prose + heredoc-body + `#`-comment false-positive locks ─────────────
// The trigger scan must only ever see EXECUTABLE structure. A `git commit` that appears only
// inside quoted text (echo/prose or a quoted arg to another program), inside a heredoc BODY
// (data written to a file, never run), or after a `#` comment marker (discarded by the shell)
// is NOT a real command token and must NOT fire the guard. (Regression: a
// `cat >> log << 'EOF' … git commit … EOF` heredoc-append and a `# … git commit …` comment
// were both DENIED before the fix. The pre-fix kit hook lacked both quote-masking AND
// heredoc/comment neutralization; either would false-fire here.) Teeth-preserving case last.

test('does NOT fire on echo text containing "git commit" and "main" on main (quoted prose)', () => {
  const repoOnMain = makeGitRepo('main');
  const hookRun = runHook('echo "remember to git commit then merge to main"', repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('does NOT fire on a quoted "git commit …" argument to another program on main', () => {
  const repoOnMain = makeGitRepo('main');
  const hookRun = runHook('node brief.mjs --goal "git commit then merge to main"', repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('does NOT fire on a `git commit` inside a heredoc BODY on main (data, never executed)', () => {
  const repoOnMain = makeGitRepo('main');
  const heredocCommand = "cat >> notes.log << 'EOF'\ngit commit -m \"a note that mentions committing on main\"\nEOF";
  const hookRun = runHook(heredocCommand, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('does NOT fire on a `#`-comment `git commit` on main (comment discarded by the shell)', () => {
  const repoOnMain = makeGitRepo('main');
  const hookRun = runHook('echo hi   # later: git commit -m "on main"', repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('TEETH: a REAL `git commit` on main is STILL BLOCKED after the FP fix', () => {
  const repoOnMain = makeGitRepo('main');
  const hookRun = runHook('git commit -m "real direct-to-main commit"', repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /Commit to main blocked/);
});
