#!/usr/bin/env node
/**
 * agent-monitor-cadence — Stop hook WITH TEETH. Forces the ORCHESTRATOR (the main
 * conversation that spawned background agents) to PERIODICALLY verify those agents
 * are alive, so the user is never the one who has to notice an agent died.
 *
 * The rule: the orchestrator must attend to its agents on a cadence — not wait for the
 * user to spot a dead one on a dashboard.
 *
 * Fires on Stop. Blocks the stop when ALL of:
 *   1. there is at least one ACTIVE background agent (spawned run_in_background:true,
 *      no completed/killed task-notification yet), AND
 *   2. it has been > CADENCE_MS since the last VERIFIED monitor check, AND
 *   3. the recent transcript shows NO git check against an agent branch since then.
 *
 * The block is satisfied by ACTUALLY running a `git log/rev-list/... worktree-agent-*`
 * command (evidence in the transcript tail) and reporting — not by words. Has teeth:
 * `decision: 'block'` re-prompts the orchestrator until it complies.
 *
 * Fail-open on any unexpected error — never permanently trap a session.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const STATE_FILE = resolve(homedir(), '.claude', 'state', 'last-agent-monitor.json');
const CADENCE_MS = 6 * 60 * 1000;        // re-require a check at most every 6 min
const TRANSCRIPT_TAIL_BYTES = 60 * 1024; // only the recent end of the transcript is "since last check"

function readStopEvent() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  try {
    return readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
}

// Reuse the authoritative active-agent detection: a spawned run_in_background:true Agent
// whose tool-use id has NOT been cleared by a completed/killed task-notification.
function activeAgentCount(transcript) {
  if (!transcript) return 0;
  const liveSpawnIds = new Set();
  const agentRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,200}?"name"\s*:\s*"Agent"[\s\S]{0,3000}?"run_in_background"\s*:\s*true/g;
  for (const spawnMatch of transcript.matchAll(agentRe)) liveSpawnIds.add(spawnMatch[1]);
  if (liveSpawnIds.size === 0) return 0;
  const notificationRe = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const notification of transcript.matchAll(notificationRe)) {
    const notificationBody = notification[1];
    if (!/<status>\s*(completed|killed)\s*<\/status>/i.test(notificationBody)) continue;
    const idMatch = notificationBody.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
    if (idMatch) liveSpawnIds.delete(idMatch[1]);
  }
  return liveSpawnIds.size;
}

// Did the orchestrator run a git check against an agent branch recently? We look only at
// the TAIL of the transcript so stale evidence from much earlier doesn't satisfy the gate.
function recentlyCheckedAgents(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  try {
    const fullTranscript = readFileSync(transcriptPath, 'utf8');
    const recentTail = fullTranscript.length > TRANSCRIPT_TAIL_BYTES ? fullTranscript.slice(-TRANSCRIPT_TAIL_BYTES) : fullTranscript;
    return /worktree-agent-[a-z0-9]/i.test(recentTail) && /\bgit\b|rev-list|git log|--format/i.test(recentTail);
  } catch {
    return false;
  }
}

function readMonitorState() {
  if (!existsSync(STATE_FILE)) return { last_checked_at: 0 };
  try {
    const parsedState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { last_checked_at: typeof parsedState.last_checked_at === 'number' ? parsedState.last_checked_at : 0 };
  } catch {
    return { last_checked_at: 0 };
  }
}

function writeMonitorState(monitorState) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(monitorState), 'utf8');
  } catch { /* fail open */ }
}

function blockStop(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function main() {
  const stopEvent = readStopEvent();
  const eventName = stopEvent.hook_event_name || stopEvent.hookEventName || '';
  if (eventName !== 'Stop') process.exit(0);
  if (stopEvent.stop_hook_active) process.exit(0); // never loop

  const transcriptPath = stopEvent.transcript_path || stopEvent.transcriptPath || '';
  const transcript = readTranscript(transcriptPath);
  const liveAgents = activeAgentCount(transcript);
  if (liveAgents === 0) process.exit(0); // nothing to monitor

  const now = Date.now();
  const monitorState = readMonitorState();

  // If the orchestrator just checked the agents (evidence in the transcript tail),
  // record it and allow the stop — and reset the cadence timer.
  if (recentlyCheckedAgents(transcriptPath)) {
    writeMonitorState({ last_checked_at: now });
    process.exit(0);
  }

  // No fresh check. If we're still inside the cadence window, allow (don't nag every turn).
  if (now - monitorState.last_checked_at < CADENCE_MS) process.exit(0);

  // Cadence elapsed AND no fresh check → force one.
  const staleMinutes = Math.round((now - monitorState.last_checked_at) / 60000);
  blockStop(`STOP BLOCKED — you have ${liveAgents} live background agent${liveAgents === 1 ? '' : 's'} and have not verified ${liveAgents === 1 ? 'it' : 'them'} in ~${staleMinutes} min. The user should NOT be the one who notices an agent died.

Before you stop, ATTEND to your agents (this is your job, not theirs):
1. For each live agent branch, check commit recency — alive vs dead:
   git log --oneline -1 --format="%h %cr | %s" worktree-agent-<id>
   (recent commit = working; many minutes stale = likely dead -> salvage its branch.)
2. Report each agent in one line: name - alive/dead - last commit - progress.
3. If one died, say what you'll do (resume / re-spawn / merge its banked work).

Running any \`git ... worktree-agent-*\` check in this turn satisfies this gate. Then stop again — it won't re-fire for ${Math.round(CADENCE_MS / 60000)} min.`);
}

// Entry-point guard: importing this file (e.g. in its test) must NOT run main(),
// because main() reads stdin (fd 0) and would hang the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

export { activeAgentCount, recentlyCheckedAgents };
