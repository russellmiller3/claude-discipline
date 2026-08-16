import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'handoff-continuity.mjs');

function makeProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'handoff-project-'));
  writeFileSync(join(projectRoot, 'HANDOFF.md'), '# Handoff\n', 'utf8');
  return projectRoot;
}

function addLabPriorityBoard(projectRoot) {
  const docsPath = join(projectRoot, 'docs');
  mkdirSync(docsPath, { recursive: true });
  writeFileSync(join(docsPath, 'LAB-PRIORITY-BOARD.html'), `<!doctype html>
<div class="score">0 of 4 headline goals closed</div>
<article class="lane active" id="dynamic-subagents" data-goal="dynamic-subagents">
  <div class="lane-head"><h3>Dynamic sub-agents</h3></div>
  <div class="gate now"><h3>Forced real-tool brigade</h3></div>
</article>`, 'utf8');
}

function runHook({ eventName = 'UserPromptSubmit', prompt, projectRoot = makeProject(), statePath, extraEnv = {} } = {}) {
  const checkpointStatePath = statePath || join(mkdtempSync(join(tmpdir(), 'handoff-state-')), 'state.json');
  const hookRun = spawnSync(process.execPath, [hookPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HANDOFF_CONTINUITY_STATE_PATH: checkpointStatePath,
      ...extraEnv,
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

test('handoff-continuity blocks parent stop while project status is ACTIVE', () => {
  const projectRoot = makeProject();
  writeFileSync(join(projectRoot, 'HANDOFF.md'), '# Handoff\n\n**STATUS:** ACTIVE\n\n▶ **GO:** Keep searching.\n', 'utf8');
  const hookOutput = parseHookOutput(runHook({ eventName: 'Stop', projectRoot }));
  assert.equal(hookOutput.decision, 'block');
  assert.match(hookOutput.reason, /still says ACTIVE/i);
});

test('handoff-continuity allows parent stop when project status is PAUSED', () => {
  const projectRoot = makeProject();
  writeFileSync(join(projectRoot, 'HANDOFF.md'), '# Handoff\n\n**STATUS:** PAUSED\n', 'utf8');
  const hookRun = runHook({ eventName: 'Stop', projectRoot });
  assert.equal(hookRun.stdout, '');
});

test('handoff-continuity escape allows an exceptional active stop', () => {
  const projectRoot = makeProject();
  writeFileSync(join(projectRoot, 'HANDOFF.md'), '# Handoff\n\nSTATUS: ACTIVE\n', 'utf8');
  const hookRun = runHook({ eventName: 'Stop', projectRoot, extraEnv: { HANDOFF_ACTIVE_STOP_OK: '1' } });
  assert.equal(hookRun.stdout, '');
});

function parseHookOutput(hookRun) {
  if (!hookRun.stdout.trim()) return null;
  return JSON.parse(hookRun.stdout);
}

test('SessionStart orients a Marcus-style project from the canonical lab priority board', () => {
  const projectRoot = makeProject();
  addLabPriorityBoard(projectRoot);
  const hookOutput = parseHookOutput(runHook({ eventName: 'SessionStart', projectRoot }));
  const context = hookOutput.hookSpecificOutput.additionalContext;

  assert.match(context, /LAB PRIORITY BOARD/i);
  assert.match(context, /docs[\\/]LAB-PRIORITY-BOARD\.html/i);
  assert.match(context, /0 of 4 headline goals closed/i);
  assert.match(context, /Dynamic sub-agents/i);
  assert.match(context, /Forced real-tool brigade/i);
  assert.match(context, /mark.*off.*board/i);
  assert.match(context, /HANDOFF\.md.*parachute/i);
});

test('SessionStart keeps normal handoff orientation when no lab board exists', () => {
  const hookOutput = parseHookOutput(runHook({ eventName: 'SessionStart', projectRoot: makeProject() }));
  assert.doesNotMatch(hookOutput.hookSpecificOutput.additionalContext, /LAB PRIORITY BOARD/i);
});

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

// --- SCOPE BOUNDARY (2026-08-16) --------------------------------------------------------------
// The incident: Russell typed `g`, Servo's HANDOFF.md DO NOW said "fix two misfiring guards" in
// ~/.claude, and a whole turn went into the wrong repo -- on work that was already done. Every
// scope rule agreed it was authorized, because the detour WAS the handoff's next action.

import { outOfRootDispatches, handoffActionRegion, isExemptFromScopeBoundary } from './handoff-continuity.mjs';

function runPreToolUse({ filePath, projectRoot = makeProject(), extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HANDOFF_CONTINUITY_STATE_PATH: join(mkdtempSync(join(tmpdir(), 'handoff-state-')), 'state.json'),
      ...extraEnv,
    },
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd: projectRoot,
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
    }),
    encoding: 'utf8',
  });
}

