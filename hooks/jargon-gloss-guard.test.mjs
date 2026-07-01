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

test('catches the newly-added ML/logic terms (argmax) with no gloss', () => {
  const transcriptPath = writeTranscript({
    assistantText: 'The trained model solves zero percent because its argmax lands on the wrong answer.',
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.decision, 'block');
  assert.match(hookOutput.reason, /argmax/);
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

test('stays quiet on a SHORT coding status beat (code written, under the word gate)', () => {
  const transcriptPath = writeTranscript({
    assistantText: 'Wired BCE loss into the training loop.',
    toolUses: [{ name: 'Write', input: { file_path: 'C:/proj/train.py' } }],
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
});

test('BLOCKS a substantial explanation even when the same turn wrote code (the bug this fixes)', () => {
  const longJargonExplanation =
    'Here is where we landed after the run finished. The trained model produces marginals for ' +
    'every single variable, and we then read out the one most likely assignment it points to. ' +
    'On unseen puzzles it solves zero percent, because that argmax is confidently wrong and the ' +
    'whole system never learned to generalize beyond the training set it simply memorized here.';
  const transcriptPath = writeTranscript({
    assistantText: longJargonExplanation,
    toolUses: [{ name: 'Edit', input: { file_path: 'C:/proj/model.py' } }],
  });
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.decision, 'block');
  assert.match(hookOutput.reason, /argmax|marginals|generalize/);
});

test('passes a substantial code-turn explanation when it is written plainly (no jargon)', () => {
  const plainExplanation =
    'Here is the plain version of what happened today. The model was asked to solve brand new ' +
    'puzzles it had never seen before, and it failed every time - it could only nail puzzles it ' +
    'had already been shown, so it never truly picked up the skill. The safety checker still ' +
    'caught every wrong answer, so nothing false ever got out, which was the entire point.';
  const transcriptPath = writeTranscript({
    assistantText: plainExplanation,
    toolUses: [{ name: 'Edit', input: { file_path: 'C:/proj/model.py' } }],
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
