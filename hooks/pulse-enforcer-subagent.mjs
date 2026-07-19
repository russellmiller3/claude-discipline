#!/usr/bin/env node
/**
 * pulse-enforcer-subagent — fires inside background-agent sessions to
 * REFUSE the stop if the agent hasn't emitted any narrative pulse during
 * this run. Forces every subagent to drop at least one summary pulse
 * describing what it did before completion.
 *
 * Detection: subagents have a transcript_path under the temp directory
 * (Windows: %LOCALAPPDATA%\Temp\claude\.../tasks/<agent-id>.output).
 * Parent sessions have transcripts in ~/.claude/projects/. We only fire
 * when the path looks like a subagent.
 *
 * If the agent emitted at least one pulse in agent-pulse.log within the
 * last hour, allow stop. Otherwise block with a reminder.
 *
 * Russell's rule (added 2026-05-13): every background agent must emit
 * plain-English narrative progress events to agent-pulse.log so he sees
 * what they're doing without polling. The PreToolUse gate ensures the
 * brief includes the contract; this Stop hook ensures the agent actually
 * honored it.
 *
 * Fail-open on any unexpected error — never permanently trap a subagent.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Test seam: AGENT_PULSE_LOG_PATH overrides the pulse log so tests can drive live-owner detection.
const PULSE_LOG = process.env.AGENT_PULSE_LOG_PATH || resolve(homedir(), 'Desktop', 'programming', '.claude', 'state', 'agent-pulse.log');
// Only checkpoints (Plan:/Progress:) count — a stale entry from another agent
// must not let this agent slip through. Parse ISO timestamps to verify recency.
const CHECKPOINT_WINDOW_MS = 30 * 60 * 1000; // 30 min

export function isSubagentTranscript(transcriptPath) {
  if (!transcriptPath) return false;
  const normalized = transcriptPath.replace(/\\/g, '/').toLowerCase();
  // Subagent transcripts live under <temp>/claude/.../tasks/<id>.output
  return /\/tasks\//.test(normalized) && /\.output$/.test(normalized);
}

export function handoffRequiresContinuation(handoffContent) {
  if (typeof handoffContent !== 'string' || handoffContent.trim() === '') return false;
  const statusLine = handoffContent.split(/\r?\n/).find((line) =>
    line.replace(/\*/g, '').trim().toUpperCase().startsWith('STATUS:'),
  );
  if (!statusLine) return false;
  const normalizedLine = statusLine.replace(/\*/g, '').trim();
  const status = normalizedLine.slice(normalizedLine.indexOf(':') + 1).trim().toUpperCase();
  if (/^(?:DONE|COMPLETE|COMPLETED|BLOCKED)\b/.test(status)) return false;
  return /^(?:ACTIVE|IN PROGRESS|RESTART REQUIRED|RUNNING|WIP)\b/.test(status);
}

function readIncompleteHandoff(cwd) {
  if (process.env.AGENT_CHECKPOINT_STOP_OK === '1' || !cwd) return null;
  const handoffPath = resolve(cwd, 'AGENT-HANDOFF.md');
  if (!existsSync(handoffPath)) return null;
  try {
    const handoffContent = readFileSync(handoffPath, 'utf8');
    return handoffRequiresContinuation(handoffContent) ? handoffPath : null;
  } catch {
    return null;
  }
}

// The worktree that OWNS a handoff, e.g. `.../marcus-worktrees/exp154/AGENT-HANDOFF.md` -> "exp154".
// Used to tell an ORCHESTRATOR (which cd'd into a live delegate's worktree) apart from the delegate
// itself: if a background agent is actively pulsing THIS handoff's task, a live owner has it and the
// stopping session is not abandoning it. (2026-07-17)
export function handoffOwnerLabel(handoffPath) {
  return basename(dirname(String(handoffPath || '')).replace(/\\/g, '/')) || '';
}

// True when a background agent is CURRENTLY pulsing checkpoints tagged with the handoff's owner label —
// i.e. the handoff's real owner is alive elsewhere, so the stopping session (the orchestrator) must not
// be blocked on a file it doesn't own and must not edit. Reads the pulse log's `[ts] [TASK] Agent: …` rows.
export function handoffOwnerHasLivePulse(ownerLabel, pulseLogPath = PULSE_LOG, now = Date.now()) {
  if (!ownerLabel || !existsSync(pulseLogPath)) return false;
  try {
    const raw = readFileSync(pulseLogPath, 'utf8');
    const cutoff = now - CHECKPOINT_WINDOW_MS;
    const label = ownerLabel.toLowerCase();
    for (const line of raw.split('\n')) {
      if (!/Agent:\s*(?:Plan|Replan|Progress):/i.test(line)) continue;
      const timestampMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:]+Z?)\]/);
      const taskTagMatch = line.match(/^\[[^\]]+\]\s*\[([^\]]+)\]/); // second bracket = the task tag
      if (!timestampMatch || !taskTagMatch) continue;
      if (!taskTagMatch[1].toLowerCase().includes(label)) continue;
      try { if (new Date(timestampMatch[1]).getTime() >= cutoff) return true; } catch { /* skip unparseable */ }
    }
    return false;
  } catch { return false; }
}

