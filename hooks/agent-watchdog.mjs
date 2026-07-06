#!/usr/bin/env node
/**
 * agent-watchdog — detect a background agent that DIED SILENTLY and force recovery from its last commit.
 * The resilience system, parts 2-4 (registry + watchdog + recovery protocol), in one dual-event hook.
 *
 * Why (2026-06-20): a worktree agent mapped the code, pulsed "resolving propagation, then TDD," then went
 * quiet — no completion, no commit, no worktree. We only noticed hours later; the work was gone. A pulse
 * tells you an agent died; a commit is what you recover. This watchdog is the "you died" detector.
 *
 * Two events:
 *   • PostToolUse(Agent) — RECORD the spawn (agentId, label, isolation, time) into the live-agents
 *     registry, so the watchdog can name a dead agent and point at its branch.
 *   • Stop — if a background agent is still active (spawned, no completed/killed task-notification) AND the
 *     pulse log has gone STALE (no new pulse from anyone in STALE_MS), the agent has likely died. BLOCK
 *     with the recovery protocol: find its worktree branch + last commit, respawn pointed at it to continue
 *     (git is the checkpoint — see agent-commit-cadence). An ACK marker prevents nagging every Stop: a
 *     given stall is flagged once, then stays quiet until fresh pulse activity resumes.
 *
 * Paths are env-overridable (tests point them at temp files):
 *   WATCHDOG_PULSE_LOG, WATCHDOG_REGISTRY, WATCHDOG_ACK, WATCHDOG_STALE_MS.
 * Fail-open on any error — never permanently block CC.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = resolve(homedir(), 'Desktop', 'programming', '.claude', 'state');
const PULSE_LOG = process.env.WATCHDOG_PULSE_LOG || resolve(STATE_DIR, 'agent-pulse.log');
const REGISTRY = process.env.WATCHDOG_REGISTRY || resolve(STATE_DIR, 'live-agents.json');
const ACK_FILE = process.env.WATCHDOG_ACK || resolve(homedir(), '.claude', 'state', 'agent-watchdog-ack.json');
const STALE_MS = Number(process.env.WATCHDOG_STALE_MS) || 10 * 60 * 1000; // 10 min of silence = suspect dead
const REGISTRY_TTL_MS = Number(process.env.WATCHDOG_REGISTRY_TTL_MS) || 12 * 60 * 60 * 1000; // 12 hr — keep a dead agent NAMEABLE/reapable by id long enough to TaskStop it (a 1-hr TTL pruned a 2h50m zombie before it could be named, 2026-07-06)

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function writeJson(path, contents) {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(contents, null, 2), 'utf8'); } catch { /* fail open */ }
}

// Read a worktree agent's own handoff/state file (agent-handoff-required.mjs makes every write-agent keep one
// at AGENT-HANDOFF.md). Lets the watchdog (a) tell "finished, didn't report" (STATUS: DONE) from "stalled",
// and (b) hand the recovery a real RESUME point — goal/done/next — instead of a bare branch sha. Returns
// { found, done, summary } or { found:false }. projectDir is the Stop event's cwd (where .claude/worktrees lives).
function readAgentHandoff(projectDir, agentId) {
  if (!projectDir || !agentId) return { found: false };
  const handoffPath = resolve(projectDir, '.claude', 'worktrees', `agent-${agentId}`, 'AGENT-HANDOFF.md');
  if (!existsSync(handoffPath)) return { found: false };
  try {
    const body = readFileSync(handoffPath, 'utf8');
    const done = /\bSTATUS:\s*DONE\b/i.test(body);
    const summary = body.replace(/\s+/g, ' ').trim().slice(0, 220);
    return { found: true, done, summary };
  } catch { return { found: false }; }
}

// ── active-agent detection (borrowed verbatim from pulse-on-agent-activity / never-idle) ──────────────
// A spawned background agent is ACTIVE until a <task-notification> with status completed|killed clears it.
function hasActiveAgents(transcriptText) {
  if (!transcriptText) return false;
  const spawnIds = new Set();
  const agentRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,200}?"name"\s*:\s*"Agent"[\s\S]{0,3000}?"run_in_background"\s*:\s*true/g;
  for (const match of transcriptText.matchAll(agentRe)) spawnIds.add(match[1]);
  if (spawnIds.size === 0) return false;
  for (const notification of transcriptText.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    if (!/<status>\s*(completed|killed)\s*<\/status>/i.test(notification[1])) continue;
    const idMatch = notification[1].match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
    if (idMatch) spawnIds.delete(idMatch[1]);
  }
  return spawnIds.size > 0;
}

function pulseLogState() {
  if (!existsSync(PULSE_LOG)) return { lines: 0, ageMs: Infinity };
  try {
    const raw = readFileSync(PULSE_LOG, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim()).length;
    const ageMs = Date.now() - statSync(PULSE_LOG).mtimeMs;
    return { lines, ageMs };
  } catch { return { lines: 0, ageMs: Infinity }; }
}

