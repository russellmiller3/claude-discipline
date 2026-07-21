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
import { stripHeredocBodies, stripPowerShellHereStrings, hasBackgroundJobFanOut, isUnitTestInvocation, isReadOnlyDiagnostic, isHookOrTempDiagnostic, isSanctionedInstantTool, looksLikeFanOutWork, isInstantInvocation } from './long-running-script-guard.mjs';

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

// 2026-07-01 FALSE-BLOCKS (this session): substring keyword matching + no py_compile exemption.
// (a) a py_compile syntax check is instant, never a long job.
check('allows a py_compile syntax check', !isDenied('python -m py_compile a.py b.py'));
// (b) "pretrained" in a filename must not match the "train" keyword (substring false-match).
check('allows a filename containing "pretrained" (not the word "train")',
  !isDenied('python -m modal run test_b_pretrained_fusion.py --sizes 20'));
// (c) "train"/"batch" inside FLAG NAMES must not demand fan-out parallelism on a single run.
check('allows a single training run whose FLAGS contain train/batch substrings',
  !isDenied('python run_fusion_sizes.py --sizes 20 --training-steps 1500 --training-batch-size 16'));
// REGRESSION: the WORD train (train.py) is still a real training job and stays gated.
check('still blocks a bare train.py with no run-shape evidence', isDenied('python train.py'));
// REGRESSION: an explicit --batch fan-out FLAG (standalone) still counts as fan-out.
check('still blocks a real batch job with the --batch flag and no evidence', isDenied('node process-orders.mjs --batch'));

// 2026-07-02 FALSE-BLOCK: a short `cat > probe.py <<'PY' … import subprocess … PY; py probe.py` write
// was denied because the long-keyword "import" appeared inside the HEREDOC BODY (file data written to
// disk, not shell structure). A heredoc body must never count toward the job's nature.
check('allows a cat-heredoc that writes a py file containing "import" (the 2026-07-02 false-block)',
  !isDenied("cat > probe.py <<'PY'\nimport subprocess, time\nprint('hi')\nPY\npy probe.py"));
check('allows a heredoc whose body mentions bench/migrate/sync but the run is short',
  !isDenied("cat > t.py <<'PY'\n# bench migrate sync import\nprint(1)\nPY\npy t.py"));
// REGRESSION: a heredoc body must not MASK a real long run in the actual executed command. The runner
// AFTER the heredoc (a bare bench harness with no evidence) is still gated.
check('still blocks a real bench harness run even when preceded by a heredoc write',
  isDenied("cat > x.txt <<'EOF'\nhello\nEOF\nnode some-bench-harness.mjs --all"));

// Unit-test the heredoc stripper directly: the body is gone, the redirection token survives.
{
  const stripped = stripHeredocBodies("cat > f.py <<'PY'\nimport os\nbench sweep\nPY\npy f.py");
  check('stripHeredocBodies removes the body keywords', !/import|bench|sweep/.test(stripped));
  check('stripHeredocBodies keeps the trailing runner', /py f\.py/.test(stripped));
}

// 2026-07-03 FALSE-BLOCK: `cmd1 & cmd2 & cmd3 & wait` (bash's own job-backgrounding fan-out) always
// read as unparalleled fan-out work — hasParallelEvidence only recognized keyword/flag evidence
// (parallel, concurrency, xargs -P, Start-Job), never the shell's native &...&wait idiom, even though
// backgrounding 2+ jobs and waiting on them plainly IS running them in parallel.
check('allows a real & fan-out (2+ backgrounded jobs + wait) with progress evidence (the 2026-07-03 false-block)',
  !isDenied('python train_a.py --shard 0 >> a.log 2>&1 & python train_b.py --shard 1 >> b.log 2>&1 & python train_c.py --shard 2 >> c.log 2>&1 & wait'));

// REGRESSION: the same fan-out shape with NO progress evidence at all must still block -- the fix
// only supplies PARALLEL evidence, it must not paper over a still-missing progress requirement.
check('still blocks the same & fan-out shape when progress evidence is missing',
  isDenied('python train_a.py --shard 0 & python train_b.py --shard 1 & python train_c.py --shard 2 & wait'));

