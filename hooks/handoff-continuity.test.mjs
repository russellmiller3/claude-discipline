import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'handoff-continuity.mjs');

function makeProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'handoff-project-'));
  writeFileSync(join(projectRoot, 'HANDOFF.md'), '# Handoff\n', 'utf8');
  return projectRoot;
}

function runHook({ eventName = 'UserPromptSubmit', prompt, projectRoot = makeProject(), statePath } = {}) {
  const checkpointStatePath = statePath || join(mkdtempSync(join(tmpdir(), 'handoff-state-')), 'state.json');
  const hookRun = spawnSync(process.execPath, [hookPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HANDOFF_CONTINUITY_STATE_PATH: checkpointStatePath,
    },
    input: JSON.stringify({
      hook_event_name: eventName,
      cwd: projectRoot,
      prompt,
    }),
    encoding: 'utf8',
  });
  return { ...hookRun, checkpointStatePath, projectRoot };
}

function parseHookOutput(hookRun) {
  if (!hookRun.stdout.trim()) return null;
  return JSON.parse(hookRun.stdout);
}

test('handoff-continuity stays quiet when Russell is discussing the handoff hook', () => {
  const hookRun = runHook({ prompt: 'ok so edit the handoff hook then' });

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('handoff-continuity stays quiet for the first few turns (cadence is 5, not 3)', () => {
  const projectRoot = makeProject();
  const checkpointStatePath = join(mkdtempSync(join(tmpdir(), 'handoff-state-')), 'state.json');

  for (const prompt of ['look at this file', 'now run the test', 'continue with the next fix']) {
    const hookRun = runHook({ prompt, projectRoot, statePath: checkpointStatePath });
    assert.equal(hookRun.status, 0);
    assert.equal(hookRun.stdout, '');
  }
});

test('handoff-continuity comes due on its own at the periodic cadence, demanding a whole-file prune', () => {
  const projectRoot = makeProject();
  const checkpointStatePath = join(mkdtempSync(join(tmpdir(), 'handoff-state-')), 'state.json');

  let firedOutput = null;
  for (let turn = 1; turn <= 5; turn += 1) {
    const hookRun = runHook({ prompt: `unrelated work step ${turn}`, projectRoot, statePath: checkpointStatePath });
    assert.equal(hookRun.status, 0);
    if (turn < 5) assert.equal(hookRun.stdout, '', `turn ${turn} should stay quiet before the cadence`);
    else firedOutput = parseHookOutput(hookRun);
  }

  assert.ok(firedOutput, 'a periodic checkpoint should have fired by the 5th turn');
  assert.match(firedOutput.hookSpecificOutput.additionalContext, /periodic checkpoint/i);
  assert.match(firedOutput.hookSpecificOutput.additionalContext, /PRUNE/);
  assert.match(firedOutput.hookSpecificOutput.additionalContext, /learnings\.md/i);
});

test('handoff-continuity triggers when Russell reports compaction', () => {
  const hookRun = runHook({ prompt: 'we compacted, continue from the summary' });
  const hookOutput = parseHookOutput(hookRun);

  assert.equal(hookRun.status, 0);
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /reported compaction/i);
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /parachute/i);
  assert.doesNotMatch(hookOutput.hookSpecificOutput.additionalContext, /every 3 user turns/i);
});

test('handoff-continuity triggers on explicit handoff requests, not incidental hook chatter', () => {
  const hookRun = runHook({ prompt: 'write the handoff and stop' });
  const hookOutput = parseHookOutput(hookRun);

  assert.equal(hookRun.status, 0);
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /explicit handoff/i);
});
