// Pins the settings.json REGISTRATION for experiment-monitor-required.mjs, not just its logic.
//
// The 2026-07-21 gap: the hook's command-matching is tool-agnostic, but settings.json only
// registered it under a Bash-only PreToolUse matcher. A `detached_run.ps1` launch run via the
// PowerShell tool never reached PreToolUse at all — six training runs launched with zero
// Monitor and no skill-reference check, because the event never fired.
//
// This test reads the REAL settings.json and asserts the hook is registered under a
// PreToolUse block whose matcher includes BOTH Bash and PowerShell — a content-logic test
// alone (experiment-monitor-required.test.mjs) cannot catch a wiring/registration regression.
//
//   node --test hooks/experiment-monitor-required.settings.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

function preToolUseMatchersRegisteringHook(basename) {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  const preToolUse = settings?.hooks?.PreToolUse || [];
  const matchers = [];
  for (const block of preToolUse) {
    const registersHook = (block.hooks || []).some((entry) =>
      typeof entry.command === 'string' && entry.command.includes(basename));
    if (registersHook) matchers.push(block.matcher || '');
  }
  return matchers;
}

test('experiment-monitor-required.mjs is registered under a matcher covering Bash AND PowerShell', () => {
  const matchers = preToolUseMatchersRegisteringHook('experiment-monitor-required.mjs');
  assert.ok(matchers.length > 0, 'hook must be registered under at least one PreToolUse matcher');
  const coversBoth = matchers.some((matcher) => matcher.includes('Bash') && matcher.includes('PowerShell'));
  assert.ok(coversBoth,
    `expected a PreToolUse matcher covering both Bash and PowerShell; found: ${JSON.stringify(matchers)}`);
});

test('experiment-monitor-required.mjs is not double-registered under a redundant Bash-only block', () => {
  const matchers = preToolUseMatchersRegisteringHook('experiment-monitor-required.mjs');
  const bashOnly = matchers.filter((matcher) => matcher === 'Bash');
  assert.equal(bashOnly.length, 0,
    'a standalone "Bash"-only registration is redundant once a Bash|PowerShell block covers it');
});
