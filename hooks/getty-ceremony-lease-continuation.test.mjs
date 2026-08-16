/**
 * Regression for todo/002 — the repair lease refused the next step of the task it was guarding.
 *
 * THE INCIDENT (2026-08-16, a full ~/.claude session). The lease refused roughly two of every
 * three tool calls, each needing two or three byte-identical re-sends before the arbiter's
 * refusal ceiling let it through. It blocked commits of finished passing work, reads of files
 * the task needed, and the merge a sibling ship gate was simultaneously demanding.
 *
 * ROOT CAUSE, exactly. The 2026-08-15 fix exempted source-control bookkeeping from arming the
 * lease, but enumerated only the WRITE verbs — commit, add, checkout, branch, worktree, stash.
 * It never listed the READ verbs. So one `git status` inside an otherwise pure bookkeeping chain
 * made `.every()` fail, the chain stopped counting as bookkeeping, LIVE_PROOF_RE matched the bare
 * word `commit`, and a failed `git add` of a gitignored file armed a live-behavior lease.
 *
 * The locked proof it then demanded was `git add HANDOFF.md ...` — and HANDOFF.md is gitignored
 * in this repo, so the one command the lease would accept could never succeed. Every other action
 * scored as a sidequest, with no legal move left in the turn.
 *
 * Same shape as the 2026-08-15 deadlock and the 2026-08-07 filename deadlock: the guard blocked
 * its own repair. Third occurrence, hence a regression rather than another note.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { detectRepairLease } from './getty-ceremony-guard.mjs';

// The verbatim failure that armed the lease this session.
const FAILED_COMMIT_WITH_STATUS = {
  name: 'Bash',
  input: {
    command:
      'cd ~/.claude && git add HANDOFF.md scripts/hook-activation-suite.mjs && git status --short '
      + '&& git commit --no-verify -q -m "docs: rewrite HANDOFF as a parachute"',
  },
  isError: true,
  resultText: 'exit code: 1\nThe following paths are ignored by one of your .gitignore files:\nHANDOFF.md',
};

const A_REAL_FAILING_TEST = {
  name: 'Bash',
  input: { command: 'py -3 -m pytest -q tests/test_invoice.py' },
  isError: true,
  resultText: 'exit code: 1\n1 failed',
};

const THE_SOLE_REPAIR_PASS = {
  name: 'Edit',
  input: { file_path: 'src/servo/invoice.py', old_string: 'a', new_string: 'b' },
};

// NOTE on fixture shape, learned the hard way while writing these. Asserting on the failed
// command ALONE proves nothing: the lease arms but its sole repair pass is still unspent, so
// `detectRepairLease` returns block:false for a completely different reason and the test passes
// green against the broken guard. Every fixture below therefore spends the repair pass first,
// which is the state the real session was actually in when everything started being refused.
const A_REPAIR_PASS_AFTER_BOOKKEEPING = {
  name: 'Edit',
  input: { file_path: 'HANDOFF.md', old_string: 'a', new_string: 'b' },
};

test('a read verb inside a bookkeeping chain does not make it a live proof', () => {
  const verdict = detectRepairLease({
    userText: 'g',
    completedTools: [FAILED_COMMIT_WITH_STATUS, A_REPAIR_PASS_AFTER_BOOKKEEPING],
    toolName: 'Bash',
    toolInput: { command: 'npm run deploy' },
  });

  assert.equal(verdict.block, false, 'git status among git add/commit is still pure bookkeeping');
});

test('every read-only git verb is bookkeeping, not a behavior proof', () => {
  for (const command of [
    'git status --short',
    'git diff --stat main',
    'git log --oneline -5',
    'git show HEAD:HANDOFF.md',
    'git ls-files --error-unmatch HANDOFF.md',
    'git check-ignore -v HANDOFF.md',
    'cd ~/.claude && git add -A && git status && git commit -m x',
  ]) {
    const verdict = detectRepairLease({
      userText: 'go',
      completedTools: [
        { name: 'Bash', input: { command }, isError: true, resultText: 'exit code: 1' },
        A_REPAIR_PASS_AFTER_BOOKKEEPING,
      ],
      toolName: 'Bash',
      toolInput: { command: 'npm run deploy' },
    });
    assert.equal(verdict.block, false, `${command} must not arm the lease`);
  }
});

// todo/002 defect 3, the most expensive one: refusing a commit strands finished passing work,
// which is precisely the loss commit-cadence-guard and No Dirt Handoffs exist to prevent. Two
// guards demanding opposite things in one turn is the 2026-07-30 deadlock class.
test('banking work is never refusable, even with a lease armed', () => {
  for (const command of [
    'git add src/servo/invoice.py && git commit --no-verify -m "fix: the failing case"',
    'cd ~/.claude && git status --short',
    'git worktree add ../wt -b fix/x main',
  ]) {
    const verdict = detectRepairLease({
      userText: 'g',
      completedTools: [A_REAL_FAILING_TEST, THE_SOLE_REPAIR_PASS],
      toolName: 'Bash',
      toolInput: { command },
    });
    assert.equal(verdict.block, false, `saving work must never be refused: ${command}`);
  }
});

// todo/002 defect 2: writing feature.py, then test_feature.py, then running that test is ONE
// task. The guard scored each as separate and unrelated.
test('a test written beside the file it covers is continuation, not a sidequest', () => {
  const verdict = detectRepairLease({
    userText: 'g',
    completedTools: [A_REAL_FAILING_TEST, THE_SOLE_REPAIR_PASS],
    toolName: 'Write',
    toolInput: { file_path: 'src/servo/invoice.test.mjs', content: 'export const covered = 1;' },
  });

  assert.equal(verdict.block, false, 'same stem as the repaired file is the same working set');
});

test('a read the current task needs is never a sidequest', () => {
  const verdict = detectRepairLease({
    userText: 'g',
    completedTools: [A_REAL_FAILING_TEST, THE_SOLE_REPAIR_PASS],
    toolName: 'Read',
    toolInput: { file_path: 'src/servo/invoice.py' },
  });

  assert.equal(verdict.block, false, 'reading to proceed is not wandering off');
});

// The anti-disarm rail todo/002 demands: at least one action must STILL be refused, or the fix
// has merely turned the guard off.
test('a genuinely unrelated action is still refused', () => {
  const verdict = detectRepairLease({
    userText: 'g',
    completedTools: [A_REAL_FAILING_TEST, THE_SOLE_REPAIR_PASS],
    toolName: 'Bash',
    toolInput: { command: 'npm run deploy' },
  });

  assert.equal(verdict.block, true, 'the lease must still stop a real sidequest');
  assert.match(verdict.reason, /REPAIR LEASE/);
});

test('an edit in an unrelated tree is still refused', () => {
  const verdict = detectRepairLease({
    userText: 'g',
    completedTools: [A_REAL_FAILING_TEST, THE_SOLE_REPAIR_PASS],
    toolName: 'Edit',
    toolInput: {
      file_path: 'C:/Users/rmill/Desktop/programming/marcus/docs/ROADMAP.md',
      old_string: 'a',
      new_string: 'b',
    },
  });

  assert.equal(verdict.block, true, 'a different repo with no link to the goal is a sidequest');
});
