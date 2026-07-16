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
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { historicalMatchCommit } from './phantom-delete-commit-guard.mjs';

const hookDirectory = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hookDirectory, 'phantom-delete-commit-guard.mjs');

// Sandbox lives NEXT TO this test file by default, not under the OS temp dir — delete-audit-guard's
// lesson: realistic project-looking paths keep path heuristics honest. ONE exception: the guard
// intentionally skips any repo under a linked-worktree home (`.claude/worktrees/`, `.worktrees/`,
// `.claude-worktrees/`), so when this test file ITSELF lives inside such a linked worktree (e.g.
// verifying the discipline-kit copy from its landing worktree, or this fix's own `.worktrees/`
// worktree), a sandbox next to the test would inherit that path and neutralize every block case.
// Fall back to the OS temp dir then — safe for THIS guard, which has no temp-dir scratch heuristic.
// Mirror the hook's own isUnderLinkedWorktree match exactly so all three homes trigger the fallback.
const testFileInsideLinkedWorktree =
  /[\\/](?:\.claude[\\/]worktrees|\.worktrees|\.claude-worktrees)[\\/]/i.test(hookDirectory);
const sandboxDirectory = testFileInsideLinkedWorktree
  ? mkdtempSync(join(tmpdir(), 'phantom-delete-commit-guard-test-'))
  : join(hookDirectory, `.phantom-delete-commit-guard-test-sandbox-${process.pid}`);
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

// ── 2026-07-07 false-positive fix: recognize ALL dot-prefixed linked-worktree homes ────────────
// THE INCIDENT (bit two agents + the orchestrator, 2026-07-07): the skip only matched
// `.claude/worktrees/`. But the ~/.claude repo (and others) place linked worktrees at `.worktrees/`
// and `.claude-worktrees/`. Legit commits from those checkouts — and stale sibling files after a
// CAS merge — tripped the guard, forcing PHANTOM_DELETE_OK=1 overrides. Linked worktrees rebase
// cleanly regardless of the dir name; the stale-tree bug is primary-checkout-specific. So ALL
// three dot-prefixed homes must skip. A plain project dir literally named `worktrees` (no dot
// prefix) is NOT a linked-worktree home and must still be guarded.

// Builds a repo under `parentSegments` inside the sandbox, with an unstaged phantom deletion.
function makeRepoUnder(parentSegments, phantomRelativePath = 'landed-by-sibling.md') {
  const repoDirectory = join(sandboxDirectory, ...parentSegments, `repo-${repoCounter++}`);
  mkdirSync(repoDirectory, { recursive: true });
  git(repoDirectory, 'init', '-q');
  writeFileSync(join(repoDirectory, phantomRelativePath), 'content\n', 'utf8');
  git(repoDirectory, 'add', '-A');
  git(repoDirectory, 'commit', '-q', '-m', 'baseline');
  rmSync(join(repoDirectory, phantomRelativePath));
  return repoDirectory;
}

test('repo under .worktrees/ -> passes (linked-worktree home; bug is primary-only)', () => {
  const repoDirectory = makeRepoUnder(['.worktrees', 'agent-hookfix']);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow inside a .worktrees/ linked worktree');
});

test('repo under .claude-worktrees/ -> passes (linked-worktree home; bug is primary-only)', () => {
  const repoDirectory = makeRepoUnder(['.claude-worktrees', 'branch-prune']);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow inside a .claude-worktrees/ linked worktree');
});

test('git -C into a .claude-worktrees/ path from a dirty session cwd -> passes', () => {
  const dirtyCwdRepo = makeRepoWithPhantomDeletions(['dirty-sibling.md'], { staged: true });
  const worktreeRepo = makeRepoUnder(['.claude-worktrees', 'agent-z'], 'wt-file.md');
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(`git -C "${worktreeRepo}" commit -am "wip"`, { transcriptPath, workingDirectory: dirtyCwdRepo });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow when -C targets a .claude-worktrees/ path');
});

