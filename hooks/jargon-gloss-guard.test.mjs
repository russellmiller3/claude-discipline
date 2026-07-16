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

/**
 * A MULTI-TURN transcript: each turn is a real human prompt followed by an assistant reply
 * (optionally with tool_use blocks). The LAST turn is "the current turn" the hook judges; every
 * earlier turn is prior-session history the session-memory scan should be able to see.
 */
function writeMultiTurnTranscript(turns) {
  const transcriptPath = join(mkdtempSync(join(tmpdir(), 'jargon-transcript-')), 'transcript.jsonl');
  const body = turns
    .map((turn) => {
      const assistantContent = [{ type: 'text', text: turn.assistantText }];
      for (const toolUse of turn.toolUses || []) {
        assistantContent.push({ type: 'tool_use', name: toolUse.name, input: toolUse.input });
      }
      return (
        jsonLine({ message: { role: 'user', content: turn.userText || 'go on' } }) +
        jsonLine({ message: { role: 'assistant', content: assistantContent } })
      );
    })
    .join('');
  writeFileSync(transcriptPath, body, 'utf8');
  return transcriptPath;
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

// ── SESSION MEMORY (2026-07-15) ─────────────────────────────────────────────
// Before this fix, a term glossed several turns ago got flagged all over again the moment it was
// reused without a fresh gloss — forcing the same override every few turns for jargon Russell had
// already seen explained. These tests lock in the fix.

test('SESSION MEMORY: term glossed earlier this session is not re-flagged when reused unglossed later', () => {
  const transcriptPath = writeMultiTurnTranscript([
    {
      userText: 'why did the run fail',
      assistantText: 'It used a checkpoint (a saved snapshot of the model\'s weights partway through training) from an old run.',
    },
    {
      userText: 'and then what happened',
      assistantText: 'We loaded that checkpoint and kept going from there, no other changes.',
    },
  ]);
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '', 'a term glossed in an earlier turn should not block a later reply that reuses it');
});

test('SESSION MEMORY: a term never glossed before still blocks (existing behavior preserved)', () => {
  const transcriptPath = writeMultiTurnTranscript([
    {
      userText: 'what happened on the first run',
      assistantText: 'The first run just set up the folders, nothing technical to report yet.',
    },
    {
      userText: 'and the second run',
      assistantText: 'We loaded a checkpoint and kept going from there, no other changes.',
    },
  ]);
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.decision, 'block');
  assert.match(hookOutput.reason, /checkpoint/);
});

test('SESSION MEMORY: override granted earlier this session for a term is not re-blocked later', () => {
  const transcriptPath = writeMultiTurnTranscript([
    {
      userText: 'why did the run fail',
      assistantText: 'It used a checkpoint from an old run. jargon-gloss override: already walked through checkpoints earlier today.',
    },
    {
      userText: 'and then what happened',
      assistantText: 'We loaded that checkpoint and kept going from there, no other changes.',
    },
  ]);
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '', 'a term covered by an earlier override should stay exempt for the rest of the session');
});

test('SESSION MEMORY: Russell using the term himself in an earlier message exempts it later', () => {
  const transcriptPath = writeMultiTurnTranscript([
    {
      userText: 'just resume from the last checkpoint, I know what that is',
      assistantText: 'Got it, resuming now.',
    },
    {
      userText: 'ok what happened',
      assistantText: 'We loaded the checkpoint and kept going from there, no other changes.',
    },
  ]);
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '', 'a term Russell already used himself should not need a gloss later');
});

test('SESSION MEMORY: a genuinely NEW term introduced later in a long session still blocks', () => {
  const transcriptPath = writeMultiTurnTranscript([
    {
      userText: 'why did the run fail',
      assistantText: 'It used a checkpoint (a saved snapshot of the model\'s weights partway through training) from an old run.',
    },
    {
      userText: 'ok, and what about the second issue',
      assistantText: 'Separately, the trained model solves zero percent because its argmax lands on the wrong answer.',
    },
  ]);
  const hookRun = runHook(transcriptPath);

  assert.equal(hookRun.status, 0);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.equal(hookOutput.decision, 'block');
  assert.match(hookOutput.reason, /argmax/, 'a term never glossed before (argmax) must still block, even though an unrelated term (checkpoint) was already glossed this session');
});
