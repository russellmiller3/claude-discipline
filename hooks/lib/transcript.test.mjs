import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readTranscript, roleOf, contentBlocks, toolUsesOf, toolResultText,
  isHumanPrompt, currentTurnEntries, lastAssistantText,
} from './transcript.mjs';

// Helpers to build entries in both transcript shapes the helpers must tolerate.
const human = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResultUser = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
const assistantText = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const assistantTool = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });

test('roleOf tolerates message-wrapped, flat, and type-only shapes', () => {
  assert.equal(roleOf({ message: { role: 'assistant' } }), 'assistant');
  assert.equal(roleOf({ role: 'user' }), 'user');
  assert.equal(roleOf({ type: 'system' }), 'system');
  assert.equal(roleOf({}), '');
});

test('contentBlocks normalizes string content to one text block and tolerates missing', () => {
  assert.deepEqual(contentBlocks({ content: 'hi' }), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(contentBlocks({}), []);
  assert.equal(contentBlocks(assistantTool('Bash', {})).length, 1);
});

test('toolUsesOf returns only tool_use blocks', () => {
  const entry = { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Edit' }] };
  assert.equal(toolUsesOf(entry).length, 1);
  assert.equal(toolUsesOf(entry)[0].name, 'Edit');
});

test('toolResultText flattens string and array content; ignores non-results', () => {
  assert.equal(toolResultText({ type: 'tool_result', content: 'done' }), 'done');
  assert.equal(toolResultText({ type: 'tool_result', content: [{ text: 'a' }, 'b'] }), 'a\nb');
  assert.equal(toolResultText({ type: 'text', text: 'nope' }), '');
});

test('isHumanPrompt is true only for user messages with real text (not tool-result carriers)', () => {
  assert.equal(isHumanPrompt(human('hello')), true);
  assert.equal(isHumanPrompt(toolResultUser('git output')), false);
  assert.equal(isHumanPrompt(assistantText('hi')), false);
});

test('currentTurnEntries starts at the human prompt and KEEPS early-turn tool results (the bug fix)', () => {
  const entries = [
    human('first turn'),
    assistantText('done first'),
    human('do a thing'),          // <- turn start
    assistantTool('Bash', { command: 'git merge' }),
    toolResultUser('[main abc1234] merged'), // early tool_result the naive parser dropped
    assistantTool('Edit', { file_path: 'a.mjs' }),
    assistantText('finished'),
  ];
  const turn = currentTurnEntries(entries);
  assert.equal(turn[0].message.content[0].text, 'do a thing');
  // the early git-merge tool_result must be inside the captured turn
  const sawMerge = turn.some((e) => contentBlocks(e).some((b) => toolResultText(b).includes('merged')));
  assert.equal(sawMerge, true);
});

test('currentTurnEntries returns [] when there is no assistant entry', () => {
  assert.deepEqual(currentTurnEntries([human('hi')]), []);
});

test('lastAssistantText accepts a pre-parsed entries array', () => {
  const entries = [human('q'), assistantText('answer one'), human('q2'), assistantText('answer two')];
  assert.equal(lastAssistantText(entries), 'answer two');
});

test('lastAssistantText accepts a transcript PATH (unified signature)', () => {
  const path = join(tmpdir(), `transcript-test-${process.pid}.jsonl`);
  const lines = [human('q'), assistantText('from disk')].map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(path, lines);
  try {
    assert.equal(lastAssistantText(path), 'from disk');
    assert.equal(readTranscript(path).length, 2);
  } finally {
    rmSync(path, { force: true });
  }
});

test('readTranscript returns [] for a missing path and skips garbled lines', () => {
  assert.deepEqual(readTranscript('/no/such/file.jsonl'), []);
  const path = join(tmpdir(), `transcript-garbled-${process.pid}.jsonl`);
  writeFileSync(path, `${JSON.stringify(human('ok'))}\nNOT JSON\n`);
  try {
    assert.equal(readTranscript(path).length, 1);
  } finally {
    rmSync(path, { force: true });
  }
});