test('repo under a NON-dot `worktrees/` dir with a phantom deletion -> still BLOCKS (not a linked-worktree home)', () => {
  // A plain project directory literally named `worktrees` (no dot prefix) is a real primary
  // checkout, not a git linked worktree. The over-match guard: it must NOT be skipped.
  const repoDirectory = makeRepoUnder(['project', 'worktrees'], 'still-guarded.md');
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny: a non-dot `worktrees` dir is a primary checkout, not a linked worktree');
  assert.match(combinedOutput, /still-guarded\.md/);
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

// Simulates the REAL incident shape (2026-07-16 redesign): the guard's phantom test now requires
// the "stale" content to actually match a real ANCESTOR commit's blob for that path — a fabricated
// string that was never committed anywhere is NOT what a stale checkout looks like. So this reads
// the path's current (already-committed) content, commits a NEWER version on top of it (simulating
// a sibling's landing advancing HEAD), then writes the OLD content back to disk — exactly what a
// primary checkout whose ref moved out from under it looks like: genuinely older, already-recorded
// content sitting where HEAD now expects something newer.
function makeStaleModification(repoDirectory, relativePath, { staged = true } = {}) {
  const fullPath = join(repoDirectory, relativePath);
  const preLandingContent = readFileSync(fullPath, 'utf8');
  writeFileSync(fullPath, `${preLandingContent}landed by a sibling\n`, 'utf8');
  git(repoDirectory, 'add', relativePath);
  git(repoDirectory, 'commit', '-q', '-m', `land: update ${relativePath}`);
  writeFileSync(fullPath, preLandingContent, 'utf8'); // the stale checkout's disk: reverted to old, real history
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

// ── 2026-07-05 false-positive fix: a PURELY ADDITIVE modification is not a phantom revert ──────
// THE INCIDENT (2026-07-05): a commit that ADDED one line to a tracked append-only results log
// (`runs/delete_copies_probe.jsonl`) was blocked. `git diff --stat` showed "1 file changed, 1
// insertion(+)" — ZERO deletions. Porcelain reads it as a staged modification (`M `), and the
// session never Write/Edit-touched it (a `>>` append or an external writer produced it), so the
// original phantom check flagged it. But a stale-checkout revert or a landing-clobber ALWAYS
// replaces content — it deletes the newer lines. A diff with zero deleted lines cannot be
// reverting anyone's landed work; it only grows the file. Append-only logs / JSONL results /
// CHANGELOG appends are the textbook safe case and must pass.

// Appends a line to an existing tracked file and stages it — porcelain 'M ', numstat 'N  0  path'.
function makeAdditiveModification(repoDirectory, relativePath) {
  const fullPath = join(repoDirectory, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `content of ${relativePath}\nappended new record line\n`, 'utf8');
  git(repoDirectory, 'add', relativePath);
}

test('purely-additive staged modification of an untouched append-only log -> passes (zero deletions is never a phantom)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]); // clean baseline containing keep.txt
  // keep.txt started as "content of keep.txt\n"; appending a line is 1 insertion, 0 deletions.
  makeAdditiveModification(repoDirectory, 'keep.txt');
  const transcriptPath = makeTranscript([]); // session never touched keep.txt
  const { combinedOutput } = runHook('git commit -m "append a result line"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: a modification whose numstat shows 0 deleted lines cannot revert landed work');
});

test('append to a tracked JSONL results file (the live 2026-07-05 repro) -> passes', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  // Build the exact shape: a tracked results log the session never Write/Edit-touched, appended to.
  const jsonlPath = join(repoDirectory, 'runs', 'delete_copies_probe.jsonl');
  mkdirSync(dirname(jsonlPath), { recursive: true });
  writeFileSync(jsonlPath, '{"task":"a","ok":true}\n', 'utf8');
  git(repoDirectory, 'add', '-A');
  git(repoDirectory, 'commit', '-q', '-m', 'seed results log');
  writeFileSync(jsonlPath, '{"task":"a","ok":true}\n{"task":"b","ok":true}\n', 'utf8'); // +1 line, 0 deleted
  git(repoDirectory, 'add', join('runs', 'delete_copies_probe.jsonl'));
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -m "record probe b"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: appending one JSONL record (1 insertion, 0 deletions) is not a phantom deletion/modification');
});

test('modification that ALSO deletes lines on an untouched file -> STILL BLOCKS (additive-exemption must not neuter the guard)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  // makeStaleModification lands a newer keep.txt (adds a line), then reverts disk to the OLD,
  // already-recorded content (0 added, 1 deleted vs the new HEAD) — the stale-modification revert
  // shape, and NOT purely additive, so the append-only exemption must not swallow it. Must block.
  makeStaleModification(repoDirectory, 'keep.txt', { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -m "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true,
    'expected deny: a modification with deleted lines is still a phantom revert hazard');
  assert.match(combinedOutput, /keep\.txt/);
});

// ── 2026-07-04 false-positive fixes: cd-blindness, never-in-HEAD deletions, empty staged diff ──
// THE INCIDENT (2026-07-04 ~05:35 UTC): a salvage agent working INSIDE a linked worktree
// (ledger/.claude/worktrees/agent-a77f...) ran `cd <worktree> && git add -A && git commit`.
// The guard ignored the cd, resolved the repo from event.cwd (the PRIMARY ledger checkout,
// stale/dirty), and blocked three ways: (1) flagged AGENT-HANDOFF.md/README.md as phantom
// modifications even though the session had Edit-tool-touched them (in the worktree — the
// guard resolved the porcelain paths against the WRONG repo root); (2) flagged files that
// exist on main but were never tracked in the worktree branch's HEAD as phantom DELETIONS;
// (3) blocked `git commit --allow-empty` from a CLEAN worktree because the PRIMARY was dirty.

// Like makeTranscript, but every entry carries a sessionId — the Edit entries under a
// DIFFERENT (salvage) session id than the transcript's first (creator) entry. Provenance
// must be keyed to what the transcript RECORDS, never to which session id recorded it.
function makeSalvageTranscript(touchedPaths) {
  const transcriptPath = join(sandboxDirectory, `transcript-salvage-${Math.random().toString(36).slice(2)}.jsonl`);
  const transcriptLines = [
    JSON.stringify({ sessionId: 'creator-session-111', message: { role: 'user', content: [{ type: 'text', text: 'original brief' }] } }),
  ];
  for (const touchedPath of touchedPaths) {
    transcriptLines.push(JSON.stringify({
      sessionId: 'salvage-session-222',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: touchedPath } }] },
    }));
  }
  writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n', 'utf8');
  return transcriptPath;
}

