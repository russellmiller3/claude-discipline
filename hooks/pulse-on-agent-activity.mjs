#!/usr/bin/env node
/**
 * Pulse hook — surfaces background-agent progress to Russell automatically,
 * but THROTTLED so it doesn't dump a pulse on every short reply.
 *
 * Fires on two events:
 *   1. PreToolUse(Agent)  — when Claude spawns a new subagent, always run
 *                           pulse so Russell sees baseline at spawn.
 *   2. Stop                — IF any agent is still running AND something has
 *                           CHANGED since the last pulse (new commit OR
 *                           5+ minutes elapsed), emit pulse; otherwise stay
 *                           silent. Russell sees pulses on genuine activity
 *                           events, not on every assistant turn.
 *
 * State file: ~/.claude/state/last-pulse.json — { last_emitted_at, last_sha }
 *
 * Throttle rules (Stop event only — PreToolUse always fires):
 *   - Emit IF the top commit SHA on feature/lenat-in-clear has changed since
 *     last pulse (a new cycle landed).
 *   - Emit IF 5+ minutes have elapsed since last pulse (heartbeat for stall
 *     detection — even without new commits, every 5 min Russell sees state).
 *   - Otherwise stay silent.
 *
 * Fail-open on any unexpected error — never permanently block CC.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PULSE_SCRIPT = resolve(homedir(), 'Desktop', 'programming', '.claude', 'state', 'pulse.cjs');
const PULSE_LOG = resolve(homedir(), 'Desktop', 'programming', '.claude', 'state', 'agent-pulse.log');
const STATE_FILE = resolve(homedir(), '.claude', 'state', 'last-pulse.json');
const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Find a git repo under the programming root that has commits — used to
 * detect "did a new commit land?" for pulse throttling. Generic: walks
 * sibling directories rather than hardcoding any one project.
 * Returns the most-recently-active repo path, or null.
 */
function activeRepo() {
  const root = resolve(homedir(), 'Desktop', 'programming');
  if (!existsSync(root)) return null;
  try {
    const dirs = require('node:fs').readdirSync(root);
    let best = null;
    let bestMtime = 0;
    for (const d of dirs) {
      const repoDir = resolve(root, d);
      const gitDir = resolve(repoDir, '.git');
      if (!existsSync(gitDir)) continue;
      try {
        const m = require('node:fs').statSync(resolve(gitDir, 'HEAD')).mtimeMs;
        if (m > bestMtime) { bestMtime = m; best = repoDir; }
      } catch {}
    }
    return best;
  } catch { return null; }
}

function runPulse() {
  if (!existsSync(PULSE_SCRIPT)) return null;
  const result = spawnSync('node', [PULSE_SCRIPT], { encoding: 'utf8', shell: false, timeout: 4000 });
  if (result.error || result.status !== 0) return null;
  const out = (result.stdout || '').trim();
  if (!out) return null;
  return out;
}

function currentTopSha() {
  // Derive from current HEAD of the most-recently-active sibling repo.
  // Generic — no specific branch or project hardcoded.
  const repo = activeRepo();
  if (!repo) return null;
  const result = spawnSync('git', ['log', '-1', '--format=%H', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
    shell: false,
    timeout: 2000,
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').trim() || null;
}

function readState() {
  if (!existsSync(STATE_FILE)) return { last_emitted_at: 0, last_sha: '', last_pulse_log_lines: 0 };
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      last_emitted_at: typeof data.last_emitted_at === 'number' ? data.last_emitted_at : 0,
      last_sha: typeof data.last_sha === 'string' ? data.last_sha : '',
      last_pulse_log_lines: typeof data.last_pulse_log_lines === 'number' ? data.last_pulse_log_lines : 0,
    };
  } catch {
    return { last_emitted_at: 0, last_sha: '', last_pulse_log_lines: 0 };
  }
}

function currentPulseLogLines() {
  if (!existsSync(PULSE_LOG)) return 0;
  try {
    const raw = readFileSync(PULSE_LOG, 'utf8');
    return raw.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function writeState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // fail open — state-file write failure shouldn't break the hook
  }
}

/**
 * Returns the REASON to emit a pulse, or null to stay silent.
 * Reasons: "new commit", "new narrative event", "heartbeat 5min", or null.
 */
