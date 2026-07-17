#!/usr/bin/env node
// =============================================================================
// BACKGROUND-ORPHAN-GUARD — no job-control `&` inside a run_in_background command
// =============================================================================
//
// new-hook-category: Background-execution discipline — nearest existing is
// pod-launch-durability-guard (durability of a launch), but that never looks at
// HOW a command is backgrounded. This closes a different gap: the double-background
// foot-gun that spawns a surviving orphan process.
//
// WHY (2026-07-16, exp153 3-seed race incident — see marcus/learnings.md
// "Race-harness process collisions"): a Bash command was run with
// `run_in_background: true` AND contained an inner shell `&`
// (`... python race.py & echo $!`). The tool already backgrounds the whole
// command, so the inner `&` spawned the python as a GRANDCHILD that SURVIVED the
// wrapper shell's exit (non-interactive bash does not SIGHUP its jobs). The
// wrapper returned "exit 0" instantly; that read as "the job finished/died," a
// second race was launched, and TWO races then ran the same units concurrently —
// corrupting each other (source-bytes-changed errors + duplicate records) and
// polluting the timing. The clean fix is: never double-background. When the tool
// backgrounds the command, the process itself must run in the FOREGROUND of that
// backgrounded command, so the harness tracks it and reports a real completion.
//
// HOW IT WORKS
// ============
//   PreToolUse on Bash. If tool_input.run_in_background is truthy AND the command
//   contains a real job-control `&` (backgrounding), DENY. A `&` that is actually
//   `&&`, an fd redirection (`2>&1`, `&>log`), `$!`/`$&`, or inside quotes does
//   NOT count. When run_in_background is false/absent the inner `&` is the caller's
//   explicit foreground-with-background-child choice and is NOT flagged — the
//   foot-gun is specifically double-backgrounding.
//
// TEETH: permissionDecision 'deny'. Escape: env BACKGROUND_ORPHAN_OK=1, or the
// literal token BACKGROUND_ORPHAN_OK in the command or the reply. FAILS OPEN on any
// error. basename entry-guard.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_OVERRIDE = 'BACKGROUND_ORPHAN_OK';
const ESCAPE_TOKEN = /\bBACKGROUND_ORPHAN_OK\b/;

/**
 * True when `command` contains a shell job-control `&` that backgrounds a process
 * — as opposed to `&&`, an fd redirection, a `$!`/`$&` special var, or a literal
 * `&` inside quotes (e.g. a URL query string).
 */
export function hasBackgroundingAmpersand(command) {
  if (!command || typeof command !== 'string') return false;
  let stripped = command;
  // Drop quoted spans so a literal & inside a string never counts.
  stripped = stripped.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  // Drop the lookalikes that contain & but are not backgrounding.
  stripped = stripped
    .replace(/&&/g, ' ')          // logical AND
    .replace(/\d*>&\d*/g, ' ')    // fd duplication: 2>&1, >&2
    .replace(/&>{1,2}/g, ' ')     // bash &> / &>> redirection
    .replace(/\$[!&]/g, ' ');     // $! (last bg pid), $& (regex match var)
  // Anything left that is an & is a backgrounding operator.
  return stripped.includes('&');
}

const DENY_REASON = `DOUBLE-BACKGROUND BLOCKED — this command is set to run_in_background AND contains an inner
job-control \`&\`. That spawns the real process as a GRANDCHILD that SURVIVES the wrapper shell's exit,
so the tool reports "completed" instantly while the process keeps running unseen. You then think it died,
relaunch, and end up with TWO copies running at once (this is exactly how the exp153 seed-11 race collided
with itself — see marcus/learnings.md "Race-harness process collisions").

Fix: drop the inner \`&\`. The tool already backgrounds the whole command, so run the process in the
FOREGROUND of the backgrounded command:
    RIGHT:  { command: "python race.py --seed 11 2>&1 | tee log", run_in_background: true }
    WRONG:  { command: "python race.py --seed 11 & echo $!",       run_in_background: true }

Now the process IS the background task, the harness tracks it, and you get a real completion notification.

Escape (rare — you truly want a detached child): put ${ENV_OVERRIDE} in the command or your reply, or set ${ENV_OVERRIDE}=1.`;

/**
 * PURE core. Returns { block, reason? }. Never throws on malformed input.
 */
export function evaluate({ command = '', runInBackground = false, replyText = '', envOk = false } = {}) {
  if (envOk) return { block: false };
  if (ESCAPE_TOKEN.test(command || '') || ESCAPE_TOKEN.test(replyText || '')) return { block: false };
  if (!runInBackground) return { block: false };
  if (!hasBackgroundingAmpersand(command)) return { block: false };
  return { block: true, reason: DENY_REASON };
}

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') process.exit(0);
    const payload = readPayload();
    const event = payload.hook_event_name || payload.hookEventName || '';
    if (event && event !== 'PreToolUse') process.exit(0);
    // Bash tool ONLY. PowerShell uses `&` as its call operator (`& "app.exe"`),
    // which is not backgrounding — never apply this guard there.
    const toolName = payload.tool_name || payload.toolName || '';
    if (toolName && toolName !== 'Bash') process.exit(0);
    const input = payload.tool_input || {};
    const command = input.command || '';
    const runInBackground = Boolean(input.run_in_background ?? input.runInBackground);
    const replyText = '';
    const verdict = evaluate({ command, runInBackground, replyText });
    if (!verdict.block) process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate command
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
