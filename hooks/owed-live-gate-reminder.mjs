#!/usr/bin/env node
/**
 * owed-live-gate-reminder — UserPromptSubmit nudge with NO teeth-on-the-workflow (by Russell's design,
 * 2026-06-26: "don't block the commit, I don't wanna lose the work, but keep reminding me until I do it").
 *
 * When `e2e-or-its-theatre` is overridden with `e2e-owed-live-gate:`, that deferral is recorded in the
 * owedLiveGates ledger instead of being a silent free pass. THIS hook reads that ledger on every turn and
 * surfaces the outstanding gates as context — so the moment you defer a real live test, you get reminded
 * every single turn until you actually run it green (which clears the gate via the theatre hook). It never
 * blocks: commits and stops flow freely; the reminder simply won't go away until the live test is done.
 *
 * Output: plain text to stdout (becomes UserPromptSubmit additionalContext). Silent when nothing is owed.
 * Fail open on any error — a reminder must never break a turn.
 */

import { readFileSync } from 'node:fs';
import { readGates } from './lib/owedLiveGates.mjs';

// "3d 4h" style age from an ISO timestamp to now — so an owed gate that's been ignored for days reads loud.
function ageSince(isoTimestamp, now) {
  const recordedMs = Date.parse(isoTimestamp || '');
  if (Number.isNaN(recordedMs)) return 'unknown age';
  const elapsedMinutes = Math.max(0, Math.round((now - recordedMs) / 60000));
  const days = Math.floor(elapsedMinutes / 1440);
  const hours = Math.floor((elapsedMinutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${elapsedMinutes % 60}m`;
  return `${elapsedMinutes}m`;
}

export function buildReminder(gates, now) {
  if (!Array.isArray(gates) || gates.length === 0) return '';
  const lines = gates.map((gate) =>
    `  • ${gate.moduleStem} (${gate.project || 'project'}) — deferred ${ageSince(gate.recordedAt, now)} ago; reason: ${gate.why || 'real boundary'}`);
  return [
    '=== OWED LIVE GATE(S) — you deferred a real e2e and have NOT run it yet ===',
    'You used e2e-owed-live-gate to defer proving a real-boundary change. That is NOT done until a real',
    'live test runs GREEN. Outstanding:',
    ...lines,
    '',
    'Do it: write/run the matching `<module>.e2e.test.*` against the REAL dependency and run it green',
    '(e.g. `cd extension && npx vitest run <stem>.e2e.test.js`). A green run clears the gate automatically;',
    'until then this reminder fires every turn. Do not call the change "done" while a gate is outstanding.',
  ].join('\n');
}

function main() {
  try { readFileSync(0, 'utf8'); } catch { /* stdin optional */ }
  let reminder = '';
  try { reminder = buildReminder(readGates(), Date.now()); } catch { reminder = ''; }
  if (reminder) process.stdout.write(reminder);
  process.exit(0);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
