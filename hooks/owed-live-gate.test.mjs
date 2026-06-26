// owed-live-gate.test.mjs — the OWED live-gate ledger + reminder + green-run clearing.
// Russell 2026-06-26: `e2e-owed-live-gate:` must NOT be a silent free pass — it records a durable owed gate
// that gets reminded every turn until the live e2e runs green (which clears it). No commit/stop block.
// Run: node owed-live-gate.test.mjs   (exits non-zero on failure)

import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readGates, recordGate, clearGate, gateKey, setClockForTest } from './lib/owedLiveGates.mjs';
import { buildReminder } from './owed-live-gate-reminder.mjs';
import { e2eGreenRunStems } from './e2e-or-its-theatre.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let seq = 0;
function freshGatesPath() {
  return join(mkdtempSync(join(tmpdir(), 'owed-gates-')), `gates-${seq++}.json`);
}

const failures = [];
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else { console.log(`FAIL  ${label}`); failures.push(label); }
}

setClockForTest(() => '2026-06-26T00:00:00.000Z');

// ── ledger: record / dedup / clear ──────────────────────────────────────────
{
  const gatesPath = freshGatesPath();
  check('empty ledger reads as []', readGates(gatesPath).length === 0);

  recordGate(gatesPath, { moduleStem: 'skaffenBrain', why: 'network/HTTP', project: 'jarvis' });
  check('record adds one gate', readGates(gatesPath).length === 1);
  check('recorded gate carries stem + project + why',
    readGates(gatesPath)[0].moduleStem === 'skaffenBrain' && readGates(gatesPath)[0].project === 'jarvis' && readGates(gatesPath)[0].why === 'network/HTTP');

  recordGate(gatesPath, { moduleStem: 'skaffenBrain', why: 'network/HTTP again', project: 'jarvis' });
  check('record is idempotent (same stem+project does not double or reset)', readGates(gatesPath).length === 1);

  recordGate(gatesPath, { moduleStem: 'skaffenBrain', why: 'network', project: 'other-project' });
  check('same stem in a DIFFERENT project is a distinct gate', readGates(gatesPath).length === 2);

  clearGate(gatesPath, 'skaffenBrain', 'jarvis');
  const remaining = readGates(gatesPath);
  check('clear removes only the matching stem+project', remaining.length === 1 && remaining[0].project === 'other-project');

  check('gateKey distinguishes project from stem', gateKey('a', 'p1') !== gateKey('a', 'p2'));
}

// ── reminder builder ─────────────────────────────────────────────────────────
{
  check('reminder is empty when nothing is owed', buildReminder([], Date.now()) === '');
  const reminder = buildReminder(
    [{ moduleStem: 'skaffenBrain', project: 'jarvis', why: 'network/HTTP', recordedAt: '2026-06-25T00:00:00.000Z' }],
    Date.parse('2026-06-26T00:00:00.000Z'),
  );
  check('reminder names the owed module', /skaffenBrain/.test(reminder));
  check('reminder shows the age (1 day)', /1d/.test(reminder));
  check('reminder tells you to run the live e2e', /e2e\.test/.test(reminder) && /green/i.test(reminder));
}

// ── green-run detector (clears the gate) ─────────────────────────────────────
{
  const greenTurn = [{
    role: 'user',
    content: [{ type: 'tool_result', content: 'RUN v4\n\n Test Files  1 passed (1)\n  Tests  1 passed (1)\n skaffenBrainFanout.e2e.test.js' }],
  }];
  const stems = e2eGreenRunStems(greenTurn);
  check('green-run detector finds the e2e stem from a passing run', stems.has('skaffenBrainFanout'));

  const redTurn = [{
    role: 'user',
    content: [{ type: 'tool_result', content: ' Tests  1 failed (1)\n skaffenBrainFanout.e2e.test.js FAIL' }],
  }];
  check('green-run detector ignores a FAILED run (no clear)', !e2eGreenRunStems(redTurn).has('skaffenBrainFanout'));
}

// ── the theatre hook still passes its OWN suite (the override split didn't break it) ──
{
  const theatreTest = join(here, 'e2e-or-its-theatre.test.mjs');
  const run = spawnSync('node', [theatreTest], { encoding: 'utf8' });
  check('e2e-or-its-theatre.test.mjs still green after the override-split refactor', run.status === 0);
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll owed-live-gate checks passed.');
