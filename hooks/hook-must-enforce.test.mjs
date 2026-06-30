#!/usr/bin/env node
/**
 * Tests for hook-must-enforce — the meta-guard. Pins the core verdict: a hook that PRESENTS as enforcement but
 * has no teeth is rejected; real (toothed) hooks and genuine context-injectors pass. Run:
 *   node --test hook-must-enforce.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateHookTeeth, isHookFile } from './hook-must-enforce.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('REJECTS a hook that prints a BLOCKED message but never blocks or acts', () => {
  const fakeHook = `
    // pretends to guard but just talks
    const reason = 'BLOCKED — you should really commit more often';
    console.error(reason);
    process.exit(0); // <- no teeth: exit 0, no deny, no side-effect
  `;
  const verdict = evaluateHookTeeth(fakeHook);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no teeth/);
});

test('PASSES a hook with a real deny decision', () => {
  const denyHook = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'STOP — nope' } }));`;
  assert.equal(evaluateHookTeeth(denyHook).ok, true);
});

test('PASSES a hook that performs a real side-effect (it DOES the thing)', () => {
  const actingHook = `execFileSync('git', ['-C', dir, 'commit', '--no-verify', '-m', 'wip']); // BLOCKED-looking text but real teeth`;
  assert.equal(evaluateHookTeeth(actingHook).ok, true);
});

test('PASSES a hook that exits 2 (block)', () => {
  assert.equal(evaluateHookTeeth(`if (bad) { console.error('STOP'); process.exit(2); }`).ok, true);
});

test('a message-only fragment looks toothless ALONE but PASSES folded into the whole hook', () => {
  // Why main() folds the existing file in: an Edit that only touches a guard's MESSAGE text
  // has no teeth in isolation, but the hook's real teeth (its deny() helper) live elsewhere.
  // Judging the fragment alone would false-block; judging the union is correct.
  const messageFragment = `return deny(\`Plan BLOCKED — declare the core journey first.\`);`;
  assert.equal(evaluateHookTeeth(messageFragment).ok, false, 'fragment alone reads as toothless');

  const wholeHook = `function deny(reason) { return { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } }; }\n${messageFragment}`;
  assert.equal(evaluateHookTeeth(wholeHook).ok, true, 'union with the deny() helper has teeth');
});

test('PASSES a genuine context-injector with the ADVISORY_ONLY_OK opt-out', () => {
  const injector = `// ADVISORY_ONLY_OK — SessionStart context, must inform only\nprocess.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'you should consider X' } }));`;
  assert.equal(evaluateHookTeeth(injector).ok, true);
});

test('PASSES a plain informational hook that never claims to enforce', () => {
  const informational = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'reminder: a tip' } }));`;
  assert.equal(evaluateHookTeeth(informational).ok, true); // no BLOCKED/deny/STOP signal → not policed
});

test('isHookFile: only .mjs hooks, not tests, not other files', () => {
  assert.equal(isHookFile('/c/Users/r/.claude/hooks/foo.mjs'), true);
  assert.equal(isHookFile('C:\\Users\\r\\.claude\\hooks\\foo.mjs'), true);
  assert.equal(isHookFile('/c/Users/r/.claude/hooks/foo.test.mjs'), false);
  assert.equal(isHookFile('/c/Users/r/proj/src/app.mjs'), false);
});

test('the REAL hooks we just built pass their own rule (dogfood)', () => {
  // Only check hooks PRESENT in this checkout — the kit is a curated subset of the global
  // hooks dir, so a global-only name (e.g. agent-commit-cadence) is absent there. Skipping
  // missing files keeps the dogfood portable across global + kit instead of ENOENT-failing.
  let checkedCount = 0;
  for (const hookName of ['hook-must-enforce.mjs', 'agent-autocommit.mjs', 'agent-commit-cadence.mjs']) {
    let source;
    try { source = readFileSync(join(here, hookName), 'utf8'); } catch { continue; }
    assert.equal(evaluateHookTeeth(source).ok, true, `${hookName} should have teeth`);
    checkedCount += 1;
  }
  assert.ok(checkedCount >= 1, 'expected at least hook-must-enforce.mjs to be present to dogfood');
});
