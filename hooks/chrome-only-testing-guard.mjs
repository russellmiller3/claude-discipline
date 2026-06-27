#!/usr/bin/env node
// =============================================================================
// chrome-only-testing-guard — Jarvis is tested ONLY on the real Chrome extension,
//                             never Playwright. Installing/invoking Playwright is BLOCKED.
// =============================================================================
//
// Russell's rule (2026-06-26): "we only use chrome for testing going forward."
// A written STRICT RULE already existed (benchmark/README.md: "the LIVE Chrome
// extension harness IS the benchmark; the Playwright path is a stand-in") and it
// FAILED to stop a Playwright install this session — so per the Getty loop the
// fix is a hook, not another note.
//
// The catchable sin at the Bash layer is INSTALLING or INVOKING Playwright:
//   - npm/pnpm/yarn/bun (i|install|add) playwright  (or @playwright/test)
//   - npx playwright ... / playwright install|test|codegen
// A JS `import 'playwright'` can't be caught here, but blocking the install means
// the Playwright path can never come back — browser coverage must run on the real
// Chrome extension harness (test/live/realExperience.mjs / recordUiLive.mjs), which
// drives production Chrome via chrome.debugger / chrome.tabs — the actual user path.
//
// Jarvis project only (gated on cwd) — never touches other projects, which may use
// Playwright legitimately. Override: `chrome-only-override: <why>` in the command,
// or CHROME_ONLY_OVERRIDE=1. Fail-open on any error.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A package-manager install that names playwright (covers `@playwright/test` — \bplaywright\b matches inside it).
const PLAYWRIGHT_INSTALL = /\b(npm|pnpm|bun|yarn)\s+(i|install|add|ci)\b[^\n]*\bplaywright\b/i;
// The Playwright CLI itself: `npx playwright ...` or a bare `playwright install|test|codegen|show-trace`.
const PLAYWRIGHT_CLI = /(\bnpx\s+playwright\b|(?:^|[\s;&|(])playwright\s+(install|test|codegen|show-trace)\b)/i;

const OVERRIDE = /chrome-only-override:/i;

/** The Playwright offense in a bash command, or null. Exported for tests. */
export function playwrightOffense(command) {
  const commandText = String(command || '');
  if (OVERRIDE.test(commandText)) return null;
  if (PLAYWRIGHT_INSTALL.test(commandText)) return 'installs Playwright';
  if (PLAYWRIGHT_CLI.test(commandText)) return 'invokes the Playwright CLI';
  return null;
}

/** True only when the working directory is inside the Jarvis project. Exported for tests. */
export function inJarvisProject(workingDirectory) {
  const normalizedPath = String(workingDirectory || '').replace(/\\/g, '/');
  return /(^|\/)jarvis(\/|$)/i.test(normalizedPath);
}

function denial(offense) {
  return `BLOCKED — this command ${offense}, but Jarvis is tested ONLY on the real Chrome extension.

Russell's rule (2026-06-26): "we only use chrome for testing going forward." The benchmark/tests run
against the LIVE loaded extension in headed Chrome (the real production page bridge via chrome.debugger /
chrome.tabs) — NOT Playwright. Playwright is a stand-in that benchmarks a reimplementation of the page
logic and structurally can't reach the real extension runtime.

Do this instead:
  - Browser/UI coverage: the live Chrome harness — extension/test/live/realExperience.mjs and
    extension/test/live/recordUiLive.mjs (real panel + real production bridge).
  - Non-browser bench tasks (google/api/research) already run without Playwright via
    bench/realworld/harness.mjs (those tasks don't touch the browser).
  - Do NOT install Playwright to make a browser task run — move that task to the live Chrome harness.

Override only if you and Russell have explicitly decided otherwise:
  chrome-only-override: <why>   (in the command), or CHROME_ONLY_OVERRIDE=1`;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); return; }

  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') { process.exit(0); return; }
  // Both shell tools carry the command on tool_input.command — an install via either is the same sin.
  if (event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') { process.exit(0); return; }
  if (process.env.CHROME_ONLY_OVERRIDE === '1') { process.exit(0); return; }

  if (!inJarvisProject(event.cwd)) { process.exit(0); return; } // other projects may use Playwright
  const command = (event.tool_input && event.tool_input.command) || '';

  const offense = playwrightOffense(command);
  if (!offense) { process.exit(0); return; }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial(offense),
    },
  }));
  process.exit(0);
}

// Entry-point guard so importing this for tests does not execute main() (which reads stdin and hangs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
