/**
 * Regression: a source-control bookkeeping command must never arm the repair lease.
 *
 * The live deadlock (2026-08-15, Servo session): LIVE_PROOF_RE matches the bare word
 * `commit`, so `git commit` read as a live behavior proof. Git exits non-zero on the
 * entirely benign "nothing to commit, working tree clean" — routine when an autocommit
 * hook already banked the same work — so the guard armed a repair lease on bookkeeping
 * and then refused every following call, including the merge the sibling ship-ritual
 * guard was demanding. It blocked its own repair.
 *
 * A commit's exit code says nothing about whether the product works. Only behavior
 * proofs — tests, builds, lints, smokes, launches, deploys — may lock a lease.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { detectRepairLease } from './getty-ceremony-guard.mjs';

const NOTHING_TO_COMMIT = {
  name: 'Bash',
  input: { command: 'git add -A src tests && git commit -q -m "fix: retry stale surface"' },
  isError: true,
  resultText: 'exit code: 1\nOn branch fix/plan51-flake\nnothing to commit, working tree clean',
};

const UNRELATED_NEXT_CALL = {
  toolName: 'Bash',
  toolInput: { command: 'git log --oneline main..HEAD' },
};

test('a failed git commit does not arm the repair lease', () => {
  const verdict = detectRepairLease({
    userText: 'g',
    completedTools: [NOTHING_TO_COMMIT],
    ...UNRELATED_NEXT_CALL,
  });

  assert.equal(verdict.block, false, 'bookkeeping must never lock a live-proof lease');
});

test('the guard does not block a follow-up source edit after a failed commit', () => {
  const verdict = detectRepairLease({
    userText: 'g',
    completedTools: [NOTHING_TO_COMMIT],
    toolName: 'Edit',
    toolInput: { file_path: 'src/servo/handlers.py', old_string: 'a', new_string: 'b' },
  });

  assert.equal(verdict.block, false, 'the follow-up repair must not be refused');
});

test('other source-control bookkeeping is equally exempt', () => {
  for (const command of [
    'git checkout 89a9398 -- results/receipt.json',
    'git branch -a',
    'git worktree add ../wt -b fix/x main',
    'git stash',
  ]) {
    const verdict = detectRepairLease({
      userText: 'go',
      completedTools: [{ name: 'Bash', input: { command }, isError: true, resultText: 'exit code: 1' }],
      ...UNRELATED_NEXT_CALL,
    });
    assert.equal(verdict.block, false, `${command} must not arm the lease`);
  }
});

test('a behavior proof chained with a commit still arms the lease', () => {
  // Red-team catch: the first cut of this exemption matched any command CONTAINING a git
  // subcommand, so `pytest && git commit` went unprotected — the commonest chain there is.
  //
  // PROBE CHANGED 2026-08-16 (todo/002). This used to probe with `git log --oneline main..HEAD`,
  // which is now never refusable — reading or saving source-control state stopped being a
  // sidequest when the lease was refusing the commits that banked finished work. The claim under
  // test is that the lease ARMS, so the probe just has to be something an armed lease refuses.
  // `npm run deploy` is that, and it keeps the assertion about arming rather than about which
  // probe happened to be handy.
  for (const command of [
    'py -3 -m pytest -q tests/ && git commit -m ship',
    'npm run build && git add -A && git commit -m x',
    'git add -A && npm test',
  ]) {
    const verdict = detectRepairLease({
      userText: 'g',
      completedTools: [
        { name: 'Bash', input: { command }, isError: true, resultText: 'exit code: 1' },
        { name: 'Edit', input: { file_path: 'src/a.py', old_string: 'a', new_string: 'b' } },
      ],
      toolName: 'Bash',
      toolInput: { command: 'npm run deploy' },
    });
    assert.equal(verdict.block, true, `${command} must still arm the lease`);
  }
});

test('a genuine failed behavior proof still arms the lease', () => {
  const verdict = detectRepairLease({
    userText: 'g',
    completedTools: [
      {
        name: 'Bash',
        input: { command: 'py -3 -m pytest -q tests/test_invoice.py' },
        isError: true,
        resultText: 'exit code: 1\n1 failed',
      },
      // The sole repair pass, spent.
      { name: 'Edit', input: { file_path: 'src/servo/invoice.py', old_string: 'a', new_string: 'b' } },
    ],
    // An unrelated action after the repair pass is the sidequest the lease exists to stop.
    toolName: 'Bash',
    toolInput: { command: 'npm run deploy' },
  });

  assert.equal(verdict.block, true, 'a real failing test must still lock the lease');
  assert.match(verdict.reason, /REPAIR LEASE/);
});