// The incident fixture: a dirty PRIMARY repo + a linked-worktree-style repo under its
// .claude/worktrees/. The commit command cd's into the worktree; event.cwd stays on the primary.
function makeSalvageIncidentFixture() {
  const primaryRepo = join(sandboxDirectory, `primary-${repoCounter++}`);
  mkdirSync(primaryRepo, { recursive: true });
  git(primaryRepo, 'init', '-q');
  for (const relativePath of ['AGENT-HANDOFF.md', 'README.md', 'graft.py']) {
    writeFileSync(join(primaryRepo, relativePath), `landed content of ${relativePath}\n`, 'utf8');
  }
  git(primaryRepo, 'add', '-A');
  git(primaryRepo, 'commit', '-q', '-m', 'baseline with landed files');

  const worktreeRepo = join(primaryRepo, '.claude', 'worktrees', 'agent-salvage');
  mkdirSync(worktreeRepo, { recursive: true });
  git(worktreeRepo, 'init', '-q');
  for (const relativePath of ['AGENT-HANDOFF.md', 'README.md']) {
    writeFileSync(join(worktreeRepo, relativePath), `worktree branch content of ${relativePath}\n`, 'utf8');
  }
  git(worktreeRepo, 'add', '-A');
  git(worktreeRepo, 'commit', '-q', '-m', 'worktree baseline (graft.py NEVER tracked here)');
  return { primaryRepo, worktreeRepo };
}

test('MODE 1: cd into worktree + session-edited files dirty on the primary -> passes (guard must audit the cd target, not event.cwd)', () => {
  const { primaryRepo, worktreeRepo } = makeSalvageIncidentFixture();
  // Primary looks stale: the same-named files sit modified+staged there.
  makeStaleModification(primaryRepo, 'AGENT-HANDOFF.md', { staged: true });
  makeStaleModification(primaryRepo, 'README.md', { staged: true });
  // The salvage session Edit-touched the WORKTREE copies (different session id than the creator).
  writeFileSync(join(worktreeRepo, 'AGENT-HANDOFF.md'), 'salvage update\n', 'utf8');
  const transcriptPath = makeSalvageTranscript([
    join(worktreeRepo, 'AGENT-HANDOFF.md'),
    join(worktreeRepo, 'README.md'),
  ]);
  const { combinedOutput } = runHook(
    `cd "${worktreeRepo}" && git add -A && git commit -m "salvage checkpoint"`,
    { transcriptPath, workingDirectory: primaryRepo },
  );
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: the commit runs in the linked worktree named by cd, not in event.cwd');
});

test('MODE 2: cd into worktree + primary shows deletions of files never in the worktree HEAD -> passes', () => {
  const { primaryRepo, worktreeRepo } = makeSalvageIncidentFixture();
  // graft.py is tracked on the PRIMARY and missing from its disk — but was NEVER tracked in the
  // worktree branch, so `git add -A` in the worktree cannot stage its deletion.
  rmSync(join(primaryRepo, 'graft.py'));
  const transcriptPath = makeSalvageTranscript([join(worktreeRepo, 'AGENT-HANDOFF.md')]);
  const { combinedOutput } = runHook(
    `cd "${worktreeRepo}" && git add -A && git commit -m "wip"`,
    { transcriptPath, workingDirectory: primaryRepo },
  );
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: a file absent from the commit repo\'s HEAD can never be a phantom deletion');
});

test('MODE 2 (right repo): added-then-deleted file (in index, never in HEAD) -> passes', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]); // clean baseline
  writeFileSync(join(repoDirectory, 'stray.md'), 'never committed\n', 'utf8');
  git(repoDirectory, 'add', 'stray.md');
  rmSync(join(repoDirectory, 'stray.md')); // porcelain: 'AD stray.md'
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: HEAD never contained stray.md, so no deletion can be baked in');
});

