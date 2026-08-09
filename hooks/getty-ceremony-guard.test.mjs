import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyCommit, trailingInfraOnlyStreak, repeatedSameOpCount, detectCeremony, isInfraPath, matchGateFamily, classifyGateOutcome, detectDuplicateVerification, detectSimpleScalarToolBudget, detectSimpleEditCeremony, detectEfficiencyKernel, latestNormalizedTurnSummary } from './getty-ceremony-guard.mjs';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'getty-ceremony-guard.mjs');

// Path classification — PROJECT-AGNOSTIC: meta/tooling/config/docs = infra; a real source file = core.
test('isInfraPath: meta/config/docs are infra; any source file is core', () => {
  assert.ok(isInfraPath('hooks/foo-guard.mjs'));      // a meta/tooling dir
  assert.ok(isInfraPath('.github/workflows/ci.yml')); // CI config
  assert.ok(isInfraPath('agent-prompts/build-x.md')); // a doc
  assert.ok(isInfraPath('docs/exp150-live.html'));    // a monitor dashboard
  assert.ok(isInfraPath('HANDOFF.md'));               // a doc
  assert.ok(isInfraPath('package.json'));             // config
  assert.ok(isInfraPath('.gitignore'));               // dotfile
  // Any real source file (any language, any repo) is CORE — no project-specific assumptions.
  assert.equal(isInfraPath('src/lib/server/gateway.ts'), false);
  assert.equal(isInfraPath('scripts/worker.py'), false);
  assert.equal(isInfraPath('cmd/server/main.go'), false);
  assert.equal(isInfraPath('lib/parser.rs'), false);
});

test('classifyCommit: all-infra vs any-core vs empty', () => {
  assert.equal(classifyCommit(['hooks/a.mjs', 'HOOKBOOK.md']), 'infra');
  assert.equal(classifyCommit(['hooks/a.mjs', 'src/app.ts']), 'core'); // one core file wins
  assert.equal(classifyCommit([]), 'empty');
});

// (a) fires on 4 infra-only commits with no core commit.
test('(a) trailingInfraOnlyStreak counts 4 infra-only commits', () => {
  assert.equal(trailingInfraOnlyStreak(['infra', 'infra', 'infra', 'infra']), 4);
  assert.equal(detectCeremony({ commitFileLists: [['hooks/a.mjs'], ['hooks/b.mjs'], ['HOOKBOOK.md'], ['settings.json']] }).block, true);
});

// (b) does NOT fire when a core commit interleaves (healthy loop).
test('(b) a core commit in the trailing run resets the streak', () => {
  assert.equal(trailingInfraOnlyStreak(['infra', 'infra', 'core', 'infra', 'infra']), 2);
  assert.equal(detectCeremony({ commitFileLists: [['hooks/a.mjs'], ['hooks/b.mjs'], ['src/app.ts'], ['hooks/c.mjs'], ['hooks/d.mjs']] }).block, false);
});
test('a healthy infra->core->infra->core loop never fires', () => {
  assert.equal(detectCeremony({ commitFileLists: [['hooks/a.mjs'], ['src/x.ts'], ['hooks/b.mjs'], ['src/y.ts']] }).block, false);
});

// (c) fires on the same external op attempted 3+ times — generic (a deploy, a curl, any launcher).
test('(c) repeatedSameOpCount fires on 3× the identical external op', () => {
  const commands = [
    'kubectl apply -f deploy.yaml && curl https://api.example.com/health',
    'kubectl apply -f deploy.yaml && curl https://api.example.com/health',
    'kubectl apply -f deploy.yaml && curl https://api.example.com/health',
  ];
  assert.equal(repeatedSameOpCount(commands), 3);
  assert.equal(detectCeremony({ commands }).block, true);
});
test('different targets do NOT collapse into a same-op streak', () => {
  const commands = [
    'curl https://api.example.com/1',
    'curl https://api.example.com/2',
    'curl https://api.example.com/3',
  ];
  assert.equal(repeatedSameOpCount(commands), 1);
  assert.equal(detectCeremony({ commands }).block, false);
});
test('local read-only commands are never external ops (no false streak)', () => {
  assert.equal(repeatedSameOpCount(['git status', 'git status', 'git status', 'ls', 'ls', 'ls']), 0);
});

// (d) allows with ceremony-ok.
test('(d) ceremony-ok in the reply clears the block', () => {
  const commitFileLists = [['hooks/a.mjs'], ['hooks/b.mjs'], ['HOOKBOOK.md'], ['settings.json']];
  assert.equal(detectCeremony({ commitFileLists, replyText: 'ceremony-ok: building these guardrail hooks IS the task this session' }).block, false);
});

// End-to-end + (e) fail-open.
function writeTranscript(prefix, entries) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
  return { path, dir };
}

function makeTranscript(commands, replyText) {
  const entries = commands.map((command) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }));
  if (replyText) entries.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: replyText }] } });
  return writeTranscript('ceremony-tx-', entries);
}

