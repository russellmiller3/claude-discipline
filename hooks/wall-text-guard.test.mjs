#!/usr/bin/env node
// wall-text-guard.test.mjs — locks the wall-of-text rule (Russell, 2026-07-25):
// >2 prose paragraphs OR any paragraph >3 lines => block. Bullets/tables/code
// are the allowed alternative and do NOT count toward the prose cap.
//
// 2026-07-26: the rule itself moved into hooks/lib/prose-shape.mjs — ONE implementation
// shared with explain-as-you-work.mjs, which used to carry a second copy with different
// thresholds. This hook is now the Stop entry point that delegates to the shared style
// governor. These tests scope the governor to the length rule (STYLE_VERDICT_ONLY) so a
// sibling rule's finding can't leak into an assertion; the combined multi-rule behaviour
// is proven in hooks/lib/style-verdict.test.mjs.
//
// Run: node --test wall-text-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  analyzeProseShape,
  proseShapeViolations,
  classifyLine,
  TEACHING_REQUEST_RE,
  MAX_PROSE_PARAGRAPHS,
  MAX_PARAGRAPH_LINES,
  WALL_PARAGRAPH_WORDS,
  EXPLAIN_WORD_BUDGET,
  SHIP_WORD_BUDGET,
} from './wall-text-guard.mjs';

const hookDir = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hookDir, 'wall-text-guard.mjs');
const scratchDir = mkdtempSync(join(tmpdir(), 'wall-text-guard-test-'));

// ~300 words of pure bullets: over the explaining budget, under the shipping budget, and
// structurally clean (no prose paragraph, no wall). Used to pin the budget behaviour.
const LONG_BULLETED_REPLY = Array.from({ length: 60 }, () => '- five short words right here').join('\n');
const hasKind = (violations, wantedKind) => violations.some((violation) => violation.kind === wantedKind);

let transcriptSeq = 0;
function transcriptWith(assistantReply) {
  const path = join(scratchDir, `transcript-${transcriptSeq++}.jsonl`);
  const lines = [
    JSON.stringify({ role: 'user', message: { role: 'user', content: 'go' } }),
    JSON.stringify({ role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantReply }] } }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function runHook(transcriptPath, { stopHookActive = false, styleRules = 'prose-shape' } = {}) {
  const payload = { hook_event_name: 'Stop', transcript_path: transcriptPath, cwd: scratchDir };
  if (stopHookActive) payload.stop_hook_active = true;
  const childEnv = {
    ...process.env,
    STYLE_VERDICT_ONLY: styleRules,
    STYLE_VERDICT_STATE_DIR: join(scratchDir, `verdict-${transcriptSeq++}`),
    COMPASS_STATE_FILE: join(scratchDir, `compass-${transcriptSeq}.json`),
    NARRATION_CADENCE_STATE_FILE: join(scratchDir, `narration-${transcriptSeq}.json`),
  };
  delete childEnv.STYLE_VERDICT_OK;
  delete childEnv.NARRATION_CADENCE_OK;
  const completed = spawnSync('node', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000, env: childEnv });
  return { stdout: completed.stdout, status: completed.status, stderr: completed.stderr };
}

// --- unit: classifyLine ---
test('classifyLine: bullets, tables, code fences, headings are not prose', () => {
  assert.equal(classifyLine('- bullet'), 'bullet');
  assert.equal(classifyLine('* bullet'), 'bullet');
  assert.equal(classifyLine('1. ordered'), 'bullet');
  assert.equal(classifyLine('| a | b |'), 'table');
  assert.equal(classifyLine('```py'), 'codefence');
  assert.equal(classifyLine('## Heading'), 'heading');
  assert.equal(classifyLine('> quote'), 'quote');
  assert.equal(classifyLine('plain text'), 'prose');
  assert.equal(classifyLine(''), 'blank');
});

// --- unit: analyzeProseShape ---
test('analyzeProseShape: 2 short paragraphs pass (at the cap)', () => {
  const shape = analyzeProseShape('First paragraph is short.\n\nSecond paragraph is short too.');
  assert.equal(shape.proseParagraphs, 2);
  assert.equal(shape.longParagraphCount, 0);
});

test('analyzeProseShape: 3 prose paragraphs exceed the cap', () => {
  assert.equal(analyzeProseShape('Para one.\n\nPara two.\n\nPara three.').proseParagraphs, 3);
});