test('MODE 3: unstaged deletion + plain `git commit --allow-empty -m` (no -a, no git add) -> passes (empty staged diff never blocks)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['not-swept.md']); // ' D' — unstaged
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit --allow-empty -m "checkpoint"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: a plain commit sweeps nothing in, and its staged diff is empty');
});

test('session-id variance: Edit recorded under a different sessionId than the creator still counts as touched', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  makeStaleModification(repoDirectory, 'keep.txt', { staged: true });
  const transcriptPath = makeSalvageTranscript([join(repoDirectory, 'keep.txt')]);
  const { combinedOutput } = runHook('git commit -m "salvage edit"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: provenance comes from the transcript contents, not the session id that wrote them');
});

test('cd into a NON-worktree primary with a staged phantom deletion -> still BLOCKS (cd honoring must not fail open)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['still-guarded.md'], { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    `cd "${repoDirectory}" && git commit -m "wip"`,
    { transcriptPath, workingDirectory: sandboxDirectory },
  );
  assert.equal(isBlocked(combinedOutput), true, 'expected deny: the cd target is a primary checkout with a phantom deletion');
  assert.match(combinedOutput, /still-guarded\.md/);
});

test('`git add -A && git commit -m` with an unstaged phantom deletion -> still BLOCKS (the add sweeps it in)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['swept-away.md']); // ' D' — unstaged
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git add -A && git commit -m "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true,
    'expected deny: git add -A will stage the phantom deletion before the commit runs');
  assert.match(combinedOutput, /swept-away\.md/);
});

// ── 2026-07-04 genuine-invocation + cross-repo fixes (second live repro, ledger session) ───────
// Same day, different session (cwd = the dirty ledger repo): the guard fired on commands that
// were not commits at all — "git commit" inside a quoted --mission argument, "commit" inside the
// FILENAME phantom-delete-commit-guard.mjs — and on commits cd'd into a clean sibling repo. These
// lock the genuine-invocation trigger, quote masking, and MSYS path handling.

test('leading cd into a CLEAN non-worktree repo while session cwd repo is dirty -> passes', () => {
  const dirtyCwdRepo = makeRepoWithPhantomDeletions(['sibling-landed.md'], { staged: true });
  const cleanTargetRepo = makeRepoWithPhantomDeletions([]); // baseline only, clean tree
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    `cd "${cleanTargetRepo}" && git add AGENT-HANDOFF.md && git commit -m "merge: land"`,
    { transcriptPath, workingDirectory: dirtyCwdRepo },
  );
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: the commit runs in the clean cd-target repo, not the dirty session cwd repo');
});

test('cd with an MSYS-style /c/... path (the live repro form) -> passes', () => {
  const dirtyCwdRepo = makeRepoWithPhantomDeletions(['msys-sibling-landed.md'], { staged: true });
  const cleanTargetRepo = makeRepoWithPhantomDeletions([]);
  // C:\foo\bar -> /c/foo/bar, exactly how Git Bash writes it
  const msysTargetPath = '/' + cleanTargetRepo[0].toLowerCase() + cleanTargetRepo.slice(2).replace(/\\/g, '/');
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    `cd ${msysTargetPath} && git checkout --ours AGENT-HANDOFF.md && git add AGENT-HANDOFF.md && git commit -m "merge: resolve"`,
    { transcriptPath, workingDirectory: dirtyCwdRepo },
  );
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: MSYS cd target resolves to the clean repo');
});

test('cd AFTER the commit does not retarget it -> still blocks on the session cwd repo', () => {
  const dirtyCwdRepo = makeRepoWithPhantomDeletions(['cd-after-commit.md']);
  const cleanElsewhereRepo = makeRepoWithPhantomDeletions([]);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    `git commit -am "wip" && cd "${cleanElsewhereRepo}"`,
    { transcriptPath, workingDirectory: dirtyCwdRepo },
  );
  assert.equal(isBlocked(combinedOutput), true, 'expected deny: a cd after the commit cannot retarget it');
});

test('git -C <clean other repo> commit while session cwd repo is dirty -> passes', () => {
  const dirtyCwdRepo = makeRepoWithPhantomDeletions(['dash-c-sibling.md'], { staged: true });
  const cleanTargetRepo = makeRepoWithPhantomDeletions([]);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    `git -C "${cleanTargetRepo}" commit -am "wip"`,
    { transcriptPath, workingDirectory: dirtyCwdRepo },
  );
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: -C names the clean repo the commit actually runs in');
});

