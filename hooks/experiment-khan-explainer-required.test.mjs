// Tests for experiment-khan-explainer-required.mjs — an experiment must be
// EXPLAINED at Khan level, and REVIEWED by Russell, before it runs.
// Red-first: written before the hook.
//
//   node --test hooks/experiment-khan-explainer-required.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExperimentLaunch, hasKhanExplainer, russellApprovedThisSession, evaluate,
} from './experiment-khan-explainer-required.mjs';

const bash = (command) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] });
const write = (filePath, content = '') => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: filePath, content } }] });
const userSays = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

const LAUNCH = 'py -3 scripts/runpod_exp170.py launch --seed 0 --arm deep';
const LOCAL_LAUNCH = 'py -3 scripts/exp170_depth_refresh.py --arm marcus --seed 0 --out runs/exp170/a.json';

// A Khan-level explainer: sustained metaphor + worked example + the failure mode.
const KHAN_BODY = `
# exp170 — depth refresh

## The metaphor: a digital repeater
An analog signal degrades over distance. A repeater reads it, decides "this is a
clean 1", and retransmits at full strength.

## Worked example
At layer 16 the register holds 7. Without refresh it drifts to 6.6 by layer 32.
With refresh it is rewritten to exactly 7.

## What would falsify this
If the control does NOT decay with depth, the task does not need depth and the
experiment proves nothing.
`;

// ── launch detection ─────────────────────────────────────────────────────────
test('a runpod launch is an experiment launch', () => {
  assert.equal(isExperimentLaunch(LAUNCH), true);
});
test('a local exp worker run is an experiment launch', () => {
  assert.equal(isExperimentLaunch(LOCAL_LAUNCH), true);
});
test('a smoke run is NOT gated', () => {
  assert.equal(isExperimentLaunch(LOCAL_LAUNCH + ' --smoke'), false);
});
test('pytest is not a launch', () => {
  assert.equal(isExperimentLaunch('py -3 -m pytest scripts/test_exp170.py'), false);
});
test('reading a file is not a launch', () => {
  assert.equal(isExperimentLaunch('cat scripts/exp170_depth_refresh.py'), false);
});

// ── explainer detection ──────────────────────────────────────────────────────
test('a plan with metaphor + example + falsification counts', () => {
  assert.equal(hasKhanExplainer([write('plans/170-depth-refresh.md', KHAN_BODY)], 'exp170'), true);
});
test('a plan for a DIFFERENT experiment does not count', () => {
  // Body must be about the OTHER experiment too — a doc whose text discusses
  // exp170 legitimately counts for exp170 regardless of its filename, so the
  // fixture has to differ in BOTH the name and the content.
  const otherBody = `
# exp169 — variable tracking
## The metaphor: a register file
Think of it as a CPU reading one register at a time.
## Worked example
Register 3 holds 5; add 2; it holds 7.
## What would falsify this
If the control does not decay, the task cannot separate the mechanisms.
`;
  assert.equal(hasKhanExplainer([write('plans/169-first-programs.md', otherBody)], 'exp170'), false);
});
test('a thin plan with no metaphor or falsification does NOT count', () => {
  const thin = '# exp170\nRun the thing with 3 seeds and see what happens.';
  assert.equal(hasKhanExplainer([write('plans/170-depth-refresh.md', thin)], 'exp170'), false);
});
test('an explainer html for this experiment counts', () => {
  assert.equal(hasKhanExplainer([write('docs/explainers/exp170-depth.html', KHAN_BODY)], 'exp170'), true);
});

// ── Russell approval detection ───────────────────────────────────────────────
test('an explicit go from Russell counts as approval', () => {
  assert.equal(russellApprovedThisSession([userSays('design looks right, launch it')]), true);
});
test('a bare question from Russell is NOT approval', () => {
  assert.equal(russellApprovedThisSession([userSays('what does the control do?')]), false);
});
test('no user message at all is not approval', () => {
  assert.equal(russellApprovedThisSession([]), false);
});

