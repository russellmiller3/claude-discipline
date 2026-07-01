import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'jargon-gloss-guard.mjs');

function jsonLine(entry) {
  return JSON.stringify(entry) + '\n';
}

function writeTranscript({ priorContext = '', assistantText, toolUses = [] }) {
  const transcriptPath = join(mkdtempSync(join(tmpdir(), 'jargon-transcript-')), 'transcript.jsonl');
  const assistantContent = [{ type: 'text', text: assistantText }];
  for (const toolUse of toolUses) assistantContent.push({ type: 'tool_use', name: toolUse.name, input: toolUse.input });

  const body =
    (priorContext ? jsonLine({ message: { role: 'user', content: priorContext } }) : '') +
    jsonLine({ message: { role: 'user', content: 'explain it' } }) +
    jsonLine({ message: { role: 'assistant', content: assistantContent } });
  writeFileSync(transcriptPath, body, 'utf8');
  return transcriptPath;
}

function runHook(transcriptPath, env = {}) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('blocks when jargon appears with no gloss nearby', () => {
  const transcriptPath = writeTranscript({
    assistantText: 'The pretrained arm used BCE loss on outcome labels, which is why it failed.',
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.decision, 'block');
  assert.match(hookOutput.reason, /BCE/);
});

test('passes when the jargon term has a parenthetical gloss', () => {
  const transcriptPath = writeTranscript({
    assistantText: 'It used BCE (a way of scoring how wrong each guess was) to train the labels.',
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('passes when the jargon term has a dash-explanation', () => {
  const transcriptPath = writeTranscript({
    assistantText: 'It used fine-tuning - nudging the model\'s existing weights instead of starting from scratch.',
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('skips a term already marked known this session', () => {
  const transcriptPath = writeTranscript({
    priorContext: 'Already known — do NOT re-explain these (Russell told us): BCE.',
    assistantText: 'It used BCE loss to train the labels, nothing else changed.',
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('stays quiet on a coding turn (a code file was written)', () => {
  const transcriptPath = writeTranscript({
    assistantText: 'Wired BCE loss into the training loop.',
    toolUses: [{ name: 'Write', input: { file_path: 'C:/proj/train.py' } }],
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('override phrase passes even with ungloss ed jargon', () => {
  const transcriptPath = writeTranscript({
    assistantText: 'It used BCE loss here. jargon-gloss override: already explained earlier this turn.',
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('a reply with no jargon at all passes untouched', () => {
  const transcriptPath = writeTranscript({
    assistantText: 'The small tool solved 92% of the big puzzles, beating the simple hand-written rule.',
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});
