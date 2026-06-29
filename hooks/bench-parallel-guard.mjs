#!/usr/bin/env node
/**
 * PreToolUse hook - benchmark commands must be parallelized and chunked.
 *
 * Russell's rule: benches/sweeps that fan out across models, scenarios, or
 * prompts should use a worker pool / concurrency cap by default. Long benches
 * must also be interruptible: run in small chunks and stream or save progress.
 *
 * This is intentionally generic:
 * - Detects benchmark-ish Bash commands.
 * - Allows commands with explicit parallel/concurrency markers.
 * - Allows script commands when the script source shows a worker pool.
 * - Blocks obvious bench commands with no parallel evidence.
 * - Blocks full-suite bench commands with no chunk/resume evidence.
 * - Blocks long bench commands with no progress/checkpoint evidence.
 *
 * Overrides:
 * - BENCH_SERIAL_OK=1 for tiny diagnostic benches where serial is intentional.
 * - BENCH_FULL_OK=1 only after Russell explicitly approves a full uninterrupted run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

function main() {
  if (process.env.BENCH_SERIAL_OK === '1') process.exit(0);

  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  const toolName = event.tool_name || event.toolName || '';
  if (toolName !== 'Bash' && toolName !== 'PowerShell') process.exit(0);

  const command = String(event.tool_input?.command || event.toolInput?.command || '').trim();
  if (!command) process.exit(0);

  if (!looksLikeBenchmark(command)) process.exit(0);
  if (isTinyDiagnostic(command)) process.exit(0);

  const cwd = event.cwd || process.cwd();
  const hasParallelEvidence = hasParallelMarker(command) || scriptSourceHasParallelism(command, cwd);
  if (!hasParallelEvidence) {
    deny(
      `Benchmark blocked: no parallel/concurrency evidence.\n\n` +
        `Russell's rule: benches, sweeps, and model evals must run with a worker pool or explicit concurrency cap by default.\n` +
        `Parallelism cuts wall-clock and exposes failures early. It does NOT reduce token cost, so still estimate spend first.\n\n` +
        describeDetectedCommand(command) +
        `Fix it by adding one of:\n` +
        `  - a --parallel or --concurrency flag\n` +
        `  - an env cap like CONCURRENCY=8\n` +
        `  - xargs -P / GNU parallel / Start-Job / ForEach-Object -Parallel\n` +
        `  - a script-level worker pool (Promise.all, p-limit, queue workers)\n\n` +
        `For a deliberately tiny serial diagnostic, rerun with BENCH_SERIAL_OK=1 and say why.`
    );
  }

  if (process.env.BENCH_FULL_OK === '1') process.exit(0);

  const hasChunkEvidence = hasChunkMarker(command);
  if (looksLikeFullSuite(command) && !hasChunkEvidence) {
    deny(
      `Benchmark blocked: full-suite run is not chunked.\n\n` +
        `Russell's rule: expensive or long benches must run in small, interruptible pieces.\n` +
        `A 20+ minute command with no safe stop point is the failure mode this hook exists to prevent.\n\n` +
        describeDetectedCommand(command) +
        `Fix it by running one bounded slice at a time:\n` +
        `  - add --chunk, --scenario, --model, --limit, --only, or --resume\n` +
        `  - write partial results after each row or chunk\n` +
        `  - aggregate only after the chunks finish\n` +
        `  - update Russell after each chunk with progress and spend\n\n` +
        `Only use BENCH_FULL_OK=1 after Russell explicitly approves a full uninterrupted run.`
    );
  }

  if (looksLongRunning(command) && !hasChunkEvidence && !hasProgressEvidence(command, cwd)) {
    deny(
      `Benchmark blocked: long run has no progress/checkpoint evidence.\n\n` +
        `Russell's rule: long benches must stream visible progress and save partial results as they go.\n` +
        `If Russell checks in mid-run, there must be something concrete to report.\n\n` +
        describeDetectedCommand(command) +
        `Fix it by adding one of:\n` +
        `  - JSONL/checkpoint writes after every row\n` +
        `  - --progress, --stream, --jsonl, --log, or --resume\n` +
        `  - Tee-Object / tee to a live log file\n` +
        `  - per-chunk reporting back to Russell\n\n` +
        `Only use BENCH_FULL_OK=1 after Russell explicitly approves the uninterrupted run.`
    );
  }

  process.exit(0);
}

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// A bench RUN — not a command that merely MENTIONS a bench path. The old version matched the bare
// word "bench" anywhere, so `grep bench`, `git add .../bench/...`, `cat bench/x`, `node report.mjs`
// (analyzing results) all got blocked even though they run nothing. That false-block wasted real time
// and made a cheap run look un-runnable. Now we require BOTH a bench-ish target AND an actual execution
// verb (a script runner / npm-run / make). Read-only + VCS commands pass untouched. (2026-06-25)
// Strip quoted-string literals and inline-code args (-c/-e/-p/-Command) so keyword detection sees
// only the executable structure — never text inside quotes/code. Without this, `grep "bench"` and
// `echo "...py -c..."` (which run nothing) false-tripped the guard. (2026-06-29)
export function executableText(command) {
  let scannableCommand = String(command);
  scannableCommand = scannableCommand.replace(/(\s-(?:c|e|p)\b|\s--?command\b)\s*(["'])(?:\\.|(?!\2).)*\2/gi, '$1 ""');
  scannableCommand = scannableCommand.replace(/(\s-(?:c|e|p)\b|\s--?command\b)\s+[^\s"'|&;]+/gi, '$1 ');
  return scannableCommand.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

export function looksLikeBenchmark(command) {
  const loweredCommand = executableText(command).toLowerCase();
  if (/\bnpm(\.cmd)?\s+(run\s+)?test\b/.test(loweredCommand)) return false;
  if (/\b(pytest|vitest|playwright|svelte-check|eslint|prettier)\b/.test(loweredCommand)) return false;
  // `node --check X` is a SYNTAX parse, not a run — never a benchmark, even on a bench/suite file.
  if (/\bnode\s+--check\b/.test(loweredCommand)) return false;
  // A unit/spec test file run directly is not a benchmark either (its name may contain a bench keyword).
  if (/\.(test|spec)\.[mc]?[jt]s\b/.test(loweredCommand)) return false;

  const mentionsBench = (
    /\bbench(mark)?\b/.test(loweredCommand) ||
    /\bmodel-bench\b/.test(loweredCommand) ||
    /\bbayes-eval\b/.test(loweredCommand) ||
    /\bsweep\b/.test(loweredCommand) ||
    /\beval[-_:]?(meph|model|models|llm|ai)\b/.test(loweredCommand)
  );
  if (!mentionsBench) return false;

  // Only gate when the command actually EXECUTES the bench. A script runner invoking a file, an
  // npm/pnpm/yarn run, or make. Inspection/VCS commands (grep, rg, cat, ls, head, tail, find, wc,
  // git, sed, awk, echo, Select-String, Get-Content) run nothing and are never benchmarks.
  const runsSomething = (
    /\b(node|bun|tsx|deno|ts-node|python3?|py)\b\s/.test(loweredCommand) ||
    /\b(npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?\S/.test(loweredCommand) ||
    /\b(powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/.test(loweredCommand) ||
    /\bmake\b\s/.test(loweredCommand)
  );
  // Even an execution that's clearly a RESULTS/REPORT reader (not a run) shouldn't be gated.
  const isReportReader = /\breport(\.mjs|\.js|\.py)?\b/.test(loweredCommand) && !/\bharness|runner|run\.mjs\b/.test(loweredCommand);

  return runsSomething && !isReportReader;
}

function hasParallelMarker(command) {
  return (
    /\bparallel\b/i.test(command) ||
    /\bconcurrency\b/i.test(command) ||
    /\bCONCURRENCY\s*=/i.test(command) ||
    /\bMAX_WORKERS\s*=/i.test(command) ||
    /\bWORKERS\s*=/i.test(command) ||
    /\bxargs\s+-P\b/i.test(command) ||
    /\bStart-Job\b/i.test(command) ||
    /\bForEach-Object\s+-Parallel\b/i.test(command) ||
    /\brun_in_background\b/i.test(command)
  );
}

function hasChunkMarker(command) {
	return (
    /(?:^|\s)(--chunk|--shard|--batch|--scenario|--scenarios|--model|--models|--limit|--only|--task|--case|--resume|--judge-only|--from|--to)(?:\s|=|$)/i.test(command) ||
    hasModelBenchScenarioArg(command)
  );
}

function hasModelBenchScenarioArg(command) {
  const match = /\bmodel-bench\.mjs\s+([^|&;]+)/i.exec(command);
  if (!match) return false;

  const args = match[1]
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return args.some((arg) => !arg.startsWith('-') && !/^[A-Z_]+=/.test(arg));
}

function looksLikeFullSuite(command) {
  const loweredCommand = command.toLowerCase();
  if (/\b(full|all|suite|sweep)\b/.test(loweredCommand)) return true;
  if (/\bmodel-bench\.mjs\b/.test(loweredCommand) && !hasModelBenchScenarioArg(command) && !hasChunkMarker(command)) return true;
  if (/\b(--judge|--all-models|--all-scenarios)\b/i.test(command) && !hasChunkMarker(command)) return true;
  return false;
}

function looksLongRunning(command) {
  return (
    looksLikeFullSuite(command) ||
    /\b(--judge|--all|--full|--sweep|--models|--scenarios)\b/i.test(command)
  );
}

function hasProgressEvidence(command, cwd) {
  return hasProgressMarker(command) || scriptSourceHasProgress(command, cwd);
}

function hasProgressMarker(command) {
  return (
    /(?:^|\s)(--progress|--stream|--jsonl|--log|--checkpoint|--resume|--judge-only)(?:\s|=|$)/i.test(command) ||
    /\b(Tee-Object|tee|Start-Transcript)\b/i.test(command) ||
    /(?:^|\s)(?:>>|2>&1|1>)/.test(command) ||
    />\s*["']?[^"'|&;]+\.(?:log|jsonl|ndjson|txt)\b/i.test(command)
  );
}

function scriptSourceHasParallelism(command, cwd) {
  const scriptPaths = extractScriptPaths(command);
  for (const scriptPath of scriptPaths) {
    const resolvedScript = isAbsolute(scriptPath) ? scriptPath : resolve(cwd, scriptPath);
    if (!existsSync(resolvedScript)) continue;
    let source = '';
    try {
      source = readFileSync(resolvedScript, 'utf8');
    } catch {
      continue;
    }

    if (
      /\bCONCURRENCY\b/.test(source) ||
      /\bPromise\.all\b/.test(source) ||
      /\bp-?limit\b/i.test(source) ||
      /\bworker pool\b/i.test(source) ||
      /\bArray\.from\(\s*\{\s*length:\s*Math\.min/i.test(source) ||
      /\bForEach-Object\s+-Parallel\b/i.test(source) ||
      /\bStart-Job\b/i.test(source)
    ) {
      return true;
    }
  }
  return false;
}

function scriptSourceHasProgress(command, cwd) {
  const scriptPaths = extractScriptPaths(command);
  for (const scriptPath of scriptPaths) {
    const resolvedScript = isAbsolute(scriptPath) ? scriptPath : resolve(cwd, scriptPath);
    if (!existsSync(resolvedScript)) continue;
    let source = '';
    try {
      source = readFileSync(resolvedScript, 'utf8');
    } catch {
      continue;
    }

    if (
      /\bappendFileSync\b/.test(source) ||
      /\bcreateWriteStream\b/.test(source) ||
      /\.jsonl\b/i.test(source) ||
      /\bcheckpoint\b/i.test(source) ||
      /\bwriteProgress\b/.test(source) ||
      /\bonProgress\b/.test(source) ||
      /\bprocess\.stdout\.write\b/.test(source)
    ) {
      return true;
    }
  }
  return false;
}

function extractScriptPaths(command) {
  const paths = new Set();
  const scriptRe = /(?:node|bun|tsx|python|python3|py|powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-[^\s]+\s+)*(?:"([^"]+\.(?:mjs|cjs|js|ts|py|ps1))"|'([^']+\.(?:mjs|cjs|js|ts|py|ps1))'|([^\s"'|&;]+\.(?:mjs|cjs|js|ts|py|ps1)))/gi;
  let match;
  while ((match = scriptRe.exec(command)) !== null) {
    paths.add(match[1] || match[2] || match[3]);
  }
  return [...paths];
}

function isTinyDiagnostic(command) {
  return /\b(--scenario|--only|--case|--limit)\b/i.test(command) && /\b1\b/.test(command);
}

function describeDetectedCommand(command) {
  return `Detected command:\n  ${command.slice(0, 240)}${command.length > 240 ? '...' : ''}\n\n`;
}

// Entry-point guard so importing this for tests does not execute main() (which reads stdin and hangs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