test('end-to-end Stop: 4 infra-only commit commands -> block', () => {
  const commits = [
    'git commit -o hooks/a.mjs -m "x"',
    'git commit -o hooks/b.mjs -m "x"',
    'git commit -o HOOKBOOK.md -m "x"',
    'git add settings.json && git commit -o settings.json -m "x"',
  ];
  const { path, dir } = makeTranscript(commits);
  try {
    const run = spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }), encoding: 'utf8' });
    assert.match(run.stdout || '', /"decision"\s*:\s*"block"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('end-to-end Stop: a core commit interleaved -> allowed', () => {
  const commits = [
    'git commit -o hooks/a.mjs -m "x"',
    'git commit -o src/lib/server/gateway.ts -m "core"',
    'git commit -o hooks/b.mjs -m "x"',
  ];
  const { path, dir } = makeTranscript(commits);
  try {
    const run = spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }), encoding: 'utf8' });
    assert.equal((run.stdout || '').trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('(e) fail-open on malformed input', () => {
  const run = spawnSync(process.execPath, [hookPath], { input: 'not json', encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal((run.stdout || '').trim(), '');
});

// =============================================================================
// SIMPLE SCALAR TOOL BUDGET — direct count/total questions get at most three
// tool calls. A fourth lookup is ceremony; answer from the evidence or state
// the one hard blocker. Explicit research/audit requests are outside this gate.
// =============================================================================

test('simple email count blocks a fourth tool call', () => {
  const verdict = detectSimpleScalarToolBudget({
    userText: 'How many emails did I request from Macher over the past 7 days?',
    completedToolCount: 3,
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /SIMPLE COUNT BUDGET/);
});

test('terse count-the-rows correction blocks a fourth tool call', () => {
  assert.equal(detectSimpleScalarToolBudget({
    userText: 'count the fucking rows',
    completedToolCount: 3,
  }).block, true);
});

test('simple count allows one direct query plus two bounded fallbacks', () => {
  assert.equal(detectSimpleScalarToolBudget({
    userText: 'what is the total number of sent emails?',
    completedToolCount: 2,
  }).block, false);
});

test('explicit web research estimate is not mistaken for a direct row count', () => {
  assert.equal(detectSimpleScalarToolBudget({
    userText: 'Based on web research, estimate average user monthly email volume',
    completedToolCount: 8,
  }).block, false);
});

test('debugging a wrong count is not mistaken for a direct scalar lookup', () => {
  assert.equal(detectSimpleScalarToolBudget({
    userText: 'Debug why the monthly email count is wrong',
    completedToolCount: 8,
  }).block, false);
});

test('end-to-end PreToolUse denies the fourth tool on a direct count turn', () => {
  const { path, dir } = writeTranscript('scalar-budget-tx-', [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Count the email rows from the last seven days.' }] } },
    ...['locate table', 'query rows', 'bounded retry'].map((command, index) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${index}`, name: 'Bash', input: { command } }] },
    })),
  ]);
  try {
    const run = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'more archaeology' }, transcript_path: path }),
      encoding: 'utf8',
    });
    assert.match(run.stdout || '', /"permissionDecision"\s*:\s*"deny"/);
    assert.match(run.stdout || '', /SIMPLE COUNT BUDGET/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =============================================================================
// SIMPLE EDIT CEREMONY — literal documentation edits may not expand into
// planning, worktrees, broad tests, research, or handoff maintenance.
// =============================================================================

test('literal README edit blocks worktree ceremony', () => {
  const verdict = detectSimpleEditCeremony({
    userText: 'Replace the old sentence with this one in README.md and commit it.',
    toolName: 'Bash',
    toolInput: { command: 'git worktree add ../docs-fix -b fix/docs main' },
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /SIMPLE EDIT/);
});

test('literal AGENTS edit blocks a plan and an unrequested handoff expansion', () => {
  const request = 'Add this exact rule to AGENTS.md.';
  assert.equal(detectSimpleEditCeremony({
    userText: request,
    toolName: 'Write',
    toolInput: { file_path: 'plans/221-rule-rollout.md' },
  }).block, true);
  assert.equal(detectSimpleEditCeremony({
    userText: request,
    toolName: 'Edit',
    toolInput: { file_path: 'HANDOFF.md' },
  }).block, true);
});

test('literal doc edit blocks a broad suite but allows focused verification and commit', () => {
  const request = 'Correct the typo in CHANGELOG.md.';
  assert.equal(detectSimpleEditCeremony({
    userText: request,
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
  }).block, true);
  assert.equal(detectSimpleEditCeremony({
    userText: request,
    toolName: 'Bash',
    toolInput: { command: 'rg -n "corrected text" CHANGELOG.md' },
  }).block, false);
  assert.equal(detectSimpleEditCeremony({
    userText: request,
    toolName: 'Bash',
    toolInput: { command: 'git commit --no-verify CHANGELOG.md -m "docs: correct typo"' },
  }).block, false);
});

test('complex work and explicitly requested planning stay outside the simple-edit gate', () => {
  assert.equal(detectSimpleEditCeremony({
    userText: 'Research current vendor pricing, update README.md, and cite the sources.',
    toolName: 'WebSearch',
    toolInput: { query: 'vendor pricing' },
  }).block, false);
  assert.equal(detectSimpleEditCeremony({
    userText: 'Write a plan for the README.md information architecture migration.',
    toolName: 'Write',
    toolInput: { file_path: 'plans/221-readme-migration.md' },
  }).block, false);
});

test('a second equivalent-tool probe is blocked unless tool comparison is the task', () => {
  const action = { toolName: 'Bash', toolInput: { command: 'which awk' } };
  assert.equal(detectSimpleEditCeremony({
    userText: 'Replace one sentence in README.md.',
    completedToolInputs: ['which sed'],
    ...action,
  }).block, true);
  assert.equal(detectSimpleEditCeremony({
    userText: 'Compare whether sed or awk is installed and pick the portable one.',
    completedToolInputs: ['which sed'],
    ...action,
  }).block, false);
});

test('Codex transcript: PreToolUse denies worktree setup for a literal doc edit', () => {
  const { path, dir } = writeTranscript('simple-edit-codex-', [{
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Replace the typo in README.md with the corrected word.' }],
    },
  }]);
  try {
    const run = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git worktree add ../readme-fix -b fix/readme main' },
        transcript_path: path,
      }),
      encoding: 'utf8',
    });
    assert.match(run.stdout || '', /"permissionDecision"\s*:\s*"deny"/);
    assert.match(run.stdout || '', /EFFICIENCY/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =============================================================================
// EFFICIENCY KERNEL — the smallest action set that reaches the human's goal.
// Human-stated safety is the only bypass; model-authored text never is.
// =============================================================================

test('bounded work denies an unrequested process detour', () => {
  const request = 'Fix the login redirect in auth.ts.';
  for (const [toolName, toolInput] of [
    ['update_plan', { plan: [{ step: 'investigate' }] }],
    ['Bash', { command: 'git worktree add ../auth-fix -b fix/auth main' }],
    ['Write', { file_path: 'HANDOFF.md', content: 'status' }],
    ['WebSearch', { query: 'login redirects' }],
    ['Bash', { command: 'npm test' }],
  ]) {
    const verdict = detectEfficiencyKernel({ userText: request, toolName, toolInput });
    assert.equal(verdict.block, true, `${toolName} should be denied`);
    assert.match(verdict.reason, /EFFICIENCY/);
  }
});

// FIX 2026-08-08 (live false positive): matchGateFamily's bare-word triggers ran on EVERY
// tool's action text, including Edit/Write CONTENT -- so writing an HTML/doc file whose prose
// merely mentions a real project name containing "pytest" (e.g. "sphinx+pytest run") false-
// positived as "running the whole pytest suite," even though nothing was ever executed.
test('writing prose that merely MENTIONS a test-runner name is never a broad-test-suite detour', () => {
  const request = 'add the failure-bucket table to the roadmap';
  for (const [toolName, toolInput] of [
    ['Edit', { file_path: 'roadmap.html', old_string: 'a',
              new_string: '<p>Real data from a sphinx+pytest run, xarray subset.</p>' }],
    ['Write', { file_path: 'notes.md', content: 'jest and vitest are both JS test runners.' }],
  ]) {
    const verdict = detectEfficiencyKernel({ userText: request, toolName, toolInput });
    assert.equal(verdict.block, false, `${toolName} should not be denied`);
  }
});

// PRESERVED: an actual Bash/PowerShell invocation of a whole-project gate command is still
// caught -- the fix narrows WHICH TOOLS this check applies to, not what it matches within them.
test('an actual Bash invocation of a whole-project test command is still a broad-test-suite detour', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'fix the WIP',
    toolName: 'Bash',
    toolInput: { command: 'pytest' },
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /broad test suite/);
});

test('bounded work allows the core edit, focused test, and direct commit', () => {
  const request = 'Fix the login redirect in auth.ts.';
  for (const [toolName, toolInput] of [
    ['Edit', { file_path: 'auth.ts', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: 'auth.test.ts', content: 'test' }],
    ['Bash', { command: 'node --test auth.test.ts' }],
    ['Bash', { command: 'git commit -m "fix: login redirect"' }],
  ]) {
    assert.equal(detectEfficiencyKernel({ userText: request, toolName, toolInput }).block, false);
  }
});

test('ninth orientation action is denied, but the core edit remains open', () => {
  const completedTools = Array.from({ length: 8 }, (_, index) => ({
    name: 'Read', input: { file_path: `context-${index}.md` },
  }));
  const request = 'Update the timeout in config.ts.';
  assert.equal(detectEfficiencyKernel({
    userText: request,
    completedTools,
    toolName: 'Read',
    toolInput: { file_path: 'context-9.md' },
  }).block, true);
  assert.equal(detectEfficiencyKernel({
    userText: request,
    completedTools,
    toolName: 'Edit',
    toolInput: { file_path: 'config.ts' },
  }).block, false);
});

test('third identical action and third edit of one file are denied as spinning', () => {
  const request = 'Fix the timeout in config.ts.';
  const repeatedRead = { name: 'Read', input: { file_path: 'config.ts' } };
  assert.equal(detectEfficiencyKernel({
    userText: request,
    completedTools: [repeatedRead, repeatedRead],
    toolName: repeatedRead.name,
    toolInput: repeatedRead.input,
  }).block, true);

  const edit = { name: 'Edit', input: { file_path: 'config.ts' } };
  assert.equal(detectEfficiencyKernel({
    userText: request,
    completedTools: [edit, edit],
    toolName: edit.name,
    toolInput: edit.input,
  }).block, true);
});

// =============================================================================
// TWO-GUARD DEADLOCK REPAIRS (2026-08-05, Russell: "fix hook first").
// Three live false-positives in one session, each making a REQUIRED action illegal:
//   1. errored attempts counted as spinning, so the retry after a fix was denied
//   2. the worktree `worktree-default-for-edits` DEMANDS was denied as unrequested
//   3. the first Read of a human-named file was denied as orientation, making the
//      Edit (which requires a prior Read) unreachable — no legal move existed
// =============================================================================

test('a retry after errored attempts is not spinning; a stuck loop still blocks', () => {
  const request = 'Fix the timeout in config.ts.';
  const attempt = { name: 'Read', input: { file_path: 'config.ts' } };
  const failed = { ...attempt, isError: true };
  // Both prior attempts ERRORED — the blocker was fixed between them, so the retry is legitimate.
  assert.equal(detectEfficiencyKernel({
    userText: request, completedTools: [failed, failed], toolName: attempt.name, toolInput: attempt.input,
  }).block, false);
  // Two SUCCESSFUL identical attempts still block — original protection intact.
  assert.equal(detectEfficiencyKernel({
    userText: request, completedTools: [attempt, attempt], toolName: attempt.name, toolInput: attempt.input,
  }).block, true);
  // Hard ceiling: four identical attempts is a stuck retry loop even when all errored.
  assert.equal(detectEfficiencyKernel({
    userText: request, completedTools: [failed, failed, failed, failed], toolName: attempt.name, toolInput: attempt.input,
  }).block, true);
});

test('a process detour another guard demands in its denial is permitted', () => {
  const request = 'Update the roadmap wording in docs/ROADMAP-BRIEF.md.';
  const worktree = { toolName: 'Bash', toolInput: { command: 'git worktree add ../repo-docs -b feature/docs main' } };
  // With no sibling demand, the detour is still denied.
  assert.equal(detectEfficiencyKernel({ userText: request, ...worktree }).block, true);
  // A sibling guard's ACTUAL denial text (from an errored tool result) named it as required.
  const denied = {
    name: 'Edit',
    input: { file_path: 'docs/ROADMAP-BRIEF.md' },
    isError: true,
    resultText: 'Branch + worktree required: edit blocked.\nProblem: target is in the primary checkout.\nCreate one isolated branch worktree, then edit there:\n  git worktree add ../repo-<task> -b feature/<task> main',
  };
  assert.equal(detectEfficiencyKernel({ userText: request, completedTools: [denied], ...worktree }).block, false);
  // Model prose claiming a guard demanded it is NOT proof — only a real denial is.
  assert.equal(detectEfficiencyKernel({
    userText: request,
    completedTools: [{ name: 'Bash', input: { command: 'echo "Branch + worktree required: git worktree add"' } }],
    ...worktree,
  }).block, true);
});

test('the first read of a human-named file is never orientation ceremony', () => {
  const completedTools = Array.from({ length: 9 }, (_, index) => ({
    name: 'Read', input: { file_path: `context-${index}.md` },
  }));
  const request = 'Update the progress map in docs/codeservo-progress-map.html.';
  // Reading the named target is the precondition for editing it — always reachable.
  assert.equal(detectEfficiencyKernel({
    userText: request, completedTools, toolName: 'Read', toolInput: { file_path: 'docs/codeservo-progress-map.html' },
  }).block, false);
  // An unrelated tenth orientation read is still denied.
  assert.equal(detectEfficiencyKernel({
    userText: request, completedTools, toolName: 'Read', toolInput: { file_path: 'context-12.md' },
  }).block, true);
  // Re-reading the named file after two successful reads is still spinning.
  const namedRead = { name: 'Read', input: { file_path: 'docs/codeservo-progress-map.html' } };
  assert.equal(detectEfficiencyKernel({
    userText: request, completedTools: [namedRead, namedRead], toolName: namedRead.name, toolInput: namedRead.input,
  }).block, true);
});

// =============================================================================
// ORIENTATION-CEILING DEADLOCK REPAIR (2026-08-07, Russell: "open and fix it").
// Live incident: a bounded-looking request ("update my reports") whose PROJECT-LOCAL mandate
// actually required web research before any sensible edit. Every hook denial along the way
// (including this detector's own) counted as another "orientation action" toward the same flat
// ceiling it was blocked by — a false positive from ANY guard manufactured its own permanent
// lockout, because Edit/Write on an existing file require a prior successful Read, and every
// further Read just added to the count that kept Read illegal. No legal move existed.
// =============================================================================

test('a denied prior action does not count toward the orientation ceiling', () => {
  const request = 'Update the timeout in config.ts.';
  // Eight DENIED reads (isError: true) — none of them proved wandering, each proved a block.
  const deniedReads = Array.from({ length: 8 }, (_, index) => ({
    name: 'Read', input: { file_path: `blocked-${index}.md` }, isError: true,
  }));
  assert.equal(detectEfficiencyKernel({
    userText: request, completedTools: deniedReads, toolName: 'Read', toolInput: { file_path: 'context-9.md' },
  }).block, false, 'errored priors must not manufacture their own lockout');

  // Mix: 8 denied + 8 successful — only the 8 SUCCESSFUL ones count, so this is exactly at the ceiling.
  const successfulReads = Array.from({ length: 8 }, (_, index) => ({
    name: 'Read', input: { file_path: `context-${index}.md` },
  }));
  assert.equal(detectEfficiencyKernel({
    userText: request, completedTools: [...deniedReads, ...successfulReads], toolName: 'Read', toolInput: { file_path: 'context-9.md' },
  }).block, true, 'eight SUCCESSFUL priors still hits the ceiling regardless of how many denials sit alongside them');
});

// The wiring regression. The three deadlock repairs above passed as pure functions while the LIVE
// hook still denied everything, because the transcript summary never attached tool outcomes to the
// records those rules read. Hand-fed fixtures cannot see that gap; this test and the installed-file
// payload proof are what do. Never assert the detectors without also asserting the feed.
test('the live turn summary attaches each tool call outcome to its record', () => {
  const entries = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the timeout in config.ts.' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'config.ts' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Branch + worktree required: git worktree add', is_error: true }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'Read', input: { file_path: 'config.ts' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'file contents', is_error: false }] } },
  ];
  const summary = latestNormalizedTurnSummary(entries);
  assert.equal(summary.completedTools.length, 2);
  assert.equal(summary.completedTools[0].isError, true);
  assert.match(summary.completedTools[0].resultText, /worktree required/);
  assert.equal(summary.completedTools[1].isError, false);
  assert.equal(summary.completedTools[1].resultText, 'file contents');
});

// Thrashing is REWORK, not volume (Russell, 2026-08-05: "our goal is to prevent thrashing and
// sidequests and bikeshedding"). A flat per-file count measured file size and blocked genuine
// multi-part fixes twice mid-implementation. These lock the real signal: same region again.
test('a multi-part fix to one file is composition, not thrashing', () => {
  const request = 'Fix the timeout handling in config.ts.';
  const editAt = (anchor) => ({ name: 'Edit', input: { file_path: 'config.ts', old_string: anchor } });
  const distinctEdits = ['import block', 'const TIMEOUT', 'function connect', 'function retry', 'module.exports']
    .map(editAt);
  assert.equal(detectEfficiencyKernel({
    userText: request,
    completedTools: distinctEdits,
    toolName: 'Edit',
    toolInput: { file_path: 'config.ts', old_string: 'class Session' },
  }).block, false);
});

test('reworking the same passage is bikeshedding and still blocks', () => {
  const request = 'Fix the timeout handling in config.ts.';
  // Same anchor, different replacement each time — the real shape of bikeshedding one passage,
  // and distinct enough that the identical-action spin rule never fires.
  const reworkAt = (replacement) => ({
    name: 'Edit',
    input: { file_path: 'config.ts', old_string: 'const TIMEOUT = 30', new_string: replacement },
  });
  const verdict = detectEfficiencyKernel({
    userText: request,
    completedTools: [reworkAt('45'), reworkAt('60'), reworkAt('90')],
    toolName: 'Edit',
    toolInput: { file_path: 'config.ts', old_string: 'const  TIMEOUT   = 30', new_string: '120' },
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /bikeshedding/);
});

test('rewriting one whole file over and over still blocks', () => {
  const request = 'Fix the timeout handling in config.ts.';
  const wholeFile = { name: 'Write', input: { file_path: 'config.ts', content: 'x' } };
  const verdict = detectEfficiencyKernel({
    userText: request,
    completedTools: [wholeFile, wholeFile, wholeFile],
    toolName: 'Write',
    toolInput: { file_path: 'config.ts', content: 'y' },
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /rewritten whole/);
});

test('two failed edits to the SAME region still block a third attempt at that region', () => {
  const request = 'Fix the timeout handling in config.ts.';
  const failedEdit = { name: 'Edit', input: { file_path: 'config.ts', old_string: 'a' }, isError: true };
  assert.equal(detectEfficiencyKernel({
    userText: request,
    completedTools: [failedEdit, { ...failedEdit }],
    toolName: 'Edit',
    toolInput: { file_path: 'config.ts', old_string: 'a' },
  }).block, true);
});

// REGRESSION (2026-08-05): the "failed to edit twice" check used to count errors ANYWHERE in the
// file's history this turn, so a trivial, already-fixed mistake in one passage (region 'a') got
// lumped in with a real, unrelated error in a totally different passage (region 'b') later — and
// then blocked EVERY subsequent attempt at a THIRD, still-different passage ('c'), even though no
// single passage had actually failed twice. Fixed to scope the counter to the CURRENT region, same
// as the sameRegion/bikeshedding check right below it.
test('two failed edits to TWO DIFFERENT regions do NOT block a third attempt at a THIRD region', () => {
  const request = 'Fix the timeout handling in config.ts.';
  const failedEdit = { name: 'Edit', input: { file_path: 'config.ts', old_string: 'a' }, isError: true };
  const verdict = detectEfficiencyKernel({
    userText: request,
    completedTools: [failedEdit, { ...failedEdit, input: { file_path: 'config.ts', old_string: 'b' } }],
    toolName: 'Edit',
    toolInput: { file_path: 'config.ts', old_string: 'c' },
  });
  assert.equal(verdict.block, false);
});

test('a THIRD attempt at the SAME failed region still blocks, even with an unrelated error elsewhere in between', () => {
  const request = 'Fix the timeout handling in config.ts.';
  const failedRegionA1 = { name: 'Edit', input: { file_path: 'config.ts', old_string: 'a' }, isError: true };
  const failedRegionB = { name: 'Edit', input: { file_path: 'config.ts', old_string: 'b' }, isError: true };
  const failedRegionA2 = { name: 'Edit', input: { file_path: 'config.ts', old_string: 'a' }, isError: true };
  const verdict = detectEfficiencyKernel({
    userText: request,
    completedTools: [failedRegionA1, failedRegionB, failedRegionA2],
    toolName: 'Edit',
    toolInput: { file_path: 'config.ts', old_string: 'a' },
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /this same passage already failed to edit twice/);
});

test('a runaway edit loop on one file still has a backstop', () => {
  const request = 'Fix the timeout handling in config.ts.';
  const manyDistinctEdits = Array.from({ length: 12 }, (_, index) => ({
    name: 'Edit', input: { file_path: 'config.ts', old_string: `region-${index}` },
  }));
  assert.equal(detectEfficiencyKernel({
    userText: request,
    completedTools: manyDistinctEdits,
    toolName: 'Edit',
    toolInput: { file_path: 'config.ts', old_string: 'region-99' },
  }).block, true);
});

// REGRESSION (2026-08-08): a live write-plan session got hard-blocked mid-plan. write-plan's OWN
// Rule 0 mandates composing a large plan via many small, non-overlapping Edits and explicitly
// FORBIDS batching sections to save tool calls -- so a real plan document routinely needs 15-20+
// edits, well past the flat backstop of 12. Each edit here targets a DISTINCT region (a different
// section being composed), which is exactly what the region checks above already prove isn't
// thrashing -- the flat count was a redundant, miscalibrated second gate for this one workflow.
// (Path built via concatenation, not a literal -- see the 2026-08-08 processDetour fix above.)
test('composing a plans-dir artifact via many distinct-region edits does NOT hit the flat same-file backstop', () => {
  const planPath = ['plans', '71-billing-sync-08-08-2026.md'].join('/');
  const request = 'Write a plan for the new billing sync feature.';
  const manyDistinctSectionEdits = Array.from({ length: 20 }, (_, index) => ({
    name: 'Edit', input: { file_path: planPath, old_string: `## Section ${index}` },
  }));
  const verdict = detectEfficiencyKernel({
    userText: request,
    completedTools: manyDistinctSectionEdits,
    toolName: 'Edit',
    toolInput: { file_path: planPath, old_string: '## Section 20' },
  });
  assert.equal(verdict.block, false);
});

// The exemption is narrow: reworking the SAME section of a plan file over and over is still real
// bikeshedding and must still block, proving the region-rework checks were not weakened.
test('reworking the SAME section of a plans-dir artifact repeatedly still blocks as bikeshedding', () => {
  const planPath = ['plans', '71-billing-sync-08-08-2026.md'].join('/');
  const request = 'Write a plan for the new billing sync feature.';
  const reworkAt = (replacement) => ({
    name: 'Edit',
    input: { file_path: planPath, old_string: '## Open questions', new_string: replacement },
  });
  const verdict = detectEfficiencyKernel({
    userText: request,
    completedTools: [reworkAt('draft 1'), reworkAt('draft 2'), reworkAt('draft 3')],
    toolName: 'Edit',
    toolInput: { file_path: planPath, old_string: '## Open questions', new_string: 'draft 4' },
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /bikeshedding/);
});

// REGRESSION (2026-08-08): found by red-team-code replaying the Read exemption above against
// sibling read-only tools. Grep and Glob are exactly as read-only as Read (neither can DO
// planning/handoff work), but only Read was exempted -- so "grep the plans/ directory for TODOs"
// reproduced the identical false positive via a different tool name.
test('grepping a plans-dir path mid-task is never classified as unrequested planning', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'Fix the login redirect in auth.ts.',
    completedTools: [],
    toolName: 'Grep',
    toolInput: { path: 'plans/', pattern: 'TODO' },
  });
  assert.equal(verdict.block, false);
});

test('globbing a plans-dir path mid-task is never classified as unrequested planning', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'Fix the login redirect in auth.ts.',
    completedTools: [],
    toolName: 'Glob',
    toolInput: { path: 'plans/', pattern: '*.md' },
  });
  assert.equal(verdict.block, false);
});

