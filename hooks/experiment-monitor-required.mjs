#!/usr/bin/env node
// =============================================================================
// EXPERIMENT-MONITOR-REQUIRED — a live Monitor must exist BEFORE a launch runs
// =============================================================================
//
// new-hook-category: Benchmark / long-run discipline — nearest existing is pod-launch-durability-guard; it does NOT cover this because it fires on WRITING launcher code, not on RUNNING a launch, and never requires a live Monitor.
//
// WHY (Russell, 2026-07-16, verbatim): "I want the monitor created BEFORE the
// experiment launches" + "it should be a GLOBAL hook."
//
// THE GAP: starting an experiment by RUNNING a Bash command (runpod_exp153.py
// launch, `modal run`, `python .../modal_*.py`) had NO enforcement that a live
// Monitor was attached. pod-launch-durability-guard only fires when launcher CODE
// is WRITTEN — it never sees a launch actually RUN, and never requires a Monitor.
// A paid pod/experiment could therefore start with nobody watching it, and a
// death (or a silent stall) went unnoticed for a whole session.
//
// HOW IT WORKS
// ============
//   PRIMARY TEETH — PreToolUse on Bash: if the command is an experiment LAUNCH
//   and NO Monitor tool-use exists yet in the transcript, DENY. This enforces
//   monitor-BEFORE-launch: you must start a Monitor first, then launch.
//
//   BACKSTOP — Stop: if a launch happened this session and the last Monitor is
//   BEFORE the last launch (or there is no Monitor at all), BLOCK. This catches a
//   launch that ran some other way, or a re-launch whose Monitor went stale — the
//   invariant "every launch is covered by a live Monitor" is asserted on the
//   resulting STATE, not just at the moment of the launch action.
//
//   LINK REQUIREMENT (Russell, 2026-07-16, verbatim: "when you create monitor you
//   must give me link"): a chat-only Monitor isn't enough. When a launch + Monitor
//   exist, Stop ALSO BLOCKS unless a watch LINK (an http(s) URL, localhost:PORT, or a
//   *-live.html watch page) was given to Russell this session — so he always has a
//   browser page to WATCH the paid run, not just terminal notifications.
//
// TEETH: PreToolUse permissionDecision 'deny'; Stop decision 'block'.
// Launch detection is precise (see isLaunchCommand) so prose/finalize/help/reads
// never false-positive. Escape: EXPERIMENT_MONITOR_REQUIRED_OK=1 in env, or the
// literal token EXPERIMENT_MONITOR_REQUIRED_OK in the reply/command. Respects
// stop_hook_active (never loops). FAILS OPEN on any error. basename entry-guard.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, toolUsesOf, lastAssistantText } from './lib/transcript.mjs';

const ENV_OVERRIDE = 'EXPERIMENT_MONITOR_REQUIRED_OK';
const ESCAPE_TOKEN = /\bEXPERIMENT_MONITOR_REQUIRED_OK\b/;
const MONITOR_TOOL = 'Monitor';
// A watch LINK Russell can open: an http(s) URL, a localhost:PORT, or a *-live.html
// watch page. Russell's rule (2026-07-16): a Monitor must come with a link.
const LINK_RE = /(https?:\/\/\S+)|(?:localhost|127\.0\.0\.1):\d+|[\w.-]+-live\.html/i;

// A launch is one of: a runpod launcher run with the `launch` verb; a `modal run`;
// or a python invocation of a modal_*.py job script.
// Forward order only — the runpod launcher is INVOKED then handed the `launch`
// subcommand (`python runpod_exp153.py launch`). Requiring file-then-launch avoids
// matching a `grep launch runpod_exp153.py` that merely searches the file.
const RUNPOD_LAUNCH = /runpod_\w*\.py\b[\s\S]*\blaunch\b/;
const MODAL_RUN = /\bmodal\s+run\b/;
const PYTHON_MODAL = /\b(?:python[0-9.]*|py)\b[\s\S]*\bmodal_\w*\.py\b/;

// Anything that is NOT a real spend-and-run: help, dry runs, smoke tests, listings,
// and the finalize/teardown step (which runs AFTER a launch, not a new launch).
const NOT_A_LAUNCH = /\bfinalize\b|--help\b|(?:^|\s)-h(?:\s|$)|--dry-run\b|--smoke\b|--check\b|--list\b/;

/**
 * True when a Bash command actually STARTS an experiment/pod/training run.
 * Precise on purpose: excludes finalize/help/dry-run/smoke/check/list and plain
 * reads of a launcher file, so prose and inspection never trip the guard.
 */
export function isLaunchCommand(command) {
  if (!command || typeof command !== 'string') return false;
  if (NOT_A_LAUNCH.test(command)) return false;
  return RUNPOD_LAUNCH.test(command) || MODAL_RUN.test(command) || PYTHON_MODAL.test(command);
}

// Flatten a transcript into its tool-uses in order: [{ name, command }]. `command`
// is only meaningful for Bash tool-uses (used to spot launches in history).
function toolUsesInOrder(entries) {
  const toolUses = [];
  for (const entry of entries || []) {
    for (const block of toolUsesOf(entry)) {
      toolUses.push({ name: block?.name || '', command: block?.input?.command || '' });
    }
  }
  return toolUses;
}

