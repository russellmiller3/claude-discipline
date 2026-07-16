#!/usr/bin/env node
// =============================================================================
// CHECK-RUNNER-LOGGER-BEFORE-BUILD — reuse the shared libs, don't rebuild them
// =============================================================================
//
// WHY (Russell, 2026-07-15, emphatic): I wrote `train_exp153_bundles.py` — a
// GPU-pod training script — WITHOUT first opening `programming/runner`. I
// inferred Runner's API from how a sibling script imported it, instead of
// `ls`-ing the repo + reading its README + grepping for the capability. Two
// shared libraries own the reusable plumbing:
//
//   programming/runner  — ALL execution/durability: retry+backoff, JSONL resume,
//                         bounded concurrency, Control-Tower pulses, live
//                         dashboard, TelemetryRecorder, and TrainingLifecycle
//                         (paid-pod identity, checkpoint rescue, verified
//                         off-machine publication, guarded teardown).
//   programming/Logger  — ALL structured logging: one validated + redacted event
//                         shape so no private data leaks.
//
// A project writes only DOMAIN-SPECIFIC glue on top; it never clones retry,
// resume, teardown, telemetry, or a log format.
//
// HOW IT WORKS
// ============
// Fires PreToolUse on Write. When a NEW source file under a `programming/`
// project (one whose tree contains a sibling `runner/` or `Logger/`) reads like
// reusable infrastructure (concurrency/retry/pod/telemetry/logging signals) AND
// shows no sign of actually reusing runner/Logger, it BLOCKS with
// permissionDecision:'deny'. The fix is literal: open the repo, read the README,
// grep for the capability — THEN, if it's genuinely domain-specific glue, add
// the `runner-logger-checked` token (in a comment) and Write again.
//
// TEETH: permissionDecision 'deny'. Escape: `runner-logger-checked` in the file
// content, or CHECK_RUNNER_LOGGER_BEFORE_BUILD_OK=1 in env.
// FAILS OPEN on any error.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_TOKEN = 'runner-logger-checked';
const ENV_OVERRIDE = 'CHECK_RUNNER_LOGGER_BEFORE_BUILD_OK';

// A source file at all? (infra can be Python or JS/TS.)
const SOURCE_EXT = /\.(py|mjs|cjs|js|ts|jsx|tsx)$/;