// REGRESSION (2026-08-05): Russell named a full absolute path under the PRIMARY checkout
// (C:\Users\rmill\.claude\hooks\getty-ceremony-guard.mjs), but every edit to a hook file is
// required to land in an isolated WORKTREE first (a different absolute root, same relative
// structure underneath). `path === goal || path.endsWith('/' + goal)` can never match when goal
// is itself a full absolute path and the roots diverge — so naming an absolute path structurally
// self-blocked every edit meant to satisfy that exact request. Fixed via a path-tail (last-2-
// segment) fallback comparison.
test('naming a full absolute path under the primary checkout does NOT block editing the same file via a worktree', () => {
  const request = 'Fix the counter in C:\\Users\\rmill\\.claude\\hooks\\getty-ceremony-guard.mjs please.';
  const verdict = detectEfficiencyKernel({
    userText: request,
    completedTools: [],
    toolName: 'Edit',
    toolInput: {
      file_path: 'C:\\Users\\rmill\\.claude-some-task\\hooks\\getty-ceremony-guard.mjs',
      old_string: 'x',
    },
  });
  assert.equal(verdict.block, false);
});

test('naming an absolute path still catches an edit that genuinely leaves file scope', () => {
  const request = 'Fix the counter in C:\\Users\\rmill\\.claude\\hooks\\getty-ceremony-guard.mjs please.';
  const verdict = detectEfficiencyKernel({
    userText: request,
    completedTools: [],
    toolName: 'Edit',
    toolInput: {
      file_path: 'C:\\Users\\rmill\\.claude-some-task\\hooks\\some-unrelated-hook.mjs',
      old_string: 'x',
    },
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /leaves the file scope/);
});

test('named-file work denies an unrelated source edit but permits its test', () => {
  const request = 'Change the timeout in src/config.ts.';
  assert.equal(detectEfficiencyKernel({
    userText: request,
    toolName: 'Edit',
    toolInput: { file_path: 'src/cache.ts' },
  }).block, true);
  assert.equal(detectEfficiencyKernel({
    userText: request,
    toolName: 'Write',
    toolInput: { file_path: 'tests/config.test.ts' },
  }).block, false);
});

test('explicit complex/process goals are the task, not an override', () => {
  assert.equal(detectEfficiencyKernel({
    userText: 'Design and implement a repo-wide authentication migration plan.',
    toolName: 'update_plan',
    toolInput: { plan: [{ step: 'map dependencies' }] },
  }).block, false);
  assert.equal(detectEfficiencyKernel({
    userText: 'Research current OAuth guidance and update auth.md with sources.',
    toolName: 'WebSearch',
    toolInput: { query: 'OAuth guidance' },
  }).block, false);
});

test('only human approval after a safety concern bypasses the kernel', () => {
  const completedTools = Array.from({ length: 8 }, () => ({ name: 'Read', input: { file_path: 'auth.ts' } }));
  const blocked = {
    userText: 'Prevent credential leakage and data loss in auth.ts.',
    completedTools,
    toolName: 'Read',
    toolInput: { file_path: 'secrets.ts' },
  };
  assert.equal(detectEfficiencyKernel(blocked).block, true);
  assert.equal(detectEfficiencyKernel({ ...blocked, humanSafetyApproval: true }).block, false);
  assert.equal(detectEfficiencyKernel({
    userText: 'Fix the typo in auth.ts.',
    completedTools,
    toolName: 'Read',
    toolInput: { file_path: 'secrets.ts', reason: 'safety concern' },
  }).block, true);
});

// =============================================================================
// DUPLICATE VERIFICATION — 3rd detector: the same whole-project gate proving
// success twice against unchanged code (running it again is ceremony, not proof).
// =============================================================================

// ---------- gate family recognition ----------

test('matchGateFamily: recognizes whole-project forms across languages', () => {
  assert.equal(matchGateFamily('npm test'), 'js-test');
  assert.equal(matchGateFamily('npm run test'), 'js-test');
  assert.equal(matchGateFamily('pnpm test'), 'js-test');
  assert.equal(matchGateFamily('yarn test'), 'js-test');
  assert.equal(matchGateFamily('bun test'), 'js-test');
  assert.equal(matchGateFamily('npx vitest run'), 'vitest');
  assert.equal(matchGateFamily('npx jest'), 'jest');
  assert.equal(matchGateFamily('pytest'), 'pytest');
  assert.equal(matchGateFamily('go test ./...'), 'go-test');
  assert.equal(matchGateFamily('cargo test'), 'cargo-test');
  assert.equal(matchGateFamily('dotnet test'), 'dotnet-test');
  assert.equal(matchGateFamily('npm run lint'), 'lint');
  assert.equal(matchGateFamily('npm run typecheck'), 'typecheck');
  assert.equal(matchGateFamily('tsc --noEmit'), 'typecheck');
  assert.equal(matchGateFamily('npm run build'), 'build');
  assert.equal(matchGateFamily('npx playwright test'), 'e2e');
});

test('matchGateFamily: a file/test selector downgrades to focused (not whole-project)', () => {
  assert.equal(matchGateFamily('pytest scripts/test_exp154_model_config.py'), null);
  assert.equal(matchGateFamily('pytest tests/test_foo.py::test_bar'), null);
  assert.equal(matchGateFamily('npx vitest run src/foo.test.ts'), null);
  assert.equal(matchGateFamily('npx jest -t "does the thing"'), null);
  assert.equal(matchGateFamily('go test ./pkg/foo'), null);
  assert.equal(matchGateFamily('go test ./... -run TestFoo'), null);
  assert.equal(matchGateFamily('dotnet test --filter "FullyQualifiedName~Foo"'), null);
  assert.equal(matchGateFamily('pnpm --filter my-pkg test'), null);
});

test('matchGateFamily: unrelated / read-only commands never match', () => {
  assert.equal(matchGateFamily('git status'), null);
  assert.equal(matchGateFamily('ls -la'), null);
  assert.equal(matchGateFamily('echo hello'), null);
});

// ---------- outcome classification ----------

test('classifyGateOutcome: pytest pass/fail/unknown', () => {
  assert.equal(classifyGateOutcome('pytest', '5 passed in 1.02s', false), 'pass');
  assert.equal(classifyGateOutcome('pytest', '1 failed, 4 passed in 226.09s', false), 'fail');
  assert.equal(classifyGateOutcome('pytest', 'collected 0 items', false), 'unknown');
});

test('classifyGateOutcome: js-test/vitest/jest pass/fail', () => {
  assert.equal(classifyGateOutcome('vitest', ' Test Files  3 passed (3)\n      Tests  12 passed (12)', false), 'pass');
  assert.equal(classifyGateOutcome('jest', 'Tests:       1 failed, 11 passed, 12 total', false), 'fail');
  assert.equal(classifyGateOutcome('js-test', '12 passing (400ms)', false), 'pass');
});

test('classifyGateOutcome: go/cargo/dotnet', () => {
  assert.equal(classifyGateOutcome('go-test', 'ok  \tgithub.com/foo/bar\t0.005s', false), 'pass');
  assert.equal(classifyGateOutcome('go-test', '--- FAIL: TestFoo (0.00s)\nFAIL', false), 'fail');
  assert.equal(classifyGateOutcome('cargo-test', 'test result: ok. 12 passed; 0 failed', false), 'pass');
  assert.equal(classifyGateOutcome('cargo-test', 'test result: FAILED. 10 passed; 2 failed', false), 'fail');
  assert.equal(classifyGateOutcome('dotnet-test', 'Passed!  - Failed: 0, Passed: 12, Skipped: 0, Total: 12', false), 'pass');
  assert.equal(classifyGateOutcome('dotnet-test', 'Failed!  - Failed: 2, Passed: 10, Skipped: 0, Total: 12', false), 'fail');
});

test('classifyGateOutcome: generic lint/typecheck/build', () => {
  assert.equal(classifyGateOutcome('build', 'webpack compiled successfully', false), 'pass');
  assert.equal(classifyGateOutcome('typecheck', 'src/app.ts:10:5 - error TS2322: Type mismatch', false), 'fail');
});

// ---------- duplicate detection (pure, hand-built session events) ----------

function shellEvent(command, commandOutput, isError = false) { return { kind: 'shell', command, outputText: commandOutput, isError }; }
function editEvent(isError = false) { return { kind: 'edit', isError }; }

test('positive 1: the same whole-project gate succeeds twice with no edit between -> block', () => {
  const events = [shellEvent('npm test', '42 passed'), shellEvent('npm test', '42 passed')];
  const verdict = detectDuplicateVerification({ events });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /DUPLICATE VERIFICATION/);
});

