// Tests for pod-teardown-rescue-guard.mjs — a raw experiment-pod DELETE is BLOCKED
// unless results were rescued first (or an override). Red-first.
//
// The mistake (2026-07-17): twice I killed pods with a raw DELETE /v1/pods/{id},
// bypassing the rescue-gated teardown. A pod delete is IRREVERSIBLE — any completed
// race JSONL / checkpoint on it is gone forever the instant it's deleted.
//
//   node --test hooks/pod-teardown-rescue-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPodTeardown, isResultRescue, evaluate } from './pod-teardown-rescue-guard.mjs';

const bash = (command) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] });
const monitor = () => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Monitor', input: {} }] });

const DELETE_REST = 'curl -s -X DELETE "https://api.runpod.io/v1/pods/euckaq0jd9kcvt" -H "Authorization: Bearer $KEY"';
const DELETE_CLI = 'runpodctl remove pod euckaq0jd9kcvt';
const DELETE_TERM = 'python runpod_exp154.py --delete-pod --seed 7';
const FINALIZE = 'python runpod_exp154.py finalize --seed 7';
const REMOVE_LOCAL_FILE = 'rm runs/exp153/trained-race-run.jsonl';
const RESCUE = 'scp -P 22 root@1.2.3.4:/workspace/marcus-exp154/jobs/seed-7/race.jsonl runs/exp154/seed7-race.jsonl';

// ── isResultRescue: recognizes pulling results home ───────────────────────────
test('isResultRescue: scp of a race.jsonl is a rescue', () => {
  assert.equal(isResultRescue(RESCUE), true);
});
test('isResultRescue: rsync of a results dir is a rescue', () => {
  assert.equal(isResultRescue('rsync -avz root@1.2.3.4:/workspace/results/ ./local-results/'), true);
});
test('isResultRescue: a plain ls is NOT a rescue', () => {
  assert.equal(isResultRescue('ls runs/exp154/'), false);
});
test('isResultRescue: malformed input fails safe', () => {
  assert.equal(isResultRescue(''), false);
  assert.equal(isResultRescue(null), false);
});

// ── isPodTeardown: precise, no false positives ────────────────────────────────
test('isPodTeardown: a REST DELETE of a pod is a teardown', () => {
  assert.equal(isPodTeardown(DELETE_REST), true);
});
test('isPodTeardown: runpodctl remove pod is a teardown', () => {
  assert.equal(isPodTeardown(DELETE_CLI), true);
});
test('isPodTeardown: a launcher --delete-pod is a teardown', () => {
  assert.equal(isPodTeardown(DELETE_TERM), true);
});
test('isPodTeardown: finalize (rescues then deletes via the guarded path) is NOT a teardown', () => {
  assert.equal(isPodTeardown(FINALIZE), false);
});
test('isPodTeardown: rm of a local file is NOT a pod teardown', () => {
  assert.equal(isPodTeardown(REMOVE_LOCAL_FILE), false);
});
test('isPodTeardown: reading/listing is NOT a teardown', () => {
  assert.equal(isPodTeardown('cat runpod_exp154.py'), false);
  assert.equal(isPodTeardown('grep DELETE runpod_exp154.py'), false);
});
test('isPodTeardown: malformed / empty input fails safe', () => {
  assert.equal(isPodTeardown(''), false);
  assert.equal(isPodTeardown(null), false);
  assert.equal(isPodTeardown(undefined), false);
});

// ── PreToolUse: DENY a raw teardown with no prior rescue ───────────────────────
test('PreToolUse: DENY a raw pod DELETE when nothing was rescued first', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: DELETE_REST, entries: [] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
  assert.match(verdict.reason, /rescue|results|pull/i);
});
test('PreToolUse: DENY runpodctl remove with no prior rescue', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: DELETE_CLI, entries: [monitor()] });
  assert.equal(verdict.block, true);
});

// ── PreToolUse: ALLOW when results were rescued first ──────────────────────────
test('PreToolUse: ALLOW a teardown after a prior scp-of-results', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: DELETE_REST, entries: [bash(RESCUE)] });
  assert.equal(verdict.block, false);
});
test('PreToolUse: ALLOW after a realistic sequence (rescue, monitor, then delete)', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: DELETE_CLI, entries: [bash(RESCUE), monitor(), bash('ls runs/')] });
  assert.equal(verdict.block, false);
});

// ── PreToolUse: never fires on finalize / rm file / reads ──────────────────────
test('PreToolUse: does NOT fire on finalize (guarded rescue-then-delete)', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: FINALIZE, entries: [] });
  assert.equal(verdict.block, false);
});
test('PreToolUse: does NOT fire on a local rm', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: REMOVE_LOCAL_FILE, entries: [] });
  assert.equal(verdict.block, false);
});

// ── Escape hatches ────────────────────────────────────────────────────────────
test('escape: KILL_WITHOUT_RESCUE_OK token in the command lets the teardown through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: DELETE_REST + ' # KILL_WITHOUT_RESCUE_OK: OOM, no output', entries: [] });
  assert.equal(verdict.block, false);
});
test('escape: KILL_WITHOUT_RESCUE_OK token in the reply lets the teardown through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: DELETE_REST, entries: [], replyText: 'the job OOM-crashed pre-output — KILL_WITHOUT_RESCUE_OK: nothing to save' });
  assert.equal(verdict.block, false);
});
test('escape: env override lets the teardown through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: DELETE_REST, entries: [], envOk: true });
  assert.equal(verdict.block, false);
});

// ── Fail open on malformed payload / unrelated events ─────────────────────────
test('fails open on malformed/empty evaluate input', () => {
  assert.equal(evaluate({}).block, false);
  assert.equal(evaluate({ event: 'PreToolUse' }).block, false);
  assert.equal(evaluate({ event: 'PreToolUse', command: null, entries: null }).block, false);
});
test('does not fire on unrelated events (Stop / PostToolUse)', () => {
  assert.equal(evaluate({ event: 'Stop', command: DELETE_REST, entries: [] }).block, false);
  assert.equal(evaluate({ event: 'PostToolUse', command: DELETE_REST, entries: [] }).block, false);
});
