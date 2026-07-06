#!/usr/bin/env node
// agent-watchdog.test.mjs — locks the silent-dead-agent watchdog (resilience parts 2-4).
//   • PostToolUse(Agent): records the spawn into the registry.
//   • Stop: blocks when an active agent has gone silent (stale pulse), once per stall; allows when fresh,
//     when no agent is active, and when the same stall was already flagged.
// Run: node agent-watchdog.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'agent-watchdog.mjs');

const failures = [];
const check = (label, condition) => { if (condition) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };
const cleanups = [];
function tempDir() { const path = mkdtempSync(join(tmpdir(), 'watchdog-')); cleanups.push(path); return path; }

// A transcript line that looks like a live background-agent spawn.
const ACTIVE_AGENT_TRANSCRIPT =
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_ABC123","name":"Agent","input":{"run_in_background":true,"description":"x"}}]}}';
// Same spawn, then a completion notification that clears it.
const COMPLETED_AGENT_TRANSCRIPT = ACTIVE_AGENT_TRANSCRIPT +
  '\n{"type":"user"}\n<task-notification><tool-use-id>toolu_ABC123</tool-use-id><status>completed</status></task-notification>';

function runStop({ transcriptText, freshPulse = false, workDir }) {
  const transcriptPath = join(workDir, 'transcript.jsonl');
  writeFileSync(transcriptPath, transcriptText);
  const pulseLog = join(workDir, 'agent-pulse.log');
  if (freshPulse) writeFileSync(pulseLog, '[X] Agent: working\n'); // mtime = now → fresh
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    encoding: 'utf8',
    env: { ...process.env, WATCHDOG_PULSE_LOG: pulseLog, WATCHDOG_REGISTRY: join(workDir, 'reg.json'), WATCHDOG_ACK: join(workDir, 'ack.json') },
  });
  return /"decision"\s*:\s*"block"/.test(proc.stdout || '');
}

// ── PostToolUse: records the spawn ─────────────────────────────────────────────
{
  const workDir = tempDir();
  const registryPath = join(workDir, 'reg.json');
  spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Agent',
      tool_input: { description: 'Build thing', isolation: 'worktree', prompt: 'do it' },
      tool_response: 'Async agent launched successfully.\nagentId: a840ef32daecffe00 (internal ID)' }),
    encoding: 'utf8',
    env: { ...process.env, WATCHDOG_REGISTRY: registryPath },
  });
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : {};
  check('PostToolUse records the spawned agent into the registry',
    registry['a840ef32daecffe00']?.label === 'Build thing');
}

// ── Stop: stale + active → block ───────────────────────────────────────────────
check('active agent + silent pulse log (none) → blocked',
  runStop({ transcriptText: ACTIVE_AGENT_TRANSCRIPT, freshPulse: false, workDir: tempDir() }));

// ── Stop: fresh pulse → allowed (agent alive) ──────────────────────────────────
check('active agent + FRESH pulse → allowed',
  !runStop({ transcriptText: ACTIVE_AGENT_TRANSCRIPT, freshPulse: true, workDir: tempDir() }));

// ── Stop: no active agent (completed) → allowed ────────────────────────────────
check('completed agent (no longer active) → allowed',
  !runStop({ transcriptText: COMPLETED_AGENT_TRANSCRIPT, freshPulse: false, workDir: tempDir() }));

// ── Stop: same stall flagged twice → only blocks once ──────────────────────────
{
  const workDir = tempDir();
  const first = runStop({ transcriptText: ACTIVE_AGENT_TRANSCRIPT, freshPulse: false, workDir });
  const second = runStop({ transcriptText: ACTIVE_AGENT_TRANSCRIPT, freshPulse: false, workDir });
  check('first stale Stop blocks, second (same stall) stays quiet', first === true && second === false);
}

// ── Stop: a stalled agent whose AGENT-HANDOFF.md says STATUS: DONE is NOT flagged (finished, didn't report)
{
  const workDir = tempDir();
  const agentId = 'a840ef32daecffe00';
  writeFileSync(join(workDir, 'reg.json'), JSON.stringify({ [agentId]: { label: 'Build', spawnedAt: Date.now() } }));
  const handoffDir = join(workDir, '.claude', 'worktrees', `agent-${agentId}`);
  mkdirSync(handoffDir, { recursive: true });
  writeFileSync(join(handoffDir, 'AGENT-HANDOFF.md'), 'GOAL: build X\nDONE: everything\nSTATUS: DONE\n');
  const transcriptPath = join(workDir, 'transcript.jsonl');
  writeFileSync(transcriptPath, ACTIVE_AGENT_TRANSCRIPT);
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath, cwd: workDir }),
    encoding: 'utf8',
    env: { ...process.env, WATCHDOG_PULSE_LOG: join(workDir, 'nopulse.log'), WATCHDOG_REGISTRY: join(workDir, 'reg.json'), WATCHDOG_ACK: join(workDir, 'ack.json') },
  });
  check('agent that wrote STATUS: DONE in its handoff is NOT flagged as dead',
    !/"decision"\s*:\s*"block"/.test(proc.stdout || ''));
}

// ── Stop: the block hands the orchestrator the EXACT TaskStop reap call (2026-07-06) ──
{
  const workDir = tempDir();
  const agentId = 'deadbeef12345678';
  writeFileSync(join(workDir, 'reg.json'), JSON.stringify({ [agentId]: { label: 'Zombie', spawnedAt: Date.now() } }));
  const transcriptPath = join(workDir, 'transcript.jsonl');
  writeFileSync(transcriptPath, ACTIVE_AGENT_TRANSCRIPT); // active agent, no handoff DONE → a suspect
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath, cwd: workDir }),
    encoding: 'utf8',
    env: { ...process.env, WATCHDOG_PULSE_LOG: join(workDir, 'nopulse.log'), WATCHDOG_REGISTRY: join(workDir, 'reg.json'), WATCHDOG_ACK: join(workDir, 'ack.json') },
  });
  check('dead-agent block hands the orchestrator the exact TaskStop reap call + the agent id',
    proc.stdout.includes('TaskStop task_id=') && proc.stdout.includes(agentId));
}

for (const path of cleanups) { try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ } }

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll agent-watchdog checks passed.');
