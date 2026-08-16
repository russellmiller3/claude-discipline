/**
 * Regression: a sibling guard's REFUSAL must never count as the model thrashing.
 *
 * THE INCIDENT (2026-08-16, blocking live sessions). A refused tool call comes back with
 * `isError: true`, exactly like a call that ran and failed. Three EFFICIENCY counters treated
 * the two identically, so every refusal inflated the very number that decides the next refusal:
 *
 *   - `sameAction.length >= EFFICIENCY_STUCK_RETRY_LIMIT` — a call a sibling guard refused four
 *     times read as a "stuck retry loop", even though nothing had run even once.
 *   - `erroredSameRegion >= 2` — two refusals of one passage read as "this same passage already
 *     failed to edit twice; fix the blocker instead of retrying the same change", when the
 *     blocker WAS the other guard.
 *   - `edits.length >= EFFICIENCY_SAME_FILE_EDIT_LIMIT` — 26 refused edit attempts to one file
 *     read as thrashing and demanded the work be landed mid-change.
 *
 * The result is a self-manufacturing lockout: one false positive from any guard breeds the next
 * refusal, which breeds the next. The file already encodes the correct principle twice — once for
 * the repair lease, once for `successfulOrientation`, both citing "a denial from this or any
 * sibling guard proves nothing about what the model was doing". These three counters were simply
 * the places it had not been applied.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { detectEfficiencyKernel } from './getty-ceremony-guard.mjs';

const REQUEST = 'fix the repair lease in getty-ceremony-guard';

// What a sibling guard's refusal actually looks like coming back from the arbiter.
function refusal(name, input) {
  return {
    name,
    input,
    isError: true,
    resultText:
      'PreToolUse:Edit hook error: TOOL CALL REFUSED — 1 guard objected.\n\n'
      + '1. [require-learnings-ack]\nSTOP-BLOCKED — read the surfaced learning before editing code.',
  };
}

// A real failure: the command ran and the tool itself reported an error.
function realFailure(name, input) {
  return { name, input, isError: true, resultText: 'exit code: 1\nnpm ERR! the task did not finish' };
}

const EDIT = { file_path: 'hooks/getty-ceremony-guard.mjs', old_string: 'a', new_string: 'b' };

test('four sibling refusals of one call are not a stuck retry loop', () => {
  const verdict = detectEfficiencyKernel({
    userText: REQUEST,
    toolName: 'Edit',
    toolInput: EDIT,
    completedTools: [refusal('Edit', EDIT), refusal('Edit', EDIT), refusal('Edit', EDIT), refusal('Edit', EDIT)],
  });

  assert.equal(verdict.block, false, 'nothing ran, so nothing was retried');
});

test('two refusals of one passage are not two failed edits', () => {
  const verdict = detectEfficiencyKernel({
    userText: REQUEST,
    toolName: 'Edit',
    toolInput: EDIT,
    completedTools: [refusal('Edit', EDIT), refusal('Edit', EDIT)],
  });

  assert.equal(verdict.block, false, 'the blocker was another guard, not the change');
});

test('a long run of refused edits to one file is not thrashing', () => {
  const refused = Array.from({ length: 20 }, (unused, index) => refusal('Edit', {
    file_path: 'hooks/getty-ceremony-guard.mjs',
    old_string: `old-${index}`,
    new_string: `new-${index}`,
  }));

  const verdict = detectEfficiencyKernel({
    userText: REQUEST,
    toolName: 'Edit',
    toolInput: { file_path: 'hooks/getty-ceremony-guard.mjs', old_string: 'final', new_string: 'change' },
    completedTools: refused,
  });

  assert.equal(verdict.block, false, 'refused attempts never touched the file');
});

// The anti-disarm rails: real thrashing must still be caught, or this fix is just an off switch.
test('genuinely repeated SUCCESSFUL edits to one region are still caught', () => {
  const succeeded = Array.from({ length: 4 }, () => ({ name: 'Edit', input: EDIT }));

  const verdict = detectEfficiencyKernel({
    userText: REQUEST,
    toolName: 'Edit',
    toolInput: EDIT,
    completedTools: succeeded,
  });

  assert.equal(verdict.block, true, 'reworking one passage over and over is still bikeshedding');
  assert.match(verdict.reason, /EFFICIENCY/);
});

test('a real execution failure repeated to the stuck limit is still caught', () => {
  const failed = Array.from({ length: 4 }, () => realFailure('Bash', { command: 'npm run assemble' }));

  const verdict = detectEfficiencyKernel({
    userText: REQUEST,
    toolName: 'Bash',
    toolInput: { command: 'npm run assemble' },
    completedTools: failed,
  });

  assert.equal(verdict.block, true, 'a command that really ran and really failed four times is a loop');
});
