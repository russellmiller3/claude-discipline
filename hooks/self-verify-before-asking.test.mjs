#!/usr/bin/env node
// self-verify-before-asking.test.mjs — proves the Stop hook BLOCKS handing testing to Russell in builder mode,
// PASSES when self-tested / genuinely-can't / not-builder / overridden. Run: node self-verify-before-asking.test.mjs

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { asksRussellToVerify, turnIsBuilderMode, shouldBlock } from './self-verify-before-asking.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'self-verify-before-asking.mjs');
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ── asksRussellToVerify: BLOCK shapes (differently worded) ────────────────────
ok(asksRussellToVerify('Done. Can you test this and let me know if it works?'), 'can you test → true');
ok(asksRussellToVerify('Shipped it — please verify the tests pass.'), 'please verify → true');
ok(asksRussellToVerify("You'll need to run it to confirm the fix."), "you'll need to run → true");
ok(asksRussellToVerify('Let me know if it works on your side later.'), 'let me know if it works → true');
ok(asksRussellToVerify('Go ahead and try running it.'), 'go ahead and try → true');

// ── asksRussellToVerify: PASS shapes ─────────────────────────────────────────
ok(!asksRussellToVerify('I ran the test suite — 57 pass, 1 pre-existing fail.'), 'reporting own results → false');
ok(!asksRussellToVerify('Can you confirm the live Chrome extension renders on your machine?'), 'genuine env reason → false');
ok(!asksRussellToVerify('Needs your eyes — please check the visual layout in your browser.'), 'visual/your-eyes → false');
ok(!asksRussellToVerify('Which approach do you prefer, A or B?'), 'design question → false');
ok(!asksRussellToVerify('Can you test this? self-verify-override: needs a physical USB key'), 'override token → false');
ok(!asksRussellToVerify('I explained that saying `can you test this` is the trap.'), 'quoted trigger in backticks → false');
ok(!asksRussellToVerify(''), 'empty reply → false');

// ── builder-mode detection ───────────────────────────────────────────────────
ok(turnIsBuilderMode([{ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }]), 'an Edit makes builder mode');
ok(turnIsBuilderMode([{ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }] } }]), 'a build command makes builder mode');
ok(!turnIsBuilderMode([{ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }]), 'a Read-only turn is not builder mode');

// ── shouldBlock composition ──────────────────────────────────────────────────
ok(shouldBlock({ reply: 'Can you test this?', builderMode: true, userPaused: false }), 'builder + ask → block');
ok(!shouldBlock({ reply: 'Can you test this?', builderMode: false, userPaused: false }), 'no build this turn → no block');
ok(!shouldBlock({ reply: 'Can you test this?', builderMode: true, userPaused: true }), 'user paused → no block');

// ── end-to-end via stdin ─────────────────────────────────────────────────────
function runStop(turn) {
  const dir = mkdtempSync(join(tmpdir(), 'selfverify-'));
  const transcriptPath = join(dir, 't.jsonl');
  writeFileSync(transcriptPath, turn.map((entry) => JSON.stringify(entry)).join('\n'));
  const completed = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }), encoding: 'utf8',
  });
  return completed.stdout || '';
}
{
  const turn = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'add the feature' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'x.js' } }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Built it. Can you test it and let me know if it works?' }] } },
  ];
  ok(/decision/.test(runStop(turn)) && /block/.test(runStop(turn)), 'e2e: builder turn that asks Russell to test is blocked');
}
{
  const turn = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'add the feature' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'x.js' } }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Built it and ran the unit tests — all 12 pass.' }] } },
  ];
  ok(runStop(turn).trim() === '', 'e2e: builder turn that self-tested is allowed');
}

console.log(`self-verify-before-asking.test.mjs — ${passed} checks passed`);
