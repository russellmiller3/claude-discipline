// Regression net for soft-reset-merge-base-guard.
//
// The incident it pins: `git reset --soft <ref>` moves HEAD to <ref> but leaves the INDEX at this
// branch's old tip. When <ref> has advanced past the fork point, everything <ref> gained since
// stages as a DELETION — a revert wearing the clothes of a squash. Cost a whole feature on
// 2026-08-09 and came within one read of doing it again on 2026-08-17.
//
// Written as plain strings, never nested template literals: two earlier drafts of this file used
// backticked test names inside a backticked generator and produced a file that would not parse.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractSoftResetRefs, judgeReset } from './soft-reset-merge-base-guard.mjs';

let passed = 0;
function test(name, caseBody) { caseBody(); passed++; console.log('  ok  ' + name); }

// -- unit: extractSoftResetRefs ----------------------------------------------
test('plain "git reset --soft main" extracts main', () => {
  assert.deepEqual(extractSoftResetRefs('git reset --soft main'), ['main']);
});
test('"--soft HEAD" is a no-op and is never extracted', () => {
  assert.deepEqual(extractSoftResetRefs('git reset --soft HEAD'), []);
});
test('the merge-base command-substitution recipe is recognized and skipped', () => {
  assert.deepEqual(extractSoftResetRefs('git reset --soft $(git merge-base main HEAD)'), []);
});
test('found inside a chained command', () => {
  assert.deepEqual(extractSoftResetRefs('git add -A && git reset --soft main && git commit -m x'), ['main']);
});
test('--mixed and --hard are out of scope', () => {
  assert.deepEqual(extractSoftResetRefs('git reset --hard main'), []);
  assert.deepEqual(extractSoftResetRefs('git reset --mixed main'), []);
});
test('a relative ref in own history is still extracted for judging', () => {
  assert.deepEqual(extractSoftResetRefs('git reset --soft HEAD~3'), ['HEAD~3']);
});

// The hole self-review found before this shipped: the character class excluded quote characters
// without allowing them AROUND the ref, so a quoted ref matched zero characters, failed the `+`,
// and was never extracted. The guard silently allowed the exact command it exists to stop.
test('a DOUBLE-quoted ref is still extracted (quoting must not disarm the guard)', () => {
  assert.deepEqual(extractSoftResetRefs('git reset --soft "main"'), ['main']);
});
test('a SINGLE-quoted ref is still extracted', () => {
  assert.deepEqual(extractSoftResetRefs("git reset --soft 'main'"), ['main']);
});

// -- e2e: judgeReset against a real temp git repo ----------------------------
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'soft-reset-guard-'));
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  return { dir, run };
}
function commit(run, subject) {
  run(['add', '-A']);
  const committed = run(['commit', '-q', '-m', subject, '--no-gpg-sign']);
  if (committed.status !== 0) throw new Error('commit failed: ' + committed.stderr);
}

test('e2e: main untouched since the fork -> reset --soft main is SAFE', () => {
  const { dir, run } = makeRepo();
  writeFileSync(join(dir, 'a.txt'), '1\n');
  commit(run, 'base');
  run(['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(dir, 'b.txt'), '2\n');
  commit(run, 'feature work');

  const verdict = judgeReset('main', dir);
  assert.ok(verdict, 'expected a verdict, not fail-open');
  assert.equal(verdict.safe, true);
  rmSync(dir, { recursive: true, force: true });
});

// The 2026-08-17 near-miss in miniature: a fairness gate lands on main while the branch is stale.
test('e2e: main gained a NEW file after the fork -> UNSAFE, and names the file at risk', () => {
  const { dir, run } = makeRepo();
  writeFileSync(join(dir, 'a.txt'), '1\n');
  commit(run, 'base');
  run(['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(dir, 'feature.txt'), 'wip\n');
  commit(run, 'feature wip');

  run(['checkout', '-q', 'main']);
  writeFileSync(join(dir, 'fairness-gate.txt'), 'landed while feature was stale\n');
  commit(run, 'fairness gate lands on main');
  run(['checkout', '-q', 'feature']);

  const verdict = judgeReset('main', dir);
  assert.ok(verdict, 'expected a verdict, not fail-open');
  assert.equal(verdict.safe, false);
  assert.ok(verdict.atRiskFiles.includes('fairness-gate.txt'),
    'expected fairness-gate.txt at risk, got ' + JSON.stringify(verdict.atRiskFiles));
  rmSync(dir, { recursive: true, force: true });
});

test('e2e: main MODIFIED an existing file after the fork -> still UNSAFE', () => {
  const { dir, run } = makeRepo();
  writeFileSync(join(dir, 'shared.txt'), 'v1\n');
  commit(run, 'base');
  run(['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(dir, 'feature.txt'), 'wip\n');
  commit(run, 'feature wip');

  run(['checkout', '-q', 'main']);
  writeFileSync(join(dir, 'shared.txt'), 'v2 landed on main\n');
  commit(run, 'main edits shared.txt');
  run(['checkout', '-q', 'feature']);

  const verdict = judgeReset('main', dir);
  assert.ok(verdict);
  assert.equal(verdict.safe, false);
  assert.ok(verdict.atRiskFiles.includes('shared.txt'));
  rmSync(dir, { recursive: true, force: true });
});

// MUST-NOT-FIRE: squashing your own WIP is the legitimate everyday use. A guard that blocked this
// would be worked around within the hour, which is worse than not having it.
test('e2e: resetting to an ANCESTOR in own history (squashing own WIP) is SAFE', () => {
  const { dir, run } = makeRepo();
  writeFileSync(join(dir, 'a.txt'), '1\n');
  commit(run, 'base');
  writeFileSync(join(dir, 'a.txt'), '2\n');
  commit(run, 'wip 1');
  writeFileSync(join(dir, 'a.txt'), '3\n');
  commit(run, 'wip 2');

  const verdict = judgeReset('HEAD~2', dir);
  assert.ok(verdict);
  assert.equal(verdict.safe, true);
  rmSync(dir, { recursive: true, force: true });
});

test('e2e: an unresolvable ref fails OPEN (no verdict, never a false block)', () => {
  const { dir, run } = makeRepo();
  writeFileSync(join(dir, 'a.txt'), '1\n');
  commit(run, 'base');

  assert.equal(judgeReset('does-not-exist-branch', dir), null);
  rmSync(dir, { recursive: true, force: true });
});

console.log('');
console.log(passed + ' tests passed');
