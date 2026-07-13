import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

// ── mid-chain cd: a cd after an earlier chain segment must still retarget the check ───────
// (Regression 2026-07-03: `DANGEROUS_BASH_OVERRIDE=1 true && cd <worktree-on-fix-branch> &&
//  git commit` was false-blocked — the ^-anchored cd regex missed the mid-chain cd, so the
//  hook judged the SESSION repo's branch (main) instead of the cd target's fix branch.)

test('allows `X=1 true && cd <other repo on a fix branch> && git commit` while session repo is on main', () => {
  const sessionRepoOnMain = makeGitRepo('main');
  const targetRepoOnBranch = makeGitRepo('fix/bash-guard-data-pipe-fp');
  const command = `DANGEROUS_BASH_OVERRIDE=1 true && cd ${targetRepoOnBranch.replace(/\\/g, '/')} && git add -A && git commit --no-verify -m "fix"`;
  const hookRun = runHook(command, sessionRepoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('still BLOCKS `X=1 true && cd <other repo on main> && git commit` even from a branch session', () => {
  const sessionRepoOnBranch = makeGitRepo('feature/safe-elsewhere');
  const targetRepoOnMain = makeGitRepo('main');
  const command = `X=1 true && cd "${targetRepoOnMain.replace(/\\/g, '/')}" && git commit -m "oops"`;
  const hookRun = runHook(command, sessionRepoOnBranch);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
});

test('honors the LAST cd before the commit when the chain cds twice', () => {
  const firstStopOnMain = makeGitRepo('main');
  const finalTargetOnBranch = makeGitRepo('fix/final-target');
  const command = `cd "${firstStopOnMain.replace(/\\/g, '/')}" && true && cd "${finalTargetOnBranch.replace(/\\/g, '/')}" && git commit -m "lands on the fix branch"`;
  const hookRun = runHook(command, firstStopOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('a semicolon-chained mid-command cd also retargets the check', () => {
  const sessionRepoOnMain = makeGitRepo('main');
  const targetRepoOnBranch = makeGitRepo('fix/semicolon-chain');
  const command = `true; cd "${targetRepoOnBranch.replace(/\\/g, '/')}"; git commit -m "fine"`;
  const hookRun = runHook(command, sessionRepoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('a cd AFTER the commit does not retarget the check (still judged by session repo on main)', () => {
  const sessionRepoOnMain = makeGitRepo('main');
  const elsewhereOnBranch = makeGitRepo('fix/elsewhere');
  const command = `git commit -m "oops on main" && cd "${elsewhereOnBranch.replace(/\\/g, '/')}"`;
  const hookRun = runHook(command, sessionRepoOnMain);

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
// safe-merge-to-main.sh landing (incident 2026-07-02: a plain override commit's stale
// parent silently produced a 991-line regression while another agent's landing raced in).

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

// ── non-executable regions: `git commit` in a HEREDOC BODY or a `#` COMMENT is DATA/prose, ──
// not a real command token. (Regression 2026-07-06: a `cat >> log.txt << 'EOF' … git commit …
// EOF` heredoc-append was DENIED — the phrase lived in the heredoc BODY, which is text written
// to a file, never executed. Same class as a bash `#`-comment mentioning `git commit`.)

test('does NOT fire on a `git commit` inside a single-quoted heredoc BODY (data, not a command)', () => {
  const repoOnMain = makeGitRepo('main');
  const command = "cat >> log.txt << 'EOF'\ndid a git commit earlier today\nEOF";
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('does NOT fire on a `git commit` inside an unquoted `<<EOF` heredoc BODY', () => {
  const repoOnMain = makeGitRepo('main');
  const command = 'cat >> notes.txt <<EOF\nremember to git commit the changes\nEOF';
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('does NOT fire on a `git commit` inside an indented `<<-TAG` heredoc BODY', () => {
  const repoOnMain = makeGitRepo('main');
  const command = 'cat >> notes.txt <<-END\n\t\tstep 1: git commit -m foo\n\tEND';
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('does NOT fire on a `git commit` inside a double-quoted `<<"TAG"` heredoc BODY', () => {
  const repoOnMain = makeGitRepo('main');
  const command = 'cat >> notes.txt <<"MSG"\nthe instructions say git commit next\nMSG';
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('does NOT fire on a `git commit` that appears only in a `#` shell COMMENT', () => {
  const repoOnMain = makeGitRepo('main');
  const command = 'echo hi # remember to git commit later on the branch';
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('does NOT fire on a `git commit` in a `#` comment on a chain segment after a real command', () => {
  const repoOnMain = makeGitRepo('main');
  const command = 'git status    # then git commit once the branch is cut';
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

// TEETH: a real `git commit` OUTSIDE any heredoc/comment on main must STILL block — even when
// an EARLIER heredoc body happens to also contain the words `git commit`.
test('STILL BLOCKS a real `git commit` on main that follows a heredoc body also mentioning git commit', () => {
  const repoOnMain = makeGitRepo('main');
  const command = "cat >> log.txt << 'EOF'\nnote: git commit later\nEOF\ngit commit -m \"real commit on main\"";
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /Commit to main blocked/);
});

test('STILL BLOCKS a real `git commit` on main that follows a `#` comment mentioning git commit', () => {
  const repoOnMain = makeGitRepo('main');
  const command = 'echo start # will git commit soon\ngit commit -m "real one on main"';
  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /Commit to main blocked/);
});

// ── merge exemption: a `git commit` COMPLETING an in-progress merge on main must be ALLOWED ──
// (Added 2026-07-06.) A merge commit MUST land on the target branch — you cannot finish a
// `git merge`/`git pull` into main on a feature branch. Blocking it forced COMMIT_MAIN_OVERRIDE=1
// for every routine merge-to-main (friction + override-habit training). The exemption keys off
// MERGE_HEAD (mid-flight merge) or a `git merge`/`git pull` command token; ordinary direct
// commits (no merge in progress) must STILL block.

// Put main on a real merge that leaves a conflict so MERGE_HEAD persists (the merge is
// "in progress" and awaiting `git commit`). Returns the repo dir sitting mid-merge on main.
function makeRepoMidMergeOnMain() {
  const repoDirectory = mkdtempSync(join(tmpdir(), 'no-commit-to-main-merge-'));
  const runGit = (gitArguments) => execSync(`git ${gitArguments}`, { cwd: repoDirectory, stdio: 'ignore' });
  runGit('init -q');
  runGit('config user.email test@example.com');
  runGit('config user.name Test');
  runGit('checkout -q -b main'); // force the base branch name to main regardless of git default
  writeFileSync(join(repoDirectory, 'conflict.txt'), 'base\n', 'utf8');
  runGit('add conflict.txt');
  runGit('commit -q -m base');
  // Branch that edits the same line one way…
  runGit('switch -q -c feature/side');
  writeFileSync(join(repoDirectory, 'conflict.txt'), 'from-feature\n', 'utf8');
  runGit('add conflict.txt');
  runGit('commit -q -m feature-edit');
  // …and main edits it another way, so the merge conflicts and MERGE_HEAD is written + kept.
  runGit('switch -q main');
  writeFileSync(join(repoDirectory, 'conflict.txt'), 'from-main\n', 'utf8');
  runGit('add conflict.txt');
  runGit('commit -q -m main-edit');
  try {
    runGit('merge feature/side'); // conflicts → non-zero exit, MERGE_HEAD left in place
  } catch {
    // expected: merge halts with a conflict, MERGE_HEAD now exists
  }
  // Resolve the conflict so a real `git commit` could complete the merge (state is what matters).
  writeFileSync(join(repoDirectory, 'conflict.txt'), 'resolved\n', 'utf8');
  runGit('add conflict.txt');
  return repoDirectory;
}

test('ALLOWS `git commit` completing an in-progress merge on main (MERGE_HEAD present)', () => {
  const repoMidMerge = makeRepoMidMergeOnMain();
  // Sanity: MERGE_HEAD really exists (the fixture is mid-merge).
  execSync('git rev-parse -q --verify MERGE_HEAD', { cwd: repoMidMerge, stdio: 'ignore' });

  const hookRun = runHook('git commit --no-edit', repoMidMerge);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, ''); // silent = allowed, no override needed
});

test('STILL BLOCKS an ordinary direct `git commit` on main (no merge in progress)', () => {
  const repoDirectory = makeGitRepo('main'); // clean repo, NO MERGE_HEAD
  const hookRun = runHook('git commit -m "ordinary direct commit"', repoDirectory);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /Commit to main blocked/);
});

test('ALLOWS a `git merge <branch> && git commit` command on main (merge/pull command token)', () => {
  const repoDirectory = makeGitRepo('main');
  const hookRun = runHook('git merge feature/x && git commit --no-edit', repoDirectory);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('COMMIT_MAIN_OVERRIDE=1 still bypasses on an ordinary main commit (merge exemption is additive)', () => {
  const repoDirectory = makeGitRepo('main');
  const hookRun = runHook('COMMIT_MAIN_OVERRIDE=1 git commit -m "deliberate main commit"', repoDirectory);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('does NOT treat a `git merge` mentioned only in quoted prose as a real merge (teeth kept)', () => {
  const repoDirectory = makeGitRepo('main'); // clean, no MERGE_HEAD
  const hookRun = runHook('git commit -m "about to git merge later"', repoDirectory);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
});

test('fails open (ALLOWS) when `git worktree list` errors — never block on a plumbing hiccup', () => {
  // Point the hook at a directory that looks like it has a .git file but where `git
  // worktree list` will fail (a git command run outside any real repository).
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

// ── doc-only exemption: a DOCUMENTATION-ONLY commit on main is ALLOWED without a branch ──────
// (Added 2026-07-07, Russell asked directly.) doc-only iff EVERY staged path is one of
// .md/.markdown/.mdx/.txt/.rst (case-insensitive). If ANY staged file is code (.py/.mjs/.js/
// .html/.json/.sh/no-extension/…) the existing block stands. Empty staged set → NOT doc-only.

function stageFile(repoDirectory, fileName, contents = 'content\n') {
  writeFileSync(join(repoDirectory, fileName), contents, 'utf8');
  execSync(`git add "${fileName}"`, { cwd: repoDirectory, stdio: 'ignore' });
}

test('ALLOWS a commit on main when ALL staged files are .md (doc-only)', () => {
  const repoOnMain = makeGitRepo('main');
  stageFile(repoOnMain, 'NOTES.md');
  stageFile(repoOnMain, 'docs.md');

  const hookRun = runHook('git commit -m "docs update"', repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, ''); // silent = allowed, no branch/override needed
});

test('ALLOWS a commit on main when staged files span the whole doc-only set (.markdown/.mdx/.txt/.rst)', () => {
  const repoOnMain = makeGitRepo('main');
  stageFile(repoOnMain, 'a.markdown');
  stageFile(repoOnMain, 'b.mdx');
  stageFile(repoOnMain, 'c.txt');
  stageFile(repoOnMain, 'd.rst');

  const hookRun = runHook('git commit -m "all doc kinds"', repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('BLOCKS a commit on main when staged files MIX .md and .py (not doc-only)', () => {
  const repoOnMain = makeGitRepo('main');
  stageFile(repoOnMain, 'README.md');
  stageFile(repoOnMain, 'script.py');

  const hookRun = runHook('git commit -m "mixed"', repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /Commit to main blocked/);
});

test('BLOCKS a commit on main when ALL staged files are code (.py)', () => {
  const repoOnMain = makeGitRepo('main');
  stageFile(repoOnMain, 'one.py');
  stageFile(repoOnMain, 'two.py');

  const hookRun = runHook('git commit -m "code only"', repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /Commit to main blocked/);
});

test('doc-only detection is case-insensitive (.MD counts as doc-only)', () => {
  const repoOnMain = makeGitRepo('main');
  stageFile(repoOnMain, 'READ.MD');

  const hookRun = runHook('git commit -m "shouty extension"', repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('a doc-only (.md) commit on a FEATURE branch is allowed exactly as before', () => {
  const repoOnBranch = makeGitRepo('feature/docs-work');
  stageFile(repoOnBranch, 'GUIDE.md');

  const hookRun = runHook('git commit -m "docs on a branch"', repoOnBranch);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('COMMIT_MAIN_OVERRIDE=1 with staged .py on main still bypasses (override unaffected by doc-only path)', () => {
  const repoOnMain = makeGitRepo('main');
  stageFile(repoOnMain, 'app.py');

  const hookRun = runHook('COMMIT_MAIN_OVERRIDE=1 git commit -m "deliberate code commit"', repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('a no-extension staged file on main is NOT doc-only (blocks)', () => {
  const repoOnMain = makeGitRepo('main');
  stageFile(repoOnMain, 'Makefile');

  const hookRun = runHook('git commit -m "no extension"', repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
});

// ── chained `git add ... && git commit`: PreToolUse fires BEFORE the shell command runs, so an
// earlier `git add` in the SAME chained command has not staged anything yet when the doc-only
// check reads `git diff --cached --name-only`. (Regression 2026-07-13: a real commit of exactly
// three .md files — one under docs/, via `git add README.md HANDOFF.md docs/plans/x.md && git
// commit -m ...` — was wrongly blocked, forcing the COMMIT_MAIN_OVERRIDE=1 escape hatch even
// though the hook's own stated rule says an all-.md commit should auto-pass.)

test('ALLOWS `git add <3 .md files, one under docs/> && git commit` on main in one chained command (exact repro)', () => {
  const repoOnMain = makeGitRepo('main');
  writeFileSync(join(repoOnMain, 'README.md'), 'readme\n', 'utf8');
  writeFileSync(join(repoOnMain, 'HANDOFF.md'), 'handoff\n', 'utf8');
  mkdirSync(join(repoOnMain, 'docs/plans'), { recursive: true });
  writeFileSync(join(repoOnMain, 'docs/plans/145-persistent-lazy-gateway-07-13-2026.md'), 'plan\n', 'utf8');
  const command = 'git add README.md HANDOFF.md docs/plans/145-persistent-lazy-gateway-07-13-2026.md && git commit -m "docs update"';

  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, ''); // silent = allowed, no COMMIT_MAIN_OVERRIDE=1 needed
});

test('BLOCKS `git add <.md + .py> && git commit` chained on main (pending add is not doc-only)', () => {
  const repoOnMain = makeGitRepo('main');
  writeFileSync(join(repoOnMain, 'NOTES.md'), 'notes\n', 'utf8');
  writeFileSync(join(repoOnMain, 'script.py'), 'print(1)\n', 'utf8');
  const command = 'git add NOTES.md script.py && git commit -m "mixed chained"';

  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
});

test('BLOCKS `git add -A && git commit` chained on main even when the working tree only has .md changes (ambiguous pathspec fails closed)', () => {
  const repoOnMain = makeGitRepo('main');
  writeFileSync(join(repoOnMain, 'NOTES.md'), 'notes\n', 'utf8');
  const command = 'git add -A && git commit -m "add all, docs only in practice"';

  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
});

test('BLOCKS `git add . && git commit` chained on main (bare-dot pathspec fails closed, same as -A)', () => {
  const repoOnMain = makeGitRepo('main');
  writeFileSync(join(repoOnMain, 'NOTES.md'), 'notes\n', 'utf8');
  const command = 'git add . && git commit -m "add dot"';

  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
});

test('ALLOWS a chained doc-only add+commit combined with a file staged in an EARLIER separate command', () => {
  const repoOnMain = makeGitRepo('main');
  stageFile(repoOnMain, 'ALREADY-STAGED.md'); // staged as its own prior command, like the existing tests do
  writeFileSync(join(repoOnMain, 'NEW.md'), 'new\n', 'utf8');
  const command = 'git add NEW.md && git commit -m "combine already-staged with pending add"';

  const hookRun = runHook(command, repoOnMain);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});
