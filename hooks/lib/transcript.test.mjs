#!/usr/bin/env node
// transcript.test.mjs — direct coverage for the shared transcript helpers.
// Run: node lib/transcript.test.mjs   (exits non-zero on failure)

import assert from 'node:assert';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTranscript, roleOf, contentBlocks, textOf, toolUsesOf, toolResultText, isHumanPrompt,
  currentTurnEntries, lastAssistantText, lastUserText, lastAssistantTextOf, lastUserTextOf,
} from './transcript.mjs';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// readTranscript: missing file → [], real file → parsed entries, bad lines skipped.
ok(readTranscript('').length === 0, 'empty path → []');
ok(readTranscript('/nope/missing.jsonl').length === 0, 'missing file → []');
{
  const dir = mkdtempSync(join(tmpdir(), 'transcript-test-'));
  const transcriptPath = join(dir, 't.jsonl');
  writeFileSync(transcriptPath, '{"role":"user"}\nnot-json\n{"role":"assistant"}');
  const entries = readTranscript(transcriptPath);
  ok(entries.length === 2, 'parses good lines, skips the broken one');
}

// roleOf: both shapes + fallback.
ok(roleOf({ message: { role: 'assistant' } }) === 'assistant', 'roleOf reads message.role');
ok(roleOf({ role: 'user' }) === 'user', 'roleOf reads flat role');
ok(roleOf({ type: 'tool_result' }) === 'tool_result', 'roleOf falls back to type');
ok(roleOf({}) === '', 'roleOf empty → ""');

// contentBlocks: string → one text block, array passthrough, missing → [].
ok(contentBlocks({ content: 'hi' })[0].text === 'hi', 'string content → text block');
ok(contentBlocks({ message: { content: [{ type: 'text', text: 'x' }] } }).length === 1, 'array content passthrough');
ok(contentBlocks({}).length === 0, 'no content → []');

// textOf + toolUsesOf.
ok(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'a\nb', 'textOf joins blocks');
ok(toolUsesOf({ content: [{ type: 'tool_use', name: 'Edit' }, { type: 'text', text: 'x' }] }).length === 1, 'toolUsesOf filters tool_use');

// toolResultText + isHumanPrompt.
ok(toolResultText({ type: 'tool_result', content: 'done' }) === 'done', 'toolResultText reads string content');
ok(toolResultText({ type: 'tool_result', content: [{ text: 'a' }, 'b'] }) === 'a\nb', 'toolResultText flattens array parts');
ok(toolResultText({ type: 'text', text: 'x' }) === '', 'toolResultText ignores non-tool_result');
ok(isHumanPrompt({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), 'a text user message is a human prompt');
ok(!isHumanPrompt({ role: 'user', content: [{ type: 'tool_result', content: 'r' }] }), 'a tool-result-only user message is NOT a human prompt');
ok(!isHumanPrompt({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }), 'an assistant message is not a human prompt');

// currentTurnEntries: last user → end.
{
  const entries = [
    { role: 'user', message: { role: 'user', content: 'first' } },
    { role: 'assistant', message: { role: 'assistant', content: 'reply1' } },
    { role: 'user', message: { role: 'user', content: 'second' } },
    { role: 'assistant', message: { role: 'assistant', content: 'reply2' } },
  ];
  const turn = currentTurnEntries(entries);
  ok(turn.length === 2 && roleOf(turn[0]) === 'user', 'currentTurnEntries starts at the last user prompt');
  ok(currentTurnEntries([]).length === 0, 'no entries → []');
  ok(lastAssistantText(entries) === 'reply2', 'lastAssistantText is the newest assistant text');
  ok(lastUserText(entries) === 'second', 'lastUserText is the newest user text');
}
// currentTurnEntries anchors on the HUMAN prompt, keeping an early tool_result in-turn.
{
  const entries = [
    { role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
    { role: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'merge output' }] } },
    { role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];
  const turn = currentTurnEntries(entries);
  ok(turn.length === 3, 'turn keeps the tool-result user message (anchored on the human prompt, not the tool result)');
}

// lastAssistantText skips a trailing tool-use-only assistant message and returns the real reply.
{
  const entries = [
    { role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I fixed it' }] } },
    { role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
  ];
  ok(lastAssistantText(entries) === 'I fixed it', 'lastAssistantText skips a tool-only trailing message');
}

// Path-taking wrappers fold readTranscript + getter together.
{
  const dir = mkdtempSync(join(tmpdir(), 'transcript-wrap-'));
  const transcriptPath = join(dir, 't.jsonl');
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n'));
  ok(lastAssistantTextOf(transcriptPath) === 'done', 'lastAssistantTextOf reads reply from a path');
  ok(lastUserTextOf(transcriptPath) === 'go', 'lastUserTextOf reads user text from a path');
  ok(lastAssistantTextOf('/nope/missing.jsonl') === '', 'wrappers fail-safe on a missing file');
}

console.log(`transcript.test.mjs — ${passed} checks passed`);
