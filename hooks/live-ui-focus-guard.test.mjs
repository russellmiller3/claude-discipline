import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runsLiveUiTests, decideLiveUiFocusGate } from './live-ui-focus-guard.mjs';

const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const agent = (prompt) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt } });
const isDeny = (decision) => decision?.hookSpecificOutput?.permissionDecision === 'deny';

// ---- runsLiveUiTests (the pure detector) ----

test('detects pytest -m integration (quoted)', () => {
  assert.equal(runsLiveUiTests('py -m pytest tests -m "integration" --rootdir .'), true);
});

test('detects pytest -m integration (bare)', () => {
  assert.equal(runsLiveUiTests('python -m pytest -m integration'), true);
});

test('detects a direct *_live.py file run', () => {
  assert.equal(runsLiveUiTests('py -m pytest tests/integration/test_calculator_live.py -q'), true);
});

test('does NOT flag the safe default suite -m "not integration"', () => {
  assert.equal(runsLiveUiTests('py -m pytest tests -m "not integration" -q'), false);
});

test('does NOT flag a plain non-integration pytest run', () => {
  assert.equal(runsLiveUiTests('py -m pytest tests/test_scheduler.py -q'), false);
});

test('does NOT flag a non-pytest command that merely says integration', () => {
  assert.equal(runsLiveUiTests('git commit -m "wire integration layer"'), false);
});

test('does NOT flag an agent brief that PROHIBITS -m integration in prose (2026-07-02 false positive)', () => {
  const brief =
    'Verify green with the SPECIFIC test files: py -m pytest tests/test_app_storage.py -q --rootdir . ' +
    "Do NOT run anything under tests/integration or anything marked -m integration — that's live-UI gated and off-limits to you.";
  assert.equal(runsLiveUiTests(brief), false);
});

test('does NOT flag a brief that prohibits a *_live.py file by name', () => {
  const brief = 'Run the headless suite only. Do NOT run tests/integration/test_calculator_live.py — that steals focus.';
  assert.equal(runsLiveUiTests(brief), false);
});

test('still DENIES when the same brief also contains a real invocation later', () => {
  const brief =
    "Do NOT run anything marked -m integration normally, but for this one-off go ahead: py -m pytest -m integration -q";
  assert.equal(runsLiveUiTests(brief), true);
});

// ---- decideLiveUiFocusGate (the gate) ----

test('DENIES a Bash pytest -m integration run', () => {
  assert.equal(isDeny(decideLiveUiFocusGate(bash('py -m pytest -m integration'))), true);
});

test('DENIES an Agent brief that runs -m integration', () => {
  const decision = decideLiveUiFocusGate(agent('reproduce the flake via py -m pytest -m integration on the real Calculator'));
  assert.equal(isDeny(decision), true);
});

test('ALLOWS the safe default suite (no deny)', () => {
  assert.equal(decideLiveUiFocusGate(bash('py -m pytest tests -m "not integration"')), null);
});

test('ALLOWS with the live-ui-ok override token', () => {
  assert.equal(decideLiveUiFocusGate(bash('py -m pytest -m integration  # live-ui-ok: Russell is asleep')), null);
});

test('ALLOWS with the LIVE_UI_TEST_OK env override', () => {
  assert.equal(decideLiveUiFocusGate(bash('py -m pytest -m integration'), { LIVE_UI_TEST_OK: '1' }), null);
});

test('ignores non-guarded tools', () => {
  assert.equal(decideLiveUiFocusGate({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { command: 'pytest -m integration' } }), null);
});

test('ignores non-PreToolUse events', () => {
  assert.equal(decideLiveUiFocusGate({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'pytest -m integration' } }), null);
});