test('positive 2: direct success then the SAME gate echoed inside a successful commit hook -> block', () => {
  const events = [
    shellEvent('npx vitest run', ' Test Files  3 passed (3)\n Tests  12 passed (12)'),
    shellEvent('git commit -m "x"', 'husky > pre-commit\n> vitest run\n\n Test Files  3 passed (3)\n Tests  12 passed (12)\n[main abc1234] x'),
  ];
  const verdict = detectDuplicateVerification({ events });
  assert.equal(verdict.block, true);
});

test('positive 3: a proven full gate spans two commits with no content edit between -> block (commits do not reset proof)', () => {
  const events = [
    shellEvent('git commit -m "a"', '> vitest run\n Tests  12 passed (12)\n[main aaa1111] a'),
    shellEvent('git commit -m "b"', '> vitest run\n Tests  12 passed (12)\n[main bbb2222] b'),
  ];
  const verdict = detectDuplicateVerification({ events });
  assert.equal(verdict.block, true);
});

test('positive 4: three differently worded whole-project families each independently trigger the policy', () => {
  const cases = [
    [shellEvent('pytest', '9 passed in 1s'), shellEvent('pytest', '9 passed in 1s')],
    [shellEvent('cargo test', 'test result: ok. 9 passed; 0 failed'), shellEvent('cargo test', 'test result: ok. 9 passed; 0 failed')],
    [shellEvent('go test ./...', 'ok  \tpkg\t0.01s'), shellEvent('go test ./...', 'ok  \tpkg\t0.01s')],
  ];
  for (const events of cases) assert.equal(detectDuplicateVerification({ events }).block, true);
});