// STRONG signals: hand-rolled plumbing smells. Any ONE fires the check.
const STRONG_SIGNALS = [
  /ThreadPoolExecutor|ProcessPoolExecutor/,
  /\bas_completed\b/,
  /\bbackoff\b/i,
  /def\s+\w*retry\w*\s*\(/i,          // a hand-rolled retry function
  /while\s+attempt|for\s+attempt\s+in\s+range/i, // a retry loop
  /\brunpod\b/i,                       // talking to RunPod directly
  /\bteardown\b/i,
  /checkpoint[^\n]{0,30}(rescue|resume|recover)/i,
];

// MEDIUM signals: infra vocabulary. TWO distinct families fire the check.
// Stem-matched (no trailing \b) so snake_case identifiers count too —
// `retry_call`, `manage_concurrency`, `pulse_log` all read as infra.
const MEDIUM_SIGNALS = [
  /retr(y|ies|ying)/i,
  /resume/i,
  /concurrenc/i,
  /max_workers/i,
  /pulse/i,
  /telemetry/i,
  /sweep/i,
  /benchmark/i,
  /pod[_ -]?id/i,
  /provision/i,
  /dashboard/i,
  /live[_ -]?feed/i,
  /gpu[_ -]?(hourly|cost|pod)/i,
];

// Evidence the file ALREADY reuses runner/Logger — if present, never block.
// These include Runner's own exported classes: referencing them IS reuse.
const REUSE_REFS = [
  /\bfrom\s+runner\b|\bimport\s+runner\b/,
  /\bfrom\s+durable_runner\b|\bimport\s+durable_runner\b/,
  /\bDurableRunner\b/,
  /\bTrainingLifecycle\b/,
  /\bTelemetryRecorder\b/,
  /\bSshRemoteJob\b|\bRemoteJobSpec\b/,
  /\bRunPodTrainingProvider\b/,
  /programming[/\\]runner/i,
  /\bfrom\s+logger\b|\bimport\s+logger\b/i,
  /programming[/\\]Logger/i,
  /\bStructuredLogger\b|\bredact/i,
];

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// Walk up from a directory looking for a parent whose tree contains a sibling
// `runner/` or `Logger/` — i.e. the shared libs are actually available to reuse.
// Returns the matched lib name(s), or null if neither is reachable.
export function reachableSharedLibs(startDir, existsFn = existsSync) {
  let current = startDir;
  for (let i = 0; i < 12 && current; i++) {
    const found = [];
    if (existsFn(resolve(current, 'runner', 'runner'))) found.push('runner');
    else if (existsFn(resolve(current, 'runner'))) found.push('runner');
    if (existsFn(resolve(current, 'Logger'))) found.push('Logger');
    if (found.length) return found;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// PURE core — no filesystem. `hasSiblingLib` says whether runner/Logger is
// reachable from the file's location (main() computes it). Returns
// { block, matched } so the test can assert on the exact reason.
export function evaluate({ toolName, filePath, content, hasSiblingLib }) {
  if (toolName !== 'Write') return { block: false };
  if (!filePath || !SOURCE_EXT.test(filePath)) return { block: false };
  // Test/spec files aren't the concern — they exercise code, not build infra.
  if (/\.(test|spec)\.|(^|[/\\])test_/.test(filePath)) return { block: false };
  if (!content) return { block: false };
  if (!hasSiblingLib) return { block: false }; // nothing to reuse — don't nag

  // Escape hatches.
  if (content.includes(OVERRIDE_TOKEN)) return { block: false };

  // Already reusing the shared libs → pass.
  if (REUSE_REFS.some((re) => re.test(content))) return { block: false };

  const strong = STRONG_SIGNALS.filter((re) => re.test(content));
  const medium = MEDIUM_SIGNALS.filter((re) => re.test(content));
  const fires = strong.length >= 1 || medium.length >= 2;
  if (!fires) return { block: false };

  return {
    block: true,
    matched: [...strong.map((re) => re.source), ...medium.map((re) => re.source)].slice(0, 6),
  };
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') { process.exit(0); }
    const payload = readPayload();
    const toolName = payload.tool_name || '';
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    const content = input.content || '';

    const hasSiblingLib = filePath
      ? Boolean(reachableSharedLibs(dirname(resolve(filePath))))
      : false;

    const verdict = evaluate({ toolName, filePath, content, hasSiblingLib });
    if (!verdict.block) { process.exit(0); }

    const libs = reachableSharedLibs(dirname(resolve(filePath))) || ['runner', 'Logger'];
    const reason = `BUILD BLOCKED — check the shared libs BEFORE writing ${basename(filePath)}.

This file reads like reusable infrastructure (matched: ${verdict.matched.join(', ')}) but shows no sign of
reusing the shared plumbing. Reachable shared lib(s): ${libs.join(', ')}.

Do this FIRST (literally, not from memory):
  1. ls  programming/runner  &&  read its README.md ("Ownership rule")   ← retry/resume/concurrency/pulses/
     telemetry + TrainingLifecycle (pod identity, checkpoint rescue, off-machine publish, guarded teardown)
  2. ls  programming/Logger   &&  read its README.md                      ← validated + redacted log shape
  3. grep the repo for the exact capability you're about to build.

Inferring the API from how another script imports it is NOT checking — that's the shortcut that wasted a
build (2026-07-15). Reuse the lib; a project writes only DOMAIN-SPECIFIC glue on top — never its own retry,
resume, teardown, telemetry, or log format.

If you HAVE checked and this is genuinely domain-specific glue (or it legitimately reuses the lib), add the
token \`${OVERRIDE_TOKEN}\` in a comment near the top and Write again. Env escape: ${ENV_OVERRIDE}=1.`;

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

// Only run as a hook when executed directly — importing (from the test) must not read stdin.
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
