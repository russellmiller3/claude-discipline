#!/usr/bin/env node
/**
 * live-ui-focus-guard — DENIES launching focus-stealing live-UI / integration tests unless Russell
 * is confirmed away (an explicit override), because these tests physically take over his screen.
 *
 * Why this rule exists:
 * 2026-06-30 — an overnight background agent was hardening skaffen-desktop's `tests/integration/*_live`
 * tests, which drive a REAL Calculator/Notepad via `uiautomation`. Run on Russell's ACTIVE desktop while
 * he was working, they kept popping Calculator windows and STEALING FOCUS — "stopped the calculator it's
 * messing up my work". These agents run on his real machine, not a headless CI, so any live-UI test
 * hijacks the screen. The default (`-m "not integration"`) suite is safe and must NOT be blocked.
 *
 * What it catches (PreToolUse on Bash / PowerShell / Agent): a command or agent brief that RUNS a pytest
 * selection INCLUDING the `integration` marker (but not `not integration`), or directly runs a `*_live.py`
 * test file. Advisory-precise: it keys on the concrete test-run invocation, not vague app-driving prose.
 *
 * Teeth: permissionDecision:'deny'.
 * Overrides (Russell is away / it's genuinely safe to grab the screen now):
 *   - the token  live-ui-ok: <why>  in the command/brief, or
 *   - env  LIVE_UI_TEST_OK=1
 * Fail-open on any parse error — a guard bug must never block all work.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARDED_TOOLS = new Set(['Bash', 'PowerShell', 'Agent']);

/**
 * Does this command/brief launch a live-UI / integration test run? Pure string check.
 * TRUE for: a pytest run selecting the `integration` marker (quoted or bare) that is NOT
 * `not integration`, OR a direct run of a `*_live.py` test file under pytest/python.
 */
export function runsLiveUiTests(commandOrPrompt) {
  if (!commandOrPrompt) return false;
  const hasPytest = /\b(pytest|py(thon)?\s+-m\s+pytest)\b/.test(commandOrPrompt);
  if (!hasPytest) return false;

  // Directly invoking a *_live test file (e.g. tests/integration/test_calculator_live.py).
  if (/_live\.py\b/.test(commandOrPrompt)) return true;

  // Collapse the `python -m pytest` MODULE-run flag so it can't be mistaken for a `-m <marker>` select
  // (otherwise "python -m pytest -m integration" reads the first `-m pytest` as the marker).
  const withoutModuleRun = commandOrPrompt.replace(/\bpy(thon)?\s+-m\s+pytest\b/g, 'pytest');

  // `-m <marker expression>` selecting `integration` — quoted form first, then a bare single token.
  const quoted = withoutModuleRun.match(/-m\s*(['"])([^'"]*)\1/);
  const bare = withoutModuleRun.match(/-m\s+([A-Za-z_][A-Za-z0-9_ ]*)/);
  const markerExpression = (quoted && quoted[2]) || (bare && bare[1]) || '';
  if (/\bintegration\b/.test(markerExpression) && !/\bnot\s+integration\b/.test(markerExpression)) {
    return true;
  }
  return false;
}

/**
 * Decide on one PreToolUse event. Returns a deny-decision object, or null to allow.
 * Pure (env injected) so the test drives it directly.
 */
export function decideLiveUiFocusGate(event, env = {}) {
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') return null;
  if (!GUARDED_TOOLS.has(event.tool_name || '')) return null;

  const input = event.tool_input || {};
  const commandOrPrompt = input.command || input.prompt || '';

  if (!runsLiveUiTests(commandOrPrompt)) return null;

  // Overrides — Russell is away / it's safe to grab the screen right now.
  if (env.LIVE_UI_TEST_OK === '1') return null;
  if (/\blive-ui-ok:/i.test(commandOrPrompt)) return null;

  const reason = `BLOCKED — this runs live-UI / integration tests that STEAL FOCUS on Russell's active desktop.

These tests drive a REAL Calculator/Notepad (via uiautomation) and physically take over the screen — they run on Russell's machine, not headless CI. Launching them while he's working hijacks his desktop (2026-06-30: "stopped the calculator it's messing up my work").

Safe alternative: run the DEFAULT suite instead — \`-m "not integration"\` (or a specific non-live test file). That never grabs the screen.

Override ONLY when Russell is confirmed away / it's safe to take the screen now:
  - add the token  live-ui-ok: <why>  to the command/brief, or
  - set env  LIVE_UI_TEST_OK=1`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }
  const decision = decideLiveUiFocusGate(event, process.env);
  if (decision) process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

const invokedAsScript =
  process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1]);
if (invokedAsScript) main();