// REGRESSION: `&&` is sequential AND, not job-backgrounding -- must never be read as parallel fan-out.
check('still blocks a sequential && chain masquerading as long work (no parallel evidence)',
  isDenied('python train_a.py --shard 0 >> a.log && python train_b.py --shard 1 >> b.log'));

// REGRESSION: a single backgrounded job is not fan-out (nothing to parallelize against).
check('a lone backgrounded job + wait is not treated as parallel fan-out (still needs real evidence)',
  isDenied('python backfill_all.py & wait'));

// xargs -I{} WITHOUT -P is genuinely sequential (one item at a time) -- a literal --resume flag must
// still be recognized as chunk/resume evidence, but the command must still block on missing PARALLEL
// evidence since it is not actually parallel. Confirms --resume detection is not the bug here.
check('still blocks xargs -I (no -P) even with --resume: genuinely sequential, missing parallel evidence only',
  isDenied('find . -name "*.json" | xargs -I{} node ingest.mjs --resume --file {}'));

// REGRESSION: xargs -P (real parallelism) with --resume already passed before this fix and must keep passing.
check('allows xargs -P with --resume (already-correct case, unaffected by the fix)',
  !isDenied('ls chunks/*.jsonl | xargs -P 4 -I {} node ingest.mjs --resume --chunk {} >> ingest.log 2>&1'));

// REGRESSION: a genuinely shapeless long run must still block, unaffected by the new & detection.
check('still blocks a bare shapeless long run (unaffected by the & fan-out fix)', isDenied('python train.py'));

// 2026-07-05 FALSE-BLOCK: a fast UNIT-TEST file + pure READ-ONLY diagnostics were denied because a
// training-keyword substring ('sweep','train','runs','sleepwake','steps') lived in the file PATH or
// filename. A test_*.py run (or pytest) is a fast test, never a long fan-out job; a command built only
// of wc/tail/head/ls/cat/grep/echo reads finished output and exits. Inspect the EXECUTED program +
// flags, not path/filename substrings. (Russell's 2026-07-05 tuning ask.)
// (a) a python target whose basename matches test_*.py is a unit-test run — allowed even with 'sweep' in the name.
check('allows python scripts/test_modal_sweep.py (unit-test file, not a sweep job)',
  !isDenied('python scripts/test_modal_sweep.py'));
// (b) a pure read-only diagnostic (wc over run-log files) is instant — allowed even with 'runs'/'sleepwake' in paths.
check('allows wc -l over runs/*.jsonl log files (read-only diagnostic)',
  !isDenied('wc -l runs/proj47_runs.jsonl runs/sleepwake_runs.jsonl'));
// REGRESSION: a GENUINE training run (word 'train' in the program name + a real --steps sweep) still blocks.
check('still blocks a genuine proj47_train.py --steps run with no run-shape evidence',
  isDenied('python scripts/proj47_train.py --single proj_every 1337 --steps 4000'));

// More coverage for the 2026-07-05 fix so the exemption stays narrow.
check('allows a pytest invocation targeting a sweep-named module', !isDenied('pytest tests/test_sweep_runner.py'));
check('allows python -m pytest', !isDenied('python -m pytest tests/'));
check('allows tail of a training run log (read-only)', !isDenied('tail -n 50 runs/train_sweep.log'));
check('allows head+grep pipeline over a runs file (read-only)', !isDenied('head -100 runs/sweep_runs.jsonl | grep proj47'));
// REGRESSION: a read-only exemption must not swallow a real long run hidden after a diagnostic in the chain.
check('still blocks a real train run chained after a read-only diagnostic',
  isDenied('wc -l runs/x.jsonl && python train.py --steps 4000'));
// REGRESSION: test_*.py exemption must not fire for a non-test python file that merely lives beside tests.
check('still blocks a real sweep file that is not a test_ file (proj47_sweep.py)',
  isDenied('python scripts/proj47_sweep.py --steps 4000'));

