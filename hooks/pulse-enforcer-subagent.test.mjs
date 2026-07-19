import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  handoffRequiresContinuation,
  isSubagentTranscript,
  handoffOwnerLabel,
  handoffOwnerHasLivePulse,
} from './pulse-enforcer-subagent.mjs';

let passed = 0;
function test(name, check) {
  check();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('blocks ACTIVE handoffs', () => {
  assert.equal(handoffRequiresContinuation(
    '# AGENT-HANDOFF\n\n## BLOCKER\nNone.\n\nSTATUS: ACTIVE — 18/68 pass. Blocked from full rerun until the driver is restored.',
  ), true);
});

test('blocks bold IN PROGRESS handoffs', () => {
  assert.equal(handoffRequiresContinuation('**STATUS:** IN PROGRESS\n\n## NEXT\nPhase 2'), true);
});

test('allows DONE handoffs', () => {
  assert.equal(handoffRequiresContinuation('STATUS: DONE'), false);
});

test('allows genuine BLOCKED handoffs', () => {
  assert.equal(handoffRequiresContinuation('STATUS: BLOCKED — hardware key required'), false);
});

test('fails open without a recognized status', () => {
  assert.equal(handoffRequiresContinuation('## NEXT\nKeep working'), false);
  assert.equal(handoffRequiresContinuation(null), false);
});

test('recognizes only subagent transcripts', () => {
  assert.equal(isSubagentTranscript('C:/Temp/claude/tasks/agent-1.output'), true);
  assert.equal(isSubagentTranscript('C:/Users/me/.claude/projects/thread.jsonl'), false);
});

test('live hook blocks ACTIVE Codex lane without a Claude transcript', () => {
  const laneDirectory = mkdtempSync(join(tmpdir(), 'codex-active-lane-'));
  const hookPath = fileURLToPath(new URL('./pulse-enforcer-subagent.mjs', import.meta.url));
  try {
    writeFileSync(join(laneDirectory, 'AGENT-HANDOFF.md'), 'STATUS: ACTIVE\n\n## NEXT\nContinue toward 68.\n');
    const hookRun = spawnSync(process.execPath, [hookPath], {
      cwd: laneDirectory,
      input: JSON.stringify({
        hook_event_name: 'Stop',
        cwd: laneDirectory,
        transcript_path: 'C:/Users/rmill/.codex/sessions/collaboration-agent.jsonl',
      }),
      encoding: 'utf8',
    });
    assert.equal(hookRun.status, 0);
    assert.equal(JSON.parse(hookRun.stdout).decision, 'block');
  } finally {
    rmSync(laneDirectory, { recursive: true, force: true });
  }
});

// 2026-07-17 FALSE-BLOCK: the orchestrator, parked in a live delegate's worktree, was blocked on the
// delegate's IN PROGRESS AGENT-HANDOFF.md. A live owner pulsing that handoff's task must exempt the block.
test('handoffOwnerLabel extracts the owning worktree name', () => {
  assert.equal(handoffOwnerLabel('C:/x/marcus-worktrees/exp154/AGENT-HANDOFF.md'), 'exp154');
});

test('a handoff whose owner is pulsing (30s ago) is exempt; a 3h-old pulse is not', () => {
  const pulseDir = mkdtempSync(join(tmpdir(), 'pulse-log-'));
  const pulseLog = join(pulseDir, 'agent-pulse.log');
  const now = Date.parse('2026-07-17T12:00:00Z');
  const iso = (msAgo) => new Date(now - msAgo).toISOString().replace(/\.\d+Z$/, 'Z');
  try {
    writeFileSync(pulseLog, `[${iso(30_000)}] [exp154 Phase 4] Agent: Progress: 2/5 - training\n`);
    assert.equal(handoffOwnerHasLivePulse('exp154', pulseLog, now), true, 'a fresh owner pulse exempts the block');
    writeFileSync(pulseLog, `[${iso(3 * 60 * 60 * 1000)}] [exp154 Phase 4] Agent: Progress: 2/5 - training\n`);
    assert.equal(handoffOwnerHasLivePulse('exp154', pulseLog, now), false, 'a 3h-old pulse does not exempt');
    // A pulse for a DIFFERENT task must not exempt this owner.
    writeFileSync(pulseLog, `[${iso(30_000)}] [other-agent] Agent: Progress: 1/1 - done\n`);
    assert.equal(handoffOwnerHasLivePulse('exp154', pulseLog, now), false, 'another task\'s pulse is not this owner');
  } finally {
    rmSync(pulseDir, { recursive: true, force: true });
  }
});

// End-to-end escape parity: the token in the final assistant reply clears the block (env is unreachable).
test('AGENT_CHECKPOINT_STOP_OK in the reply text clears the incomplete-handoff block', () => {
  const laneDirectory = mkdtempSync(join(tmpdir(), 'orchestrator-lane-'));
  const hookPath = fileURLToPath(new URL('./pulse-enforcer-subagent.mjs', import.meta.url));
  const transcriptPath = join(laneDirectory, 'thread.jsonl');
  try {
    writeFileSync(join(laneDirectory, 'AGENT-HANDOFF.md'), 'STATUS: IN PROGRESS\n\n## NEXT\nPhase 2\n');
    writeFileSync(transcriptPath, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Done for now. AGENT_CHECKPOINT_STOP_OK' }] } }) + '\n');
    const hookRun = spawnSync(process.execPath, [hookPath], {
      cwd: laneDirectory,
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: laneDirectory, transcript_path: transcriptPath }),
      encoding: 'utf8',
      env: { ...process.env, AGENT_PULSE_LOG_PATH: join(laneDirectory, 'nonexistent.log') },
    });
    assert.equal(hookRun.stdout.trim(), '', 'reply-text escape token must clear the block');
  } finally {
    rmSync(laneDirectory, { recursive: true, force: true });
  }
});

console.log(`\n${passed} tests passed`);
