#!/usr/bin/env node
// =============================================================================
// bench-pattern-guard — every benchmark RUNNER must be parallel + event-emitting
//                       + durable & idempotent, or the write is BLOCKED.
// =============================================================================
//
// Russell's rule (2026-06-23): "Any benchmark should always run in parallel, emit
// regular progress events to the Control Tower, and be durable + idempotent. Make a
// hook that stops me if I try to write something that doesn't follow that pattern."
//
// THE PATTERN (all four, non-negotiable for a bench/eval/sweep RUNNER):
//   1. PARALLEL    — a bounded worker pool / Promise.all / mapBounded over the tasks
//                    (never a plain serial for-loop). Cuts wall-clock, surfaces
//                    failures early.
//   2. EVENTS      — emit plain-English progress to the Control Tower
//                    (programming/.claude/state/agent-pulse.log) per the pulse
//                    contract, so Russell watches every task advance live.
//   3. DURABLE+IDEMPOTENT — append a per-item checkpoint as each finishes (JSONL),
//                    support --resume, and never double-write on a re-run.
//   4. RETRY       — retry-with-backoff on TRANSIENT errors (a flaky provider route,
//                    a rate limit, a momentary 5xx), not just "durable" in the sense
//                    of not losing progress. Added 2026-07-13 after a real bench died
//                    4 times in a row on a flaky OpenRouter route with no retry logic
//                    — every prior marker (parallel/events/durable) was satisfied and
//                    it STILL needed a manual relaunch every time. See the ml-experiment
//                    skill (programming/durable-run/) — import it instead of
//                    hand-rolling retry logic; it already has this marker built in.
//
// Fires on PreToolUse(Write) for a file that LOOKS like a bench runner (lives under a
// bench/eval/sweep path AND both iterates a task/scenario list AND calls a model/agent).
// Helper modules (fixtures, scoring, a report renderer) are not runners — they don't
// match both signals — so they pass untouched. Tests (*.test.*) are skipped.
//
// Bypass (rare, e.g. a deliberately tiny one-shot probe): put `bench-pattern-override`
// in the file, or set BENCH_PATTERN_OVERRIDE=1. The teeth: PreToolUse permissionDecision
// 'deny' — it actually blocks the write, it does not merely advise.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BENCH_PATH = /(^|[\\/])(bench|benchmark|benchmarks|eval|evals|sweep|sweeps)[\\/]/i;
const ITERATES_TASKS = /\b(TASKS|scenarios|taskQueue|testCases|probes)\b/;
const CALLS_AGENT = /(runAgent|callModel|callChatCompletion|createJarvisBrain|api\.anthropic|\/v1\/messages|openrouter|runOneTask|runScenario)/i;