test('negative 1: focused test then full test -> allow', () => {
  const events = [shellEvent('pytest scripts/test_foo.py', '3 passed'), shellEvent('pytest', '40 passed')];
  assert.equal(detectDuplicateVerification({ events }).block, false);
});

test('negative 2: full test fails, content edit, full test passes -> allow', () => {
  const events = [shellEvent('npm test', '1 failed, 39 passed'), editEvent(), shellEvent('npm test', '40 passed')];
  assert.equal(detectDuplicateVerification({ events }).block, false);
});

test('negative 2b: a flaky failure followed by one retry with no edit -> allow (success not yet established twice)', () => {
  const events = [shellEvent('npm test', '1 failed, 39 passed'), shellEvent('npm test', '40 passed')];
  assert.equal(detectDuplicateVerification({ events }).block, false);
});

test('negative 3: full test passes, content edit, full test passes again -> allow (new snapshot)', () => {
  const events = [shellEvent('npm test', '40 passed'), editEvent(), shellEvent('npm test', '40 passed')];
  assert.equal(detectDuplicateVerification({ events }).block, false);
});

test('negative 4: full test once + a different full check once -> allow', () => {
  const events = [shellEvent('npm test', '40 passed'), shellEvent('npm run typecheck', 'no errors')];
  assert.equal(detectDuplicateVerification({ events }).block, false);
});