// ── evaluate ─────────────────────────────────────────────────────────────────
test('BLOCK a launch with no explainer at all', () => {
  const verdict = evaluate({ command: LAUNCH, entries: [] });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /khan/i);
});
test('BLOCK a launch that has an explainer but no Russell approval', () => {
  const verdict = evaluate({
    command: LAUNCH,
    entries: [write('plans/170-depth-refresh.md', KHAN_BODY)],
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /review|approv/i);
});
test('ALLOW a launch with explainer AND Russell approval', () => {
  const verdict = evaluate({
    command: LAUNCH,
    entries: [write('plans/170-depth-refresh.md', KHAN_BODY), userSays('yes, launch it')],
  });
  assert.equal(verdict.block, false);
});
test('ALLOW a non-launch command', () => {
  assert.equal(evaluate({ command: 'ls runs/', entries: [] }).block, false);
});
test('ALLOW a smoke run without the gate', () => {
  assert.equal(evaluate({ command: LOCAL_LAUNCH + ' --smoke', entries: [] }).block, false);
});
test('escape token clears the block', () => {
  const verdict = evaluate({ command: LAUNCH, entries: [], replyText: 'EXPERIMENT_KHAN_OK re-run of a reviewed design' });
  assert.equal(verdict.block, false);
});
test('env override clears the block', () => {
  assert.equal(evaluate({ command: LAUNCH, entries: [], envOk: true }).block, false);
});

// ── chat-level explanation satisfies the gate (Russell 2026-07-22: "no full
// explainer html required. just a few lines in chat") ────────────────────────
const CHAT_EXPLANATION = { role: 'assistant', content: [{ type: 'text', text:
  'exp170 — Test: a digital in-layer repeater. Ablation: no repeater. '
  + 'The task must remember complex state across 64 layers, which is what makes it hard. '
  + 'Think of it as a repeater on a phone line: a fading signal is read, decided, retransmitted clean. '
  + 'For example, x holds 3 at layer 8 and drifts to 2.87 by layer 16, where we restore it to exactly 3. '
  + 'What would falsify this: if the no-repeater control does not decay, the task is broken, not the model.' }] };

// The omission that let a nothing-experiment through: a fluent description of the
// MECHANISM that never says what is compared against what.
const CHAT_NO_ABLATION = { role: 'assistant', content: [{ type: 'text', text:
  'exp170 works like a repeater on a phone line, reading and retransmitting the signal clean. '
  + 'For example a value of 3 drifts to 2.87 by layer 16 and is snapped back to 3. '
  + 'This would be falsified if accuracy does not improve.' }] };

test('a few lines in CHAT satisfy the explainer requirement', () => {
  const verdict = evaluate({
    command: LAUNCH,
    entries: [CHAT_EXPLANATION, userSays('looks right, launch it')],
  });
  assert.equal(verdict.block, false);
});
test('chat explanation WITHOUT approval still blocks', () => {
  const verdict = evaluate({ command: LAUNCH, entries: [CHAT_EXPLANATION] });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /approv/i);
});
test('approval WITHOUT any explanation still blocks', () => {
  const verdict = evaluate({ command: LAUNCH, entries: [userSays('launch it')] });
  assert.equal(verdict.block, true);
});

// ── the omission that shipped an experiment measuring nothing ─────────────────
test('an explanation with NO ablation named still BLOCKS', () => {
  // Russell, 2026-07-22: "this experiment was set up totally wrong, didn't test
  // depth repair at all. Test: Digital in-layer repeater. Ablation: No repeater."
  // Every arm came out at chance (0.124 vs a 0.125 floor) because nothing was
  // actually being compared. A fluent mechanism description must not pass.
  const verdict = evaluate({
    command: LAUNCH,
    entries: [CHAT_NO_ABLATION, userSays('launch it')],
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /ABLATION/i);
});
test('an explanation for a DIFFERENT experiment does not license this launch', () => {
  // The original bug: explainedInChat scanned the WHOLE session, so any earlier
  // explanation satisfied any later launch.
  const otherExperiment = { role: 'assistant', content: [{ type: 'text', text:
    'exp999 — Test: a paged fetch. Ablation: no fetch. It must recall values across many pages. '
    + 'Think of it as virtual memory. For example page 7431 holds 42. '
    + 'Falsified if the no-fetch control still answers.' }] };
  const verdict = evaluate({
    command: LAUNCH,   // exp170
    entries: [otherExperiment, userSays('launch it')],
  });
  assert.equal(verdict.block, true);
});