// Concatenate every assistant TEXT block (not tool-uses) so we can check whether a
// watch link was given anywhere this session. Handles both the raw transcript shape
// and the test's plain {role, content:[{type:'text',text}]} entries.
function allAssistantText(entries) {
  let assistantText = '';
  for (const entry of entries || []) {
    const role = entry?.role || entry?.message?.role;
    if (role !== 'assistant') continue;
    const content = entry?.content ?? entry?.message?.content ?? [];
    if (typeof content === 'string') { assistantText += ' ' + content; continue; }
    for (const block of content || []) {
      if (typeof block === 'string') assistantText += ' ' + block;
      else if (block?.type === 'text' && block?.text) assistantText += ' ' + block.text;
    }
  }
  return assistantText;
}

const DENY_REASON = `EXPERIMENT LAUNCH BLOCKED — no live Monitor is attached yet.

Russell's rule (2026-07-16): "I want the monitor created BEFORE the experiment launches."
A paid pod / training run that starts with nobody watching can die (or stall silently) and
not be noticed for a whole session — exactly how exp150 lost 3 reader checkpoints.

Do this BEFORE launching, in order:
  1. Build the browser monitor from Russell's STANDARD template — copy
     ~/.claude/skills/live-watch/watch-template.html to <repo>/docs/<exp>-live.html and edit ONLY
     its CONFIG block (arms, seeds, metric, the purpose cards). Do NOT hand-roll a bespoke page.
  2. Serve it and give Russell the clickable link.
  3. Start a Monitor (the Monitor tool) for the liveness/finalize loop.
  4. THEN launch.

If this genuinely does not need a Monitor (a smoke/dry-run, or you are re-attaching after the
Monitor already exists), add the token ${ENV_OVERRIDE} to your reply, or set ${ENV_OVERRIDE}=1.`;

const STOP_REASON = `LAUNCH WITHOUT A LIVE MONITOR — an experiment/pod launch ran this session but no Monitor
is watching it (the last Monitor is before the last launch, or there is none).

A launch must be covered by a live Monitor (liveness poll + finalize/teardown loop) through its
whole lifecycle, so a death or stall is seen in real time instead of a session later. Attach a
Monitor to the launch now (or finalize/teardown it if it is already done).

If the run is already finalized and torn down, put ${ENV_OVERRIDE} in your reply to clear this.`;

const NO_LINK_REASON = `MONITOR WITHOUT A LINK — an experiment launched with a Monitor, but no watch LINK
was given to Russell this session.

Russell's rule (2026-07-16): "when you create a monitor you must give me a link." A chat-only
Monitor isn't enough — Russell wants a URL he can open to WATCH the run: a served watch page
(e.g. http://localhost:PORT/....html) or a *-live.html watch page. The page MUST be built from the
STANDARD template (~/.claude/skills/live-watch/watch-template.html, CONFIG edited only) — not hand-rolled.

Give Russell the watch link, then stop. Escape: ${ENV_OVERRIDE} in your reply, or ${ENV_OVERRIDE}=1.`;

/**
 * PURE core. `entries` is the parsed transcript (array). Returns
 * { block, mode?, reason? }. Never throws on malformed input.
 */
export function evaluate({ event, command = '', entries = [], replyText = '', stopHookActive = false, envOk = false } = {}) {
  if (envOk) return { block: false };
  if (ESCAPE_TOKEN.test(command || '') || ESCAPE_TOKEN.test(replyText || '')) return { block: false };

  const toolUses = toolUsesInOrder(entries);

  if (event === 'PreToolUse') {
    if (!isLaunchCommand(command)) return { block: false };
    const hasMonitor = toolUses.some((toolUse) => toolUse.name === MONITOR_TOOL);
    if (hasMonitor) return { block: false };
    return { block: true, mode: 'deny', reason: DENY_REASON };
  }

  if (event === 'Stop') {
    if (stopHookActive) return { block: false };
    let lastLaunchIndex = -1;
    let lastMonitorIndex = -1;
    toolUses.forEach((toolUse, index) => {
      if (toolUse.name === MONITOR_TOOL) lastMonitorIndex = index;
      if (toolUse.name === 'Bash' && isLaunchCommand(toolUse.command)) lastLaunchIndex = index;
    });
    if (lastLaunchIndex < 0) return { block: false };
    if (lastMonitorIndex < lastLaunchIndex) {
      return { block: true, mode: 'stop', reason: STOP_REASON };
    }
    // The Monitor covers the launch — but was a watch LINK given to Russell?
    if (!LINK_RE.test(allAssistantText(entries))) {
      return { block: true, mode: 'stop', reason: NO_LINK_REASON };
    }
    return { block: false };
  }

  return { block: false };
}

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') process.exit(0);
    const payload = readPayload();
    const event = payload.hook_event_name || payload.hookEventName || '';
    const transcriptPath = payload.transcript_path || payload.transcriptPath || '';
    const entries = readTranscript(transcriptPath);
    const replyText = lastAssistantText(entries);

    if (event === 'PreToolUse') {
      const input = payload.tool_input || {};
      const command = input.command || '';
      const verdict = evaluate({ event, command, entries, replyText });
      if (!verdict.block) process.exit(0);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      }));
      process.exit(0);
    }

    if (event === 'Stop') {
      if (payload.stop_hook_active) process.exit(0);
      const verdict = evaluate({ event, entries, replyText, stopHookActive: false });
      if (!verdict.block) process.exit(0);
      process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
      process.exit(0);
    }

    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate command or stop
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