// Unit-test the two new classifiers directly.
{
  check('isUnitTestInvocation: true for python scripts/test_modal_sweep.py',
    isUnitTestInvocation('python scripts/test_modal_sweep.py'));
  check('isUnitTestInvocation: true for pytest tests/test_x.py', isUnitTestInvocation('pytest tests/test_x.py'));
  check('isUnitTestInvocation: true for python -m pytest', isUnitTestInvocation('python -m pytest tests/'));
  check('isUnitTestInvocation: false for a non-test python file (proj47_sweep.py)',
    !isUnitTestInvocation('python scripts/proj47_sweep.py --steps 4000'));
  check('isUnitTestInvocation: false for a bare train.py', !isUnitTestInvocation('python train.py'));

  check('isReadOnlyDiagnostic: true for wc over two run files',
    isReadOnlyDiagnostic('wc -l runs/proj47_runs.jsonl runs/sleepwake_runs.jsonl'));
  check('isReadOnlyDiagnostic: true for a head|grep pipeline', isReadOnlyDiagnostic('head -100 runs/x.jsonl | grep proj47'));
  check('isReadOnlyDiagnostic: true for tail of a log', isReadOnlyDiagnostic('tail -n 50 runs/train_sweep.log'));
  check('isReadOnlyDiagnostic: false when a python run is in the chain',
    !isReadOnlyDiagnostic('wc -l runs/x.jsonl && python train.py --steps 4000'));
  check('isReadOnlyDiagnostic: false for a bare train run', !isReadOnlyDiagnostic('python train.py --steps 4000'));
}

// Unit-test hasBackgroundJobFanOut directly: 2+ single-& job separators plus a bare `wait`.
{
  check('hasBackgroundJobFanOut: true for a & b & c & wait', hasBackgroundJobFanOut('a & b & c & wait'));
  check('hasBackgroundJobFanOut: false for a && b && c (sequential, no backgrounding)',
    !hasBackgroundJobFanOut('a && b && c'));
  check('hasBackgroundJobFanOut: false for a lone backgrounded job (cmd & wait)',
    !hasBackgroundJobFanOut('cmd & wait'));
  check('hasBackgroundJobFanOut: false with no wait at all (fire-and-forget, never joined)',
    !hasBackgroundJobFanOut('a & b & c'));
  check('hasBackgroundJobFanOut: false for the PowerShell call operator (single leading &, no bare wait)',
    !hasBackgroundJobFanOut('& "C:\\Program Files\\App\\app.exe" arg1 arg2'));
  check('hasBackgroundJobFanOut: true for mixed && and & separators as long as 2+ single-& plus wait',
    hasBackgroundJobFanOut('a & b && c & wait'));
}