test('negative 5: a commit hook runs a gate not already proven in this epoch -> allow', () => {
  const events = [shellEvent('git commit -m "x"', '> vitest run\n Tests  12 passed (12)\n[main a] x')];
  assert.equal(detectDuplicateVerification({ events }).block, false);
});

test('negative: read-only commands repeated many times -> allow', () => {
  const events = Array.from({ length: 10 }, () => shellEvent('git status', 'clean'));
  assert.equal(detectDuplicateVerification({ events }).block, false);
});

test('negative: git add / plain git commit / git status / git diff never advance the content epoch', () => {
  const events = [
    shellEvent('npm test', '40 passed'),
    shellEvent('git add -A', ''),
    shellEvent('git commit -m "no gate here"', '[main a] no gate here'),
    shellEvent('git status', 'clean'),
    shellEvent('git diff', ''),
    shellEvent('npm test', '40 passed'),
  ];
  assert.equal(detectDuplicateVerification({ events }).block, true); // still same epoch -> still a duplicate
});

test('override: verification-rerun-ok with a real reason clears the block', () => {
  const events = [shellEvent('npm test', '40 passed'), shellEvent('npm test', '40 passed')];
  const verdict = detectDuplicateVerification({ events, replyText: 'verification-rerun-ok: CI cache was stale, needed a clean rerun to trust the number' });
  assert.equal(verdict.block, false);
});

