import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyCommit, trailingInfraOnlyStreak, repeatedSameOpCount, detectCeremony, isInfraPath, matchGateFamily, classifyGateOutcome, detectDuplicateVerification } from './ceremony-rabbithole-guard.mjs';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'ceremony-rabbithole-guard.mjs');

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