test('scope: DENIES an edit in a different repo than this session', () => {
  const projectRoot = makeProject();
  const hookRun = runPreToolUse({ filePath: join(homedir(), '.claude', 'hooks', 'some-guard.mjs'), projectRoot });
  const hookOutput = parseHookOutput(hookRun);

  assert.equal(hookRun.status, 0, 'a deny is still a clean exit');
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /ask Russell/i);
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /not authorization/i);
});

test('scope: ALLOWS an edit inside the project', () => {
  const projectRoot = makeProject();
  assert.equal(runPreToolUse({ filePath: join(projectRoot, 'src', 'thing.js'), projectRoot }).stdout, '');
});

test('scope: ALLOWS a sibling linked worktree -- same work, not another repo', () => {
  const projectRoot = makeProject();
  const sibling = `${projectRoot}-fix-some-branch`;
  assert.equal(isExemptFromScopeBoundary(join(sibling, 'src', 'a.js'), projectRoot), true);
  assert.equal(runPreToolUse({ filePath: join(sibling, 'src', 'a.js'), projectRoot }).stdout, '');
});

test('scope: ALLOWS the scratchpad, which is never project work', () => {
  const projectRoot = makeProject();
  assert.equal(runPreToolUse({ filePath: join(tmpdir(), 'claude', 'scratchpad', 'probe.mjs'), projectRoot }).stdout, '');
});

test('scope: the escape token releases it once Russell says go', () => {
  const projectRoot = makeProject();
  const hookRun = runPreToolUse({
    filePath: join(homedir(), '.claude', 'hooks', 'some-guard.mjs'),
    projectRoot,
    extraEnv: { HANDOFF_SCOPE_OK: '1' },
  });
  assert.equal(hookRun.stdout, '', 'the escape must work while the condition is still failing');
});

test('scope: FAILS OPEN on a tool call carrying no path', () => {
  assert.equal(runPreToolUse({ filePath: undefined }).stdout, '');
});

test('scope: the REAL Servo handoff DO NOW is caught as an out-of-project dispatch', () => {
  const realDoNow = [
    '# Handoff', '',
    '## DO NOW (one action)', '',
    'Fix two misfiring guards that scan surrounding TEXT instead of the actual command:',
    '`bash-json-default-guard` ... Then commit the pending `~/.claude/CLAUDE.md` edit.',
    'All git uses Git Bash -- `~/.claude/scripts/safe-merge-to-main.sh`.', '',
    '## Context', '',
    '| `Servo-plan43-latency` | branch | commit |',
  ].join('\n');
  const found = outOfRootDispatches(realDoNow, 'C:/Users/rmill/Desktop/programming/Servo');
  assert.ok(found.length >= 1, 'the ~/.claude dispatch must be flagged');
  assert.ok(found.some((p) => /\.claude/i.test(p)));
});

test('scope: the cross-repo STATUS TABLE below ## Context is not a dispatch', () => {
  const region = handoffActionRegion('# H\n\n## DO NOW\n\nDo the thing.\n\n## Context\n\nC:/Users/rmill/other-repo/x.md\n');
  assert.doesNotMatch(region, /other-repo/, 'reporting on another repo is not sending work there');
});

test('scope: an in-project handoff produces NO warning', () => {
  assert.deepEqual(outOfRootDispatches('# H\n\n## DO NOW\n\nRun the tests.\n', 'C:/proj'), []);
});