test('override: bare/empty verification-rerun-ok reason does NOT clear the block', () => {
  const events = [shellEvent('npm test', '40 passed'), shellEvent('npm test', '40 passed')];
  assert.equal(detectDuplicateVerification({ events, replyText: 'verification-rerun-ok:' }).block, true);
  assert.equal(detectDuplicateVerification({ events, replyText: 'verification-rerun-ok:    ' }).block, true);
});

test('the pre-existing ceremony-ok token also clears the duplicate-verification block (intentional backcompat, kept per spec: one override vocabulary, both detectors)', () => {
  const events = [shellEvent('npm test', '40 passed'), shellEvent('npm test', '40 passed')];
  assert.equal(detectDuplicateVerification({ events, replyText: 'ceremony-ok: rerunning intentionally to double-check a flake' }).block, false);
});

test('malformed/missing events -> fail open', () => {
  assert.equal(detectDuplicateVerification({}).block, false);
  assert.equal(detectDuplicateVerification({ events: null }).block, false);
});

// ---------- end-to-end Stop invocation ----------

function makeRichTranscript(steps, replyText) {
  const entries = [];
  let seq = 0;
  for (const step of steps) {
    const id = `toolu_${seq++}`;
    if (step.type === 'edit') {
      entries.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: step.tool || 'Edit', input: { file_path: step.filePath || 'src/app.ts' } }] } });
      entries.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] } });
    } else {
      entries.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: step.command } }] } });
      entries.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: step.output || '', is_error: !!step.isError }] } });
    }
  }
  if (replyText) entries.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: replyText }] } });
  return writeTranscript('dupver-tx-', entries);
}

test('end-to-end Stop: duplicate whole-project gate -> block JSON', () => {
  const { path, dir } = makeRichTranscript([
    { type: 'bash', command: 'npm test', output: '40 passed' },
    { type: 'bash', command: 'npm test', output: '40 passed' },
  ]);
  try {
    const run = spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }), encoding: 'utf8' });
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /DUPLICATE VERIFICATION/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('end-to-end Stop: full test passes, edit, full test passes -> allowed (no stdout)', () => {
  const { path, dir } = makeRichTranscript([
    { type: 'bash', command: 'npm test', output: '40 passed' },
    { type: 'edit', tool: 'Edit' },
    { type: 'bash', command: 'npm test', output: '40 passed' },
  ]);
  try {
    const run = spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }), encoding: 'utf8' });
    assert.equal((run.stdout || '').trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('end-to-end Stop: missing transcript path -> fail open', () => {
  const run = spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: 'C:/nonexistent/path/transcript.jsonl' }), encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal((run.stdout || '').trim(), '');
});

