#!/usr/bin/env node
/**
 * Tests for plan-core-journey-guard — the plan-time gate that forces a plan to be checked
 * against the product's NORTH_STAR core journey.
 */

import assert from 'node:assert/strict';
import { decidePlanGate, isPlanPath, parseNorthStar } from './plan-core-journey-guard.mjs';

let passedCount = 0;
function test(name, testBody) {
  try { testBody(); passedCount += 1; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const planEvent = (filePath, content) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: filePath, content },
});
const ROOT = 'C:/proj';
const deps = ({ northStar = null, proofExists = false } = {}) => ({
  projectRoot: ROOT,
  readNorthStar: () => northStar,
  fileExists: () => proofExists,
});

// isPlanPath
test('isPlanPath matches plans/ dir + plan-*.md + *-plan.md, not other md', () => {
  assert.ok(isPlanPath('C:/proj/plans/plan-foo-06-29.md'));
  assert.ok(isPlanPath('plan-bar.md'));
  assert.ok(isPlanPath('docs/x-plan.md'));
  assert.equal(isPlanPath('README.md'), false);
  assert.equal(isPlanPath('src/widget.py'), false);
});

// parseNorthStar
test('parseNorthStar reads core_journey + proof', () => {
  const parsed = parseNorthStar('core_journey: talk -> it operates an app\nproof: tests/integration/test_e2e.py');
  assert.equal(parsed.coreJourney, 'talk -> it operates an app');
  assert.equal(parsed.proof, 'tests/integration/test_e2e.py');
});

// 1. No NORTH_STAR.md → first plan is BLOCKED (declare the core journey first).
test('blocks a plan when no NORTH_STAR.md exists', () => {
  const decision = decidePlanGate(planEvent('C:/proj/plans/plan-component-06-29.md', '# Plan\nbuild a widget'), deps({ northStar: null }));
  assert.ok(decision, 'expected a deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /declare the product's CORE JOURNEY/i);
});

// 2. NORTH_STAR exists, proof MISSING, plan does NOT address the core → BLOCKED.
test('blocks a component plan while the core journey is unwired', () => {
  const decision = decidePlanGate(
    planEvent('C:/proj/plans/plan-another-bridge.md', '# Plan\nAdd a second bridge adapter with tests.'),
    deps({ northStar: 'core_journey: talk -> agent operates an app\nproof: tests/test_e2e.py', proofExists: false }),
  );
  assert.ok(decision, 'expected a deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /UNWIRED/);
});

// 3. Same, but the plan ADDRESSES the core (mentions wiring the engine end-to-end) → allowed.
test('allows a plan that wires the core journey', () => {
  const decision = decidePlanGate(
    planEvent('C:/proj/plans/plan-wire-it.md', '# Plan\nPhase 1: integrate the brain with the engine end-to-end so a turn can act.'),
    deps({ northStar: 'core_journey: talk -> agent operates an app\nproof: tests/test_e2e.py', proofExists: false }),
  );
  assert.equal(decision, null);
});

// 4. Core journey already WIRED (proof exists) → plan freely.
test('allows any plan once the proof path exists', () => {
  const decision = decidePlanGate(
    planEvent('C:/proj/plans/plan-polish.md', '# Plan\nrefactor a module'),
    deps({ northStar: 'core_journey: x\nproof: tests/test_e2e.py', proofExists: true }),
  );
  assert.equal(decision, null);
});

// 5. The override bypasses (explicit defer).
test('NORTH_STAR_DEFER_OK bypasses', () => {
  const decision = decidePlanGate(
    planEvent('C:/proj/plans/plan-component.md', '# Plan\nbuild a part first. NORTH_STAR_DEFER_OK — foundation before the wire.'),
    deps({ northStar: 'core_journey: x\nproof: tests/test_e2e.py', proofExists: false }),
  );
  assert.equal(decision, null);
});

// 6. Non-plan writes are ignored.
test('ignores a non-plan file write', () => {
  assert.equal(decidePlanGate(planEvent('C:/proj/src/foo.py', 'x = 1'), deps({ northStar: null })), null);
});

// 7. A NORTH_STAR with no proof declared → nothing to check, allowed.
test('allows when north-star declares no proof path', () => {
  assert.equal(decidePlanGate(planEvent('C:/proj/plans/plan-x.md', 'plan'), deps({ northStar: 'core_journey: x' })), null);
});

console.log(`\n${passedCount} passed`);
