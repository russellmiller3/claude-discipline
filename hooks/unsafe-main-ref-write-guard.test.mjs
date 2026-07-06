import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'unsafe-main-ref-write-guard.mjs');

function runHook(command, toolName = 'Bash', extraEnvironment = {}) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnvironment },
  });
}

function assertDenied(hookRun, pattern) {
  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  if (pattern) assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, pattern);
}

function assertAllowed(hookRun) {
  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
}

test('blocks a two-arg update-ref write to refs/heads/main', () => {
  assertDenied(
    runHook('git update-ref refs/heads/main abc123def456'),
    /UNSAFE MAIN-REF WRITE BLOCKED/,
  );
});

test('blocks a two-arg update-ref write to refs/heads/master', () => {
  assertDenied(runHook('git update-ref refs/heads/master abc123'));
});

test('blocks git branch -f main <sha>', () => {
  assertDenied(runHook('git branch -f main abc123def456'), /force-moves the ref/);
});

test('blocks git branch --force main <sha>', () => {
  assertDenied(runHook('git branch --force main abc123def456'));
});

test('blocks git checkout -B main <sha>', () => {
  assertDenied(runHook('git checkout -B main abc123def456'), /no fast-forward check/);
});

test('blocks git switch -C main <sha>', () => {
  assertDenied(runHook('git switch -C main abc123def456'));
});

test('allows the three-arg compare-and-swap update-ref form', () => {
  assertAllowed(runHook('git update-ref refs/heads/main abc123def456 789fedcba012'));
});

test('allows invoking the sanctioned safe-merge script even if it contains update-ref internally', () => {
  assertAllowed(runHook('bash ~/.claude/scripts/safe-merge-to-main.sh /repo my-branch "pytest -q"'));
});

test('allows an ordinary git merge --ff-only', () => {
  assertAllowed(runHook('git -C /repo merge --ff-only my-branch'));
});

test('allows an ordinary git commit', () => {
  assertAllowed(runHook('git commit -m "fine"'));
});

test('allows update-ref on a branch that is not main/master', () => {
  assertAllowed(runHook('git update-ref refs/heads/feature/x abc123'));
});

test('SAFE_MERGE_OVERRIDE=1 allows an otherwise-blocked write', () => {
  assertAllowed(runHook('git update-ref refs/heads/main abc123', 'Bash', { SAFE_MERGE_OVERRIDE: '1' }));
});

test('inline SAFE_MERGE_OVERRIDE=1 prefix in the command itself is honored', () => {
  assertAllowed(runHook('SAFE_MERGE_OVERRIDE=1 git update-ref refs/heads/main abc123'));
});

test('ignores non-Bash/PowerShell tools', () => {
  const hookRun = runHook('git update-ref refs/heads/main abc123', 'Read');
  assertAllowed(hookRun);
});

// ── 2026-07-06 quoted-prose + read-only false-positive locks ──────────────────────────────
// The unsafe-ref patterns must only match a REAL ref-write command, never a mention of one in
// quoted text, and never a read-only command that merely has "main" in a filename. (Pre-fix
// kit hook lacked quote-masking, so an `echo "… git update-ref refs/heads/main …"` was DENIED.)
// Teeth-preserving case last.

test('does NOT fire on echo text mentioning update-ref refs/heads/main (quoted prose)', () => {
  assertAllowed(runHook('echo "never run: git update-ref refs/heads/main <sha>"'));
});

test('does NOT fire on a quoted "update-ref refs/heads/main" argument to another program', () => {
  assertAllowed(runHook('node brief.mjs --note "do NOT git update-ref refs/heads/main by hand"'));
});

test('does NOT fire on a read-only `git status -- <file-with-main-in-name>`', () => {
  assertAllowed(runHook('git status -- hooks/x-main-y.mjs'));
});

test('TEETH: a REAL two-arg `git update-ref refs/heads/main <sha>` is STILL BLOCKED after the FP fix', () => {
  assertDenied(
    runHook('git update-ref refs/heads/main abc123def456'),
    /UNSAFE MAIN-REF WRITE BLOCKED/,
  );
});
