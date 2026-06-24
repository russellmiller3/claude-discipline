#!/usr/bin/env node
// ross-perot-guard.test.mjs — locks the Ross Perot guard, including the deferred-fix check:
// when a turn ALREADY shipped code edits (builder mode) and the reply DEFERS an obvious fix
// ("I'd make that fix next") instead of just doing it, BLOCK. Must NOT fire on pure strategy
// advice in a discussion turn (no edits), and must keep the existing asking-permission and
// alternatives-without-recommendation blocks working.
//
// Run: node ross-perot-guard.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'ross-perot-guard.mjs');

// Build a transcript (user prompt + one assistant entry). withEdit adds an Edit tool_use block so the
// turn counts as "builder mode". Returns the path. The hook reads transcript_path from its payload.
let seq = 0;
function transcript(userText, assistantText, { withEdit = false } = {}) {
  const assistantBlocks = [];
  if (withEdit) assistantBlocks.push({ type: 'tool_use', name: 'Edit', input: {} });
  assistantBlocks.push({ type: 'text', text: assistantText });
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    { type: 'assistant', message: { role: 'assistant', content: assistantBlocks } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const path = join(tmpdir(), `ross-perot-test-${process.pid}-${seq++}.jsonl`);
  writeFileSync(path, lines);
  return path;
}
function isBlocked(path) {
  const run = spawnSync('node', [HOOK], { input: JSON.stringify({ transcript_path: path }), encoding: 'utf8' });
  return /"decision"\s*:\s*"block"/.test(run.stdout || '');
}

const failures = [];
function check(label, condition) {
  if (condition) { console.log(`  ok  ${label}`); }
  else { console.log(`FAIL  ${label}`); failures.push(label); }
}

// A builder turn that DEFERS an obvious fix is blocked.
check('blocks deferring an obvious fix in a builder turn',
  isBlocked(transcript('fix the guard', 'Done. The fix I’d make next: exempt test files in the other guard.', { withEdit: true })));
check('blocks "I’d make that fix next" in a builder turn',
  isBlocked(transcript('fix it', 'Shipped. I’d make that fix next so it stops tripping.', { withEdit: true })));

// Builder turn where the fix was actually DONE (no deferral language) passes.
check('passes a builder turn that just did the work',
  !isBlocked(transcript('fix it', 'Done — fixed and proven green. Both tests pass.', { withEdit: true })));

// Discussion turn (no edits) with future-tense advice is NOT a Ross Perot violation — it’s strategy.
check('does not fire on strategy advice in a discussion turn',
  !isBlocked(transcript('is my idea good?', 'I’d add a hybrid resolver next — it dominates the text-only version.')));

// Escape hatches: explicit override, and a genuine scope reason.
check('honors ross-perot-override token',
  !isBlocked(transcript('fix it', 'Done. I’d make that fix next. ross-perot-override: it needs a schema migration first.', { withEdit: true })));
check('allows a deferral with an explicit scope reason',
  !isBlocked(transcript('fix it', 'Done. I’d do the broader refactor next, but it’s out of scope for this change.', { withEdit: true })));

// "offering choices / deferring the obvious next step to the user" forms. Each must BLOCK. The bug it
// guards: "your call:" / "your pick:" being read as a recommendation, and "which do you want" having no coverage.
check('blocks "Your call: I build X now, or we wrap here."',
  isBlocked(transcript('keep going', 'Your call: I build X now, or we wrap here.')));
check('blocks "Two ways forward, your pick: ... or ..."',
  isBlocked(transcript('keep going', 'Two ways forward, your pick: refactor the parser, or patch the call site.')));
check('blocks "or we wrap here and finish next session"',
  isBlocked(transcript('keep going', 'I can wire it up now, or we wrap here and finish next session.')));
check('blocks "I can X now, or Y — which do you want?"',
  isBlocked(transcript('keep going', 'I can refactor now, or add the test first — which do you want?')));
check('blocks "I can do X now, or Y — which do you want?"',
  isBlocked(transcript('keep going', 'I can do X now, or Y — which do you want?')));
check('blocks a menu of next steps with "where do you want to start?"',
  isBlocked(transcript('keep going', 'Next steps: 1) add caching 2) write docs 3) ship it. Where do you want to start?')));

// CONTROL: a genuinely-needs-the-user question (real money / irreversible) still PASSES — the
// existing legit carve-out must survive the widening.
check('passes a genuine irreversible call that truly needs the user',
  !isBlocked(transcript('clean up', 'This deletes the prod database and is irreversible — I need your explicit go-ahead before I run it.')));

// ANNOUNCE-NEXT class — naming a concrete next dev action instead of doing it. The exact crack that slips:
// a bare gerund close ("Doing X next") with no commit word. Must BLOCK broadly.
check('blocks "Doing the warm-session wiring next."',
  isBlocked(transcript('keep going', 'Native voice shipped, 1494 green. Doing the warm-session wiring next.', { withEdit: true })));
check('blocks "next: wire the audio playback"',
  isBlocked(transcript('keep going', 'Committed. next: wire the audio playback into handleSend.', { withEdit: true })));
check('blocks "the next step is to build the controller"',
  isBlocked(transcript('keep going', 'Phase D done. The next step is to build the controller.', { withEdit: true })));
check('blocks "next I\'ll add the warm session"',
  isBlocked(transcript('keep going', 'Green and committed. Next I’ll add the warm session.', { withEdit: true })));
check('blocks "I’ll wire the player next session"',
  isBlocked(transcript('keep going', 'Done for now. I’ll wire the player next session.', { withEdit: true })));
// CONTROLS for the announce-next class: scope reason, override, genuine hardware-gate, and plain done all PASS.
check('announce-next allows an explicit scope reason',
  !isBlocked(transcript('keep going', 'Doing the migration next, but that’s out of scope for this change.', { withEdit: true })));
check('announce-next honors the override token',
  !isBlocked(transcript('keep going', 'Doing the warm session next. ross-perot-override: it needs a real-device voice test first.', { withEdit: true })));
check('announce-next does NOT fire on a plain done with no next action',
  !isBlocked(transcript('keep going', 'Done — native voice ships and all tests are green.', { withEdit: true })));
check('announce-next does NOT fire on a non-dev next (summary, not a build action)',
  !isBlocked(transcript('what changed?', 'Here’s the summary of what shipped. That’s everything for this change.')));

// REGRESSION: existing checks still fire.
check('still blocks asking-permission closers',
  isBlocked(transcript('do the thing', 'Looks good. Want me to wire it up?')));
check('still blocks alternatives without a recommendation',
  isBlocked(transcript('which approach?', 'Two options: A or B. Your call.')));

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll ross-perot-guard checks passed.');
