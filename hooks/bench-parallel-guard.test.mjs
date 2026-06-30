// bench-parallel-guard.test.mjs — run: node --test ~/.claude/hooks/bench-parallel-guard.test.mjs
//
// The bug this pins (2026-06-25): the guard matched the bare word "bench" anywhere in a command, so
// read-only / VCS commands that merely MENTION a bench path (grep, git add, cat, ls, a report reader)
// got DENIED even though they run nothing. That false-block wasted real time and made a cheap bench
// run look un-runnable. The fix: only treat a command as a benchmark when it actually EXECUTES one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeBenchmark } from './bench-parallel-guard.mjs';

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
];

for (const command of NOT_RUNS) {
  test(`NOT a benchmark (runs nothing): ${command.slice(0, 48)}`, () => {
    assert.equal(looksLikeBenchmark(command), false);
  });
}

// ── these actually EXECUTE a bench — must still be gated ──
const REAL_RUNS = [
  'node bench/realworld/harness.mjs --cap=5',
  'cd extension && node bench/realworld/harness.mjs',
  'npm run bench',
  'npm run bench:sweep',
  'node scripts/model-bench.mjs',
  'python evals/sweep.py',
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
