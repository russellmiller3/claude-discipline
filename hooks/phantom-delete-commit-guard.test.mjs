#!/usr/bin/env node
// phantom-delete-commit-guard.test.mjs — locks the "don't silently revert a sibling agent's landing" guard.
//
// THE INCIDENT this guard exists for (bit 3x on 2026-07-03): a sibling agent's compare-and-swap
// landing moves refs/heads/main under the PRIMARY checkout; the primary's working tree goes stale;
// the just-landed files show up as DELETIONS in `git status`; the next `git commit` from the
// primary silently REVERTS the landing. These tests prove the guard blocks exactly that shape
// (committing phantom deletions of files this session never touched) while staying silent on
// linked worktrees, session-owned deletions, clean trees, and non-commit commands.
//
// Run: node --test phantom-delete-commit-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const hookDirectory = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hookDirectory, 'phantom-delete-commit-guard.mjs');

// Sandbox lives NEXT TO this test file, not under the OS temp dir — delete-audit-guard's lesson:
// temp-dir paths read as scratch/special to path heuristics, and this guard's worktree-path skip
// must be exercised against realistic project-looking paths.
const sandboxDirectory = join(hookDirectory, `.phantom-delete-commit-guard-test-sandbox-${process.pid}`);
mkdirSync(sandboxDirectory, { recursive: true });

const combinedOutputOf = (childProcess) => (childProcess.stdout || '') + (childProcess.stderr || '');

// Runs `git` in a directory with identity flags so commits work on any machine.
function git(repoDirectory, ...gitArgs) {
  const gitInvocation = spawnSync('git', [
    '-C', repoDirectory,
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=Test',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', // a repo-level hook must never leak into this sandbox
    ...gitArgs,
  ], { encoding: 'utf8' });
  if (gitInvocation.status !== 0) {
    throw new Error(`git ${gitArgs.join(' ')} failed in ${repoDirectory}:\n${gitInvocation.stderr}`);
  }
  return gitInvocation.stdout;
}

// Builds a real git repo containing committed files, then deletes `phantomRelativePaths` from the
// working tree WITHOUT any session record — exactly what a stale primary checkout looks like after
// a sibling agent's ref-move. Returns the repo path.
let repoCounter = 0;
function makeRepoWithPhantomDeletions(phantomRelativePaths, { staged = false } = {}) {
  const repoDirectory = join(sandboxDirectory, `repo-${repoCounter++}`);
  mkdirSync(repoDirectory, { recursive: true });
  git(repoDirectory, 'init', '-q');
  for (const relativePath of ['keep.txt', ...phantomRelativePaths]) {
    const fullPath = join(repoDirectory, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `content of ${relativePath}\n`, 'utf8');
  }
  git(repoDirectory, 'add', '-A');
  git(repoDirectory, 'commit', '-q', '-m', 'baseline');
  for (const relativePath of phantomRelativePaths) {
    if (staged) {
      git(repoDirectory, 'rm', '-q', relativePath); // 'D ' — staged deletion
    } else {
      rmSync(join(repoDirectory, relativePath)); // ' D' — unstaged deletion
    }
  }
  return repoDirectory;
}

// Minimal fake session transcript (JSONL). Records a Write tool_use for each of `touchedPaths`
// so the guard sees those files as session-owned.
function makeTranscript(touchedPaths = []) {
  const transcriptPath = join(sandboxDirectory, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  const transcriptLines = [
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
  ];
  for (const touchedPath of touchedPaths) {
    transcriptLines.push(JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: touchedPath } }],
      },
    }));
  }
  if (!touchedPaths.length) {
    transcriptLines.push(JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'whatever' } }] },
    }));
  }
  writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n', 'utf8');
  return transcriptPath;
}

function runHook(command, { tool = 'Bash', transcriptPath, workingDirectory, env } = {}) {
  const payload = {
    tool_name: tool,
    tool_input: { command },
    transcript_path: transcriptPath,
    cwd: workingDirectory || sandboxDirectory,
  };
  const hookProcess = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, PHANTOM_DELETE_OK: '', ...(env || {}) },
  });
  return { combinedOutput: combinedOutputOf(hookProcess), exitCode: hookProcess.status };
}

const isBlocked = (combinedOutput) => /"permissionDecision"\s*:\s*"deny"/.test(combinedOutput);

