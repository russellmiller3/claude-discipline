#!/usr/bin/env node
/**
 * background-on-agent-spawn — gate hook that DENIES any Agent spawn that is not
 * run_in_background: true. Forces EVERY agent (build OR read-only research) to
 * run detached so it survives the user pressing Stop / interrupting the turn.
 *
 * Why this rule exists:
 * 2026-06-29 — a read-only "find the hard bench" Explore agent was spawned in the
 * FOREGROUND (the worktree hook's FOREGROUND_OK escape allows it because it writes
 * nothing). Russell then interrupted the turn to redirect — and the foreground
 * agent DIED with the interrupt, losing its in-flight work. Russell: "Should be a
 * hook that forces all agents to background ... bench finding agent shouldn't have
 * broken." A background agent is owned by the session, not the turn: an interrupt
 * stops the orchestrator's current message but the detached child keeps running and
 * pulses to the Control Tower. Foreground couples the agent's life to one turn.
 *
 * Teeth: emits permissionDecision:'deny' (a real block, not advice).
 *
 * Only escape: FOREGROUND_RUSSELL_OK in the prompt — Russell's explicit per-spawn
 * approval. Never self-grant it. (FOREGROUND_OK, which the WORKTREE hook honors for
 * no-tree-to-clobber read-only agents, is intentionally NOT honored here — Russell
 * wants those backgrounded too, which is exactly the case that broke.)
 *
 * Fail-open on unexpected errors (a parse failure must never block all agent work).
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Decide on one PreToolUse event. Returns a deny-decision object to print, or
 * null to allow. Pure (no I/O) so the test can drive it directly.
 */
export function decideBackgroundGate(event) {
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') return null;
  if ((event.tool_name || '') !== 'Agent') return null;

  const input = event.tool_input || {};
  const prompt = input.prompt || '';
  const description = input.description || '(unnamed)';

  // Already detached — the only correct default. Allow.
  if (input.run_in_background === true) return null;

  // Russell's explicit, per-spawn override. ASK first; never self-grant.
  if (/\bFOREGROUND_RUSSELL_OK\b/.test(prompt)) return null;

  const reason = `Agent spawn BLOCKED — "${description}" is not run_in_background: true.

Russell's rule (2026-06-29): EVERY agent — build OR read-only research — must be spawned with run_in_background: true so it survives an interrupt. A foreground agent dies the instant the turn is interrupted (it is owned by the turn, not the session), losing all in-flight work — exactly how the "find the hard bench" agent broke. A background agent keeps running detached and pulses to the Control Tower.

Fix: add run_in_background: true to the Agent call.
Override (rare — Russell explicitly wants this ONE spawn foreground): add FOREGROUND_RUSSELL_OK to the prompt. Never self-grant it.`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }
  const decision = decideBackgroundGate(event);
  if (decision) process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

// Entry-point guard by BASENAME (Windows MSYS path forms differ between
// import.meta.url and argv[1]; basename is stable). Import != execute, so the
// test can import decideBackgroundGate without main() reading stdin and hanging.
const invokedAsScript =
  process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1]);
if (invokedAsScript) main();