function shouldEmit(state) {
  const now = Date.now();
  const topSha = currentTopSha();
  const pulseLogLines = currentPulseLogLines();

  if (topSha && topSha !== state.last_sha) {
    return { reason: 'new commit', topSha, pulseLogLines, now };
  }
  if (pulseLogLines > state.last_pulse_log_lines) {
    const delta = pulseLogLines - state.last_pulse_log_lines;
    return { reason: `${delta} new narrative event${delta === 1 ? '' : 's'}`, topSha: topSha || state.last_sha, pulseLogLines, now };
  }
  if (now - state.last_emitted_at >= HEARTBEAT_MS) {
    return { reason: 'heartbeat 5min', topSha: topSha || state.last_sha, pulseLogLines, now };
  }
  return null;
}

function readTranscriptText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  try { return readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
}

/**
 * Returns true if the transcript shows at least one spawned background subagent
 * that has not yet completed. Borrows the exact detection from never-idle.mjs.
 */
export function hasActiveAgents(raw, projectDir) {
  if (!raw) return false;

  // Background agents are ALWAYS worktree-isolated (the worktree-on-agent-spawn gate requires it), so an
  // agent is still active IFF its worktree directory still exists on disk. This is the GROUND-TRUTH
  // liveness signal, and the reason this is worktree-based rather than notification-based:
  //   - a COMPLETED agent → orchestrator merged + removed its worktree → gone → not active.
  //   - a DEAD agent (died silently, e.g. the relay agent that launched then vanished) → its worktree was
  //     auto-removed → gone → not active. A task-notification can be MISSED (a silent death never sends
  //     one), which is exactly what wedged the old notification-based check into forcing a pulse forever.
  //   - a still-RUNNING agent → its worktree exists → active.
  //   - a DENIED spawn never launched, so it has no "agentId:" line and never counts.
  // The agentId comes from the launch result ("Async agent launched successfully ... agentId: <id>"); the
  // worktree lives at <projectDir>/.claude/worktrees/agent-<id>.
  const launchedAgentIds = new Set();
  for (const m of raw.matchAll(/Async agent launched successfully[\s\S]{0,200}?agentId:\s*([a-z0-9]+)/gi)) {
    launchedAgentIds.add(m[1]);
  }
  if (launchedAgentIds.size === 0) return false;
  if (!projectDir) return true; // no project dir to resolve worktrees against — be conservative (active)

  const worktreesDir = resolve(projectDir, '.claude', 'worktrees');
  for (const agentId of launchedAgentIds) {
    if (existsSync(resolve(worktreesDir, `agent-${agentId}`))) return true; // a live worktree = active
  }
  return false; // every launched agent's worktree is gone → all completed or dead → nothing to pulse
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

  // PreToolUse(Agent): two responsibilities.
  // (1) GATE — block any spawn whose prompt is missing a reference to the
  //     pulse-emission contract. Forces Claude to include it every time.
  // (2) PULSE — on a valid spawn, emit baseline pulse so Russell sees the
  //     starting state of the new agent.
  if (eventName === 'PreToolUse') {
    const toolName = event.tool_name || '';
    if (toolName !== 'Agent') {
      process.exit(0);
      return;
    }
    const prompt = (event.tool_input && event.tool_input.prompt) || '';
    const description = (event.tool_input && event.tool_input.description) || '(unnamed)';
    const runInBackground = !!(event.tool_input && event.tool_input.run_in_background === true);

    // Opt-out tokens (Russell, 2026-06-27):
    //   FOREGROUND_OK       — marks a genuinely quick READ-ONLY one-shot that may run foreground + skip pulses
    //                         (self-serve; low risk because Russell watches it finish inline).
    //   NO_PULSE_RUSSELL_OK — Russell's EXPLICIT approval to skip pulses on a background/long agent. Claude may
    //                         add this ONLY after asking Russell and getting a yes — never self-grant it.
    const foregroundOk = /\bFOREGROUND_OK\b/.test(prompt);
    const russellApprovedNoPulse = /\bNO_PULSE_RUSSELL_OK\b/.test(prompt);

    // GATE 0 — BACKGROUND BY DEFAULT. A foreground agent dies the instant Russell presses Stop to ask a
    // question, so every real work-agent must launch in the background (run_in_background:true). The ONLY
    // foreground exception is a quick read-only one-shot, explicitly marked FOREGROUND_OK.
    if (!runInBackground && !foregroundOk) {
      const reason = `Agent spawn BLOCKED — agents must launch in the BACKGROUND.

Russell's rule (2026-06-27): a FOREGROUND agent is killed the moment Russell presses Stop to ask a question — so he loses all in-flight work and has no way to check progress without destroying it. Launch every work-agent with run_in_background: true; it survives his interrupts and pulses to the Control Tower.

Fix: re-spawn the Agent with run_in_background: true.
Only exception — a genuinely quick READ-ONLY one-shot (a map/search that finishes in well under a minute and writes nothing): add the marker FOREGROUND_OK to the brief.`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }));
      process.exit(0);
      return;
    }

    // GATE: prompt must reference the pulse contract. Detection is
    // permissive — any of these markers passes:
    //   - "AGENT-PULSE-CONTRACT" (file name)
    //   - "agent-pulse.log" (the log file path)
    //   - "pulse contract" (prose reference)
    //   - "EMIT PULSES" / "emit pulses" / "emit a pulse" (explicit instruction)
    //   - "[TASK NAME] Agent:" (the format itself, included as example)
    // OPT-OUT (Russell, 2026-06-27): a background agent can NO LONGER self-skip pulses. The bare
    // NO_PULSE_CONTRACT marker is retired — skipping pulses now requires either FOREGROUND_OK (a quick
    // read-only foreground one-shot) or NO_PULSE_RUSSELL_OK (Russell's explicit, asked-for approval).
    const hasContract = /AGENT-PULSE-CONTRACT|agent-pulse\.log|pulse[- ]?contract|emit[ -](?:a |the )?pulse|emit pulses|\[TASK NAME\]|\[Phase \d|narrative pulse/i.test(prompt);
    const explicitOptOut = foregroundOk || russellApprovedNoPulse;

    if (!hasContract && !explicitOptOut) {
      const reason = `Agent spawn BLOCKED — the brief for "${description}" is missing the pulse-emission contract.

Russell's rule (2026-05-13, tightened 2026-06-27): every background agent must emit plain-English narrative progress to programming/.claude/state/agent-pulse.log so Russell sees what it's doing without polling or pressing Stop (which kills it).

Fix (preferred): add a pulse section to the brief — reference C:/Users/rmill/Desktop/programming/.claude/state/AGENT-PULSE-CONTRACT.md and tell the agent to emit "[Task Name] Agent: <status>" at least every 60 SECONDS (the deadman monitor flags silence > 2 min as dead), plus a Plan/Progress checkpoint. CRITICAL: any command expected to run > 60s (a test suite, a build, a long install) MUST be run in the BACKGROUND and polled — emit a heartbeat pulse each poll — because a long FOREGROUND command makes the agent go silent and trip the 2-min deadman.

Skipping pulses is NO LONGER self-serve:
- FOREGROUND_OK — only for a quick READ-ONLY foreground one-shot.
- NO_PULSE_RUSSELL_OK — requires Russell's explicit yes (ASK him first; never self-grant). The "unless you ask me and I let you" path he mandated.`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }));
      process.exit(0);
      return;
    }

    // NAME GATE (#1): the description IS the dashboard card title and the Goal
    // text. A generic name ("bug fixes", "work", "task") gives Russell a board
    // of indistinguishable cards. Require a specific, descriptive name. Opt-out:
    // NO_PULSE_CONTRACT (already handled above for read-only one-shots).
    const GENERIC_NAME = /^(?:bug\s*fixes?|fixes?|work|task|stuff|things?|misc|tmp|test|agent|todo|changes?|updates?|do\s+it|help)\.?$/i;
    const wordCount = description.trim().split(/\s+/).filter(Boolean).length;
    if (!explicitOptOut && (GENERIC_NAME.test(description.trim()) || wordCount < 2 || description.trim().length < 8)) {
      const reason = `Agent spawn BLOCKED — the agent name "${description}" is too generic.

Russell's rule (2026-06-22): the description is the dashboard card title — a board full of "bug fixes" / "work" cards is unreadable. Give each agent a SPECIFIC name describing what it's focused on.

Bad: "bug fixes", "work", "task", "changes"
Good: "Fix phantom user messages in voice chat", "Add run/expand/delete to Recipes panel"

Re-attempt with a descriptive description (4+ words, names the actual feature/area).`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }));
      process.exit(0);
      return;
    }

    // PLAN GATE (#5): every agent must declare a checkpoint plan so the dashboard
    // shows real progress, not just a goal. The brief must instruct the agent to
    // emit a Plan: line. (The Goal is auto-written below; the Plan must come from
    // the agent's own work, so we require the brief to ask for it.) Opt-out: same
    // NO_PULSE_CONTRACT marker for genuine read-only one-shots.
    const hasPlanInstruction = /\bPlan:\b|checkpoint|\bplan\b[\s\S]{0,40}\b(steps?|checkpoints?)\b|emit\s+(?:a\s+)?plan/i.test(prompt);
    if (!explicitOptOut && !hasPlanInstruction) {
      const reason = `Agent spawn BLOCKED — the brief for "${description}" never tells the agent to emit a checkpoint Plan.

Russell's rule (2026-06-22): every agent must have BOTH a goal AND a plan on the dashboard. The goal is auto-written; the plan must come from the agent. Tell it (verbatim or close):

  "Before real work starts, emit: Plan: N checkpoints - <brief list>. Then emit Progress: X/N - <what cleared> as each checkpoint completes."

Re-attempt with a Plan instruction in the brief. Opt-out for read-only one-shots: NO_PULSE_CONTRACT.`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }));
      process.exit(0);
      return;
    }

    // GOAL PULSE: the orchestrator rule requires a Goal: entry before spawn.
    // Write it automatically so the orchestrator never forgets. Description
    // field is the plain-English task summary passed to Agent().
    try {
      mkdirSync(dirname(PULSE_LOG), { recursive: true });
      const iso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      appendFileSync(PULSE_LOG, `[${iso}] [${description}] Agent: Goal: ${description}.\n`);
    } catch {}

    // PULSE: emit baseline so Russell sees starting state at agent kickoff.
    const pulse = runPulse();
    if (!pulse) {
      process.exit(0);
      return;
    }
    const message = `PULSE — agent spawn: ${description}\n\n${pulse}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message,
      },
    }));
    process.exit(0);
    return;
  }

  // Stop: throttled. Only emit pulse if (a) a new commit landed since last
  // pulse, OR (b) 5+ minutes have elapsed since last pulse. Stays silent on
  // every short reply where nothing changed.
  if (eventName === 'Stop') {
    if (event.stop_hook_active) {
      process.exit(0);
      return;
    }
    const transcript = readTranscriptText(event.transcript_path);
    if (!hasActiveAgents(transcript, event.cwd)) {
      process.exit(0);
      return;
    }
    const state = readState();
    const decision = shouldEmit(state);
    if (!decision) {
      process.exit(0); // throttled — nothing to say
      return;
    }
    const pulse = runPulse();
    if (!pulse) {
      process.exit(0);
      return;
    }
    writeState({
      last_emitted_at: decision.now,
      last_sha: decision.topSha || '',
      last_pulse_log_lines: decision.pulseLogLines,
    });
    // Stop hooks surface info to Claude via decision: 'block' with reason.
    // The block tells Claude "you can't stop yet — here's a pulse you must
    // surface to Russell in your reply." After Claude includes the pulse in
    // its reply and the next Stop fires, the throttle won't re-emit (same
    // SHA, <5min elapsed), so Claude can stop cleanly.
    const reason = `PULSE (reason: ${decision.reason}) — surface this in your reply so Russell sees fresh agent activity. Russell explicitly asked for throttled ambient pulses; this fires ONLY on new commits or 5min heartbeats, not every reply. Include the box verbatim in your next message to Russell:

${pulse}`;
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
    return;
  }

  process.exit(0);
}

// Entry-point guard: only run when invoked directly (node pulse-on-agent-activity.mjs), NOT when a test
// imports hasActiveAgents — main() reads stdin via readFileSync(0) and would hang the importing process.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