test('git commit on primary checkout with unstaged phantom deletion -> blocks, names path, fix, and escape token', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['landed-by-sibling.md']);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny for committing a phantom deletion');
  assert.match(combinedOutput, /landed-by-sibling\.md/, 'deny reason must name the phantom path');
  assert.match(combinedOutput, /git checkout HEAD --/, 'deny reason must give the restore fix');
  assert.match(combinedOutput, /PHANTOM_DELETE_OK/, 'deny reason must give the escape token');
});

test('git commit with STAGED phantom deletion (git rm) -> blocks', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['staged-away.md'], { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -m "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny for committing a staged phantom deletion');
  assert.match(combinedOutput, /staged-away\.md/);
});

test('deleted file WAS written by this session -> passes (intentional deletion)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['mine-to-delete.md']);
  const transcriptPath = makeTranscript([join(repoDirectory, 'mine-to-delete.md')]);
  const { combinedOutput } = runHook('git commit -am "remove my own file"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow when the session itself created/edited the deleted file');
});

test('repo under .claude/worktrees/ -> passes (linked worktrees rebase cleanly; bug is primary-only)', () => {
  const worktreeParent = join(sandboxDirectory, '.claude', 'worktrees', 'agent-x');
  mkdirSync(worktreeParent, { recursive: true });
  const repoDirectory = join(worktreeParent, 'repo');
  mkdirSync(repoDirectory, { recursive: true });
  git(repoDirectory, 'init', '-q');
  writeFileSync(join(repoDirectory, 'file.md'), 'content\n', 'utf8');
  git(repoDirectory, 'add', '-A');
  git(repoDirectory, 'commit', '-q', '-m', 'baseline');
  rmSync(join(repoDirectory, 'file.md'));
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow inside a .claude/worktrees/ checkout');
});

test('git -C <worktree-path> commit from elsewhere -> passes (repo in play is the worktree)', () => {
  const worktreeRepo = join(sandboxDirectory, '.claude', 'worktrees', 'agent-y');
  mkdirSync(worktreeRepo, { recursive: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(`git -C "${worktreeRepo}" commit -am "wip"`, { transcriptPath, workingDirectory: sandboxDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow when -C targets a .claude/worktrees/ path');
});

test('PHANTOM_DELETE_OK token in the command -> passes even with phantom deletions', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['escape-hatch.md']);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('PHANTOM_DELETE_OK=1 git commit -am "I really mean it"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow with the inline escape token');
});

test('PHANTOM_DELETE_OK=1 in the environment -> passes even with phantom deletions', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['env-escape.md']);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory, env: { PHANTOM_DELETE_OK: '1' } });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow with the env escape');
});

test('non-commit git command (git status) with phantom deletions present -> passes', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['not-committing-yet.md']);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git status', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow for a non-commit command');
});

test('git commit on a clean tree -> passes', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]); // baseline only, nothing deleted
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit --allow-empty -m "clean"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow on a clean tree');
});

test('git commit outside any git repo -> passes (fail-open on non-repo)', () => {
  const bareDirectory = join(sandboxDirectory, 'not-a-repo');
  mkdirSync(bareDirectory, { recursive: true });
  const transcriptPath = makeTranscript([]);
  // The sandbox itself lives inside a real repo (~/.claude); a discovery ceiling makes this
  // directory genuinely repo-less from git's point of view instead of resolving upward.
  const { combinedOutput } = runHook('git commit -am "wip"', {
    transcriptPath,
    workingDirectory: bareDirectory,
    env: { GIT_CEILING_DIRECTORIES: sandboxDirectory.replace(/\\/g, '/') },
  });
  assert.equal(isBlocked(combinedOutput), false, 'expected fail-open outside a repo');
});

test('no transcript available -> passes (fail-open: cannot prove provenance)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['unknowable.md']);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath: undefined, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected fail-open when no transcript exists');
});

test('malformed JSON on stdin -> silent pass (fail-open)', () => {
  const hookProcess = spawnSync('node', [HOOK_PATH], { input: '{not valid json', encoding: 'utf8' });
  const combinedOutput = combinedOutputOf(hookProcess);
  assert.equal(isBlocked(combinedOutput), false, 'expected no block on malformed input');
  assert.equal(hookProcess.status, 0, 'expected clean exit on malformed input');
});