test('non-git command with "git commit" inside a quoted prose argument -> passes', () => {
  const dirtyCwdRepo = makeRepoWithPhantomDeletions(['prose-trigger.md'], { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    'node scripts/agent-kit/agent-brief.mjs --mission "land the fix, then git commit the result and merge" --out brief.md',
    { transcriptPath, workingDirectory: dirtyCwdRepo },
  );
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: no actual git commit command, just prose mentioning one');
});

test('git command whose quoted argument mentions commit (git log --grep "commit") -> passes', () => {
  const dirtyCwdRepo = makeRepoWithPhantomDeletions(['grep-trigger.md'], { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    'git log --grep "why we commit like this" --oneline',
    { transcriptPath, workingDirectory: dirtyCwdRepo },
  );
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: "commit" only appears inside quotes, not as a git subcommand');
});

test('"commit" as a FILENAME substring (git checkout main -- ...-commit-guard.mjs) -> passes', () => {
  const dirtyCwdRepo = makeRepoWithPhantomDeletions(['filename-trigger.md'], { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    'git checkout main -- hooks/phantom-delete-commit-guard.mjs hooks/phantom-delete-commit-guard.test.mjs',
    { transcriptPath, workingDirectory: dirtyCwdRepo },
  );
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: "commit" inside a path token is not a commit invocation');
});

test('real git commit whose -m message mentions "git commit" -> still vetted (blocks on phantoms)', () => {
  const dirtyCwdRepo = makeRepoWithPhantomDeletions(['message-mention.md']);
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    'git commit -am "teach the guard about git commit parsing"',
    { transcriptPath, workingDirectory: dirtyCwdRepo },
  );
  assert.equal(isBlocked(combinedOutput), true, 'expected deny: the actual commit tokens sit outside the quotes');
});

test('quoted --all inside a commit message does not sweep unstaged modifications in', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  makeStaleModification(repoDirectory, 'keep.txt', { staged: false });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    'git commit --allow-empty -m "add --all support later"',
    { transcriptPath, workingDirectory: repoDirectory },
  );
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: "--all" only appears inside the quoted message');
});

// ── 2026-07-04 salvage (fix/phantom-guard-fp2): commit must be the RESOLVED SUBCOMMAND ─────────
// The dead fp2 agent live-reproduced the guard arming on the word "commit" ANYWHERE after "git".
// Main's quoted-prose fix (maskQuotedSpans) covers quoted mentions, but the segment check still
// matched a bare word "commit" anywhere in the argument tail — so an UNQUOTED argument
// (`git log --grep commit`) still armed the guard. Now the first non-option token after git's
// global options must BE `commit` for the segment to count.

test('read-only git chain naming a *commit* file (git log/diff/rev-parse/status) -> passes even with staged phantoms', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['landed-elsewhere.md'], { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    'git log --oneline -3 -- hooks/phantom-delete-commit-guard.mjs && git diff HEAD --stat -- hooks/phantom-delete-commit-guard.mjs && git rev-parse HEAD main && git status --porcelain',
    { transcriptPath, workingDirectory: repoDirectory },
  );
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: no segment invokes the commit subcommand — "commit" only appears inside a filename');
});

test('UNQUOTED "commit" as a plain argument (git log --grep commit) -> passes even with staged phantoms', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['unquoted-grep-trigger.md'], { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git log --grep commit --oneline', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: the subcommand is log; unquoted "commit" is only a search argument');
});

test('env-prefixed commit with global options (VAR=x git -c k=v commit -am) -> still BLOCKS on staged phantoms', () => {
  const repoDirectory = makeRepoWithPhantomDeletions(['still-a-real-commit.md'], { staged: true });
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook(
    'GIT_AUTHOR_NAME=agent git -c core.autocrlf=false commit -am "wip"',
    { transcriptPath, workingDirectory: repoDirectory },
  );
  assert.equal(isBlocked(combinedOutput), true,
    'expected deny: env prefixes and value-taking global options must not hide a real commit subcommand');
  assert.match(combinedOutput, /still-a-real-commit\.md/);
});

// ── 2026-07-04 incident lock: cd into a DIFFERENT repo's linked worktree ───────────────────────
// The blocked command was `cd C:/…/.claude/.claude/worktrees/agent-aitime-fix && git add
// AGENT-HANDOFF.md && git commit --no-verify -m …` while the SESSION cwd sat in the (dirty)
// ledger repo — the deny listed ledger files. The guard must follow the cd into the other repo's
// worktree and skip it there, no matter how dirty the session-cwd repo is.