// 2026-07-16 FALSE-BLOCKS: running a HOOK file / temp-dir throwaway / live-fire JSON pipe, and the
// launch-agent kit's brief GENERATOR, were all denied as "long scripts". They are instantaneous.
{
  // (A) hook file / temp dir / live-fire pipe — unit-level.
  check('isHookOrTempDiagnostic: true for running a hook file', isHookOrTempDiagnostic('node C:/Users/rmill/.claude/hooks/experiment-manifest-guard.mjs'));
  check('isHookOrTempDiagnostic: true for a /tmp throwaway script', isHookOrTempDiagnostic('node /tmp/dbg2.mjs'));
  check('isHookOrTempDiagnostic: true for an AppData\\Local\\Temp script',
    isHookOrTempDiagnostic('node C:/Users/rmill/AppData/Local/Temp/x.mjs'));
  check('isHookOrTempDiagnostic: true for a live-fire JSON pipe into a hook',
    isHookOrTempDiagnostic(`printf '{"hook_event_name":"PreToolUse","tool_name":"Bash"}' | node C:/Users/rmill/.claude/hooks/x.mjs`));
  check('isHookOrTempDiagnostic: false for a real training run', !isHookOrTempDiagnostic('python train.py --steps 4000'));
  // (A) integration — the guard must ALLOW these shapes even with training keywords nearby.
  check('allows running a hook file (live-fire target)',
    !isDenied('node C:/Users/rmill/.claude/hooks/experiment-manifest-guard.mjs'));
  check('allows a live-fire JSON pipe into a hook',
    !isDenied(`printf '{"hook_event_name":"PreToolUse","tool_input":{"command":"train sweep"}}' | node C:/Users/rmill/.claude/hooks/x.mjs`));
  check('allows a /tmp diagnostic even with a training keyword in its name',
    !isDenied('node /tmp/dbg_train_sweep.mjs'));

  // (C) launch-agent kit brief generator — sub-second template emitter, MANDATED before every spawn.
  check('isSanctionedInstantTool: true for an agent-kit brief emitter',
    isSanctionedInstantTool('node ~/.claude/scripts/agent-kit/agent-brief.mjs --task-name x --repo y --mission z'));
  check('isSanctionedInstantTool: false for an arbitrary node script', !isSanctionedInstantTool('node train_sweep.mjs'));
  check('allows the agent-brief.mjs generator with many args (the circular-trap false-block)',
    !isDenied('node ~/.claude/scripts/agent-kit/agent-brief.mjs --task-name fix-x --repo /r --mission m --merge-test "npm test" --goal g'));
  // REGRESSION: a genuine training sweep is still gated (allowlist stays narrow).
  check('still blocks a genuine train_sweep.py with no run-shape evidence', isDenied('python train_sweep.py --steps 4000'));
}

// 2026-07-17 FALSE-BLOCK: a single-pod, single-seed training launch was forced to prove parallelism it
// cannot have — `--batch-size` matched the `--batch` fan-out flag, and the lone `train` keyword tripped
// fan-out even for one seed. Fan-out means MULTIPLE units (plural --seeds / --all / a bare --batch).
{
  check('looksLikeFanOutWork: false for a single-seed launch with --batch-size (single-pod repro)',
    !looksLikeFanOutWork('py -3 runpod_exp151.py launch --seed 9151 --batch-size 2 --task-count 4', here));
  check('looksLikeFanOutWork: false for a lone train keyword + singular --seed',
    !looksLikeFanOutWork('python train_qwen_dependent.py --seed 9151 --batch-size 2', here));
  check('looksLikeFanOutWork: true for a plural --seeds multi-seed sweep',
    looksLikeFanOutWork('python run_exp151_qwen_remote.py --seeds 151 152 153', here));
  check('looksLikeFanOutWork: false for --batch-size 8 alone (a hyperparameter, not a batch selector)',
    !looksLikeFanOutWork('python some_script.py --batch-size 8', here));
  check('looksLikeFanOutWork: true for a bare --batch flag (a real batch/shard selector)',
    looksLikeFanOutWork('node process-orders.mjs --batch', here));
  // Integration: the single-pod launch no longer demands parallel evidence.
  check('allows the single-pod launch (no fan-out, so no parallel requirement)',
    !isDenied('py -3 runpod_exp151.py launch --artifact-root ../runs/exp151-smoke --seed 9151 --chain-length 2 --scale qwen2.5-coder-1.5b --steps 2 --batch-size 2 --task-count 4'));
}

// 2026-07-15 FALSE-BLOCKS: sub-second read-only commands were denied because the keyword scan read
// the WHOLE command string — commit-message text and data arguments included — as if it were the
// executable job. Three documented cases from today, plus the here-string shape that actually fired:
// a commit message written as a PowerShell here-string (@'...'@) containing an apostrophe broke the
// quote-pairing blanker, exposing the message body (with a `py -3 ... bench.py` mention) to the scan.
// (a) a git commit whose -m STRING contains a bench filename — the message is DATA, not the job.
check('allows git commit -m with a bench filename inside the message (2026-07-15 case a)',
  !isDenied('git commit -m "feat(bench): add scripts/codeservo_session_bench.py --turns 24 runner"'));
