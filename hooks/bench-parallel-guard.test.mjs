// bench-parallel-guard.test.mjs — run: node --test ~/.claude/hooks/bench-parallel-guard.test.mjs
//
// The bug this pins (2026-06-25): the guard matched the bare word "bench" anywhere in a command, so
// read-only / VCS commands that merely MENTION a bench path (grep, git add, cat, ls, a report reader)
// got DENIED even though they run nothing. That false-block wasted real time and made a cheap bench
// run look un-runnable. The fix: only treat a command as a benchmark when it actually EXECUTES one.
//
// Second bug this pins (2026-07-02): a `head ... > file && cat >> file <<'EOF' ... EOF` heredoc
// writing DOCUMENTATION PROSE (e.g. a HANDOFF.md rewrite) that merely NAMES a bench/ path inside the
// heredoc body — combined with an unrelated real run-word (node/python/etc.) elsewhere in the same
// compound command — satisfied both `mentionsBench` and `runsSomething` and got DENIED even though no
// benchmark was ever invoked. The fix: strip heredoc bodies (reusing long-running-script-guard.mjs's
// stripHeredocBodies) before keyword scanning, so heredoc DATA is never read as executable structure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeBenchmark, stripHeredocBodies } from './bench-parallel-guard.mjs';

// The exact HANDOFF.md-rewrite shape that triggered the 2026-07-02 false-block: a `head` truncation,
// a `cat` heredoc appending prose that names finished bench/ work, then `mv` to replace the file.
// Shared by the classification test and the end-to-end (spawned-hook) test below — one source of truth.
const HANDOFF_REWRITE_COMMAND =
  "head -n 60 HANDOFF.md > HANDOFF.md.new && cat >> HANDOFF.md.new << 'EOF'\n\n## DONE tonight\n" +
  "- Finished and merged bench/filebrain_bench.py (filebrain benchmark suite)\n" +
  "- Also landed bench/hard_chrome/ harness for headless-chrome scenarios\n" +
  "- Both already ran to completion earlier and results are committed\nEOF\nmv HANDOFF.md.new HANDOFF.md";

// ── these RUN nothing — must NOT be classified as a benchmark (the false-block class) ──
const NOT_RUNS = [
  'grep -rli "bench" hooks/*.mjs',
  'grep -rlE "command.*bench" hooks/*.mjs | head',
  'git add extension/bench/realworld/suite.mjs',
  'git status --short | grep bench',
  'cat extension/bench/realworld/harness.mjs',
  'ls extension/bench/realworld/runs/',
  'head -50 extension/bench/realworld/suite.mjs',
  'find . -path "*bench*" -name "*.mjs"',
  'wc -l extension/bench/realworld/harness.mjs',
  'rg "firecrawl" extension/bench/realworld/suite.mjs',
  'node bench/realworld/report.mjs',            // analyzing results, not running the bench
  'node --check bench/realworld/suite.mjs',     // syntax parse, not a run
  'node --check bench/realworld/harness.mjs && node --check bench/realworld/localSites.mjs',
  'node bench/realworld/suite.test.mjs',        // a test file, not a bench run
  // git commits touching .py files in bench/ — the `.py` extension must NOT read as a `py` RUN
  // (this was the false-block that forced git workarounds). (2026-06-30)
  'git add bench/critic.py bench/gan.py',
  'cd /x && git add bench/critic.py bench/gan.py && git commit -m "feat: gan kintsugi weakness"',
  'git commit -m "feat(bench): sweep eval improvements"',   // bench keyword in MESSAGE, runs nothing

  // heredoc DOCUMENTATION bodies that merely mention a bench/ path — the 2026-07-02 false-block class.
  // Real shape: a HANDOFF.md rewrite (head to truncate, cat heredoc to append prose, mv to replace).
  HANDOFF_REWRITE_COMMAND,
  // same shape, double-quoted delimiter
  'cat >> NOTES.md << "EOF"\nSee bench/filebrain_bench.py and node scripts/report.mjs for context.\nEOF',
  // a plain echo/redirect mentioning a bench path — never a real invocation
  'echo "see bench/foo.py for details" > README.md',
  'echo "run node scripts/thing.mjs after checking bench/hard_chrome/" >> NOTES.md',
];