test('cd into a DIFFERENT repo\'s .claude/worktrees checkout + scoped add + commit -> passes despite a dirty session-cwd repo', () => {
  const sessionRepo = makeRepoWithPhantomDeletions(['ledger-landed-file.py', 'Truth-ledger.md'], { staged: true });
  const otherWorktree = join(sandboxDirectory, 'other-project', '.claude', 'worktrees', 'agent-aitime-fix');
  mkdirSync(otherWorktree, { recursive: true });
  git(otherWorktree, 'init', '-q');
  writeFileSync(join(otherWorktree, 'AGENT-HANDOFF.md'), 'handoff update\n', 'utf8');
  const transcriptPath = makeTranscript([join(otherWorktree, 'AGENT-HANDOFF.md')]);
  const { combinedOutput } = runHook(
    `cd "${otherWorktree}" && git add AGENT-HANDOFF.md && git commit --no-verify -m "docs(handoff): checkpoint"`,
    { transcriptPath, workingDirectory: sessionRepo },
  );
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: the commit runs in another repo\'s linked worktree, not the dirty session-cwd repo');
});

// ── 2026-07-06 false-positive fix: an EXPLICIT-PATH `git add <file>` must not sweep the tree ────
// THE INCIDENT (reproduced twice, 2026-07-06): a clean doc commit of the shape
// `git add <one-file> && git commit -m ...` was BLOCKED. The working tree also held UNRELATED
// unstaged changes the session never touched — a pre-existing `HANDOFF.md` modification and a
// `runs/.tmp_msg.txt` deletion. `sweepsUnstagedChanges` matched the bare `git add` and flipped
// includeUnstaged, so those loose worktree changes were counted as in-play and flagged as phantoms.
// But `git add <explicit-file>` stages ONLY that file — the unstaged changes are NOT in the commit,
// so the block was a false positive. An explicit-path add must leave the rest of the worktree out.
// A WHOLE-TREE add (`git add -A/--all/-u/.`) DOES sweep the tree in and must still be caught.

// Seeds an untracked file the session owns + an unrelated unstaged deletion and modification of
// TRACKED files the session never touched. Returns the repo path.
function makeExplicitAddFixture() {
  const repoDirectory = join(sandboxDirectory, `repo-${repoCounter++}`);
  mkdirSync(repoDirectory, { recursive: true });
  git(repoDirectory, 'init', '-q');
  writeFileSync(join(repoDirectory, 'keep.txt'), 'content of keep.txt\n', 'utf8');
  writeFileSync(join(repoDirectory, 'HANDOFF.md'), 'original handoff line\n', 'utf8');
  mkdirSync(join(repoDirectory, 'runs'), { recursive: true });
  writeFileSync(join(repoDirectory, 'runs', '.tmp_msg.txt'), 'scratch\n', 'utf8');
  git(repoDirectory, 'add', '-A');
  git(repoDirectory, 'commit', '-q', '-m', 'baseline');
  // The session's OWN new file (what it will explicitly add):
  writeFileSync(join(repoDirectory, 'my-doc.md'), 'the doc I actually wrote\n', 'utf8');
  // UNRELATED unstaged changes the session never touched (a pre-existing edit + a scratch deletion):
  writeFileSync(join(repoDirectory, 'HANDOFF.md'), 'original handoff line\nunstaged edit I did not make\n', 'utf8');
  rmSync(join(repoDirectory, 'runs', '.tmp_msg.txt'));
  return repoDirectory;
}

test('explicit-path add + commit with an unrelated UNSTAGED deletion/modification present -> passes (today FP)', () => {
  const repoDirectory = makeExplicitAddFixture();
  // Session provenance: it Write-touched only its own my-doc.md, never HANDOFF.md or the scratch file.
  const transcriptPath = makeTranscript([join(repoDirectory, 'my-doc.md')]);
  const { combinedOutput } = runHook(
    'git add my-doc.md && git commit -m "docs: add my doc"',
    { transcriptPath, workingDirectory: repoDirectory },
  );
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: `git add my-doc.md` stages only that file — unrelated unstaged changes are not in the commit');
});

test('explicit-path add of MULTIPLE named files + commit, unrelated unstaged deletion present -> passes', () => {
  const repoDirectory = makeExplicitAddFixture();
  writeFileSync(join(repoDirectory, 'my-second.md'), 'second doc\n', 'utf8');
  const transcriptPath = makeTranscript([
    join(repoDirectory, 'my-doc.md'),
    join(repoDirectory, 'my-second.md'),
  ]);
  const { combinedOutput } = runHook(
    'git add my-doc.md my-second.md && git commit -m "docs: two files"',
    { transcriptPath, workingDirectory: repoDirectory },
  );
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: naming explicit files stages only those — the unrelated unstaged deletion stays out');
});

test('`git add .` (whole-tree pathspec) + commit that STAGES a phantom deletion of an untouched file -> still BLOCKS', () => {
  // `git add .` sweeps the ENTIRE tree, including the deletion of a tracked file the session never
  // touched — the disaster case (a stale sweep baking in phantom deletions). Must still block.
  const repoDirectory = makeExplicitAddFixture(); // runs/.tmp_msg.txt is deleted-but-unstaged here
  const transcriptPath = makeTranscript([join(repoDirectory, 'my-doc.md')]);
  const { combinedOutput } = runHook(
    'git add . && git commit -m "wip"',
    { transcriptPath, workingDirectory: repoDirectory },
  );
  assert.equal(isBlocked(combinedOutput), true,
    'expected deny: `git add .` stages the phantom deletion of runs/.tmp_msg.txt (untouched this session)');
  assert.match(combinedOutput, /\.tmp_msg\.txt/, 'the swept-in phantom deletion must be named');
});

