// Tests for never-idle.mjs — locks the "block Stop while a background task looks unresolved" rule,
// including the 2026-07-02 fix: a spawn_task chip resolved via dismiss_task must stop blocking.
// Run: node hooks/never-idle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'never-idle.mjs');

function blocksStop(transcriptLines) {
  const workDirectory = mkdtempSync(join(tmpdir(), 'never-idle-'));
  const transcriptPath = join(workDirectory, 'transcript.jsonl');
  writeFileSync(transcriptPath, transcriptLines.join('\n'));
  const hookRun = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    encoding: 'utf8',
  });
  return /"decision"\s*:\s*"block"/.test(hookRun.stdout || '');
}

const line = (entry) => JSON.stringify(entry);

const spawnTaskCall = (toolUseId, title) => line({
  message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'mcp__ccd_session__spawn_task', input: { title, prompt: 'x', tldr: 'x' } }] },
});
const spawnTaskResult = (toolUseId, taskId) => line({
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Noted (position 1, task_id: ${taskId}). A chip is showing for the user.` }] },
});
const dismissTaskCall = (taskId) => line({
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_dismiss1', name: 'mcp__ccd_session__dismiss_task', input: { task_id: taskId, reason: 'stale' } }] },
});
const bgAgentCall = (toolUseId, description) => line({
  message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { run_in_background: true, description } }] },
});
const taskNotification = (toolUseId) => line({
  message: { role: 'user', content: [{ type: 'text', text: `<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>` }] },
});

// --- The 2026-07-02 bug + fix ---

test('spawn_task with NO dismiss_task call still blocks (regression guard: the real rule keeps firing)', () => {
  const transcript = [spawnTaskCall('toolu_st1', 'Scope no-backcompat.mjs'), spawnTaskResult('toolu_st1', 'task_aaa111')];
  assert.equal(blocksStop(transcript), true);
});

test('spawn_task WITH a matching dismiss_task call does NOT block (the fix)', () => {
  const transcript = [
    spawnTaskCall('toolu_st1', 'Scope no-backcompat.mjs'),
    spawnTaskResult('toolu_st1', 'task_aaa111'),
    dismissTaskCall('task_aaa111'),
  ];
  assert.equal(blocksStop(transcript), false);
});

test('spawn_task with a dismiss_task call for a DIFFERENT task_id still blocks (no over-matching)', () => {
  const transcript = [
    spawnTaskCall('toolu_st1', 'Scope no-backcompat.mjs'),
    spawnTaskResult('toolu_st1', 'task_aaa111'),
    dismissTaskCall('task_zzz999'),
  ];
  assert.equal(blocksStop(transcript), true);
});

test('two spawn_task chips: dismissing only one leaves the other blocking', () => {
  const transcript = [
    spawnTaskCall('toolu_st1', 'First chip'),
    spawnTaskResult('toolu_st1', 'task_aaa111'),
    spawnTaskCall('toolu_st2', 'Second chip'),
    spawnTaskResult('toolu_st2', 'task_bbb222'),
    dismissTaskCall('task_aaa111'),
  ];
  assert.equal(blocksStop(transcript), true);
});

// --- Regression: existing Agent / background-bash completion detection unaffected ---

test('a background Agent with a completed task-notification does NOT block', () => {
  const transcript = [bgAgentCall('toolu_ag1', 'Do the thing'), taskNotification('toolu_ag1')];
  assert.equal(blocksStop(transcript), false);
});

test('a background Agent with NO completion notification still blocks', () => {
  const transcript = [bgAgentCall('toolu_ag1', 'Do the thing')];
  assert.equal(blocksStop(transcript), true);
});

test('no spawns at all never blocks', () => {
  assert.equal(blocksStop([line({ message: { role: 'user', content: 'hello' } })]), false);
});
