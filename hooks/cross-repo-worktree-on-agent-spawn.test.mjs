#!/usr/bin/env node
/**
 * Tests for cross-repo-worktree-on-agent-spawn — the gate that forces an Agent
 * driving a SIBLING repo by absolute path to set up its own worktree there.
 */

import assert from 'node:assert/strict';
import { decideCrossRepoGate, extractAbsolutePaths } from './cross-repo-worktree-on-agent-spawn.mjs';

let passedCount = 0;
function test(name, testBody) {
  try {
    testBody();
    passedCount += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const SESSION_ROOT = 'C:/Users/rmill/Desktop/programming/claude-voice';
// In this layout, skaffen-desktop, context, and some-other-repo are sibling git repos;
// claude-voice is the session.
const isGitRepo = (candidate) => {
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  return (
    normalized === 'c:/users/rmill/desktop/programming/skaffen-desktop' ||
    normalized === 'c:/users/rmill/desktop/programming/claude-voice' ||
    normalized === 'c:/users/rmill/desktop/programming/context' ||
    normalized === 'c:/users/rmill/desktop/programming/some-other-repo'
  );
};
const opts = { sessionRepoRoot: SESSION_ROOT, isGitRepo };

const agentEvent = (prompt) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { description: 'phase agent', prompt },
});

// 1. Sibling-repo brief with NO worktree setup → DENIED, even with the (useless) param.
test('denies a sibling-repo brief lacking git worktree add', () => {
  const decision = decideCrossRepoGate(
    agentEvent('Work DIRECTLY in C:\\Users\\rmill\\Desktop\\programming\\skaffen-desktop by absolute path; git checkout -b feature/x'),
    opts,
  );
  assert.ok(decision, 'expected a deny');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /skaffen-desktop/);
});

// 2. The same brief WITH git worktree add → allowed.
test('allows a sibling-repo brief that sets up its own worktree', () => {
  const decision = decideCrossRepoGate(
    agentEvent('Work in C:\\Users\\rmill\\Desktop\\programming\\skaffen-desktop. FIRST run: git worktree add ../sd-wt -b feature/x main, then work there.'),
    opts,
  );
  assert.equal(decision, null);
});

// 2b. The `git -C <path> worktree add` form (with -C between git and worktree) is
//     also valid setup and must be allowed (regression: the old regex missed it).
test('allows the `git -C <path> worktree add` form', () => {
  const decision = decideCrossRepoGate(
    agentEvent('Run: git -C C:\\Users\\rmill\\Desktop\\programming\\skaffen-desktop worktree add ../wt -b feature/x main, then work in skaffen-desktop there.'),
    opts,
  );
  assert.equal(decision, null);
});

// 3. FOREGROUND_OK (read-only) bypasses — no tree to clobber.
test('allows a read-only FOREGROUND_OK sibling-repo recon', () => {
  const decision = decideCrossRepoGate(
    agentEvent('FOREGROUND_OK read-only. Search C:\\Users\\rmill\\Desktop\\programming\\skaffen-desktop for X.'),
    opts,
  );
  assert.equal(decision, null);
});

// 4. Russell's explicit override bypasses.
test('allows with CROSS_REPO_WORKTREE_RUSSELL_OK', () => {
  const decision = decideCrossRepoGate(
    agentEvent('Work in C:\\Users\\rmill\\Desktop\\programming\\skaffen-desktop. CROSS_REPO_WORKTREE_RUSSELL_OK'),
    opts,
  );
  assert.equal(decision, null);
});

// 5. A same-repo brief (session repo only) is NOT cross-repo → allowed (the
//    worktree-on-agent-spawn hook governs that case, not this one).
test('ignores a same-repo (session) brief', () => {
  const decision = decideCrossRepoGate(
    agentEvent('Work in C:\\Users\\rmill\\Desktop\\programming\\claude-voice/scripts; edit widget.py'),
    opts,
  );
  assert.equal(decision, null);
});

// 6. A brief that mentions no sibling-repo path is ignored.
test('ignores a brief with no sibling-repo path', () => {
  const decision = decideCrossRepoGate(agentEvent('Refactor the parser and add tests.'), opts);
  assert.equal(decision, null);
});

// 7. A path under a NON-repo sibling dir does not trip it (isGitRepo false).
test('ignores an absolute path that is not a git repo', () => {
  const decision = decideCrossRepoGate(
    agentEvent('Read C:\\Users\\rmill\\Desktop\\programming\\not-a-repo\\notes.txt'),
    opts,
  );
  assert.equal(decision, null);
});

// 8. Non-Agent / non-PreToolUse events ignored.
test('ignores non-Agent tools', () => {
  assert.equal(
    decideCrossRepoGate({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, opts),
    null,
  );
});

// 9. extractAbsolutePaths pulls both Windows and MSYS forms.
test('extractAbsolutePaths finds Windows + MSYS paths', () => {
  const paths = extractAbsolutePaths('see C:\\Users\\rmill\\a and /c/Users/rmill/b here');
  assert.ok(paths.includes('c:/users/rmill/a'));
  assert.ok(paths.includes('/c/users/rmill/b'));
});

// ---- Read/write intent carve-out (2026-07-02) ----

// 10. REGRESSION — a second phrasing of the original 2026-06-29 incident shape: git
//     checkout -b and editing directly in a sibling CODE repo, no worktree add, no
//     escape token. Must still DENY.
test('denies a sibling-repo brief that edits files directly (second phrasing)', () => {
  const decision = decideCrossRepoGate(
    agentEvent(
      'Build the feature by editing files directly in C:\\Users\\rmill\\Desktop\\programming\\skaffen-desktop\\src\\main.py, then commit.',
    ),
    opts,
  );
  assert.ok(decision, 'expected a deny');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
});

// 11. NEW REGRESSION — mixed read+write in the SAME sibling repo is NOT the safe
//     case. Reading one file for context but editing another in the same repo must
//     still DENY (ambiguous/mixed near that repo = conservative deny).
test('denies a brief that reads one file but edits another in the same sibling repo', () => {
  const decision = decideCrossRepoGate(
    agentEvent(
      'Read C:\\Users\\rmill\\Desktop\\programming\\skaffen-desktop\\README.md for context, then edit C:\\Users\\rmill\\Desktop\\programming\\skaffen-desktop\\src\\main.py to add the feature.',
    ),
    opts,
  );
  assert.ok(decision, 'expected a deny');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
});

// 12. NEW — a brief that only reads a file under programming/context/ (Russell's
//     documented docs-only shared reference dir) for reference, doing all actual
//     writing inside the session repo, must now ALLOW.
test('allows a brief that only reads a file under programming/context/ for reference', () => {
  const decision = decideCrossRepoGate(
    agentEvent(
      'Read C:\\Users\\rmill\\Desktop\\programming\\context\\design.md in full for the palette and layout rules, then build the mock in C:\\Users\\rmill\\Desktop\\programming\\claude-voice\\ui\\mock.html.',
    ),
    opts,
  );
  assert.equal(decision, null);
});

// 13. NEW — a generic read-only sentence pointing at some OTHER sibling repo's file
//     for reference, no write signal anywhere near that path, and no other work
//     happening in that sibling repo, must now ALLOW.
test('allows a generic read-only mention of another sibling repo for reference', () => {
  const decision = decideCrossRepoGate(
    agentEvent(
      'read C:\\Users\\rmill\\Desktop\\programming\\some-other-repo\\README.md for the API shape, then implement the client in the session repo.',
    ),
    opts,
  );
  assert.equal(decision, null);
});

console.log(`\n${passedCount} passed`);