test('analyzeProseShape: bullets do NOT count toward the prose cap', () => {
  const reply = 'BLUF line is the answer.\n\n- bullet one\n- bullet two\n- bullet three\n- bullet four\n- bullet five';
  assert.equal(analyzeProseShape(reply).proseParagraphs, 1); // only the BLUF line is prose
});

test('analyzeProseShape: a 4-line prose paragraph is flagged long', () => {
  assert.equal(analyzeProseShape('line one\nline two\nline three\nline four').longParagraphCount, 1);
});

test('analyzeProseShape: code fence contents are never prose and never count words', () => {
  const reply = 'Intro line.\n\n```python\nx = 1\ny = 2\nz = 3\nw = 4\nv = 5\n```\n\nOutro line.';
  const shape = analyzeProseShape(reply);
  assert.equal(shape.proseParagraphs, 2); // intro + outro, code excluded
  assert.equal(shape.longParagraphCount, 0);
  assert.equal(shape.totalWords, 4); // "Intro line." + "Outro line."
});

test('analyzeProseShape: a table is not a paragraph', () => {
  const reply = 'BLUF answer.\n\n| col a | col b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |';
  assert.equal(analyzeProseShape(reply).proseParagraphs, 1);
});

// --- unit: the ONE verdict, shared with explain-as-you-work ---
test('proseShapeViolations: a shipping turn gets the wider budget an explaining turn does not', () => {
  assert.ok(hasKind(proseShapeViolations({ reply: LONG_BULLETED_REPLY, shipped: false }), 'too long overall'));
  assert.equal(proseShapeViolations({ reply: LONG_BULLETED_REPLY, shipped: true }).length, 0);
});

test('proseShapeViolations: a depth request lifts the word budget but never the wall rule', () => {
  assert.equal(proseShapeViolations({ reply: LONG_BULLETED_REPLY, depthAsked: true }).length, 0);
  const unbrokenWall = Array.from({ length: 130 }, () => 'word').join(' ');
  assert.ok(hasKind(proseShapeViolations({ reply: unbrokenWall, depthAsked: true }), 'wall of text'));
});

test('proseShapeViolations: the style-override escape waives the rule', () => {
  const reply = 'Para one.\n\nPara two.\n\nPara three.\n\nstyle-override: Russell asked for the full table';
  assert.equal(proseShapeViolations({ reply }).length, 0);
});

// --- e2e: hook blocks / passes ---
test('e2e POSITIVE: 3-paragraph reply is BLOCKED', () => {
  const reply = 'Para one is short.\n\nPara two is short.\n\nPara three is short.';
  const { stdout, status } = runHook(transcriptWith(reply));
  assert.equal(status, 0);
  const decision = JSON.parse(stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /3 prose paragraphs/);
});

test('e2e NEGATIVE: BLUF + bullet list PASSES (the allowed alternative)', () => {
  const reply = 'Use X. It is faster.\n\n- reason one\n- reason two\n- reason three\n- reason four';
  const { stdout, status } = runHook(transcriptWith(reply));
  assert.equal(status, 0);
  assert.equal(stdout, ''); // no block
});