const HAS_PARALLEL = /(Promise\.all|Promise\.allSettled|mapBounded|p-limit|plimit|runPool|workerPool|worker pool|concurrency|--concurrency)/i;
const HAS_EVENTS = /(agent-pulse|emitPulse|createTaskPulse|pulse\(|controlTower|control tower)/i;
const HAS_DURABLE = /(resume|cursor|dedupe|checkpoint|appendFileSync|\.jsonl|idempotent)/i;
// Either import the shared library (preferred — durable_runner / durable-run / DurableRunner
// / retrying_call / retrying_http_call) OR hand-roll a real retry-with-backoff shape: a loop
// bounded by an attempt count, checking/catching a transient signal (status code or error),
// and a sleep/backoff between attempts. A bare `catch` with no re-attempt loop doesn't count.
const HAS_RETRY_LIBRARY = /(durable_runner|durable-run|DurableRunner|retrying_call|retrying_http_call)/i;
const HAS_HANDROLLED_RETRY = /(max_attempts|maxAttempts|maxRetries|max_retries)\b[\s\S]{0,400}?(sleep|setTimeout|backoff)/i;

const OVERRIDE = /bench-pattern-override/i;

// --- Fifth marker: a sweep must never run against the LIVE checkout ---------
//
// Added 2026-08-15. A CodeServo plan proposed profiling every action "against
// the repo itself" for realistic size. The tool registry it enumerated held
// delete_file, move_file, git_commit, merge, checkout, rollback and run_python.
// Running that sweep would have deleted files, moved HEAD, and executed
// arbitrary code inside the live working checkout. A red-team pass caught it,
// which is luck, not a system.
//
// This check is deliberately NOT gated on BENCH_PATH: a profiler lives wherever
// it likes (scripts/, tools/, the repo root), and the damage does not care.
const ENUMERATES_TOOL_REGISTRY =
  /(TOOL_SPECS|REPOSITORY_TOOL_SPECS|COCKPIT_TOOL_SPECS|list_tools\s*\(\)|for\s+\w+\s+in\s+\w*(?:tools|specs|actions)\b)/i;
const DESTRUCTIVE_OPERATIONS =
  /\b(delete_file|move_file|git_commit|rollback|run_python|rmtree|shutil\.rmtree)\b/;
// Any sign the target root is a copy, a temp dir, or is explicitly refused when
// it resolves inside the live checkout.
const DISPOSABLE_ROOT =
  /(mkdtemp|tempfile\.|gettempdir|copytree|materialize_starting_repository|disposable\s+cop(?:y|ies)|scratchpad|refus\w*[\s\S]{0,60}live\s+checkout|must\s+not\s+be\s+the\s+live)/i;

/** Does this file sweep a tool registry destructively without a disposable root? */
export function sweepsDestructivelyOnLiveRoot(filePath, source) {
  const lower = (filePath || '').toLowerCase();
  if (/\.test\.|\.spec\./.test(lower)) return false;
  if (!/\.(mjs|cjs|js|ts|py)$/.test(lower)) return false;
  if (!ENUMERATES_TOOL_REGISTRY.test(source)) return false;
  if (!DESTRUCTIVE_OPERATIONS.test(source)) return false;
  return !DISPOSABLE_ROOT.test(source);
}

function sweepDenial(filePath) {
  return `BLOCKED — this sweep would run destructive tools against a live checkout.

${filePath} enumerates a tool registry and executes what it finds, and the registry it
walks includes destructive operations (delete_file / move_file / git_commit / rollback /
run_python / rmtree). Nothing in the file shows the target root is disposable.

Run the sweep against a COPY, and refuse a root inside the live checkout:
  - copy the repository first (tempfile.mkdtemp + shutil.copytree, or a materialized fixture);
  - assert the resolved target root is NOT inside the working checkout, and exit if it is;
  - delete the copy when the run finishes.

Caught for real on 2026-08-15 (CodeServo plan 255): a proposed action profiler was one
red-team pass away from running delete_file and checkout against live work. Size realism
comes from copying a big repo, never from pointing at the live one.

Bypass only for a genuinely read-only sweep: put bench-pattern-override in the file.`;
}

/** Is this the runner that actually drives the benchmark loop (vs a helper module)? */
export function looksLikeRunner(filePath, source) {
  if (!BENCH_PATH.test(filePath || '')) return false;
  const lower = (filePath || '').toLowerCase();
  if (/\.test\.|\.spec\./.test(lower)) return false; // tests aren't runners
  if (!/\.(mjs|cjs|js|ts|py)$/.test(lower)) return false;
  return ITERATES_TASKS.test(source) && CALLS_AGENT.test(source);
}

/** Which of the four required pattern markers are MISSING from a runner's source. */
export function missingMarkers(source) {
  const missing = [];
  if (!HAS_PARALLEL.test(source)) missing.push('PARALLEL (a worker pool / Promise.all / mapBounded over the tasks, plus a --concurrency knob — not a serial for-loop)');
  if (!HAS_EVENTS.test(source)) missing.push('EVENTS (emit plain-English progress to the Control Tower — import a pulse helper that appends to programming/.claude/state/agent-pulse.log per AGENT-PULSE-CONTRACT.md)');
  if (!HAS_DURABLE.test(source)) missing.push('DURABLE + IDEMPOTENT (append a per-item JSONL checkpoint as each task finishes, support --resume, never double-write on re-run)');
  if (!HAS_RETRY_LIBRARY.test(source) && !HAS_HANDROLLED_RETRY.test(source)) missing.push('RETRY (retry-with-backoff on TRANSIENT errors — a flaky provider route, a rate limit, a momentary 5xx. Import the durable-run library (programming/durable-run/) instead of hand-rolling this — it already has retrying_call/retrying_http_call built and tested)');
  return missing;
}

function denial(filePath, missing) {
  return `BLOCKED — benchmark runner does not follow the required pattern.

${filePath} looks like a benchmark/eval RUNNER (it iterates a task list AND calls a model/agent),
but it is missing:

${missing.map((entry) => `  - ${entry}`).join('\n')}

Russell's rule (2026-06-23, extended 2026-07-13): EVERY benchmark must run its tasks IN PARALLEL,
EMIT regular progress events to the Control Tower, be DURABLE + IDEMPOTENT, and RETRY transient
failures. Reference implementations: extension/bench/realworld/ (harness.mjs runPool + pulse.mjs +
JSONL runs/ + --resume) and programming/durable-run/ (the Python library — import it directly for
a Python runner instead of reimplementing any of this four-part pattern by hand).

Fix the runner to:
  1. Replace the serial loop with a bounded worker pool (e.g. N workers draining a queue, a
     --concurrency flag), each task fully isolated.
  2. Import a pulse helper and emit a Goal, then a line per real step, then a pass/fail summary
     to programming/.claude/state/agent-pulse.log (format: [<ISO>] [<task>] Agent: <plain English>).
  3. Append one JSONL row per task the instant it finishes; support --resume (skip task ids already
     recorded); re-running a task must not double-write.
  4. Retry a TRANSIENT failure (flaky route, rate limit, momentary 5xx) with backoff before giving
     up on that task — a real, permanent error should still fail fast, not retry forever.

Bypass only for a deliberately tiny one-shot probe: put bench-pattern-override in the file, or set
BENCH_PATTERN_OVERRIDE=1.`;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); return; }

  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') { process.exit(0); return; }
  if ((event.tool_name || '') !== 'Write') { process.exit(0); return; } // full-file create is where the pattern is set

  const input = event.tool_input || {};
  const filePath = input.file_path || '';
  const source = input.content || '';
  if (!source) { process.exit(0); return; }
  if (process.env.BENCH_PATTERN_OVERRIDE === '1' || OVERRIDE.test(source)) { process.exit(0); return; }

  // Checked BEFORE the runner shape: a destructive sweep on the live checkout is
  // damaging whether or not it is parallel, and it need not live under bench/.
  if (sweepsDestructivelyOnLiveRoot(filePath, source)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: sweepDenial(filePath),
      },
    }));
    process.exit(0);
    return;
  }

  if (!looksLikeRunner(filePath, source)) { process.exit(0); return; }

  const missing = missingMarkers(source);
  if (missing.length === 0) { process.exit(0); return; }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial(filePath, missing),
    },
  }));
  process.exit(0);
}

// Entry-point guard so importing this for tests does not execute main() (which reads stdin and hangs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