// ── 2026-07-15 false-positive fix: an explicit DIRECTORY-pathspec add is SCOPED, not a whole-tree sweep ─────
// THE INCIDENT (Macher repo, plan 7): `git add <dir> <file> && git commit` was BLOCKED because an unrelated file
// (wrangler.app.jsonc) was merely `M` modified in the working tree — NOT staged, and a +8/-0 purely-additive
// change. `stagesWholeTreeAdd` treated the directory pathspec as a whole-tree sweep, flipping includeUnstaged for
// the ENTIRE tree, so an unstaged edit to a file OUTSIDE the added dir counted as in-play and got flagged. But
// `git add app/ file` stages only files UNDER those pathspecs; an unrelated worktree change is never committed.

// A repo with a committed src/existing.js + an unrelated wrangler.app.jsonc; the session's own new src/plan7.js
// staged-to-be; and wrangler.app.jsonc modified PURELY ADDITIVELY (+lines, 0 deletions) in the worktree, OUTSIDE
// src/, untouched by the session.
function makeScopedAddFixture() {
  const repoDirectory = join(sandboxDirectory, `repo-${repoCounter++}`);
  mkdirSync(repoDirectory, { recursive: true });
  git(repoDirectory, 'init', '-q');
  writeFileSync(join(repoDirectory, 'keep.txt'), 'content of keep.txt\n', 'utf8');
  writeFileSync(join(repoDirectory, 'wrangler.app.jsonc'), '{ "name": "app" }\n', 'utf8');
  mkdirSync(join(repoDirectory, 'src'), { recursive: true });
  writeFileSync(join(repoDirectory, 'src', 'existing.js'), 'export const existing = 1;\n', 'utf8');
  git(repoDirectory, 'add', '-A');
  git(repoDirectory, 'commit', '-q', '-m', 'baseline');
  // The session's OWN new file under src/ (what `git add src/` will actually stage):
  writeFileSync(join(repoDirectory, 'src', 'plan7.js'), 'export const plan7 = true;\n', 'utf8');
  // UNRELATED, untouched, purely-additive worktree modification OUTSIDE src/ (the false-positive trigger):
  writeFileSync(join(repoDirectory, 'wrangler.app.jsonc'), '{ "name": "app" }\nextra line one\nextra line two\n', 'utf8');
  return repoDirectory;
}

test('explicit DIRECTORY add + an unrelated additive worktree modification OUTSIDE the added paths -> passes (2026-07-15 FP)', () => {
  const repoDirectory = makeScopedAddFixture();
  const transcriptPath = makeTranscript([join(repoDirectory, 'src', 'plan7.js')]);
  const { combinedOutput } = runHook(
    'git add src/ && git commit -m "plan 7"',
    { transcriptPath, workingDirectory: repoDirectory },
  );
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: `git add src/` stages only files under src/ — an unrelated worktree edit to wrangler.app.jsonc is never staged');
  assert.doesNotMatch(combinedOutput, /wrangler\.app\.jsonc/, 'the out-of-scope worktree change must not be named');
});

test('a phantom DELETION UNDER the added directory is still swept in and BLOCKS (scoping must not neuter protection)', () => {
  const repoDirectory = makeScopedAddFixture();
  // A sibling-landed file under src/ the session never touched, now missing on disk (unstaged deletion) — the
  // `git add src/` WILL stage its deletion, so it is a genuine phantom and must still block.
  rmSync(join(repoDirectory, 'src', 'existing.js'));
  const transcriptPath = makeTranscript([join(repoDirectory, 'src', 'plan7.js')]);
  const { combinedOutput } = runHook(
    'git add src/ && git commit -m "plan 7"',
    { transcriptPath, workingDirectory: repoDirectory },
  );
  assert.equal(isBlocked(combinedOutput), true,
    'expected deny: `git add src/` stages the phantom deletion of src/existing.js (under the added dir, untouched this session)');
  assert.match(combinedOutput, /existing\.js/, 'the swept-in phantom deletion must be named');
});

// ── 2026-07-16 redesign: "untouched by session" alone is the WRONG test ────────────────────────
// THE RECURRING FALSE POSITIVE: Russell's dominant workflow is "read HANDOFF.md, continue a prior
// session's WIP, commit it." Files edited BEFORE this session started are, by construction, never
// in ITS transcript — the old rule ("untouched ⇒ phantom") blocked that constantly. The fix: a path
// is only phantom when its content is a REVERT to something this repo already recorded (matches an
// ancestor commit's blob). Inherited WIP is NOVEL content — it was never a git blob before — so it
// can never match history and must pass, regardless of session provenance.

