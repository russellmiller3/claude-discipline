#!/usr/bin/env node
// long-running-script-guard.test.mjs — locks the run-shape guard's behavior, especially the fix for
// the false-positive Russell hit: a direct `node <file>.test.mjs` unit-test run was being blocked as a
// "long script" whenever the filename contained a long-keyword substring (e.g. hookbook-**sync**.test.mjs
// → matched 'sync'). Unit-test files are short by definition and must be exempt — without weakening the
// guard on genuinely long jobs (backfills, migrations, scrapes) that lack chunk/progress evidence.
//
// Run: node long-running-script-guard.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'long-running-script-guard.mjs');

// Returns true when the guard DENIED the command. The guard prints a deny JSON and exits 0; an allowed
// command prints nothing. We strip LONG_SCRIPT_OK from the child env so the override can't mask results.
function isDenied(command, toolName = 'Bash') {
  const childEnv = { ...process.env };
  delete childEnv.LONG_SCRIPT_OK;
  const run = spawnSync('node', [GUARD], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd: here }),
    encoding: 'utf8',
    env: childEnv,
  });
  return /"permissionDecision"\s*:\s*"deny"/.test(run.stdout || '');
}

const failures = [];
function check(label, condition) {
  if (condition) { console.log(`  ok  ${label}`); }
  else { console.log(`FAIL  ${label}`); failures.push(label); }
}

// THE BUG: a *.test.mjs run whose name contains a long-keyword ('sync') was blocked. Must be allowed.
check('allows node <name-with-sync>.test.mjs (the reported false-positive)',
  !isDenied('node hookbook-sync.test.mjs 2>&1 | tail -15'));

// Generic unit-test files run directly are short — allowed regardless of name.
check('allows a plain node *.test.mjs run', !isDenied('node lib/foo.test.mjs'));
check('allows a *.test.js run', !isDenied('node src/bar.test.js'));
check('allows a *.spec.ts run', !isDenied('node src/baz.spec.ts'));

// 2026-06-26 FALSE-BLOCK: `node bench/realworld/report.mjs` (a results READER) was denied because its
// path contains "bench" → the guard treated a sequential reader as a parallel bench run. A report /
// analysis reader is short by definition and must pass, even with a long-keyword in its path.
check('allows a bench REPORT reader (the 2026-06-26 false-block)', !isDenied('node bench/realworld/report.mjs'));
check('allows cd+report reader', !isDenied('cd extension && node bench/realworld/report.mjs'));
check('allows an analyze/summarize reader', !isDenied('node scripts/analyze-sweep.mjs runs/latest.jsonl'));
check('allows a python stats reader', !isDenied('python evals/stats.py'));

// 2026-06-30 FALSE-BLOCK: a git commit touching *.py files in bench/ — the `.py` EXTENSION matched the
// `py` interpreter pattern, so a plain git command (with a 'bench'/'migrate' keyword in a path) looked
// like a long python run. A git command runs no script; it must pass.
check('allows git add of .py files in bench/', !isDenied('git add bench/critic.py bench/gan.py'));
check('allows a git commit touching bench .py files',
  !isDenied('cd /x && git add bench/critic.py bench/gan.py && git commit -m "feat: gan kintsugi migrate sync"'));

// REGRESSION: genuinely long jobs with NO chunk/progress evidence must STILL be blocked.
check('still blocks a backfill script with no run-shape evidence', isDenied('node backfill-users.mjs'));
check('still blocks a scrape with a long-keyword and no evidence', isDenied('python crawl_sites.py'));
// a real bench HARNESS run (not a reader) with no evidence is still blocked — the reader exemption is narrow.
check('still blocks a bench HARNESS run with no evidence', isDenied('node some-bench-harness.mjs --all'));

// 2026-06-29 FALSE-BLOCK: a `py -c "import ..."` one-liner was denied because the long-keyword "import"
// appeared inside the quoted code string. An inline one-liner is short by definition; keywords inside
// quotes/code must not count.
check('allows py -c one-liner with import in the code (the 2026-06-29 false-block)', !isDenied('py -c "import websocket, sys; print(1)"'));
check('allows node -e one-liner', !isDenied('node -e "require(\'fs\').readFileSync(0)"'));
check('allows ls|grep with a long-keyword in the grep pattern', !isDenied('ls hooks | grep -iE "bench|migrate|sync"'));
// REGRESSION: a real long script FILE (not -c) with a long-keyword in its NAME is still gated.
check('still blocks a real migrate script file', isDenied('node run-migrate.mjs'));

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll long-running-script-guard checks passed.');
