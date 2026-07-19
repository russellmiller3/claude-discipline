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
// project (one whose tree contains a sibling `runner/` or `Logger/`) EITHER
// (a) reads like reusable infrastructure (concurrency/retry/pod/telemetry/
// logging signals), OR (b) IS an experiment script by identity (naming
// convention like exp<N>/runpod_exp<N>/modal_*.py, or trains a model / drives
// a GPU pod job) — AND shows no sign of actually reusing runner/Logger — it
// BLOCKS with permissionDecision:'deny'. The fix is literal: open the repo,
// read the README, grep for the capability — THEN, if it's genuinely
// domain-specific glue, add the `runner-logger-checked` token (in a comment)
// and Write again.
//
// EXTENDED 2026-07-16 (Russell, verbatim: "for any experiment to use Runner
// and Logger... inspect any experiment to confirm their usage or otherwise
// block"): the original signal set only caught files that SMELLED like
// hand-rolled infra (ThreadPoolExecutor, retry loops, etc). A plain experiment
// script that just trains a model or launches a pod with none of that
// vocabulary sailed through untouched, even though the whole point is that
// EVERY experiment routes through Runner (retry/resume/pulses/telemetry/
// TrainingLifecycle) and Logger (structured+redacted logging) — see
// `~/.claude/CLAUDE.md` "Check Runner + Logger BEFORE building ANY infra".
// Added a second, independent detector keyed on EXPERIMENT IDENTITY (not
// vocabulary smell) so a clean-looking experiment script still gets checked.
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

