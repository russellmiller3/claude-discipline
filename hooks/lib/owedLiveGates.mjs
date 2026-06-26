// owedLiveGates.mjs — the durable ledger of OWED live e2e gates. When `e2e-or-its-theatre` is overridden with
// `e2e-owed-live-gate:`, the deferral is RECORDED here instead of being a silent free pass; a UserPromptSubmit
// reminder then nags every turn until the matching live e2e actually RUNS GREEN, which clears the gate. No
// commit/stop block — Russell's call (2026-06-26): "don't block the commit, I don't wanna lose the work, but
// keep reminding me until I do it." Keyed by module STEM + project so the same owed gate never double-records.
//
// Pure-ish: the state-file path is injected so the tests use a temp file (never the real ~/.claude ledger).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function defaultGatesPath() {
  // OWED_GATES_PATH isolates tests onto a temp ledger so spawning the REAL hook in a test never writes the
  // live ~/.claude ledger (that pollution fired a false reminder once — 2026-06-26).
  return process.env.OWED_GATES_PATH || join(homedir(), '.claude', 'state', 'owed-live-gates.json');
}

export function gateKey(moduleStem, project) {
  return `${String(project || '').trim()}::${String(moduleStem || '').trim()}`;
}

export function readGates(gatesPath = defaultGatesPath()) {
  if (!existsSync(gatesPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(gatesPath, 'utf8'));
    return Array.isArray(parsed?.gates) ? parsed.gates : [];
  } catch {
    return [];
  }
}

function writeGates(gatesPath, gates) {
  try {
    mkdirSync(dirname(gatesPath), { recursive: true });
    writeFileSync(gatesPath, JSON.stringify({ gates, updatedAt: nowIso() }, null, 2));
  } catch { /* fail open — a ledger write must never break a hook */ }
}

// Injected clock so tests are deterministic; defaults to wall clock in the live hook.
let clockFn = () => new Date().toISOString();
export function setClockForTest(injectedClock) { clockFn = injectedClock; }
function nowIso() { return clockFn(); }

// Record a deferral. No-op if this stem+project is already owed (don't reset its age or duplicate it).
export function recordGate(gatesPath, { moduleStem, why, project }) {
  const gates = readGates(gatesPath);
  const key = gateKey(moduleStem, project);
  if (gates.some((gate) => gateKey(gate.moduleStem, gate.project) === key)) return gates;
  const next = [...gates, { moduleStem, why: String(why || '').slice(0, 300), project, recordedAt: nowIso() }];
  writeGates(gatesPath, next);
  return next;
}

// Clear a satisfied gate (the live e2e ran green). Returns the remaining gates.
export function clearGate(gatesPath, moduleStem, project) {
  const key = gateKey(moduleStem, project);
  const remaining = readGates(gatesPath).filter((gate) => gateKey(gate.moduleStem, gate.project) !== key);
  writeGates(gatesPath, remaining);
  return remaining;
}
