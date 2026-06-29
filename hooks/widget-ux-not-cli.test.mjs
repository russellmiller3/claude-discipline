#!/usr/bin/env node
/**
 * Tests for widget-ux-not-cli — the gate that forces product UX into the widget,
 * not a CLI, when the project has a widget.html.
 */

import assert from 'node:assert/strict';
import { decideWidgetUxGate } from './widget-ux-not-cli.mjs';

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

const agentEvent = (prompt) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { description: 'expose ux', prompt },
});
const withWidget = { widgetExists: true };
const noWidget = { widgetExists: false };

// 1. UX-exposure intent + CLI-only + widget exists + no widget mention → DENIED.
test('denies a CLI-only UX-exposure brief when a widget exists', () => {
  const decision = decideWidgetUxGate(
    agentEvent('Make sure everything has UX exposed: add python -m skaffen_desktop.chat and a memory CLI.'),
    withWidget,
  );
  assert.ok(decision, 'expected a deny');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /widget/i);
});

// 2. Same intent but the brief BUILDS the widget surface → allowed.
test('allows when the brief wires the widget (pywebview js_api)', () => {
  const decision = decideWidgetUxGate(
    agentEvent('Surface the UX: wire Brain.turn into widget.html via window.pywebview.api, plus a py -m dev CLI.'),
    withWidget,
  );
  assert.equal(decision, null);
});

// 3. No widget in the project → a CLI may be the only surface → allowed.
test('allows a CLI UX brief when the project has NO widget', () => {
  const decision = decideWidgetUxGate(
    agentEvent('Expose the UX via python -m tool.cli for this headless library.'),
    noWidget,
  );
  assert.equal(decision, null);
});

// 4. No UX-exposure intent (just a dev tool) → not this gate's concern → allowed.
test('ignores a brief with no UX-exposure intent', () => {
  const decision = decideWidgetUxGate(
    agentEvent('Add a python -m maintenance CLI for reindexing. No user-facing change.'),
    withWidget,
  );
  assert.equal(decision, null);
});

// 5. UX intent but no CLI (already building a GUI) → allowed.
test('ignores a UX brief that builds no CLI', () => {
  const decision = decideWidgetUxGate(
    agentEvent('Expose the UX for search results in a panel.'),
    withWidget,
  );
  assert.equal(decision, null);
});

// 6. The UX_CLI_OK override bypasses.
test('UX_CLI_OK bypasses the gate', () => {
  const decision = decideWidgetUxGate(
    agentEvent('Expose the UX via python -m tool.cli. UX_CLI_OK — this is a dev-only tool.'),
    withWidget,
  );
  assert.equal(decision, null);
});

// 7. Non-Agent / non-PreToolUse ignored.
test('ignores non-Agent tools', () => {
  assert.equal(
    decideWidgetUxGate({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, withWidget),
    null,
  );
});

console.log(`\n${passedCount} passed`);
