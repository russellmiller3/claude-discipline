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
const deps = ({ northStar = null, proofExists = false, existingPlan = '' } = {}) => ({
  projectRoot: ROOT,
  readDeclaration: () => northStar,
  fileExists: () => proofExists,
  readFile: () => existingPlan,
});

const editEvent = (filePath, newString) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: 'x', new_string: newString },
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

// 8. REGRESSION: a section Edit whose fragment doesn't mention the core journey is ALLOWED
//    when the existing plan file (read whole) DOES address it. This is the incremental-
//    authoring bug: the write-plan skill mandates section-by-section Edits.
test('allows a section Edit when the whole existing plan addresses the core', () => {
  const decision = decidePlanGate(
    editEvent('C:/proj/plans/plan-wire.md', '## Edge cases\n- InMemoryStorage named differently'),
    deps({
      northStar: 'core_journey: x\nproof: tests/test_e2e.py',
      proofExists: false,
      existingPlan: '# Plan\nPhase 1: wire the brain to the engine end-to-end, creating tests/test_e2e.py.',
    }),
  );
  assert.equal(decision, null);
});

// 9. The inverse still BLOCKS: neither the fragment nor the existing plan addresses the core.
test('still blocks a section Edit when neither fragment nor existing plan addresses the core', () => {
  const decision = decidePlanGate(
    editEvent('C:/proj/plans/plan-component.md', '## Edge cases\n- handle empty input'),
    deps({
      northStar: 'core_journey: x\nproof: tests/test_e2e.py',
      proofExists: false,
      existingPlan: '# Plan\nAdd a third bridge adapter with full TDD coverage.',
    }),
  );
  assert.ok(decision, 'expected a deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /UNWIRED/);
});

// 10. DEFER override works across the whole plan too (in the existing file, not this fragment).
test('NORTH_STAR_DEFER_OK in the existing plan bypasses a later section Edit', () => {
  const decision = decidePlanGate(
    editEvent('C:/proj/plans/plan-component.md', '## More detail'),
    deps({
      northStar: 'core_journey: x\nproof: tests/test_e2e.py',
      proofExists: false,
      existingPlan: '# Plan\nbuild a part first. NORTH_STAR_DEFER_OK — foundation before the wire.',
    }),
  );
  assert.equal(decision, null);
});

// 11. The declaration can live in README-style content: fenced block, list item, blockquote.
test('parseNorthStar reads markers from README-style content (fenced / list / blockquote)', () => {
  const readmeFenced = '# My Product\n\nsome intro\n\n```\ncore_journey: talk -> it acts\nproof: tests/e2e.py\n```\n';
  assert.equal(parseNorthStar(readmeFenced).coreJourney, 'talk -> it acts');
  assert.equal(parseNorthStar(readmeFenced).proof, 'tests/e2e.py');
  const readmeList = '## North star\n- core_journey: a user talks and it operates an app\n- proof: tests/integration/test_core.py\n';
  assert.equal(parseNorthStar(readmeList).proof, 'tests/integration/test_core.py');
  const readmeQuote = '> core_journey: x\n> proof: t/p.py\n';
  assert.equal(parseNorthStar(readmeQuote).coreJourney, 'x');
});

// 12. A doc with NO core_journey marker counts as undeclared (blocks), even if non-empty.
test('blocks when the declaration doc exists but carries no core_journey marker', () => {
  const decision = decidePlanGate(
    planEvent('C:/proj/plans/plan-x.md', '# Plan\nbuild a thing'),
    deps({ northStar: '# README\n\nA fine readme with no markers at all.' }),
  );
  assert.ok(decision, 'expected a deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /declare the product's CORE JOURNEY/i);
});

// 13. The gate works the SAME whether the markers came from a README or a NORTH_STAR — the
//     decision function only sees declaration TEXT, so a README source allows/blocks identically.
test('a README-sourced declaration drives the gate (allows a wiring plan, proof missing)', () => {
  const readmeDeclaration = '# Product\n```\ncore_journey: talk -> acts\nproof: tests/test_e2e.py\n```\n';
  const blocked = decidePlanGate(
    planEvent('C:/proj/plans/plan-component.md', '# Plan\nadd another component'),
    deps({ northStar: readmeDeclaration, proofExists: false }),
  );
  assert.ok(blocked, 'a component plan is blocked while proof missing');
  const allowed = decidePlanGate(
    planEvent('C:/proj/plans/plan-wire.md', '# Plan\nwire it end-to-end, create tests/test_e2e.py'),
    deps({ northStar: readmeDeclaration, proofExists: false }),
  );
  assert.equal(allowed, null);
});

console.log(`\n${passedCount} passed`);