test('e2e NEGATIVE: 2 short paragraphs PASS', () => {
  const { stdout, status } = runHook(transcriptWith('First short paragraph.\n\nSecond short paragraph.'));
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

// REWRITTEN 2026-07-30. This asserted that stop_hook_active never blocks — which meant the
// REWRITE was never graded, the bug Russell reported as "the wall-of-text hook isn't working".
// The anti-loop rail is now the per-turn block budget in style-verdict, not stop_hook_active.
test('e2e: a still-bad REWRITE is graded, not waved through', () => {
  const reply = 'Para one.\n\nPara two.\n\nPara three.\n\nPara four.';
  const { stdout, status } = runHook(transcriptWith(reply), { stopHookActive: true });
  assert.equal(status, 0);
  assert.notEqual(stdout, '', 'a rewrite that still breaks the rule must still block');
  assert.equal(JSON.parse(stdout).decision, 'block');
});

// The "one message per draft" dedup is a SHARED-governor invariant and is covered in
// lib/style-verdict.test.mjs. It cannot be asserted here: this harness gives every runHook its
// own STYLE_VERDICT_STATE_DIR on purpose, so this suite tests its own rule in isolation.

test('e2e NEGATIVE: empty reply passes silently', () => {
  const { stdout, status } = runHook(transcriptWith(''));
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('e2e POSITIVE: a 5-line paragraph is BLOCKED on length even with only 1 paragraph', () => {
  const reply = 'line one\nline two\nline three\nline four\nline five';
  const { stdout, status } = runHook(transcriptWith(reply));
  assert.equal(status, 0);
  const decision = JSON.parse(stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /over 3 lines/);
});

test('e2e: the verdict is ONE message that lists every length problem together', () => {
  // 4 paragraphs, one of them 5 lines long: several findings, ONE message.
  const reply = [
    'Para one is short.',
    '',
    'line a\nline b\nline c\nline d\nline e',
    '',
    'Para three.',
    '',
    'Para four.',
  ].join('\n');
  const { stdout } = runHook(transcriptWith(reply));
  const decision = JSON.parse(stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /prose paragraphs/);
  assert.match(decision.reason, /over 3 lines/);
  // ONE header, not one per finding.
  assert.equal((decision.reason.match(/^STOP —/gm) || []).length, 1);
});

test('constants match the rule and are the ONLY copy', () => {
  assert.equal(MAX_PROSE_PARAGRAPHS, 2);
  assert.equal(MAX_PARAGRAPH_LINES, 3);
  assert.equal(WALL_PARAGRAPH_WORDS, 110);
  assert.equal(EXPLAIN_WORD_BUDGET, 220);
  assert.equal(SHIP_WORD_BUDGET, 400);
});

// --- Khan-format teaching room (2026-08-11, Russell: "epicycles on epicycles") ---
// CLAUDE.md had 15 contradictory voice rules; this checker only measured LENGTH, so
// every collision resolved toward terse-and-dense and Russell's verdict was "I dont
// understand this. you should know that." A mechanism question now earns room --
// but only from HIS wording, and the wall check never relaxes.
test('a Khan-format lesson passes when Russell asked a mechanism question', () => {
  const lesson = [
    'Imagine you need one book from a huge library.', '',
    'Version A: the librarian hands you a ranked sheet. You walk straight to shelf three.', '',
    'Version B: you get a floor directory, so you do the searching yourself, floor by floor.', '',
    'The surprise: the big sheet was never the expensive part.', '',
    'Mapped back: that is prompt caching versus navigation turns.',
  ].join('\n');
  assert.equal(proseShapeViolations({ reply: lesson, teachingAsked: true }).length, 0);
});

test('the SAME reply still blocks when no mechanism question was asked', () => {
  const lesson = [
    'Imagine you need one book from a huge library.', '',
    'Version A: the librarian hands you a ranked sheet. You walk straight to shelf three.', '',
    'Version B: you get a floor directory, so you do the searching yourself, floor by floor.', '',
    'The surprise: the big sheet was never the expensive part.', '',
    'Mapped back: that is prompt caching versus navigation turns.',
  ].join('\n');
  const kinds = proseShapeViolations({ reply: lesson, teachingAsked: false }).map((v) => v.kind);
  assert.ok(kinds.includes('too many prose paragraphs'));
});

test('teaching room NEVER excuses an unbroken wall of text', () => {
  const wall = Array.from({ length: 130 }, (_, index) => `word${index}`).join(' ');
  const kinds = proseShapeViolations({ reply: wall, teachingAsked: true }).map((v) => v.kind);
  assert.ok(kinds.includes('wall of text'), 'the wall check must still bite while teaching');
});

test('teaching room does not apply on a SHIPPING turn (that is a status beat)', () => {
  const slab = [
    'We did a thing and then another thing and it went fine overall.', '',
    'Second paragraph of status chatter that nobody actually asked for.', '',
    'Third paragraph continuing to ramble about the work in a status voice.', '',
    'Fourth paragraph still going with more unrequested context added on.',
  ].join('\n');
  const kinds = proseShapeViolations({ reply: slab, teachingAsked: true, shipped: true })
    .map((v) => v.kind);
  assert.ok(kinds.includes('too many prose paragraphs'));
});

test('TEACHING_REQUEST_RE reads Russell\'s question, not my own reply', () => {
  assert.ok(TEACHING_REQUEST_RE.test('why did that break?'));
  assert.ok(TEACHING_REQUEST_RE.test('I dont understand this'));
  assert.ok(TEACHING_REQUEST_RE.test('explain it plainly'));
  assert.ok(TEACHING_REQUEST_RE.test('thoughts?'));
  assert.ok(!TEACHING_REQUEST_RE.test('ship it'));
  assert.ok(!TEACHING_REQUEST_RE.test('run the tests and commit'));
});
