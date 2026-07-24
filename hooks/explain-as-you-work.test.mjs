#!/usr/bin/env node
// explain-as-you-work.test.mjs — locks the "narrate like a teacher, tie everything to the big picture"
// standard, AND proves the voice silent-mode hook no longer CONTRADICTS it (Russell, 2026-06-16: "build
// a hook that forces you to explain as you go, big-picture, like a teacher").
//
// Run: node explain-as-you-work.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const EXPLAIN_HOOK = join(here, 'explain-as-you-work.mjs');
const SILENT_HOOK = 'C:/Users/rmill/Desktop/programming/claude-voice/hooks/silent-mode.mjs';

function runHook(path, payload) {
  const run = spawnSync('node', [path], { input: JSON.stringify(payload), encoding: 'utf8' });
  return (run.stdout || '') + (run.stderr || '');
}

// Build a 2-entry transcript (user prompt + assistant reply) on disk and return its path, so we can
// exercise the Stop branch (which reads transcript_path). assistantToolUses lets a test mark a turn
// as CODE work (a tool_use block) vs a pure EXPLAINING turn.
let tmpSeq = 0;
function transcriptWith(userText, assistantText, { assistantToolUses = [] } = {}) {
  const blocks = assistantToolUses.map((t) => ({ type: 'tool_use', name: t.name, input: t.input || {} }));
  blocks.push({ type: 'text', text: assistantText });
  const lines = [
    { message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    { message: { role: 'assistant', content: blocks } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const path = join(tmpdir(), `explain-test-${process.pid}-${tmpSeq++}.jsonl`);
  writeFileSync(path, lines);
  return path;
}
const stopOn = (path) => runHook(EXPLAIN_HOOK, { hook_event_name: 'Stop', transcript_path: path });
const isBlocked = (out) => /"decision"\s*:\s*"block"/.test(out);

// Fixtures: a single >110-word paragraph (a "wall"), a long but bulleted reply (>220 words, structured),
// and a short bulleted reply. Words are stripped of markdown by the hook, so plain repeats are fine.
const WALL_PARAGRAPH = ('lorem ipsum dolor sit amet '.repeat(26)).trim(); // ~130 words, one block, no breaks
const LONG_BULLETED = 'Quick rundown:\n\n' + Array.from({ length: 12 }, () => '- ' + 'detail point here words '.repeat(5)).join('\n'); // ~240 words, all bullets
const SHORT_BULLETED = 'Here it is:\n\n- first point\n- second point\n- third point'; // tiny

const failures = [];
function check(label, condition) {
  if (condition) { console.log(`  ok  ${label}`); }
  else { console.log(`FAIL  ${label}`); failures.push(label); }
}

// 1. The narrate hook, on a normal prompt, injects the big-picture / teacher standard.
const explainOut = runHook(EXPLAIN_HOOK, {
  hook_event_name: 'UserPromptSubmit',
  prompt: 'add a feature to the parser',
});
check('narrate hook mentions the BIG PICTURE', /big picture/i.test(explainOut));
check('narrate hook frames it as TEACHING', /teacher|teach/i.test(explainOut));
check('narrate hook still says narrate AS YOU GO', /as you go/i.test(explainOut));

// 2. The voice silent-mode hook must NO LONGER tell me to stay silent (that was the contradiction).
const silentOut = runHook(SILENT_HOOK, {
  hook_event_name: 'UserPromptSubmit',
  prompt: 'keep building',
});
check('voice hook no longer says "stay silent"', !/stay silent/i.test(silentOut));
check('voice hook no longer forbids narrating tool calls', !/do not narrate/i.test(silentOut));

// 3. Anti-wall / brevity gate on EXPLAINING turns (the gap that let walls of text through).
// A. A wall-of-text paragraph in a plain chat answer (no depth asked) is BLOCKED.
check('blocks a wall-of-text paragraph in explaining mode',
  isBlocked(stopOn(transcriptWith('is my servo idea novel?', WALL_PARAGRAPH))));

// G. The real bug: a LONG reply, even nicely bulleted, is blocked when depth was NOT requested.
check('blocks an over-long bulleted answer when depth was not asked',
  isBlocked(stopOn(transcriptWith('which of these are OSS?', LONG_BULLETED))));

// B. A short, structured answer PASSES.
check('passes a short structured answer',
  !isBlocked(stopOn(transcriptWith('which of these are OSS?', SHORT_BULLETED))));

// C. When Russell ASKS for depth, a long (but well-structured) answer is allowed.
check('allows a long answer when depth was explicitly requested',
  !isBlocked(stopOn(transcriptWith('walk me through an example in detail', LONG_BULLETED))));

// F. A wall paragraph is blocked EVEN when depth was asked — break it into bullets, never a blob.
check('blocks a wall paragraph even when depth was requested',
  isBlocked(stopOn(transcriptWith('explain this in detail, walk me through it', WALL_PARAGRAPH))));

// D. REGRESSION (2026-07-24, Russell: "i can t read walls of text"). A shipping turn used to skip
// the brevity gate entirely, which is how every long reply that session slipped through — each one
// had also edited a file. A wall is a wall regardless of whether code shipped.
check('blocks a wall-of-text paragraph even on a shipping turn',
  isBlocked(stopOn(transcriptWith('add the gate', WALL_PARAGRAPH, { assistantToolUses: [{ name: 'Edit' }] }))));

// D2. A shipping turn gets a WIDER budget than an explaining turn — a normal status beat passes.
check('allows a normal-length status beat on a shipping turn',
  !isBlocked(stopOn(transcriptWith('add the gate', LONG_BULLETED, { assistantToolUses: [{ name: 'Edit' }] }))));

// D3. …but that budget is not unlimited: a 400+ word shipping reply is still blocked.
const HUGE_BULLETED = 'Shipped:\n\n' + Array.from({ length: 24 }, () => '- ' + 'detail point here words '.repeat(5)).join('\n');
check('blocks an over-long shipping turn past the wider budget',
  isBlocked(stopOn(transcriptWith('add the gate', HUGE_BULLETED, { assistantToolUses: [{ name: 'Edit' }] }))));

// E. The escape hatch works.
check('honors style-override token',
  !isBlocked(stopOn(transcriptWith('explain OSS options', WALL_PARAGRAPH + '\n\nstyle-override: Russell asked for the full table'))));

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll hook-narration checks passed.');