// ── Prune registry entries older than REGISTRY_TTL_MS ────────────────────────────────────────────────
function pruneRegistry(registry) {
  const cutoff = Date.now() - REGISTRY_TTL_MS;
  const pruned = {};
  for (const [id, record] of Object.entries(registry)) {
    if (typeof record.spawnedAt === 'number' && record.spawnedAt < cutoff) continue; // drop stale
    pruned[id] = record;
  }
  return pruned;
}

// ── PostToolUse(Agent): record the spawn into the registry ────────────────────────────────────────────
function onAgentSpawn(event) {
  const input = event.tool_input || {};
  const spawnResponse = typeof event.tool_response === 'string' ? event.tool_response : JSON.stringify(event.tool_response || '');
  const idMatch = spawnResponse.match(/agentId[:\s"]+([a-z0-9]{8,})/i);
  if (!idMatch) return; // couldn't find the agent id — nothing to record
  const registry = pruneRegistry(readJson(REGISTRY, {})); // drop entries older than 1 hr
  registry[idMatch[1]] = {
    label: input.description || '(unnamed)',
    isolation: input.isolation || '',
    briefHead: String(input.prompt || '').replace(/\s+/g, ' ').slice(0, 100),
    spawnedAt: Date.now(),
  };
  writeJson(REGISTRY, registry);
}

// ── Stop: flag a silent (likely dead) active agent, once per stall ────────────────────────────────────
function onStop(event) {
  if (event.stop_hook_active) return;
  let transcriptText = '';
  try { transcriptText = event.transcript_path && existsSync(event.transcript_path) ? readFileSync(event.transcript_path, 'utf8') : ''; } catch { return; }
  if (!hasActiveAgents(transcriptText)) return; // no running agent → nothing to watch

  const { lines, ageMs } = pulseLogState();
  if (ageMs < STALE_MS) return; // fresh pulse activity → the agent is alive

  // Stale + active → suspect death. Flag ONCE per stall (don't nag every Stop).
  const ack = readJson(ACK_FILE, { flaggedAtLines: -1 });
  if (ack.flaggedAtLines === lines) return; // already flagged THIS stall (no new pulses since)
  writeJson(ACK_FILE, { flaggedAtLines: lines, at: Date.now() });

  const registry = pruneRegistry(readJson(REGISTRY, {}));
  writeJson(REGISTRY, registry); // persist the pruned state
  const staleMin = Math.round(ageMs / 60000);

  // Read each recorded agent's OWN handoff (agent-handoff-required guarantees one). Skip any that wrote
  // STATUS: DONE — finished, just never sent a completed task-notification (not a death). The rest are the
  // real suspects, and we hand the recovery their actual goal/done/next so the resume is one mechanical step.
  const projectDir = event.cwd || process.cwd();
  const suspects = [];
  let doneCount = 0;
  for (const [id, record] of Object.entries(registry)) {
    const handoff = readAgentHandoff(projectDir, id);
    if (handoff.found && handoff.done) { doneCount += 1; continue; }
    suspects.push({ id, label: record.label, branch: `worktree-agent-${id}`, handoff });
  }
  // If every recorded agent self-reports DONE, there's nothing to recover — don't nag.
  if (suspects.length === 0 && doneCount > 0) return;

  const suspectBlock = suspects.length
    ? suspects.map((agent) => {
        const state = agent.handoff.found ? `\n      state: ${agent.handoff.summary}` : '\n      (no AGENT-HANDOFF.md — recover from git diff if you resume)';
        return `  • ${agent.label} (${agent.id})\n      → REAP IT: TaskStop task_id="${agent.id}"${state}`;
      }).join('\n')
    : '  (registry empty — the dead agent spawned >12h ago, or was a GRANDCHILD spawned by another agent (no id handle); check `git worktree list`)';

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      `⚠️ AGENT WATCHDOG — background agent(s) SILENT ~${staleMin} min (no pulse) — likely DEAD.`,
      `Only TaskStop (yours) or the panel ✕ can kill a Claude task agent — watchtower/any external monitor CANNOT.`,
      `So REAP them right here, by id:`,
      '',
      'Dead agent(s) — for EACH, KILL it (default) or RESUME it:',
      suspectBlock,
      '',
      'KILL (default — a finished/dead/zombie agent): run the `TaskStop task_id="..."` shown above. That reaps it;',
      '  Russell never has to touch the panel ✕. This is the whole point — do it, do not just resume.',
      'RESUME (ONLY if its AGENT-HANDOFF NEXT shows unfinished VALUABLE work worth saving): spawn a fresh worktree',
      '  agent on `worktree-agent-<id>` — "read AGENT-HANDOFF.md, CONTINUE from NEXT, do not restart."',
      'Clears once you have TaskStopped (or resumed) each. If one is genuinely mid-long-step, say so — quiet until',
      'fresh pulse activity resumes.',
    ].join('\n'),
  }));
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName === 'PostToolUse' && (event.tool_name || '') === 'Agent') onAgentSpawn(event);
  else if (eventName === 'Stop') onStop(event);
  process.exit(0);
}

main();
