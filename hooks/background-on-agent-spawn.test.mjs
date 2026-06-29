#!/usr/bin/env node
/**
 * Tests for background-on-agent-spawn — the gate that forces every Agent spawn
 * to run_in_background: true. Drives the pure decision function directly.
 */

import assert from 'node:assert/strict';
import { decideBackgroundGate } from './background-on-agent-spawn.mjs';

let passedCount = 0;
function test(name, testBody) {
  try {
    testBody();
    passedCount += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const agentEvent = (toolInput) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: toolInput,
});

// 1. A foreground agent (no run_in_background) is DENIED with teeth.
test('denies a foreground Agent spawn', () => {
  const decision = decideBackgroundGate(
    agentEvent({ description: 'Find hard bench', prompt: 'FOREGROUND_OK read-only search' }),
  );
  assert.ok(decision, 'expected a deny decision');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /run_in_background/);
});

// 2. run_in_background: true is ALLOWED (null = no block).
test('allows a backgrounded Agent spawn', () => {
  const decision = decideBackgroundGate(
    agentEvent({ description: 'Build X', run_in_background: true, prompt: 'do the thing' }),
  );
  assert.equal(decision, null);
});

// 3. The worktree hook's FOREGROUND_OK does NOT satisfy THIS gate (the exact case
//    that broke — a read-only foreground agent must still be backgrounded).
test('FOREGROUND_OK alone does NOT bypass the background gate', () => {
  const decision = decideBackgroundGate(
    agentEvent({ description: 'read-only', prompt: 'FOREGROUND_OK pure research, writes nothing' }),
  );
  assert.ok(decision, 'FOREGROUND_OK must not bypass — Russell wants it backgrounded');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
});

// 4. Russell's explicit override DOES bypass.
test('FOREGROUND_RUSSELL_OK bypasses the gate', () => {
  const decision = decideBackgroundGate(
    agentEvent({ description: 'one-shot', prompt: 'quick check FOREGROUND_RUSSELL_OK' }),
  );
  assert.equal(decision, null);
});

// 5. Non-Agent tools are ignored.
test('ignores non-Agent tools', () => {
  const decision = decideBackgroundGate({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(decision, null);
});

// 6. Non-PreToolUse events are ignored.
test('ignores non-PreToolUse events', () => {
  const decision = decideBackgroundGate({
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input: {},
  });
  assert.equal(decision, null);
});

console.log(`\n${passedCount} passed`);