// The escape token can be given in the final assistant reply, not only in process.env (which a session
// can't reach from a Bash tool call). Read the last assistant text block from the Stop transcript.
function replyTextHasCheckpointEscape(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  try {
    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      let entry; try { entry = JSON.parse(lines[index]); } catch { continue; }
      const role = entry?.message?.role || entry?.role;
      if (role !== 'assistant') continue;
      const blocks = entry?.message?.content ?? entry?.content ?? [];
      const replyText = typeof blocks === 'string' ? blocks
        : (Array.isArray(blocks) ? blocks.map((block) => (typeof block === 'string' ? block : block?.text || '')).join(' ') : '');
      return /\bAGENT_CHECKPOINT_STOP_OK\b/.test(replyText);
    }
    return false;
  } catch { return false; }
}

function pulseLogHasRecentCheckpointEntry() {
  if (!existsSync(PULSE_LOG)) return false;
  try {
    const raw = readFileSync(PULSE_LOG, 'utf8');
    const cutoff = Date.now() - CHECKPOINT_WINDOW_MS;
    for (const line of raw.split('\n')) {
      if (!/Agent:\s*(?:Plan|Replan|Progress):/i.test(line)) continue;
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:]+Z?)\]/);
      if (!m) continue;
      try { if (new Date(m[1]).getTime() >= cutoff) return true; } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }

  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'Stop') {
    process.exit(0);
    return;
  }

  // An agent-owned handoff is the platform-neutral identity signal. Check it
  // before Claude-specific transcript detection so Codex collaboration lanes
  // cannot stop while their durable checkpoint remains nonterminal.
  const incompleteHandoffPath = readIncompleteHandoff(event.cwd || process.cwd());
  if (incompleteHandoffPath) {
    // Don't block an ORCHESTRATOR parked in a live delegate's worktree: if a background agent is
    // actively pulsing this handoff's task, its real owner is alive and this session doesn't own it.
    if (handoffOwnerHasLivePulse(handoffOwnerLabel(incompleteHandoffPath))) { process.exit(0); return; }
    // Escape parity: the token works from the final assistant reply, not only process.env.
    if (replyTextHasCheckpointEscape(event.transcript_path || '')) { process.exit(0); return; }
    const reason = `STOP BLOCKED — AGENT-HANDOFF.md still says ACTIVE or IN PROGRESS.\n\n` +
      `A phase checkpoint, partial benchmark, or newly found wall is not completion. Resume the NEXT section now. ` +
      `Only stop after changing STATUS to DONE (objective achieved) or BLOCKED (genuine external blocker).\n\n` +
      `Handoff: ${incompleteHandoffPath}\n` +
      `Escape: put AGENT_CHECKPOINT_STOP_OK=1 in env OR the literal token AGENT_CHECKPOINT_STOP_OK in your reply. ` +
      `(If a live delegated agent owns this handoff, this session is exempt automatically while that agent pulses.)`;
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
    return;
  }

  // Pulse enforcement still applies only to Claude-style subagent transcripts.
  // Parent sessions and terminal Codex lanes are exempt here.
  if (!isSubagentTranscript(event.transcript_path || '')) {
    process.exit(0);
    return;
  }

  // Prevent infinite re-blocking
  if (event.stop_hook_active) {
    process.exit(0);
    return;
  }

  if (pulseLogHasRecentCheckpointEntry()) {
    process.exit(0);
    return;
  }

  // Block — agent hasn't emitted Plan:/Progress: checkpoints in this run
  const reason = `STOP BLOCKED — you (the background subagent) did not emit Plan: or Progress: checkpoint pulses during this run.

Russell's rule: every background agent must emit a Plan: before work starts and Progress: as checkpoints clear, so he sees structured progress without polling git.

Before completing, emit at minimum:
  1. Plan: N checkpoints - <brief list of what you did>
  2. Progress: N/N - <what the final state is, any open issues>

[<ISO timestamp>] [<TASK NAME from your brief>] Agent: Plan: <N> checkpoints - <list>
[<ISO timestamp>] [<TASK NAME from your brief>] Agent: Progress: <N>/<N> - <summary>

How (bash):
  PULSE=/c/Users/rmill/Desktop/programming/.claude/state/agent-pulse.log
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "[$ts] [<TASK NAME>] Agent: <summary>" >> "$PULSE"

How (Node):
  import { appendFileSync } from 'node:fs';
  const PULSE = '/c/Users/rmill/Desktop/programming/.claude/state/agent-pulse.log';
  const ts = new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z');
  appendFileSync(PULSE, \`[\${ts}] [<TASK NAME>] Agent: <summary>\\n\`);

Then try to stop again. The hook will check for the entry and allow stop on the second pass.`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  try { main(); } catch { process.exit(0); }
}