// --- 2026-08-07: the docs/efficiency deadlock ---------------------------------
// Two guards demanded opposite things: the docs rule REQUIRES HANDOFF/CHANGELOG
// to move after a commit, while this guard classified that as a detour. The
// docs demand arrives as STOP feedback, which guardDemandedDetour cannot see.
test('a HANDOFF refresh after a commit is not a detour', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'add run_tests to the arm',
    completedTools: [{ name: 'Bash', input: { command: 'git commit --no-verify -m "fix: x"' } }],
    toolName: 'Edit',
    toolInput: { file_path: 'C:/repo/HANDOFF.md', new_string: 'shipped' },
  });
  assert.equal(verdict.block, false, 'the docs rule requires this edit — blocking it deadlocks the turn');
});

test('a CHANGELOG refresh after safe-merge is not a detour', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'add run_tests to the arm',
    completedTools: [{ name: 'Bash', input: { command: 'bash ~/.claude/scripts/safe-merge-to-main.sh /w b "pytest"' } }],
    toolName: 'Edit',
    toolInput: { file_path: 'C:/repo/CHANGELOG.md', new_string: 'entry' },
  });
  assert.equal(verdict.block, false);
});

test('PROTECTION KEPT: gratuitous handoff bookkeeping with NO commit still blocks', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'add run_tests to the arm',
    completedTools: [{ name: 'Read', input: { file_path: 'C:/repo/scripts/a.py' } }],
    toolName: 'Edit',
    toolInput: { file_path: 'C:/repo/HANDOFF.md', new_string: 'notes' },
  });
  assert.equal(verdict.block, true, 'loosening must not blanket-exempt these files');
});

test('TIGHTENED: a detour merely MENTIONING a front-door doc is still classified', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'add run_tests to the arm',
    completedTools: [{ name: 'Bash', input: { command: 'git commit -m x' } }],
    toolName: 'update_plan',
    toolInput: { note: 'see HANDOFF.md for current state' },
  });
  assert.equal(verdict.block, true, 'the carve-out is for WRITING those files, not writing ABOUT them');
});

// REGRESSION (2026-08-08): found live seconds after the previous fix in this file shipped. Merely
// READING an existing plan or HANDOFF file mid-task (to re-orient before resuming an edit) was
// itself classified as unrequested "planning"/"handoff maintenance" -- a Read can never DO that
// work, only writing can. Two cases: a plan-dir path, and HANDOFF.md.
test('reading an existing plans-dir file mid-task is never classified as unrequested planning', () => {
  const planPath = ['plans', '71-billing-sync-08-08-2026.md'].join('/');
  const verdict = detectEfficiencyKernel({
    userText: 'Fix the timeout handling in config.ts.',
    completedTools: [],
    toolName: 'Read',
    toolInput: { file_path: planPath },
  });
  assert.equal(verdict.block, false);
});

test('reading HANDOFF.md mid-task is never classified as unrequested handoff maintenance', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'Fix the timeout handling in config.ts.',
    completedTools: [],
    toolName: 'Read',
    toolInput: { file_path: 'HANDOFF.md' },
  });
  assert.equal(verdict.block, false);
});

// Preserve: `update_plan` itself is the planning action regardless of file target, and must still
// detour when unrequested -- proves the exemption is scoped to the Read tool, not a broader gate.
test('update_plan itself still detours when unrequested, even though it is not classified as a mutation', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'Fix the login redirect in auth.ts.',
    completedTools: [],
    toolName: 'update_plan',
    toolInput: { plan: [{ step: 'investigate' }] },
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /planning/);
});

// FP fixed 2026-08-08: WORKFLOW_EXPANSION_RE matched the BARE landing-script token, which also
// appears in that script's own test filename. Running its tests was refused as "merge setup",
// so the guard blocked the very work it exists to keep honest -- and it also refused a
// quiet-override whose REASON TEXT merely named the script. Requiring the .sh extension frees
// the test file (which can never be an invocation) while keeping every real invocation matched.
test("running the landing script's OWN test file is not merge setup", () => {
  assert.equal(detectEfficiencyKernel({
    userText: 'fix the WIP',
    toolName: 'Bash',
    toolInput: { command: 'node --test scripts/safe-merge-to-main.test.mjs' },
  }).block, false);
});

// This blocks for the BROAD-TEST-SUITE reason (the embedded "npm test" argument is an
// unscoped gate command), not the branch/worktree/merge-setup reason -- see the next two
// tests, which prove that reason no longer applies to a real landing invocation at all.
test('an unscoped test-cmd argument to the landing script is still a broad-test-suite detour', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'fix the WIP',
    toolName: 'Bash',
    toolInput: { command: 'bash ~/.claude/scripts/safe-merge-to-main.sh /repo mybranch "npm test"' },
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /broad test suite/);
});

// FIX 2026-08-08 (live deadlock): landing already-finished, already-tested work is
// CLAUDE.md's own standing default ("Ship the moment a feature is DONE... Never wait to be
// asked") -- invoking safe-merge-to-main.sh must NEVER need this turn's wording to justify it,
// unlike genuinely NEW scope (a fresh worktree/branch/merge). The driving human message in the
// live incident was an unrelated question ("why did python exp fail"), containing none of
// worktree/branch/merge/land/ship/wip/commit/uncommitted -- and the same gate then blocked the
// `git worktree add` needed to fix itself, a self-referential dead end with no legal move.
test('invoking the landing script with a SCOPED test command is never branch/worktree/merge setup, regardless of this turn wording', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'why did python exp fail? make sure we get timestamps at each step. continue',
    toolName: 'Bash',
    toolInput: {
      command: 'bash ~/.claude/scripts/safe-merge-to-main.sh /repo mybranch '
        + '"python -m pytest test_codeservo_replay_ledger.py -q"',
    },
  });
  assert.equal(verdict.block, false);
});

test('invoking the landing script with NO test command at all is never branch/worktree/merge setup', () => {
  const verdict = detectEfficiencyKernel({
    userText: 'continue',
    toolName: 'Bash',
    toolInput: { command: 'bash ~/.claude/scripts/safe-merge-to-main.sh /repo mybranch' },
  });
  assert.equal(verdict.block, false);
});

// FP fixed 2026-08-08: "land the WIP" requests landing work without saying
// worktree/branch/merge, so the guard refused the exact merge Russell asked for.
test('landing language counts as REQUESTING the merge', () => {
  for (const ask of ['fix the WIP', 'land it', 'ship this', 'commit the uncommitted changes']) {
    assert.equal(detectEfficiencyKernel({
      userText: ask,
      toolName: 'Bash',
      toolInput: { command: 'bash scripts/land.sh /repo mybranch' },
    }).block, false, ask);
  }
});
