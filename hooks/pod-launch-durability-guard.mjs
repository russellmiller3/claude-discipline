#!/usr/bin/env node
// =============================================================================
// POD-LAUNCH-DURABILITY-GUARD — a paid pod must never take weights to its grave
// =============================================================================
//
// WHY (Russell, 2026-07-16): exp150 trained three reader checkpoints on a
// RunPod A40, then the pod was deleted between sessions and the weights — which
// lived only on the pod's ephemeral disk — died with it. Two mechanisms would
// have prevented it, and NEITHER was wired:
//   1. LIVENESS WATCH — `pod_liveness_watch.watch_pod` pulses "alive" every poll
//      and a loud "DEAD" line the instant the pod exits, so a death is seen in
//      real time (the window to step in) instead of discovered a session later.
//   2. EAGER RESCUE — `publish_checkpoint` at each stage boundary copies weights
//      OFF the pod the moment they exist, so even the provider reclaiming the pod
//      on its own can't lose them; plus `authorize_teardown` must be handed a
//      rescue inventory or an explicit RescueWaiver (Runner main 5356bd2), so
//      deleting a pod without accounting for its weights is impossible.
//
// HOW IT WORKS
// ============
// Fires PreToolUse on Write and Edit. When the file being written drives a paid
// training lifecycle (calls `start_or_reconcile(` on a RunPod provider) it must
// also show all three durability wirings. If any is missing it BLOCKS with
// permissionDecision:'deny', naming exactly which one. On Edit it reads the full
// on-disk file so an incrementally-built launcher is checked as a whole, not by
// the partial hunk.
//
// TEETH: permissionDecision 'deny'. Escape: `pod-durability-checked` in the file
// content, or POD_LAUNCH_DURABILITY_GUARD_OK=1 in env.
// FAILS OPEN on any error. Skips Runner's own library files and test files.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_TOKEN = 'pod-durability-checked';
const ENV_OVERRIDE = 'POD_LAUNCH_DURABILITY_GUARD_OK';

const SOURCE_EXT = /\.(py|mjs|cjs|js|ts)$/;

// The file DRIVES a paid pod lifecycle: it calls start_or_reconcile (attach or
// create the pod). `(?!.*def )` on the same match is not enough, so the def form
// is excluded separately below.
const LAUNCH_CALL = /\bstart_or_reconcile\s*\(/;
const LAUNCH_DEF = /\bdef\s+start_or_reconcile\b/;

// Invariant signals (any ONE reference satisfies each).
const LIVENESS = /\b(watch_pod|pod_liveness_watch)\b/;
const RESCUE_PUBLISH = /\b(publish_checkpoint|publish_final_model|adopt_prepublished_final_model)\b/;
const TEARDOWN_CALL = /\bauthorize_teardown\s*\(/;
const TEARDOWN_FAILED = /\bauthorize_failed_teardown\s*\(/;
const RESCUE_ARG = /\b(rescue_inventory|rescue_waiver|RescueWaiver)\b/;

// Runner's OWN library files DEFINE this machinery — they are not launchers.
function isRunnerInternal(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    /(^|\/)runner\/(runner\/|providers\/|[^/]*\.py$)/.test(normalized) ||
    /(^|\/)pod_liveness_watch\.py$/.test(normalized) ||
    /(^|\/)(test_)?runner_training/.test(normalized)
  );
}

// PURE core — no filesystem. Returns { block, missing } so the test asserts the
// exact reason. `content` is the FULL resulting file text.
export function evaluate({ toolName, filePath, content }) {
  if (toolName !== 'Write' && toolName !== 'Edit') return { block: false };
  if (!filePath || !SOURCE_EXT.test(filePath)) return { block: false };
  if (/\.(test|spec)\.|(^|[/\\])test_/.test(filePath)) return { block: false };
  if (isRunnerInternal(filePath)) return { block: false };
  if (!content) return { block: false };

  if (content.includes(OVERRIDE_TOKEN)) return { block: false };

  // Does this file actually drive a paid pod lifecycle?
  if (!LAUNCH_CALL.test(content)) return { block: false };
  if (LAUNCH_DEF.test(content) && !/self\.start_or_reconcile|lifecycle\.start_or_reconcile|\)\.start_or_reconcile/.test(content)) {
    // Only a definition of start_or_reconcile, no call site — it's a library.
    return { block: false };
  }

  const missing = [];
  if (!LIVENESS.test(content)) missing.push('liveness-watch');
  if (!RESCUE_PUBLISH.test(content)) missing.push('eager-rescue');
  if (TEARDOWN_CALL.test(content) && !TEARDOWN_FAILED.test(content) && !RESCUE_ARG.test(content)) {
    missing.push('teardown-rescue-arg');
  }
  if (!missing.length) return { block: false };
  return { block: true, missing };
}

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// On Write the full content is in the payload; on Edit only a hunk is, so read
// the on-disk file (pre-edit whole-file state) to judge the launcher as a whole.
export function resolveContent({ toolName, input, filePath, readFileFn = readFileSync, existsFn = existsSync }) {
  if (toolName === 'Write') return input.content || '';
  let onDisk = '';
  try {
    if (filePath && existsFn(filePath)) onDisk = readFileFn(filePath, 'utf8');
  } catch { onDisk = ''; }
  // Include the incoming new_string so a single-Write-style Edit that ADDS the
  // launch call is still seen even if the file did not exist before.
  return `${onDisk}\n${input.new_string || input.content || ''}`;
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') { process.exit(0); }
    const payload = readPayload();
    const toolName = payload.tool_name || '';
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    const content = resolveContent({ toolName, input, filePath });

    const verdict = evaluate({ toolName, filePath, content });
    if (!verdict.block) { process.exit(0); }

    const labels = {
      'liveness-watch': `LIVENESS WATCH missing — import runner's pod_liveness_watch and start watch_pod(...)
     in the background right after the pod attaches, so a pod death pulses "DEAD"
     into the watchtower in real time instead of being found a session later.`,
      'eager-rescue': `EAGER RESCUE missing — call publish_checkpoint(...) at EACH stage boundary so
     every stage's weights are copied OFF the pod the instant they exist, not held
     until the end where a provider-side pod reclaim loses them.`,
      'teardown-rescue-arg': `TEARDOWN NOT RESCUE-GATED — authorize_teardown(...) must be given a
     rescue_inventory (Runner lists the pod's weights and refuses while any is
     un-rescued) or an explicit RescueWaiver(reason=...). Never call it bare.`,
    };
    const reason = `POD LAUNCH BLOCKED — ${basename(filePath)} drives a paid pod but skips durability wiring.

A trained model must never die with its pod (exp150 lost 3 reader checkpoints this way, 2026-07-16).
Missing: ${verdict.missing.join(', ')}

${verdict.missing.map((key) => `  - ${labels[key]}`).join('\n')}

See the runpod-run skill (~/.claude/skills/runpod-run/SKILL.md) for the wiring, and runner/README.md
"No weight dies with its pod". If this file legitimately does not own a stage (e.g. a thin relaunch
shim) add the token \`${OVERRIDE_TOKEN}\` in a comment near the top and Write again. Env escape: ${ENV_OVERRIDE}=1.`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate write
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
