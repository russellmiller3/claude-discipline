import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { experimentBuildIntent, buildReminder } from './experiment-runner-logger-reread.mjs';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'experiment-runner-logger-reread.mjs');

// (a) fires on experiment-build phrasings.
test('experimentBuildIntent: true for build/port/line-up/scale experiment phrasings', () => {
  assert.ok(experimentBuildIntent('build the exp147c worker on Qwen 1.5B'));
  assert.ok(experimentBuildIntent('port exp149 to 1.5B'));
  assert.ok(experimentBuildIntent('line up the next GPU tests, do them in parallel'));
  assert.ok(experimentBuildIntent('scale Marcus to 7b'));
  assert.ok(experimentBuildIntent('write the training worker'));
  assert.ok(experimentBuildIntent('spin up runpod_exp151.py'));
});

// (b) does NOT fire on unrelated prompts.
test('experimentBuildIntent: false for unrelated prompts', () => {
  assert.equal(experimentBuildIntent('fix the homepage copy'), false);
  assert.equal(experimentBuildIntent('what movies are playing this weekend'), false);
  assert.equal(experimentBuildIntent('refactor the caption renderer'), false);
  assert.equal(experimentBuildIntent('read exp147 results and summarize'), false); // read/summarize is not a BUILD
});

// (d) the injected text names both README paths + the domain-glue-only rule.
test('buildReminder names both README paths and the domain-glue-only rule', () => {
  const reminder = buildReminder();
  assert.match(reminder, /runner[\/\\]README\.md/i);
  assert.match(reminder, /Logger[\/\\]README\.md/i);
  assert.match(reminder, /DOMAIN GLUE ONLY/);
  assert.match(reminder, /Do NOT hand-roll/i);
});

// End-to-end: injects on a matching prompt, silent on a non-matching one, and (c) dedups per session.
function runHook(prompt, sessionId, stateDir) {
  const run = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sessionId }),
    encoding: 'utf8',
    env: { ...process.env, EXP_REREAD_STATE_DIR: stateDir },
  });
  return run.stdout || '';
}

test('end-to-end: injects the reminder once per session, then stays silent (dedup)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'exp-reread-'));
  try {
    const first = runHook('build the exp147c worker', 'sess-1', stateDir);
    assert.match(first, /DOMAIN GLUE ONLY/, 'first matching prompt injects the reminder');
    const second = runHook('port exp149 to 1.5B', 'sess-1', stateDir);
    assert.equal(second.trim(), '', 'a second matching prompt in the SAME session stays silent (dedup)');
    // A different session fires again.
    const otherSession = runHook('build the exp150 worker', 'sess-2', stateDir);
    assert.match(otherSession, /DOMAIN GLUE ONLY/, 'a new session fires again');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('end-to-end: silent on an unrelated prompt', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'exp-reread-'));
  try {
    assert.equal(runHook('fix the homepage copy', 'sess-x', stateDir).trim(), '');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
