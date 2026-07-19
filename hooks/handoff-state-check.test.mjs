// handoff-state-check.test.mjs — pins the stale-handoff guard. Run: node --test handoff-state-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBranchAndHead, checkHandoffState } from './handoff-state-check.mjs';

const HANDOFF_MAIN = '**Repo:** `/x` on branch **`main`** (head `fe08bd0`, NOT pushed). Stuff.';
const HANDOFF_FEATURE = '**Repo:** `/x` on branch `feature/record-to-recipe` (head `48178d0`, NOT pushed).';

test('extractBranchAndHead parses branch + head from the orientation block', () => {
  assert.deepEqual(extractBranchAndHead(HANDOFF_MAIN), { branch: 'main', head: 'fe08bd0' });
  assert.deepEqual(extractBranchAndHead(HANDOFF_FEATURE), { branch: 'feature/record-to-recipe', head: '48178d0' });
  assert.deepEqual(extractBranchAndHead('no branch here'), { branch: null, head: null });
});

// A fake git: knows only `main` (tip fe08bd0aaa); any other branch throws (simulates a deleted branch).
function fakeGit(gitArgs) {
  if (/rev-parse .*\bmain\b/.test(gitArgs)) return 'fe08bd0';
  throw new Error(`fatal: Needed a single revision (${gitArgs})`);
}

test('OK when the named branch exists and the head matches its tip', () => {
  const verdict = checkHandoffState({ content: HANDOFF_MAIN, repoDir: '.', git: fakeGit });
  assert.equal(verdict.ok, true);
});

test('BLOCKS when the named branch no longer exists (merged + deleted)', () => {
  const verdict = checkHandoffState({ content: HANDOFF_FEATURE, repoDir: '.', git: fakeGit });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /does NOT exist/);
});

test('BLOCKS when the head does not match the branch tip (stale head)', () => {
  const staleHead = '**Repo:** `/x` on branch `main` (head `dead123`, NOT pushed).';
  const verdict = checkHandoffState({ content: staleHead, repoDir: '.', git: fakeGit });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /does not match the tip/);
});

test('OK (skips) when the content has no branch claim — e.g. a partial edit', () => {
  const verdict = checkHandoffState({ content: 'just some prose, no orientation block', repoDir: '.', git: fakeGit });
  assert.equal(verdict.ok, true);
});

test('extractBranchAndHead ignores a historical "Branch `X` (merged to main)" callout', () => {
  // Regression: HANDOFF.md files narrate completed milestones like
  // "**Branch `feature/wire-core-journey` (merged to main).**" in "Prior milestone" sections. That
  // branch really is gone (merged + deleted) by design, but it isn't the handoff's live "pick up here"
  // pointer -- the bare-fallback regex used to grab it anyway and hard-block every edit to any
  // HANDOFF.md that contains such a section, forever.
  const content = '**Branch `feature/wire-core-journey` (merged to main).**\nSome prose after.';
  assert.deepEqual(extractBranchAndHead(content), { branch: null, head: null });
});

test('BLOCKS still fire for a bare "Branch `X`" callout that is NOT marked merged/deleted', () => {
  const content = '**Branch `feature/still-open`** is where the work lives.';
  const verdict = checkHandoffState({ content, repoDir: '.', git: fakeGit });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /does NOT exist/);
});

test('extractBranchAndHead ignores "branch" used as an ordinary English/code word mid-prose', () => {
  // Regression: "frozen-branch code path" / "branch prediction" / "branch coverage" etc. are the
  // programming-language sense of "branch" (a conditional code path), not a git branch. The bare
  // fallback used to match ANY "branch" followed eventually by a backtick span anywhere in the text,
  // so a sentence like "...widget.py's frozen-branch `_icon_path()` lookup..." got misread as a git
  // branch claim named "_icon_path()" and hard-blocked the edit.
  const content = "widget.py's frozen-branch `_icon_path()` lookup resolves inside the frozen bundle.";
  assert.deepEqual(extractBranchAndHead(content), { branch: null, head: null });
});

// ---------------------------------------------------------------------------------------------------
// 2026-07-13 regressions: cross-repo branch claims + in-flight agent work.
// Incident: a Marcus HANDOFF.md edit referenced a branch that lives in a DIFFERENT repo
// (Desktop/programming/legible) and was being created by a just-dispatched agent. The hook ran
// rev-parse only in the CWD repo (dirname of HANDOFF.md), the branch obviously wasn't there, and it
// hard-blocked a perfectly truthful handoff line. Fix contract:
//   (a) a repo path/name mentioned on the SAME line as the branch claim is used to re-resolve the
//       branch before blocking;
//   (b) a line that marks the branch as agent work in flight (dispatched / agent / will create)
//       downgrades a would-be block to a WARNING (ok: true + verdict.warn);
//   (c) the original true positive (merged+deleted branch in Pick-up-here, same repo, no in-flight
//       marker) still BLOCKS.
// ---------------------------------------------------------------------------------------------------

const norm = (p) => String(p).replace(/\\/g, '/');

