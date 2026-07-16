#!/usr/bin/env node
/**
 * agent-spawn-guard — ONE hook that validates every PreToolUse(Agent) spawn.
 *
 * Consolidated 2026-07-15 (Russell, "one hook per idea"): seven separate hooks each denied one property of an
 * Agent spawn on the SAME event with the SAME input. They're one idea — "is this Agent spawn valid?" — so this
 * hook runs them all (lib/agentSpawnGates.mjs) in order, FIRST-DENY-WINS, and emits a single deny. Retired:
 * agent-sidebar-only, background-on-agent-spawn, worktree-on-agent-spawn, cross-repo-worktree-on-agent-spawn,
 * agent-commit-cadence, agent-handoff-required, widget-ux-not-cli.
 *
 * Teeth: permissionDecision:'deny'. Fail-open on any error — a parse failure must never block all agent work.
 * Global disable: AGENT_SPAWN_GUARD_OFF=1 (per-gate overrides — SIDEBAR_OK, FOREGROUND_RUSSELL_OK,
 * NO_WORKTREE_RUSSELL_OK, COMMIT_CADENCE_OK, AGENT_HANDOFF_OK, UX_CLI_OK, … — are unchanged in the gate library).
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateAgentSpawn, buildContext } from './lib/agentSpawnGates.mjs';

/** Pure decision for one PreToolUse event. Returns a deny-decision object, or null to allow. */
export function decideAgentSpawn(event, env = process.env) {
  if (env.AGENT_SPAWN_GUARD_OFF === '1') return null;
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') return null;
  if ((event.tool_name || '') !== 'Agent') return null;

  const reason = evaluateAgentSpawn(event.tool_input || {}, buildContext(event, env));
  if (!reason) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Agent spawn BLOCKED — ${reason}`,
    },
  };
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); return; }
  let decision;
  try { decision = decideAgentSpawn(event); } catch { process.exit(0); return; }
  if (decision) process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

// Entry-point guard by BASENAME (Windows path forms differ between import.meta.url and argv[1]).
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) main();
