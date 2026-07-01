#!/usr/bin/env node
// getty-no-repeat-mistakes.test.mjs — locks the J. Paul Getty guard: "make any mistake once, never
// twice." The DIY-RLVR reward loop: when Russell CORRECTS me, force the learn-or-build-a-hook cycle
// before the turn can end. A REPEAT correction ("again", "you keep", "same mistake") escalates from
// "log a learning" to "you must build/strengthen a HOOK this turn" — a learning already failed once.
//
// Dual-event hook:
//   • UserPromptSubmit — detect a correction in Russell's message → drop a pending-marker + inject the
//     Getty checklist (grep learnings.md → repeat? → build a hook).
//   • Stop — if a marker is pending and this turn didn't satisfy it (added a learning, or for a repeat
//     built a hook), BLOCK. Override: `getty-override:`.
//
// Run: node getty-no-repeat-mistakes.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'getty-no-repeat-mistakes.mjs');

let seq = 0;
const nextMarker = () => join(tmpdir(), `getty-marker-${process.pid}-${seq++}.json`);

// Run the hook for either event. markerPath is injected via env so tests never touch real state.
function run(payload, markerPath) {
  const childEnv = { ...process.env, GETTY_MARKER_PATH: markerPath };
  const proc = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: childEnv });
  return (proc.stdout || '') + (proc.stderr || '');
}
const ups = (prompt, markerPath) => run({ hook_event_name: 'UserPromptSubmit', prompt }, markerPath);

// Build a transcript: a user msg + one assistant entry whose tool_use blocks "edit" the given paths,
// plus the final reply text. Lets a Stop test say "this turn edited learnings.md / a hook / nothing".
function transcript(replyText, editedPaths = []) {
  const blocks = editedPaths.map((p) => ({ type: 'tool_use', name: 'Edit', input: { file_path: p } }));
  blocks.push({ type: 'text', text: replyText });
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'you keep doing that' }] } },
    { type: 'assistant', message: { role: 'assistant', content: blocks } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const path = join(tmpdir(), `getty-tx-${process.pid}-${seq++}.jsonl`);
  writeFileSync(path, lines);
  return path;
}
function stopRun(replyText, editedPaths, markerPath) {
  const transcriptPath = transcript(replyText, editedPaths);
  return run({ hook_event_name: 'Stop', transcript_path: transcriptPath }, markerPath);
}
const isBlocked = (hookOutput) => /"decision"\s*:\s*"block"/.test(hookOutput);
const writeMarker = (markerPath, repeat) => writeFileSync(markerPath, JSON.stringify({ repeat, correction: 'x', ts: 1 }));

const failures = [];
function check(label, condition) {
  if (condition) { console.log(`  ok  ${label}`); }
  else { console.log(`FAIL  ${label}`); failures.push(label); }
}

// --- UserPromptSubmit: correction detection (robust — many phrasings) ---
for (const correction of [
  'you should have checked that first',
  "why didn't you run the tests",
  'you forgot to update the docs',
  "that's not what I asked for",
]) {
  const marker = nextMarker();
  const hookOutput = ups(correction, marker);
  check(`detects correction: "${correction.slice(0, 28)}…"`, /getty/i.test(hookOutput) && existsSync(marker));
  if (existsSync(marker)) rmSync(marker);
}

// A REPEAT correction sets repeat=true in the marker.
{
  const marker = nextMarker();
  ups('you keep making the same mistake — again', marker);
  const repeatFlagged = existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).repeat === true;
  check('repeat correction flags repeat=true', repeatFlagged);
  if (existsSync(marker)) rmSync(marker);
}

// A normal request is NOT a correction — no marker, no injection.
{
  const marker = nextMarker();
  const hookOutput = ups('add a new feature to the parser', marker);
  check('normal request does not trigger Getty', !/getty/i.test(hookOutput) && !existsSync(marker));
}

// SYSTEM-INJECTED content (background-agent completion, harness reminder) lands in the user slot but is
// NOT Russell correcting me — even when it quotes correction-like wording. It must NOT arm the gate.
// (2026-06-19: a <task-notification> with an agent's design doc falsely armed Getty twice.)
for (const injected of [
  '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<result>Done. You should have nested-body repair deferred; you skipped the loop case again on purpose.</result>\n</task-notification>',
  '<system-reminder>\nyou forgot to run the tests — this is a reminder, not Russell.\n</system-reminder>',
  'Summary: Agent "Design loop" came to rest. why didn\'t you build the hook',
  // 2026-07-01: the harness re-presenting THIS HOOK'S OWN prior denial text (which itself contains
  // "twice") back as the next prompt — a self-triggering loop, not Russell correcting anything.
  'Stop hook feedback:\nSTOP-BLOCKED — Getty rule: REPEAT mistake → ASK Russell before building a hook (J. Paul Getty: never make the same one twice).',
]) {
  const marker = nextMarker();
  const hookOutput = ups(injected, marker);
  check(`system-injected does NOT arm Getty: "${injected.slice(0, 22)}…"`, !/getty/i.test(hookOutput) && !existsSync(marker));
  if (existsSync(marker)) rmSync(marker);
}

// But a GENUINE Russell correction using the SAME words still fires (the skip is precise, not broad).
{
  const marker = nextMarker();
  const hookOutput = ups('you forgot to run the tests again', marker);
  check('real correction with same words still fires', /getty/i.test(hookOutput) && existsSync(marker));
  if (existsSync(marker)) rmSync(marker);
}

// --- Stop: enforcement ---
// No marker → never blocks.
check('no pending marker → allowed', !isBlocked(stopRun('all done', [], nextMarker())));

// First-time (repeat=false): a learning satisfies it.
{
  const marker = nextMarker(); writeMarker(marker, false);
  check('first-time + learning added → allowed', !isBlocked(stopRun('logged it', ['C:/Users/rmill/.claude/learnings.md'], marker)));
  check('first-time marker cleared after satisfy', !existsSync(marker));
}
// First-time: doing nothing → blocked.
{
  const marker = nextMarker(); writeMarker(marker, false);
  check('first-time + nothing done → blocked', isBlocked(stopRun('noted, moving on', [], marker)));
}
// Repeat (repeat=true): a learning ALONE is not enough — must build a hook.
{
  const marker = nextMarker(); writeMarker(marker, true);
  check('repeat + only a learning → blocked', isBlocked(stopRun('added a learning', ['C:/Users/rmill/.claude/learnings.md'], marker)));
}
// Repeat: building/strengthening a hook satisfies it.
{
  const marker = nextMarker(); writeMarker(marker, true);
  check('repeat + a hook built → allowed', !isBlocked(stopRun('built a hook', ['C:/Users/rmill/.claude/hooks/new-guard.mjs'], marker)));
}
// Override clears any pending marker.
{
  const marker = nextMarker(); writeMarker(marker, true);
  check('getty-override token → allowed', !isBlocked(stopRun('getty-override: this was a one-off typo, no rule needed', [], marker)));
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll getty-no-repeat-mistakes checks passed.');