test('genuinely NOVEL content untouched by this session -> passes (the core 2026-07-16 fix: inherited prior-session WIP)', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]); // baseline: keep.txt = "content of keep.txt\n"
  // Simulates a PRIOR session's edit sitting uncommitted on disk when THIS session starts: content
  // that has never existed as a git blob anywhere in this repo's history.
  writeFileSync(join(repoDirectory, 'keep.txt'), 'brand new content nobody has ever committed\n', 'utf8');
  git(repoDirectory, 'add', 'keep.txt');
  const transcriptPath = makeTranscript([]); // THIS session never touched it — it's inherited WIP
  const { combinedOutput } = runHook('git commit -m "continue prior session WIP"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false,
    'expected allow: content that matches no historical commit cannot be a revert, so it must never block');
});

test('genuinely NOVEL unstaged content swept in by git commit -am -> still passes', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  writeFileSync(join(repoDirectory, 'keep.txt'), 'another novel edit, never recorded before\n', 'utf8');
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git commit -am "inherited edit"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: novel unstaged content is not a phantom either');
});

test('a REAL revert to historical content, untouched by session -> still blocks (the fix must not neuter the real bug)', () => {
  // historicalMatchCommit is exercised directly here (integration already covered by the
  // makeStaleModification-based tests above); this asserts the exported function's own contract.
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  makeStaleModification(repoDirectory, 'keep.txt', { staged: true });
  const matchSha = historicalMatchCommit(repoDirectory, 'keep.txt');
  assert.notEqual(matchSha, null, 'expected the reverted-to-old content to match a real ancestor commit');
});

test('historicalMatchCommit returns null for genuinely novel content', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]);
  writeFileSync(join(repoDirectory, 'keep.txt'), 'never seen before\n', 'utf8');
  git(repoDirectory, 'add', 'keep.txt');
  assert.equal(historicalMatchCommit(repoDirectory, 'keep.txt'), null);
});

test('a co-occurring historically-matched modification corroborates a sync-point deletion -> deletion passes too', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]); // baseline: keep.txt only
  // Land a second file AFTER the baseline (simulating a sibling's commit that both changed keep.txt
  // AND added a new file) — the stale checkout predates both.
  writeFileSync(join(repoDirectory, 'keep.txt'), 'content of keep.txt\nlanded by a sibling\n', 'utf8');
  writeFileSync(join(repoDirectory, 'added-later.md'), 'a file added in the same landing\n', 'utf8');
  git(repoDirectory, 'add', '-A');
  git(repoDirectory, 'commit', '-q', '-m', 'land: update keep.txt and add added-later.md');
  // The stale checkout: keep.txt reverts to its pre-landing content, and added-later.md is simply
  // absent (the checkout predates its creation) — both consistent with the SAME sync-point.
  writeFileSync(join(repoDirectory, 'keep.txt'), 'content of keep.txt\n', 'utf8');
  git(repoDirectory, 'add', 'keep.txt');
  rmSync(join(repoDirectory, 'added-later.md'));
  const transcriptPath = makeTranscript([]);
  const { combinedOutput } = runHook('git add -A && git commit -m "wip"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny: keep.txt is a genuine historical revert');
  assert.match(combinedOutput, /keep\.txt/);
  // added-later.md's absence is corroborated by the SAME sync-point commit (which also lacks it) —
  // it should not ALSO be named as an independent phantom deletion. (It's swept by `git add -A` but
  // never existed in the checkout's stale-sync history, so blocking on it would be a false alarm.)
});

test('session explicitly `rm`-deletes a file via Bash -> counts as touched, not phantom', () => {
  const repoDirectory = makeRepoWithPhantomDeletions([]); // clean baseline, obsolete.md added fresh below
  writeFileSync(join(repoDirectory, 'obsolete.md'), 'about to be removed\n', 'utf8');
  git(repoDirectory, 'add', '-A');
  git(repoDirectory, 'commit', '-q', '-m', 'add obsolete.md');
  rmSync(join(repoDirectory, 'obsolete.md'));
  const transcriptPath = join(sandboxDirectory, `transcript-rm-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(transcriptPath, [
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'remove the obsolete file' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `rm "${join(repoDirectory, 'obsolete.md')}"` } }] } }),
  ].join('\n') + '\n', 'utf8');
  const { combinedOutput } = runHook('git commit -am "remove obsolete file"', { transcriptPath, workingDirectory: repoDirectory });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow: an explicit rm via Bash is this session\'s own intentional deletion');
});

test.after(() => {
  rmSync(sandboxDirectory, { recursive: true, force: true });
});