// (a, actual firing shape) here-string commit message with an apostrophe + runner text in the body.
check('allows a here-string commit message with an apostrophe and a py-runner mention (the 2026-07-15 block)',
  !isDenied("git commit -m @'\nfeat(bench): plan152 warm bench\n- don't rerun; verified via py -3 scripts/codeservo_session_bench.py --turns 24\n'@"));
check('allows the same here-string commit via the PowerShell tool',
  !isDenied("git commit -m @'\nfeat(bench): plan152 warm bench\n- don't rerun; verified via py -3 scripts/codeservo_session_bench.py --turns 24\n'@", 'PowerShell'));
// (b) a cp of a bench-named script is a sub-second copy, never a run.
check('allows cp of a bench-named script (2026-07-15 case b)',
  !isDenied('cp scripts/codeservo_session_bench.py /tmp/neutral.py'));
// (c) a --help invocation prints usage and exits — instant regardless of the script name.
check('allows py -3 <bench-named>.py --help (2026-07-15 case c)',
  !isDenied('py -3 script_with_bench_in_name.py --help'));
check('allows python <bench script> --help variant',
  !isDenied('python scripts/codeservo_session_bench.py --help'));
// git log / git diff are read-only regardless of bench keywords in paths.
check('allows git log over a bench path', !isDenied('git log --oneline -5 -- scripts/codeservo_session_bench.py'));
check('allows git diff of a bench file', !isDenied('git diff scripts/codeservo_session_bench.py'));
// REGRESSION: a bare bench run with NO resume/concurrency evidence must STILL block.
check('still blocks bare python codeservo_session_bench.py --turns 24 (true positive, 2026-07-15)',
  isDenied('python codeservo_session_bench.py --turns 24'));
// REGRESSION: --help on one segment must not mask a real bench run chained after it.
check('still blocks a real bench run chained after a --help segment',
  isDenied('py -3 x.py --help && python codeservo_session_bench.py --turns 24'));
// REGRESSION: a cp segment must not mask a real bench run chained after it.
check('still blocks a real bench run chained after a cp',
  isDenied('cp a.txt b.txt && python codeservo_session_bench.py --turns 24'));

// Unit-test the two new classifiers directly.
{
  const strippedHereString = stripPowerShellHereStrings("git commit -m @'\ndon't rerun py -3 bench.py\n'@");
  check('stripPowerShellHereStrings removes the here-string body', !/bench|don't|py -3/.test(strippedHereString));
  check('stripPowerShellHereStrings keeps the surrounding command', /git commit -m @''@/.test(strippedHereString));
  check('stripPowerShellHereStrings leaves a plain command untouched',
    stripPowerShellHereStrings('python train.py --steps 4000') === 'python train.py --steps 4000');

  check('isInstantInvocation: true for a git commit with a bench message',
    isInstantInvocation('git commit -m "feat(bench): codeservo_session_bench.py"'));
  check('isInstantInvocation: true for git -C <path> commit (flag before subcommand)',
    isInstantInvocation('git -C C:/repo commit -m "bench evidence"'));
  check('isInstantInvocation: true for a cp of a bench script',
    isInstantInvocation('cp scripts/codeservo_session_bench.py /tmp/neutral.py'));
  check('isInstantInvocation: true for a --help invocation',
    isInstantInvocation('py -3 script_with_bench_in_name.py --help'));
  check('isInstantInvocation: false for git push (not an instant subcommand)',
    !isInstantInvocation('git push origin main'));
  check('isInstantInvocation: false for a bare bench run',
    !isInstantInvocation('python codeservo_session_bench.py --turns 24'));
  check('isInstantInvocation: false when a real run chains after a --help segment',
    !isInstantInvocation('py -3 x.py --help && python codeservo_session_bench.py --turns 24'));
  check('isInstantInvocation: false for --help hidden inside a quoted string',
    !isInstantInvocation('python codeservo_session_bench.py --turns 24 --note "see --help for docs"'));
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll long-running-script-guard checks passed.');
