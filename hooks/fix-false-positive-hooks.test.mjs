// Tests for fix-false-positive-hooks — the Stop hook enforcing "a false-positiving hook gets
// FIXED this turn, not worked around". Run: node --test fix-false-positive-hooks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findWorkedAroundHooks } from './fix-false-positive-hooks.mjs';

const hooksDirectory = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hooksDirectory, 'fix-false-positive-hooks.mjs');

const line = (entry) => JSON.stringify(entry);
const blockResult = (blockMessage) => line({ message: { role: 'user', content: [{ type: 'tool_result', content: blockMessage }] } });
const assistantToolUse = (toolName, input) => line({ message: { role: 'assistant', content: [{ type: 'tool_use', name: toolName, input }] } });
const assistantText = (text) => line({ message: { role: 'assistant', content: [{ type: 'text', text }] } });

const LANGDOCS_BLOCK = 'PreToolUse:Edit hook error: [node ~/.claude/hooks/require-langdocs-read.mjs]: BLOCKED — external-API code, but no API docs were read this session.';

test('block → override → no fix ⇒ flagged', () => {
  const transcript = [
    blockResult(LANGDOCS_BLOCK),
    assistantToolUse('Edit', { file_path: 'C:/proj/page.html', new_string: '<!-- api-docs-read: static doc -->' }),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), ['require-langdocs-read']);
});

test('block → override → the HOOK was edited ⇒ clean', () => {
  const transcript = [
    blockResult(LANGDOCS_BLOCK),
    assistantToolUse('Edit', { file_path: 'C:/proj/page.html', new_string: '<!-- api-docs-read: static doc -->' }),
    assistantToolUse('Edit', { file_path: 'C:\\Users\\rmill\\.claude\\hooks\\require-langdocs-read.mjs', new_string: 'fixed regex' }),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), []);
});

test('block → override → declared true-positive in the final reply ⇒ clean', () => {
  const transcript = [
    blockResult(LANGDOCS_BLOCK),
    assistantToolUse('Edit', { file_path: 'C:/proj/client.js', new_string: '// api-docs-read: docs read earlier' }),
    assistantText('Done. true-positive: require-langdocs-read — the file genuinely integrates the API and docs were read.'),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), []);
});

test('override with NO preceding block (sanctioned flow) ⇒ clean', () => {
  const transcript = [
    assistantToolUse('Bash', { command: 'cd ~/.claude && COMMIT_MAIN_OVERRIDE=1 git commit -m "docs"' }),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), []);
});

test('signature-style block (no path in message) → override → no fix ⇒ flagged', () => {
  const transcript = [
    blockResult('Commit to main blocked.\n\nCurrent branch: main\nRule: never commit directly to main.'),
    assistantToolUse('Bash', { command: 'COMMIT_MAIN_OVERRIDE=1 git commit -m "pushing through"' }),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), ['no-commit-to-main']);
});

test('block that was OBEYED (no override afterward) ⇒ clean', () => {
  const transcript = [
    blockResult(LANGDOCS_BLOCK),
    assistantToolUse('Bash', { command: 'git switch -c fix/thing' }),
    assistantText('Rerouted properly without overriding.'),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), []);
});

test('override BEFORE the block does not count as a workaround ⇒ clean', () => {
  const transcript = [
    assistantToolUse('Edit', { file_path: 'C:/proj/page.html', new_string: '<!-- api-docs-read: proactive -->' }),
    blockResult(LANGDOCS_BLOCK),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), []);
});

test('the block message advertising its own override token does not self-trigger ⇒ clean', () => {
  // The block text itself contains "api-docs-read:" (it documents the escape hatch); only
  // ASSISTANT-authored usage after the block counts.
  const transcript = [
    blockResult(LANGDOCS_BLOCK + '\nOverride: put the literal token api-docs-read: <why> in the edit.'),
    assistantText('I will fix the hook instead of overriding.'),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), []);
});

test('WRITING a hook whose source lists override tokens does not count as using them (self-flag regression)', () => {
  // The hook flagged ITSELF on its first live stop: its own OVERRIDE_TOKENS map contains
  // 'name-by-use-override', and that Write read as "used name-by-use's override".
  const transcript = [
    blockResult('STOP. Name-by-use violation.\n  - line 34: `cwd` (cryptic acronym)'),
    assistantToolUse('Write', {
      file_path: 'C:\\Users\\rmill\\.claude\\hooks\\fix-false-positive-hooks.mjs',
      content: "const OVERRIDE_TOKENS = { 'name-by-use': ['name-by-use-override', 'NAME_BY_USE_OVERRIDE=1'] };",
    }),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), []);
});

test('a HOOKBOOK/CLAUDE.md edit documenting override tokens does not count either', () => {
  const transcript = [
    blockResult('STOP. Name-by-use violation.'),
    assistantToolUse('Edit', {
      file_path: 'C:/Users/rmill/.claude/hooks/HOOKBOOK.md',
      new_string: 'Override: `name-by-use-override` in the text, or NAME_BY_USE_OVERRIDE=1.',
    }),
    assistantToolUse('Edit', {
      file_path: 'C:/Users/rmill/.claude/CLAUDE.md',
      new_string: 'escape = NAME_BY_USE_OVERRIDE=1',
    }),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), []);
});

test('a prose MENTION of an input-level token in the reply does not count as usage', () => {
  const transcript = [
    blockResult('STOP. Name-by-use violation.'),
    assistantText('The escape hatch would be name-by-use-override, but I renamed the variables instead.'),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), []);
});

test('a reply-level override (jargon-gloss override:) in message text DOES count', () => {
  const transcript = [
    blockResult('STOP — jargon used without a gloss (Russell, 2026-07-01).'),
    assistantText('jargon-gloss override: term was already explained earlier this turn.'),
  ].join('\n');
  assert.deepEqual(findWorkedAroundHooks(transcript), ['jargon-gloss-guard']);
});

test('end-to-end spawn: workaround transcript ⇒ decision block; stop_hook_active ⇒ silent', () => {
  const workDirectory = mkdtempSync(join(tmpdir(), 'ffph-'));
  const transcriptPath = join(workDirectory, 'transcript.jsonl');
  writeFileSync(transcriptPath, [
    blockResult(LANGDOCS_BLOCK),
    assistantToolUse('Edit', { file_path: 'C:/proj/page.html', new_string: '<!-- api-docs-read: dodge -->' }),
  ].join('\n'));

  const blockedRun = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    encoding: 'utf8',
    env: { ...process.env, FIX_FALSE_POSITIVE_HOOKS_OFF: '' },
  });
  assert.equal(blockedRun.status, 0);
  const verdict = JSON.parse(blockedRun.stdout);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /require-langdocs-read/);

  const loopGuardRun = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath, stop_hook_active: true }),
    encoding: 'utf8',
  });
  assert.equal(loopGuardRun.status, 0);
  assert.equal(loopGuardRun.stdout, '');
});