// EXPERIMENT IDENTITY signals — this file IS an experiment (a training run, a
// sweep, a GPU-pod job), independent of whether it happens to also read like
// hand-rolled infra. Legible's convention: scripts/exp<N>_*.py,
// scripts/runpod_exp<N>.py, scripts/modal_*.py. Path match alone is enough
// (the naming convention IS the signal); otherwise TWO distinct content
// families must match (mirrors the MEDIUM-signal threshold above).
const EXPERIMENT_PATH = /(^|[\\/])(runpod|modal)_\w*\.py$|(^|[\\/])exp\d+[_.]|[_-]exp\d+([_.]|$)/i;
const EXPERIMENT_CONTENT_SIGNALS = [
  /\brunpod\b/i,
  /\bmodal\b[^\n]{0,20}\brun\b/i,
  /def\s+train\s*\(/,
  /\.fit\(/,
  /\bcuda\b/i,
  /\bcheckpoint\b/i,
  /\bepoch\b/i,
];

export function looksLikeExperiment(filePath, content) {
  if (EXPERIMENT_PATH.test(filePath || '')) return true;
  return EXPERIMENT_CONTENT_SIGNALS.filter((re) => re.test(content || '')).length >= 2;
}

// Evidence the file ALREADY reuses runner/Logger — if present, never block.
// These include Runner's own exported classes: referencing them IS reuse.
const REUSE_REFS = [
  /\bfrom\s+runner\b|\bimport\s+runner\b/,
  /\bfrom\s+durable_runner\b|\bimport\s+durable_runner\b/,
  /\bDurableRunner\b/,
  /\bTrainingLifecycle\b/,
  /\bTelemetryRecorder\b/,
  /\bExperimentTelemetry\b/,
  /\bcreate_logger\b/,
  /\bRunFileSink\b/,
  /\bSshRemoteJob\b|\bRemoteJobSpec\b/,
  /\bRunPodTrainingProvider\b/,
  /programming[/\\]runner/i,
  /\bfrom\s+logger\b|\bimport\s+logger\b/i,
  /programming[/\\]Logger/i,
  /\bStructuredLogger\b|\bredact/i,
];

// PARALLEL-MECHANISM vocabulary — adding one of these via an Edit means you're
// hand-rolling a capability the shared lib ALREADY owns (telemetry/recording/
// logging/concurrency/retry). This is the gap that let a hand-rolled `turn_metrics`
// dict get added alongside ExperimentTelemetry (Russell, 2026-07-17: "christ you
// dummy"). Only fires on Edit (Write is already covered by the main path).
const PARALLEL_MECHANISM_SIGNALS = [
  /\bturn_metrics\b/,                       // hand-rolled per-turn transcript = ExperimentTelemetry
  /\brecord_tool_call\b|\brecord_model_exchange\b/,  // ExperimentTelemetry's own API, reimplemented
  /\bexperiment_telemetry\b/i,              // naming a fake sibling to the real module
  /\btelemetry_excerpt\b|\btool_log\b|\bper_turn_log\b/i,  // bespoke recording dicts
  /\bclass\s+\w*(Logger|Telemeter|Recorder|Transcript)\w*\s*[(:]/,  // a custom logger/recorder class
  /\bdef\s+record_\w+\s*\(/,               // a hand-rolled record_* method (shadows the real API)
  /\bdef\s+\w*clip\w*_obj\s*\(/,            // bespoke redaction/clipping (Logger owns redaction)
  /\bThreadPoolExecutor\b|\bProcessPoolExecutor\b/,  // hand-rolled concurrency (Runner owns pools)
  /\bdef\s+\w*retry\w*\s*\(|\bwhile\s+attempt\b/i,   // hand-rolled retry (Runner owns retry+backoff)
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
// Strip comments and string/docstring literals so signal scanning sees only executable CODE. A
// `#`-comment or `"""`-docstring naming `teardown`/`retry`/`telemetry` is documentation, not plumbing.
export function codeOnly(filePath, content) {
  let code = String(content || '');
  if (/\.py$/i.test(filePath)) {
    code = code.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' '); // triple-quoted docstrings/strings first
    code = code.replace(/#[^\n]*/g, ' ');                        // line comments
    code = code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' '); // single/double string literals
  } else {
    code = code.replace(/\/\*[\s\S]*?\*\//g, ' ');               // block comments
    code = code.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');           // line comments (avoid `http://`)
    code = code.replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' '); // strings/templates
  }
  return code;
}

export function evaluate({ toolName, filePath, content, hasSiblingLib }) {
  if (toolName !== 'Write') return { block: false };
  if (!filePath || !SOURCE_EXT.test(filePath)) return { block: false };
  // Test/spec files aren't the concern — they exercise code, not build infra.
  if (/\.(test|spec)\.|(^|[/\\])test_/.test(filePath)) return { block: false };
  if (!content) return { block: false };
  if (!hasSiblingLib) return { block: false }; // nothing to reuse — don't nag

  // Genuine reuse always passes — importing the lib IS proof you found it.
  if (REUSE_REFS.some((re) => re.test(content))) return { block: false };

  // Signal scanning runs on CODE ONLY — a trigger word inside a comment or docstring is not
  // hand-rolled plumbing. A file that DISCLAIMS the plumbing ("this hand-rolls no retry/teardown")
  // must not trip the strong-signal token-void. (2026-07-19) Token detection stays on full content
  // (the `runner-logger-checked` token is deliberately placed in a comment/docstring).
  const scannableCode = codeOnly(filePath, content);
  const strong = STRONG_SIGNALS.filter((re) => re.test(scannableCode));
  const medium = MEDIUM_SIGNALS.filter((re) => re.test(scannableCode));
  const isExperiment = looksLikeExperiment(filePath, content);

  // Self-cert token — but EARNED, not asserted. Before 2026-07-19 the token was a
  // blanket rubber-stamp: a file could carry `runner-logger-checked` in a docstring
  // and still hand-roll a ProcessPoolExecutor + pulse + retry — the exact plumbing
  // Runner owns (proven by feeding the hook that payload: it exited 0). A pool /
  // retry / teardown / hand-rolled pulse is NEVER "domain glue", so ANY STRONG signal
  // VOIDS the token. The token still exempts genuine domain science (a model + a mask,
  // no hand-rolled infra); to hand-roll plumbing anyway, import runner or take the
  // deliberate env override CHECK_RUNNER_LOGGER_BEFORE_BUILD_OK=1.
  const hasToken = content.includes(OVERRIDE_TOKEN);
  if (hasToken && strong.length === 0) return { block: false };

  const fires = strong.length >= 1 || medium.length >= 2 || isExperiment;
  if (!fires) return { block: false };

  return {
    block: true,
    tokenVoided: hasToken && strong.length > 0,
    matched: [
      ...strong.map((re) => re.source),
      ...medium.map((re) => re.source),
      ...(isExperiment ? ['experiment-file-identity (name/train/pod signals)'] : []),
    ].slice(0, 6),
  };
}

// PURE core for the Edit path. The Write path catches fresh infra files; the Edit
// path catches a DIFFERENT failure — adding a PARALLEL mechanism to an existing
// file that already sits next to a shared lib owning that exact capability.
// The incident (2026-07-17): a hand-rolled `turn_metrics` dict + `record_`-style
// helpers were Edit'd into codeservo_job_agent.py, reimplementing what
// ExperimentTelemetry (programming/runner) already provides — while runner was a
// sibling the whole time. The hook's Write path never saw it (no fresh file), and
// even if it had, the file already imports `from runner import DurableRunner` so
// the reuse-check would pass. The narrow signal: the NEW code adds a recording /
// logging / telemetry / concurrency / retry mechanism that the lib already owns.
//
// `newString` is the Edit's added content. `fullContent` is the file after the
// edit (best-effort) — if the file as a whole ALREADY reuses the lib, we trust
// that the author knows the lib exists and only block if the new code introduces
// a *second, parallel* mechanism with no reuse reference of its own.
export function evaluateEdit({ filePath, newString, fullContent, hasSiblingLib }) {
  if (!filePath || !SOURCE_EXT.test(filePath)) return { block: false };
  if (/\.(test|spec)\.|(^|[/\\])test_/.test(filePath)) return { block: false };
  const added = newString || '';
  if (!added) return { block: false };
  if (!hasSiblingLib) return { block: false };
  if (added.includes(OVERRIDE_TOKEN)) return { block: false };

  // Does the NEW code add a parallel mechanism the lib already owns?
  const parallel = PARALLEL_MECHANISM_SIGNALS.filter((re) => re.test(added));
  if (parallel.length === 0) return { block: false };

  // Does the NEW code itself reference the real lib API? If the author is, e.g.,
  // adding a `record_tool_call` wrapper that delegates to ExperimentTelemetry,
  // that's reuse, not a parallel mechanism. NOTE: we use a STRICTER reuse set
  // than the Write path — real imports/API names only. The Write path's REUSE_REFS
  // includes bare `\bredact\b` (loose, for prose), which false-matches the word
  // "redaction" in a comment and would let a parallel mechanism through.
  const EDIT_REUSE_REFS = [
    /\bfrom\s+runner\b|\bimport\s+runner\b/,
    /\bExperimentTelemetry\b/,
    /\bTelemetryRecorder\b/,
    /\bcreate_logger\b/,
    /\bRunFileSink\b/,
    /\bfrom\s+logger\b|\bimport\s+logger\b/i,
  ];
  if (EDIT_REUSE_REFS.some((re) => re.test(added))) return { block: false };

  // Also pass if the surrounding file clearly already routes through the lib
  // for THIS capability (the author is consistent, this is a continuation).
  // Conservative: require BOTH a reuse ref AND the parallel signal NOT to be a
  // pure reimplementation marker (e.g. `record_tool_call` defined as a fresh fn).
  // We keep this simple: if the full file reuses the lib, warn-don't-block is
  // too soft (Rule 1 — hooks need teeth). We still block, because the new code
  // itself adds a parallel mechanism without referencing the lib.

  return {
    block: true,
    matched: parallel.map((re) => re.source).slice(0, 6),
    path: 'edit-parallel-mechanism',
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

    // EDIT path: catch a parallel mechanism being added to an existing file that
    // sits next to a shared lib owning that capability. Fires BEFORE the Write
    // path (an Edit is not a Write, so the Write path would no-op on it anyway).
    if (toolName === 'Edit') {
      const newString = input.new_string || '';
      const editVerdict = evaluateEdit({
        filePath,
        newString,
        fullContent: content,
        hasSiblingLib,
      });
      if (editVerdict.block) {
        const libs = reachableSharedLibs(dirname(resolve(filePath))) || ['runner', 'Logger'];
        const reason = `EDIT BLOCKED — you're adding a parallel mechanism the shared lib already owns.

The new code in ${basename(filePath)} introduces a capability (matched: ${editVerdict.matched.join(', ')})
that a reachable shared lib ALREADY provides: ${libs.join(', ')}.

This is the "christ you dummy" failure (2026-07-17): hand-rolling a per-turn telemetry dict + record_*
helpers RIGHT NEXT TO programming/runner, which already exports ExperimentTelemetry (record_tool_call,
record_model_exchange, snapshot) — a parallel system that can never feed telemetry_report or
paired_comparison, and that drifts from the canonical logger every other eval already speaks.

Before this edit lands, do this FIRST (literally):
  1. ls  programming/runner  &&  grep for the capability (telemetry / record_tool_call / snapshot).
  2. ls  programming/Logger  &&  read its README — one validated + redacted event shape, create_logger.
  3. If the lib owns it, USE IT: import the real API and route the new code through it.
     A project writes only DOMAIN-SPECIFIC glue — never its own telemetry, logging, retry, or concurrency.

If you HAVE checked and this genuinely needs a local mechanism the lib can't provide (rare), add the
token \`${OVERRIDE_TOKEN}\` in a comment in the new code and Edit again. Env escape: ${ENV_OVERRIDE}=1.`;

        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }));
        process.exit(0);
      }
      // Edit didn't trip the parallel-mechanism check — let it through (the Write
      // path below only applies to fresh files, so for Edit we're done).
      process.exit(0);
    }

    const verdict = evaluate({ toolName, filePath, content, hasSiblingLib });
    if (!verdict.block) { process.exit(0); }

    const libs = reachableSharedLibs(dirname(resolve(filePath))) || ['runner', 'Logger'];
    const tokenVoidedNote = verdict.tokenVoided
      ? `\nThe \`${OVERRIDE_TOKEN}\` token is present but VOID here — you're hand-rolling the exact plumbing the lib owns
(matched: ${verdict.matched.join(', ')}). A pool / retry / teardown / hand-rolled pulse is never "domain glue", so the
token can't bless it. The ONLY escapes are: (a) genuinely import the runner API, or (b) the deliberate env override
${ENV_OVERRIDE}=1 (a conscious, logged bypass) — NOT re-adding the token.\n`
      : '';
    const reason = `BUILD BLOCKED — check the shared libs BEFORE writing ${basename(filePath)}.
${tokenVoidedNote}

This file reads like reusable infrastructure OR like an experiment script (matched: ${verdict.matched.join(', ')})
but shows no sign of reusing the shared plumbing. Reachable shared lib(s): ${libs.join(', ')}.

Every experiment routes through Runner (retry/resume/concurrency/pulses/TrainingLifecycle) and Logger
(structured + redacted logging) — never hand-rolled equivalents.

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
