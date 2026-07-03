#!/usr/bin/env node
// compass-line-guard.test.mjs — locks the "every working-turn reply opens with a plain-English
// compass line" rule (Russell, 2026-07-03). Advisory versions of this got compressed out under
// context pressure, so this hook BLOCKS; these tests lock the block/pass boundary.
//
// Run: node --test compass-line-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { COMPASS_MARKER, turnDidWork, finalReplyText, firstNonBlankLine, hasCompassOpening } from './compass-line-guard.mjs';

const hookDir = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hookDir, 'compass-line-guard.mjs');
const scratchDir = mkdtempSync(join(tmpdir(), 'compass-line-guard-test-'));

let transcriptSeq = 0;
function transcriptWith(userMessage, assistantReply, { toolUses = [] } = {}) {
  const blocks = toolUses.map((toolUse) => ({ type: 'tool_use', name: toolUse.name, input: toolUse.input || {} }));
  blocks.push({ type: 'text', text: assistantReply });
  const transcriptLines = [
    { message: { role: 'user', content: [{ type: 'text', text: userMessage }] } },
    { message: { role: 'assistant', content: blocks } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const transcriptPath = join(scratchDir, `transcript-${process.pid}-${transcriptSeq++}.jsonl`);
  writeFileSync(transcriptPath, transcriptLines);
  return transcriptPath;
}

function combinedOutputOf(spawnResult) {
  return (spawnResult.stdout || '') + (spawnResult.stderr || '');
}

function runHookWithRawInput(rawInput) {
  return combinedOutputOf(spawnSync('node', [HOOK_PATH], { input: rawInput, encoding: 'utf8' }));
}

function runHook(payload) {
  return runHookWithRawInput(JSON.stringify(payload));
}

function stopOn(transcriptPath, extraPayloadFields = {}) {
  return runHook({ hook_event_name: 'Stop', transcript_path: transcriptPath, ...extraPayloadFields });
}

const isBlocked = (hookOutput) => /"decision"\s*:\s*"block"/.test(hookOutput);

// --- unit-level checks on the exported primitives -------------------------------------------

test('turnDidWork: true when the turn called a mutating tool (Edit)', () => {
  const turnEntries = [
    { message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }, { type: 'text', text: 'done' }] } },
  ];
  assert.equal(turnDidWork(turnEntries), true);
});

test('turnDidWork: false when the turn only Read/Grep/Glob/ToolSearch', () => {
  const turnEntries = [
    { message: { role: 'user', content: [{ type: 'text', text: 'where is X defined?' }] } },
    { message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Grep', input: {} },
      { type: 'tool_use', name: 'Read', input: {} },
      { type: 'tool_use', name: 'Glob', input: {} },
      { type: 'tool_use', name: 'ToolSearch', input: {} },
      { type: 'text', text: 'X is defined in foo.js' },
    ] } },
  ];
  assert.equal(turnDidWork(turnEntries), false);
});

test('firstNonBlankLine: skips leading blank lines', () => {
  assert.equal(firstNonBlankLine('\n\n  \nhello world\nmore text'), 'hello world');
});

test('hasCompassOpening: true for a first line starting with the compass marker', () => {
  assert.equal(hasCompassOpening(`${COMPASS_MARKER} **Mission:** ship the thing · this step: wrote the file · why: unblocks the next step`), true);
});

test('hasCompassOpening: true for the /bigpicture TL;DR header format', () => {
  assert.equal(hasCompassOpening('## 🚀 TL;DR\n\nWe shipped the thing.'), true);
});

test('hasCompassOpening: false for a plain reply with no compass line', () => {
  assert.equal(hasCompassOpening('I edited the file to fix the bug.'), false);
});

test('finalReplyText: returns the last assistant text block, skipping tool-only entries', () => {
  const turnEntries = [
    { message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'first thought' }, { type: 'tool_use', name: 'Edit', input: {} }] } },
    { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'final reply text' }] } },
  ];
  assert.equal(finalReplyText(turnEntries), 'final reply text');
});

// --- end-to-end Stop-hook behavior via the 5 required cases ----------------------------------

test('working turn WITHOUT a compass line -> BLOCKS', () => {
  const transcriptPath = transcriptWith(
    'fix the login bug',
    'I edited auth.js to fix the null check.',
    { toolUses: [{ name: 'Edit' }] }
  );
  const hookOutput = stopOn(transcriptPath);
  assert.equal(isBlocked(hookOutput), true);
  assert.match(hookOutput, /compass/i);
});

test('working turn WITH a compass-marker first line -> PASSES', () => {
  const transcriptPath = transcriptWith(
    'fix the login bug',
    `${COMPASS_MARKER} **Mission:** get login working again · this step: fixed the null check · why: unblocks users signing in\n\nDone — auth.js now handles the missing token case.`,
    { toolUses: [{ name: 'Edit' }] }
  );
  assert.equal(isBlocked(stopOn(transcriptPath)), false);
});

test('chat turn (no working tools) WITHOUT a compass line -> PASSES (exempt)', () => {
  const transcriptPath = transcriptWith(
    'what does this function do?',
    'It parses the config file and returns a settings object.',
    { toolUses: [{ name: 'Read' }, { name: 'Grep' }] }
  );
  assert.equal(isBlocked(stopOn(transcriptPath)), false);
});

test('/bigpicture "## TL;DR" first line -> PASSES', () => {
  const transcriptPath = transcriptWith(
    '/bigpicture',
    '## 🚀 TL;DR\n\nWe shipped the new compass-line hook and it works.',
    { toolUses: [{ name: 'Write' }] }
  );
  assert.equal(isBlocked(stopOn(transcriptPath)), false);
});

test('malformed transcript (missing file) -> silent PASS', () => {
  const hookOutput = stopOn('C:/definitely/does/not/exist/transcript.jsonl');
  assert.equal(isBlocked(hookOutput), false);
  assert.equal(hookOutput.trim(), '');
});

test('malformed transcript (garbage JSON payload) -> silent PASS', () => {
  const hookOutput = runHookWithRawInput('not json at all {{{');
  assert.equal(hookOutput.trim(), '');
});

test('non-Stop event -> silent PASS (no-op)', () => {
  const transcriptPath = transcriptWith('go', 'no compass line here', { toolUses: [{ name: 'Edit' }] });
  const hookOutput = runHook({ hook_event_name: 'UserPromptSubmit', transcript_path: transcriptPath });
  assert.equal(hookOutput.trim(), '');
});

// --- anti-loop rail: stop_hook_active means we already blocked once this turn ----------------

test('re-entrant pass (stop_hook_active=true) without a compass line -> ALLOWS (never blocks twice)', () => {
  const transcriptPath = transcriptWith(
    'fix the login bug',
    'Still no compass line on this reply.',
    { toolUses: [{ name: 'Edit' }] }
  );
  const hookOutput = stopOn(transcriptPath, { stop_hook_active: true });
  assert.equal(isBlocked(hookOutput), false);
});

test('first pass (stop_hook_active=false) still blocks a missing compass line', () => {
  const transcriptPath = transcriptWith(
    'fix the login bug',
    'Still no compass line on this reply.',
    { toolUses: [{ name: 'Edit' }] }
  );
  const hookOutput = stopOn(transcriptPath, { stop_hook_active: false });
  assert.equal(isBlocked(hookOutput), true);
});