for (const command of NOT_RUNS) {
  test(`NOT a benchmark (runs nothing): ${command.slice(0, 48)}`, () => {
    assert.equal(looksLikeBenchmark(command), false);
  });
}

// ── heredoc body stripping: DATA is blanked, the `<<DELIM` token itself survives ──
test('stripHeredocBodies blanks heredoc content but keeps the redirection token', () => {
  const command = "cat >> f.md << 'EOF'\nsome bench/x.py prose\nEOF";
  const stripped = stripHeredocBodies(command);
  assert.ok(stripped.includes('<<EOF'));
  assert.ok(!stripped.includes('bench/x.py'));
});

// ── the exact denied shape from the bug report: an OUTER heredoc (writing a repro script) whose BODY
// contains both a bench/ path mention and the word "node", followed by a real `node <file>` command
// that runs the newly written script (not a benchmark) — must not be misread as "the node run is a
// benchmark because a bench path appears somewhere in this compound command." ──
test('NOT a benchmark: outer heredoc writes a script mentioning bench/ + node, then node runs it', () => {
  const outerCommand =
    "cat >> \"repro.mjs\" << 'REPROEOF'\n" +
    "// see bench/filebrain_bench.py and bench/hard_chrome/ for prior work\n" +
    "console.log('hello');\n" +
    "REPROEOF\n" +
    'node repro.mjs';
  assert.equal(looksLikeBenchmark(outerCommand), false);
});

// ── these actually EXECUTE a bench — must still be gated ──
const REAL_RUNS = [
  'node bench/realworld/harness.mjs --cap=5',
  'cd extension && node bench/realworld/harness.mjs',
  'npm run bench',
  'npm run bench:sweep',
  'node scripts/model-bench.mjs',
  'python evals/sweep.py',
  // regression: a real unchunked `py -m bench.X` invocation (the original blocking shape) — the
  // heredoc carve-out must NOT weaken detection of an actual benchmark module run. (2026-07-02)
  'py -m bench.some_suite',
];

for (const command of REAL_RUNS) {
  test(`IS a benchmark execution: ${command.slice(0, 48)}`, () => {
    assert.equal(looksLikeBenchmark(command), true);
  });
}

// ── unrelated commands stay invisible to the guard ──
test('plain test runner is not a benchmark', () => {
  assert.equal(looksLikeBenchmark('npm test'), false);
  assert.equal(looksLikeBenchmark('npx vitest run lib/foo.test.js'), false);
});

// ── chunked bench commands remain classified as benchmarks (still gated further down the pipeline
// by hasParallelMarker/hasChunkMarker — this file only asserts the classification stage) ──
test('a chunked bench invocation is still classified as a benchmark', () => {
  assert.equal(looksLikeBenchmark('node bench/realworld/harness.mjs --chunk=1 --resume'), true);
  assert.equal(looksLikeBenchmark('py -m bench.some_suite --scenario=foo --limit=10'), true);
});

// ── full end-to-end PreToolUse pipeline (spawns the hook the way Claude Code actually invokes it) ──
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hookScriptPath = join(dirname(fileURLToPath(import.meta.url)), 'bench-parallel-guard.mjs');

function runHook(command) {
  const event = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const hookResponse = spawnSync(process.execPath, [hookScriptPath], { input: event, encoding: 'utf8' });
  return hookResponse.stdout.trim();
}

test('end-to-end: HANDOFF.md heredoc rewrite mentioning bench/ paths is ALLOWED', () => {
  assert.equal(runHook(HANDOFF_REWRITE_COMMAND), ''); // empty stdout = no deny = allowed
});

test('end-to-end: real unchunked py -m bench.X invocation is DENIED', () => {
  const hookStdout = runHook('py -m bench.some_suite');
  assert.notEqual(hookStdout, '');
  const denyPayload = JSON.parse(hookStdout);
  assert.equal(denyPayload.hookSpecificOutput.permissionDecision, 'deny');
});

test('end-to-end: plain echo mentioning a bench path is ALLOWED', () => {
  assert.equal(runHook('echo "see bench/foo.py for details" > README.md'), '');
});
