// Tests for main-task-focus-guard.mjs — at Stop, block DRIFT from the recorded MAIN TASK
// into unauthorized side quests. Red-first.
//
// The mistake (2026-07-17, a repeat pattern): main task = get the 7B verdict, but under
// pressure I wandered into side quests Russell never asked for (editing hook tests, syncing
// the kit, monitor infra) while the science sat dead. Each felt like forward work; none was
// the MAIN TASK. This is the Getty "chasing clever past obvious" rabbit hole.
//
// Conservative by design (low false-positive): fires ONLY when a main-task is recorded, the
// turn was autonomous (a bare "g"/"continue" prompt, not Russell steering), there are >=3
// substantive non-brief edits, and ALL of them are unrelated to the main task.
//
//   node --test hooks/main-task-focus-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relatedToMainTask, extractMainTask, evaluate } from './main-task-focus-guard.mjs';

const MAIN_TASK = 'prove Marcus in-layer tool calling survives 7B — the exp154 P4 verdict';
// Edits that touch the main task's domain (share a token: exp154 / marcus).
const ON_TASK = ['marcus/scripts/run_exp154_full_seed.py', 'marcus/scripts/train_exp154_bundles.py', 'marcus/EXPERIMENTS.md'];
// Edits with zero token overlap with the main task = a detour.
const DRIFT = ['/c/Users/rmill/.claude/hooks/foo-guard.mjs', '/c/Users/rmill/.claude/hooks/foo-guard.test.mjs', '/c/Users/rmill/.claude/settings.json'];
const AUTONOMOUS = 'g';

// ── relatedToMainTask: token-overlap heuristic ────────────────────────────────
test('relatedToMainTask: a path sharing a token with the task is related', () => {
  assert.equal(relatedToMainTask('marcus/scripts/run_exp154_full_seed.py', MAIN_TASK), true);
});
test('relatedToMainTask: an unrelated hook path is NOT related', () => {
  assert.equal(relatedToMainTask('/c/Users/rmill/.claude/hooks/foo-guard.mjs', MAIN_TASK), false);
});
test('relatedToMainTask: malformed input fails safe (treated as unrelated)', () => {
  assert.equal(relatedToMainTask('', MAIN_TASK), false);
  assert.equal(relatedToMainTask('marcus/x.py', ''), false);
  assert.equal(relatedToMainTask(null, null), false);
});

// ── extractMainTask: reads a MAIN TASK: marker ────────────────────────────────
test('extractMainTask: pulls the task from a MAIN TASK: line', () => {
  assert.equal(extractMainTask('ok. MAIN TASK: get the 7B verdict\nmore text'), 'get the 7B verdict');
});
test('extractMainTask: no marker → null', () => {
  assert.equal(extractMainTask('just some chatter'), null);
  assert.equal(extractMainTask(''), null);
  assert.equal(extractMainTask(null), null);
});

// ── Stop: BLOCK autonomous drift ──────────────────────────────────────────────
test('Stop: BLOCK when main-task set + 3 unrelated edits + autonomous prompt + no auth', () => {
  const verdict = evaluate({ event: 'Stop', mainTask: MAIN_TASK, turnEditPaths: DRIFT, humanPrompt: AUTONOMOUS });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
  assert.match(verdict.reason, /MAIN TASK/i);
  assert.match(verdict.reason, /SIDEQUEST_OK/);
});

// ── Stop: ALLOW when Russell is steering the turn ─────────────────────────────
test('Stop: ALLOW when the human prompt authorized the detour (Russell steering)', () => {
  const verdict = evaluate({ event: 'Stop', mainTask: MAIN_TASK, turnEditPaths: DRIFT, humanPrompt: 'fix the capacity hook and sync the kit' });
  assert.equal(verdict.block, false);
});

// ── Stop: ALLOW when the detour is a written .md brief (sanctioned hygiene) ────
test('Stop: ALLOW when the "detour" edits are agent-prompt .md briefs', () => {
  const briefs = ['/c/Users/rmill/.claude/agent-prompts/fix-a.md', '/c/Users/rmill/.claude/agent-prompts/fix-b.md', 'marcus/HANDOFF.md'];
  const verdict = evaluate({ event: 'Stop', mainTask: MAIN_TASK, turnEditPaths: briefs, humanPrompt: AUTONOMOUS });
  assert.equal(verdict.block, false);
});

// ── Stop: escape token ────────────────────────────────────────────────────────
test('Stop: ALLOW with SIDEQUEST_OK in the reply', () => {
  const verdict = evaluate({ event: 'Stop', mainTask: MAIN_TASK, turnEditPaths: DRIFT, humanPrompt: AUTONOMOUS, replyText: 'SIDEQUEST_OK: Russell asked for the hooks first' });
  assert.equal(verdict.block, false);
});

// ── Stop: fail open when no main-task is recorded ─────────────────────────────
test('Stop: ALLOW (fail open) when no main task recorded', () => {
  const verdict = evaluate({ event: 'Stop', mainTask: '', turnEditPaths: DRIFT, humanPrompt: AUTONOMOUS });
  assert.equal(verdict.block, false);
});

// ── Stop: ALLOW when the edits are on-task ────────────────────────────────────
test('Stop: ALLOW when all edits relate to the main task', () => {
  const verdict = evaluate({ event: 'Stop', mainTask: MAIN_TASK, turnEditPaths: ON_TASK, humanPrompt: AUTONOMOUS });
  assert.equal(verdict.block, false);
});
test('Stop: ALLOW when SOME edits relate (not 100% drift)', () => {
  const mixed = [DRIFT[0], DRIFT[1], ON_TASK[0]];
  const verdict = evaluate({ event: 'Stop', mainTask: MAIN_TASK, turnEditPaths: mixed, humanPrompt: AUTONOMOUS });
  assert.equal(verdict.block, false);
});

// ── Stop: ALLOW when too few edits to call it drift ───────────────────────────
test('Stop: ALLOW when fewer than 3 substantive edits', () => {
  const verdict = evaluate({ event: 'Stop', mainTask: MAIN_TASK, turnEditPaths: DRIFT.slice(0, 2), humanPrompt: AUTONOMOUS });
  assert.equal(verdict.block, false);
});

// ── Stop: never loops ─────────────────────────────────────────────────────────
test('Stop: never blocks when stop_hook_active', () => {
  const verdict = evaluate({ event: 'Stop', mainTask: MAIN_TASK, turnEditPaths: DRIFT, humanPrompt: AUTONOMOUS, stopHookActive: true });
  assert.equal(verdict.block, false);
});

// ── Fail open on malformed / unrelated events ─────────────────────────────────
test('does not fire on non-Stop events', () => {
  assert.equal(evaluate({ event: 'PreToolUse', mainTask: MAIN_TASK, turnEditPaths: DRIFT, humanPrompt: AUTONOMOUS }).block, false);
});
test('fails open on malformed/empty input', () => {
  assert.equal(evaluate({}).block, false);
  assert.equal(evaluate({ event: 'Stop' }).block, false);
  assert.equal(evaluate({ event: 'Stop', mainTask: null, turnEditPaths: null, humanPrompt: null }).block, false);
});
