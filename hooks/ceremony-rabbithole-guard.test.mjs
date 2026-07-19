import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyCommit, trailingInfraOnlyStreak, repeatedSameOpCount, detectCeremony, isInfraPath } from './ceremony-rabbithole-guard.mjs';

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
function makeTranscript(commands, replyText) {
  const dir = mkdtempSync(join(tmpdir(), 'ceremony-tx-'));
  const entries = commands.map((command) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }));
  if (replyText) entries.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: replyText }] } });
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
  return { path, dir };
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
