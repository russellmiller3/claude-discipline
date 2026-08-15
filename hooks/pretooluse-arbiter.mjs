#!/usr/bin/env node
/**
 * pretooluse-arbiter — THE single registered PreToolUse hook.
 *
 * new-hook-category: PreToolUse arbitration — the nearest existing hook is stop-arbiter.mjs, which
 *   does precisely this for the Stop event. This ADDS no rule. It REMOVES 75 independent vetoes:
 *   registered PreToolUse entries in settings.json go from 75 to 1.
 *
 * WHY (Russell, 2026-08-15): "most of your guards just create more problems for you. I don't know
 * why you can't just behave the way I intend." 75 guards each holding an absolute veto over every
 * tool call means deadlock is not a bug that can be fixed one regex at a time — it is arithmetic.
 * In one session, five separate turns reached a state with no legal move: one guard demanding an
 * action while another forbade the only way to take it. Once, a guard refused a shell command
 * because the Edit tool was the right utility, then refused the Edit tool.
 *
 * The Stop event already learned this on 2026-08-08 and went from 54 registered entries to 1.
 * PreToolUse never got the same treatment. This closes that asymmetry.
 *
 * Registry: hooks/lib/pretooluse-registry.mjs (GENERATED from settings.json).
 * Engine:   hooks/lib/pretooluse-arbitration.mjs (includes the circuit breaker).
 *
 * Fails open on everything. It is now the only PreToolUse entry, so a crash here must cost
 * enforcement, never the ability to work — the property that matters most in this file.
 */

import { runPreToolUseArbiter } from './lib/pretooluse-arbitration.mjs';
import { PRETOOLUSE_CHECKERS } from './lib/pretooluse-registry.mjs';

async function main() {
  let payload = '';
  for await (const chunk of process.stdin) payload += chunk;
  let toolEvent;
  try { toolEvent = JSON.parse(payload); } catch { return; }

  const verdict = await runPreToolUseArbiter(toolEvent, { checkers: PRETOOLUSE_CHECKERS });
  if (!verdict) return;

  // The harness reads a PreToolUse refusal from exit code 2 plus stderr. Written before the exit
  // and flushed by letting the process end naturally: `process.exit` immediately after a write can
  // truncate a piped stream, which would turn a stated reason into a bare refusal.
  process.stderr.write(verdict.reason);
  process.exitCode = 2;
}

main().catch(() => { process.exitCode = 0; }); // fail open: never wedge a session