// Fake git that models TWO repos: the CWD repo `/x` (only `main` exists) and the foreign repo
// `.../programming/legible` (has `fix/exp146-sealed-journeys` at 78a8baf).
function twoRepoGit(gitArgs, repoDir) {
  const dir = norm(repoDir || '');
  if (/rev-parse .*\bmain\b/.test(gitArgs)) return 'fe08bd0';
  if (dir.endsWith('programming/legible') && gitArgs.includes('fix/exp146-sealed-journeys')) return '78a8baf';
  throw new Error(`fatal: Needed a single revision (${gitArgs} in ${repoDir})`);
}
const legibleExists = (p) => norm(p).endsWith('programming/legible');

test('CROSS-REPO OK: branch resolves in an absolute repo path named on the same line', () => {
  const content = '**Repo:** `C:/Users/rmill/Desktop/programming/legible` on branch `fix/exp146-sealed-journeys` (head `78a8baf`).';
  const verdict = checkHandoffState({ content, repoDir: '/x', git: twoRepoGit, dirExists: legibleExists });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('CROSS-REPO OK: a relative repo name on the line resolves against known roots', () => {
  const content = '**Branch `fix/exp146-sealed-journeys`** lives in `programming/legible` — integrate after review.';
  const verdict = checkHandoffState({ content, repoDir: '/x', git: twoRepoGit, dirExists: legibleExists });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('CROSS-REPO head check still applies against the foreign tip', () => {
  const content = '**Repo:** `C:/Users/rmill/Desktop/programming/legible` on branch `fix/exp146-sealed-journeys` (head `dead123`).';
  const verdict = checkHandoffState({ content, repoDir: '/x', git: twoRepoGit, dirExists: legibleExists });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /does not match the tip/);
});

// 2026-07-16 WORKSPACE-ROOT bug: a HANDOFF.md at a non-repo workspace root (`programming/`) named a
// branch that verifiably existed in a child project repo (marcus), but the hook rev-parsed only in the
// (non-repo) workspace dir and flagged every real branch as stale. Fix: scan child project repos.
test('WORKSPACE OK: branch resolves in a child project repo when the handoff dir is not a git repo', () => {
  const content = 'Pick up here: on branch `fix/exp153-timing`';
  const git = (gitArgs, dir) => {
    if (/rev-parse .*fix\/exp153-timing/.test(gitArgs) && norm(dir) === '/ws/marcus') return 'b7c8e43';
    throw new Error('unknown');
  };
  const verdict = checkHandoffState({
    content, repoDir: '/ws', git,
    dirExists: () => false,                              // no `.git` at the workspace root
    listChildRepos: (dir) => (norm(dir) === '/ws' ? ['/ws/marcus', '/ws/other'] : []),
  });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('WORKSPACE BLOCK: a branch absent in every child repo still blocks (guard keeps teeth)', () => {
  const content = 'Pick up here: on branch `fix/does-not-exist`';
  const verdict = checkHandoffState({
    content, repoDir: '/ws', git: () => { throw new Error('unknown'); },
    dirExists: () => false,
    listChildRepos: () => ['/ws/marcus', '/ws/other'],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /workspace repo/);
});

test('WORKSPACE gate: a merged+deleted branch in the handoff OWN repo still blocks (no sibling scan)', () => {
  const content = 'Pick up here: on branch `fix/deleted`';
  let scanned = false;
  const verdict = checkHandoffState({
    content, repoDir: '/repo', git: () => { throw new Error('gone'); },
    dirExists: (p) => norm(p).endsWith('/.git'),        // repoDir IS its own git repo
    listChildRepos: () => { scanned = true; return ['/repo/sub']; },
  });
  assert.equal(verdict.ok, false);
  assert.equal(scanned, false, 'must not scan siblings when the handoff dir is its own git repo');
});

test('IN-FLIGHT downgrade: a dispatched-agent line WARNS instead of blocking', () => {
  const content = '**Branch `fix/exp146-sealed-journeys`** — dispatched agent will create it in the legible repo.';
  const verdict = checkHandoffState({ content, repoDir: '/x', git: fakeGit, dirExists: () => false });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.warn || '', /in flight|in-flight|agent/i);
});

test('UNVERIFIABLE foreign repo (named but not on this disk, no in-flight marker) still BLOCKS', () => {
  // Deliberate: "can't verify" is NOT "verified". The canonical orientation line always names a repo
  // path (`**Repo:** \`/x\` on branch ...`), so letting an unresolvable path soften the block would
  // neuter the guard's original true positive. The block message points at the in-flight escape hatch.
  const content = '**Repo:** `D:/elsewhere/legible` on branch `fix/exp146-sealed-journeys` (no marker).';
  const verdict = checkHandoffState({ content, repoDir: '/x', git: fakeGit, dirExists: () => false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /does NOT exist/);
  assert.match(verdict.reason, /not found on this disk/);
});

test('TRUE POSITIVE KEPT: merged+deleted branch in Pick-up-here (same repo, no in-flight) still BLOCKS', () => {
  const content = '## Pick up here\n**Repo:** `/x` on branch `feature/record-to-recipe` (head `48178d0`, NOT pushed).';
  const verdict = checkHandoffState({ content, repoDir: '/x', git: twoRepoGit, dirExists: (p) => norm(p) === '/x' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /does NOT exist/);
});