test('importing the hook module does NOT execute main (basename entry guard)', () => {
  const importProbe = spawnSync('node', ['--input-type=module', '-e',
    `import(${JSON.stringify('file:///' + HOOK_PATH.replace(/\\/g, '/'))}).then(() => console.log('imported-ok'));`,
  ], { input: '', encoding: 'utf8', timeout: 15000 });
  const combinedOutput = combinedOutputOf(importProbe);
  assert.match(combinedOutput, /imported-ok/, 'import must complete without running main / reading stdin');
  assert.equal(isBlocked(combinedOutput), false, 'import must not emit a permission decision');
});

test('multiple phantom deletions -> ALL paths named in the deny reason', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['first-landed.md', 'docs/second-landed.md', 'src/third-landed.mjs']);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny with several phantom deletions');
  assert.match(combinedOutput, /first-landed\.md/);
  assert.match(combinedOutput, /second-landed\.md/);
  assert.match(combinedOutput, /third-landed\.mjs/);
});

test('mixed case: one session-owned deletion + one phantom -> still blocks and names only the phantom', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['owned-delete.md', 'phantom-delete.md']);
  const transcriptPath = makeTranscript([join(repoDirectory, 'owned-delete.md')]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny while any phantom deletion remains');
  assert.match(combinedOutput, /phantom-delete\.md/, 'the phantom path must be named');
});

// ── 2026-07-04 spec widening: stale MODIFICATIONS revert landings too ──────────────────────────
// 4th bite of the bug, new shape: a stale primary checkout shows sibling-landed files as MODIFIED
// (disk copy = older content); committing that rolled back a 141-line Truth-ledger rewrite. Any
// staged modification (or unstaged one swept in by `commit -a`) of a file this session never
// touched is the same phantom-revert hazard as a deletion.

// Overwrites `relativePath` in an existing repo with stale-looking content. Stages it when asked.
function makeStaleModification(repoDirectory, relativePath, { staged = true } = {}) {
  writeFileSync(join(repoDirectory, relativePath), 'stale pre-landing content\n', 'utf8');
  if (staged) git(repoDirectory, 'add', relativePath);
}

test('staged stale MODIFICATION of a file this session never touched -> blocks', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]); // clean baseline containing keep.txt
  makeStaleModification(repoDirectory, 'keep.txt', { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -m "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny for committing a phantom modification');
  assert.match(combinedOutput, /keep\.txt/, 'deny reason must name the stale-modified path');
  assert.match(combinedOutput, /git checkout HEAD --/, 'deny reason must give the restore fix');
});

test('UNSTAGED stale modification swept in by git commit -am -> blocks (the Truth-ledger rollback shape)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  makeStaleModification(repoDirectory, 'keep.txt', { staged: false });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny: -a stages the stale modification at commit time');
  assert.match(combinedOutput, /keep\.txt/);
});

test('unstaged phantom modification with plain git commit -m (no -a) -> passes (mod not part of the commit)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  makeStaleModification(repoDirectory, 'keep.txt', { staged: false });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit --allow-empty -m "unrelated"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: an unstaged modification is not swept in without -a');
});

test('session-edited modification -> passes', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  makeStaleModification(repoDirectory, 'keep.txt', { staged: true });
  const transcriptPath = makeTranscript([join(repoDirectory, 'keep.txt')]);
  const { combinedOutput } = runHook('git commit -m "my own edit"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow for a modification this session made');
});

test('mixed modification batch: one session-edited + one phantom -> blocks, names ONLY the phantom', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  writeFileSync(join(repoDirectory, 'owned-mod.md'), 'original owned\n', 'utf8');
  writeFileSync(join(repoDirectory, 'phantom-mod.md'), 'original phantom\n', 'utf8');
  git(repoDirectory, 'add', '-A');
  git(repoDirectory, 'commit', '-q', '-m', 'add both files');
  makeStaleModification(repoDirectory, 'owned-mod.md', { staged: true });
  makeStaleModification(repoDirectory, 'phantom-mod.md', { staged: true });
  const transcriptPath = makeTranscript([join(repoDirectory, 'owned-mod.md')]);
  const { combinedOutput } = runHook('git commit -m "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny while a phantom modification remains');
  assert.match(combinedOutput, /phantom-mod\.md/, 'the phantom path must be named');
  assert.doesNotMatch(combinedOutput, /owned-mod\.md/, 'the session-owned path must NOT be named as phantom');
});

test.after(() => {
  rmSync(sandboxDirectory, { recursive: true, force: true });
});
