#!/usr/bin/env node
/**
 * PreToolUse hook - long-running scripts must be chunked, resumable, visible,
 * and parallelized where the work fans out.
 *
 * Generic user-level hook. Project-specific long-run keywords belong in
 * <project>/.claude/long-running-script-guard.json.
 *
 * Override: LONG_SCRIPT_OK=1 only after Russell explicitly approves a single
 * uninterrupted run and the reply says why that is worth the risk.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function main() {
	if (process.env.LONG_SCRIPT_OK === '1') process.exit(0);

	let hookEvent;
	try {
		hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}');
	} catch {
		process.exit(0);
	}

	const toolName = hookEvent.tool_name || hookEvent.toolName || '';
	if (toolName !== 'Bash' && toolName !== 'PowerShell') process.exit(0);

	const command = String(hookEvent.tool_input?.command || hookEvent.toolInput?.command || '').trim();
	if (!command || !looksLikeLongScript(command, hookEvent.cwd || process.cwd())) process.exit(0);
	if (isKnownShortCommand(command)) process.exit(0);
	// 2026-07-05: exempt fast unit-test files (test_*.py / pytest) and pure read-only diagnostics
	// (wc/tail/head/ls/cat/grep/echo) — both were false-blocked because a training-keyword substring
	// ('sweep','train','runs','sleepwake','steps') lived in a PATH/filename. These classifiers inspect
	// the EXECUTED program + flags, not path substrings.
	if (isUnitTestInvocation(command)) process.exit(0);
	if (isReadOnlyDiagnostic(command)) process.exit(0);
	if (isHookOrTempDiagnostic(command)) process.exit(0);
	if (isSanctionedInstantTool(command)) process.exit(0);

	const cwd = hookEvent.cwd || process.cwd();
	const chunked = hasChunkOrResumeEvidence(command, cwd);
	const visible = hasProgressEvidence(command, cwd);
	const fanOut = looksLikeFanOutWork(command, cwd);
	const parallel = hasParallelEvidence(command, cwd);

	if (!chunked || !visible || (fanOut && !parallel)) {
		const missingRules = [
			!chunked ? '- interruptible/resumable chunks' : null,
			!visible ? '- progress output/checkpoints while it runs' : null,
			fanOut && !parallel ? '- parallel workers/concurrency for independent work' : null
		].filter(Boolean).join('\n');

		deny(
			`Long-running script blocked: missing required run-shape evidence.\n\n` +
				`Russell's rule: scripts that might run long must be small-piece, resumable, visible, and parallel where possible.\n\n` +
				`Missing:\n${missingRules}\n\n` +
				describeDetectedCommand(command) +
				`Fix it before running:\n` +
				`  - chunk it with --chunk, --scenario, --model, --limit, --from/--to, --page, or --resume\n` +
				`  - write progress to JSONL/checkpoint/log rows as each unit completes\n` +
				`  - use CONCURRENCY/WORKERS/Promise.all/p-limit/xargs -P/Start-Job for fan-out work\n` +
				`  - update Russell after each chunk with completed units, failures, spend, and next chunk\n\n` +
				`Only use LONG_SCRIPT_OK=1 after Russell explicitly approves a single uninterrupted run.`
		);
	}

	process.exit(0);
}

// name-by-use-override: `cwd` is this file's established parameter name (current working dir),
// used by every detector below — kept for consistency, not introduced here.
function looksLikeLongScript(command, cwd) {
	// Scan only the EXECUTABLE structure, not quoted strings or inline -c/-e code: a keyword like
	// "import"/"sync"/"bench" inside `py -c "import x"` or `grep "bench"` runs nothing and must not
	// trip the guard (the false-block that hit trivial one-liners). (2026-06-29)
	const scannableCommand = executableText(command).toLowerCase();
	if (!scriptRunnerPattern().test(scannableCommand) && !/\b(npm|pnpm|yarn)\s+(run\s+)?[\w:-]+/i.test(scannableCommand)) {
		return false;
	}

	const config = readProjectConfig(cwd);
	const longKeywords = [
		'bench', 'benchmark', 'sweep', 'eval', 'backfill', 'migrate', 'migration',
		'import', 'export', 'crawl', 'scrape', 'train', 'batch', 'bulk', 'generate',
		'reindex', 'recompute', 'ingest', 'sync', 'harvest', 'rebuild',
		...(config.longKeywords || [])
	];

	const keywordText = keywordScannable(command).toLowerCase();
	// `--batch` must be a BARE flag; `--batch-size`/`--batch-norm` are training hyperparameters,
	// not batch/sweep selectors — a plain `\b` matched the `-` in `--batch-size` and false-tripped
	// single-pod training launches. Require a \s|=|$ boundary. (2026-07-17)
	return longKeywords.some((keyword) => containsKeyword(keywordText, keyword.toLowerCase())) ||
		/\s(--all|--full|--everything|--entire|--sweep)\b/i.test(command) ||
		/\s--batch(?:\s|=|$)/i.test(command);
}

// Return the command with quoted-string literals and inline-code args (-c/-e/-p/-Command) blanked
// out, so keyword detection sees only the executable structure — never text inside quotes or code.
export function executableText(command) {
	let scannableCommand = String(command);
	// Blank HEREDOC BODIES first: `cat > f <<'TAG' … TAG` writes file DATA, not shell structure, so a
	// long-keyword inside the written file (e.g. `import x` in a py script) must not read as the job's
	// nature — the false-block that hit a short `cat > probe.py <<'PY' import … PY; py probe.py` write.
	// Keep the `<<TAG` redirection token, drop everything up to the closing delimiter line. (2026-07-02)
	scannableCommand = stripHeredocBodies(scannableCommand);
	scannableCommand = scannableCommand.replace(/(\s-(?:c|e|p)\b|\s--?command\b)\s*(["'])(?:\\.|(?!\2).)*\2/gi, '$1 ""');
	scannableCommand = scannableCommand.replace(/(\s-(?:c|e|p)\b|\s--?command\b)\s+[^\s"'|&;]+/gi, '$1 ');
	scannableCommand = scannableCommand.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
	return scannableCommand;
}

// Blank the body of every heredoc, keeping only the `<<DELIM` redirection token. Matches `<<DELIM`,
// `<< 'DELIM'`, `<<"DELIM"`, and the `<<-DELIM` indented form; the body runs up to a line that is the
// bare delimiter (leading tabs allowed for `<<-`). A heredoc writes DATA to a file/stdin — its content
// is never the shell's executable structure, so keyword scanning must not see it.
export function stripHeredocBodies(command) {
	return String(command).replace(
		/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?^[ \t]*\2[ \t]*$/gm,
		'<<$2'
	);
}

// Text for KEYWORD detection: executableText with flag tokens (--flag[=val], -x) blanked, so a
// long-keyword living inside a FLAG NAME — `--training-batch-size` contains "train"+"batch",
// `--pretrained` contains "train" — is not read as the job's nature. Explicit fan-out FLAGS
// (--all/--sweep/--batch) are matched separately, on the raw command, so they still count. (2026-07-01)
export function keywordScannable(command) {
	return executableText(command).replace(/(^|\s)--?[A-Za-z][\w-]*(=\S+)?/g, ' ');
}

// Whole-word keyword test: "train" matches the WORD train (train.py, re-train), NOT a substring of
// "pretrained"/"training". Non-alphanumeric (space, ., -, _, /) counts as a word boundary.
export function containsKeyword(scannableCommand, keyword) {
	return new RegExp(`(?:^|[^a-z0-9])${keyword}(?:[^a-z0-9]|$)`, 'i').test(scannableCommand);
}

// name-by-use-override: `cwd` is this file's established param name (current working dir), used by
// every detector; kept for consistency, not introduced here.
export function looksLikeFanOutWork(command, cwd) {
	const config = readProjectConfig(cwd);
	const fanOutKeywords = [
		'bench', 'benchmark', 'sweep', 'eval', 'batch', 'bulk', 'crawl', 'scrape',
		'train', 'generate', 'ingest', 'reindex', 'recompute',
		...(config.fanOutKeywords || [])
	];

	// Explicit fan-out CONTROL flags — plural targets or worker pools — always count. `--batch`
	// must be BARE (a batch/shard selector); `--batch-size`/`--batch-norm` are per-step training
	// hyperparameters, not fan-out controls, so require a \s|=|$ boundary (a plain `\b` matched the
	// `-` in `--batch-size` and forced a single-pod launch to prove parallelism it can't have). 2026-07-17
	if (/\s(--all|--full|--models|--scenarios|--workers?|--seeds|--tasks)\b/i.test(command) ||
		/\s--batch(?:\s|=|$)/i.test(command)) {
		return true;
	}

	// A bare fan-out KEYWORD (train/sweep/eval/…) only means fan-out when the run targets MULTIPLE
	// units. A single-target launch (a singular `--seed <n>`, no plural `--seeds`) with a lone
	// keyword is ONE unit of work — don't demand parallel evidence of it. (2026-07-17, single-pod launch)
	const keywordText = keywordScannable(command).toLowerCase();
	const hasFanOutKeyword = fanOutKeywords.some((keyword) => containsKeyword(keywordText, keyword.toLowerCase()));
	if (!hasFanOutKeyword) return false;
	const hasSingularSeed = /\s--seed(?:\s|=)\s*\S+/i.test(command) && !/\s--seeds\b/i.test(command);
	return !hasSingularSeed;
}

function hasChunkOrResumeEvidence(command, cwd) {
	if (
		/(?:^|\s)(--chunk|--shard|--batch|--scenario|--scenarios|--model|--models|--limit|--only|--task|--case|--resume|--checkpoint|--from|--to|--page|--offset|--cursor)(?:\s|=|$)/i.test(command) ||
		/\b(CHUNK|SHARD|BATCH|RESUME|CHECKPOINT|LIMIT|OFFSET|PAGE)\s*=/i.test(command)
	) {
		return true;
	}

	return scriptSourceMatches(command, cwd, [
		/\bresume\b/i,
		/\bcheckpoint\b/i,
		/\bchunk\b/i,
		/\bshard\b/i,
		/\boffset\b/i,
		/\bcursor\b/i,
		/\bappendFileSync\b/,
		/\.jsonl\b/i
	]);
}

function hasProgressEvidence(command, cwd) {
	if (
		/(?:^|\s)(--progress|--stream|--jsonl|--log|--checkpoint|--resume|--verbose)(?:\s|=|$)/i.test(command) ||
		/\b(Tee-Object|tee|Start-Transcript)\b/i.test(command) ||
		/(?:^|\s)(?:>>|2>&1|1>)/.test(command) ||
		/>\s*["']?[^"'|&;]+\.(?:log|jsonl|ndjson|txt)\b/i.test(command)
	) {
		return true;
	}

	return scriptSourceMatches(command, cwd, [
		/\bappendFileSync\b/,
		/\bcreateWriteStream\b/,
		/\.jsonl\b/i,
		/\bcheckpoint\b/i,
		/\bwriteProgress\b/,
		/\bonProgress\b/,
		/\bprocess\.stdout\.write\b/
	]);
}

// name-by-use-override: `cwd` is this file's established parameter name (current working dir),
// used by every detector in this file — kept for consistency, not introduced here.
function hasParallelEvidence(command, cwd) {
	if (
		/\bparallel\b/i.test(command) ||
		/\bconcurrency\b/i.test(command) ||
		/\b(CONCURRENCY|MAX_WORKERS|WORKERS)\s*=/i.test(command) ||
		/\bxargs\s+-P\b/i.test(command) ||
		/\bStart-Job\b/i.test(command) ||
		/\bForEach-Object\s+-Parallel\b/i.test(command) ||
		hasBackgroundJobFanOut(command)
	) {
		return true;
	}

	return scriptSourceMatches(command, cwd, [
		/\bCONCURRENCY\b/,
		/\bPromise\.all\b/,
		/\bp-?limit\b/i,
		/\bworker pool\b/i,
		/\bArray\.from\(\s*\{\s*length:\s*Math\.min/i,
		/\bStart-Job\b/i,
		/\bForEach-Object\s+-Parallel\b/i
	]);
}

// Shell-native fan-out: `cmd1 & cmd2 & cmd3 & wait` backgrounds two-plus jobs then blocks on all of
// them — that IS parallel execution, just spelled with bash job control instead of a --parallel flag
// or xargs -P. Missed before (2026-07-03): only keyword/flag evidence was recognized, so this idiom
// always read as unparalleled fan-out work even though the jobs plainly run concurrently.
// Must NOT fire on `&&` (sequential AND), a lone backgrounded job (`cmd & wait` is not fan-out), or
// the PowerShell call operator (`& "C:\...\app.exe"`, a single leading &, no bare `wait`).
export function hasBackgroundJobFanOut(command) {
	const commandWithAndAndMasked = String(command).replace(/&&/g, ' __AND__ ');
	const backgroundJobSeparatorCount = (commandWithAndAndMasked.match(/[^&]&(?!&)/g) || []).length;
	const hasBareWaitCommand = /(?:^|[\s;])wait(?:\s|$)/i.test(commandWithAndAndMasked);
	return backgroundJobSeparatorCount >= 2 && hasBareWaitCommand;
}

export function isKnownShortCommand(command) {
	const loweredCommand = command.toLowerCase();
	return (
		/\bnpm(\.cmd)?\s+(run\s+)?test\b/.test(loweredCommand) ||
		/\b(pytest|vitest|playwright|svelte-check|eslint|prettier|tsc)\b/.test(loweredCommand) ||
		// A unit-/spec-test file run directly (e.g. `node hookbook-sync.test.mjs`) is short by
		// definition — exempt it even when its NAME contains a long-keyword like 'sync' or 'migrate'.
		/\.(test|spec)\.[mc]?[jt]s\b/.test(loweredCommand) ||
		// A results/report READER (report.mjs, analyze.py, summarize.mjs, stats.mjs, view/show/inspect)
		// just reads finished output and prints — short by definition, never fan-out work — even when its
		// path contains a long-keyword like 'bench'. This is the false-block that hit `node bench/.../report.mjs`
		// (the guard treated a sequential reader as a parallel bench run). (2026-06-26)
		/\b(report|analyz|summar(y|ize|ise)|stats|view|inspect|show|render|print|dump)[\w-]*\.(?:[mc]?[jt]s|py)\b/.test(loweredCommand) ||
		/\bnode\s+--check\b/.test(loweredCommand) ||
		// A syntax check is instant, never a long job: `py_compile`, `ast.parse`, `tsc --noEmit`.
		/\bpy_compile\b/.test(loweredCommand) ||
		/\bast\.parse\b/.test(loweredCommand) ||
		/\btsc\s+(?:-[a-z-]+\s+)*--noemit\b/.test(loweredCommand) ||
		// An INLINE one-liner (`py -c "..."`, `node -e "..."`, `pwsh -Command "..."`) is a single
		// expression, never a long fan-out script — exempt regardless of keywords in its code string.
		/(?:^|[\s;&|(])(?:py|python3?|node|bun|deno|pwsh|powershell(?:\.exe)?)\s+(?:-[a-z]+\s+)*(?:-c|-e|-p|--?command)\b/i.test(loweredCommand)
	);
}

// 2026-07-05: a fast UNIT-TEST run is short by definition — a python target whose BASENAME matches
// `test_*.py`, or any pytest invocation (`pytest …` / `python -m pytest …`). Scans the executable
// STRUCTURE only (executableText blanks quoted strings / inline -c code / heredoc bodies), the same
// precedent every other detector uses — so a keyword like 'sweep' inside the test's FILENAME
// (`test_modal_sweep.py`) never reads as the job's nature. Deliberately narrow: only the `test_`
// prefix on the actual `.py` basename counts, so a non-test `proj47_sweep.py` is NOT exempted.
export function isUnitTestInvocation(command) {
	const scannableCommand = executableText(String(command));
	// pytest, directly or via `python -m pytest` / `py -m pytest`.
	if (/(?:^|[\s;&|(])pytest\b/i.test(scannableCommand)) return true;
	if (/(?:^|[\s;&|(])(?:py|python3?)\s+(?:-[a-z]+\s+)*-m\s+pytest\b/i.test(scannableCommand)) return true;
	// A python interpreter running a file whose BASENAME starts with `test_` and ends in `.py`.
	// The optional `(?:[^\s"'|&;]*[\/\\])?` lets the path carry directories before the basename.
	if (/(?:^|[\s;&|(])(?:py|python3?)\s+(?:-[a-z]+\s+)*(?:[^\s"'|&;]*[\/\\])?test_[^\s"'|&;\/\\]*\.py\b/i.test(scannableCommand)) return true;
	return false;
}

// 2026-07-05: a pure READ-ONLY diagnostic reads finished output and exits — never a long fan-out job.
// True only when EVERY command segment (split on the shell separators ; | && || & and newlines) runs a
// program drawn solely from a read-only allow-list. One segment that runs anything else (e.g. a chained
// `python train.py`) disqualifies the whole command, so a real long run hidden after a diagnostic is
// still gated. Scans executable STRUCTURE (quoted args / heredoc bodies blanked) so a keyword inside a
// grep PATTERN or a run-log PATH ('runs/sleepwake_runs.jsonl') never counts toward the job's nature.
const READ_ONLY_PROGRAMS = new Set([
	'wc', 'tail', 'head', 'ls', 'cat', 'grep', 'egrep', 'fgrep', 'echo',
	'cd', 'sort', 'uniq', 'nl', 'cut', 'tr', 'dir', 'type'
]);
export function isReadOnlyDiagnostic(command) {
	const scannableCommand = executableText(String(command));
	// Split into pipeline/sequence segments — treat ; | & newlines and the &&/|| operators as separators.
	const commandSegments = scannableCommand
		.split(/(?:\|\||&&|[;\n|&])/g)
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (commandSegments.length === 0) return false;
	for (const segment of commandSegments) {
		// The leading token of each segment is the program being run — strip any leading path + .exe.
		const firstToken = segment.split(/\s+/)[0] || '';
		const program = firstToken.replace(/^.*[\/\\]/, '').replace(/\.exe$/i, '').toLowerCase();
		if (!READ_ONLY_PROGRAMS.has(program)) return false;
	}
	return true;
}

// 2026-07-16: running a HOOK file (a PreToolUse guard reads one JSON event and exits), a throwaway
// script under a TEMP dir, or a live-fire JSON pipe into a hook is instantaneous by definition —
// never a training/sweep/bench run. Scans executable STRUCTURE (quoted args/heredoc bodies blanked)
// plus the raw command for the live-fire pipe shape.
const INSTANT_RUNNER = '(?:node|bun|tsx|py|python3?|pwsh|powershell(?:\\.exe)?)';
export function isHookOrTempDiagnostic(command) {
	const scannableCommand = executableText(String(command));
	// A script whose path carries a `hooks/` (or `.claude/hooks/`) segment.
	if (new RegExp(`(?:^|[\\s;&|(=])${INSTANT_RUNNER}\\s+(?:-[a-z]+\\s+)*["']?[^\\s"'|&;]*(?:\\.claude[\\/\\\\])?hooks[\\/\\\\][^\\s"'|&;]+\\.(?:mjs|cjs|js|ts|py|ps1)`, 'i').test(scannableCommand)) return true;
	// A script under a temp root (POSIX /tmp, Windows \Temp\, AppData\Local\Temp, or mktemp output).
	if (new RegExp(`(?:^|[\\s;&|(=])${INSTANT_RUNNER}\\s+(?:-[a-z]+\\s+)*["']?(?:\\/tmp\\/|[^\\s"'|&;]*[\\/\\\\]temp[\\/\\\\]|[^\\s"'|&;]*appdata[\\/\\\\]local[\\/\\\\]temp[\\/\\\\])`, 'i').test(scannableCommand)) return true;
	if (/\$\(\s*mktemp/i.test(command)) return true;
	// A live-fire pipe: printf/echo of a hook-event JSON payload into an interpreter.
	if (/\b(?:printf|echo)\b[^|]*\|\s*(?:node|bun|tsx|py|python3?|pwsh|powershell)/i.test(command) &&
		/(?:hook_event_name|tool_name|tool_input)/i.test(command)) return true;
	return false;
}

// 2026-07-16: sanctioned INSTANT helper tools — the launch-agent kit's brief/template emitters under
// `~/.claude/scripts/agent-kit/` print and exit in well under a second and can't carry
// --resume/--concurrency. The launch-agent skill MANDATES `agent-brief.mjs` before every spawn, so the
// guard was blocking the very pre-flight another guard requires (circular trap). Allowlist them.
export function isSanctionedInstantTool(command) {
	const scannableCommand = executableText(String(command));
	return /[\/\\]\.claude[\/\\]scripts[\/\\]agent-kit[\/\\][^\s"'|&;]+\.(?:mjs|cjs|js|ts|py)/i.test(scannableCommand) ||
		/(?:^|[\s\/\\])agent-brief\.mjs\b/i.test(scannableCommand);
}

// name-by-use-override: `cwd` in scriptSourceMatches below is this file's established parameter name
// (current working dir), used by every detector — pre-existing, not introduced by this edit.
function scriptSourceMatches(command, cwd, sourcePatterns) {
	for (const scriptPath of extractScriptPaths(command)) {
		const resolvedScript = isAbsolute(scriptPath) ? scriptPath : resolve(cwd, scriptPath);
		if (!existsSync(resolvedScript)) continue;

		let scriptSource = '';
		try {
			scriptSource = readFileSync(resolvedScript, 'utf8');
		} catch {
			continue;
		}

		if (sourcePatterns.some((sourcePattern) => sourcePattern.test(scriptSource))) return true;
	}
	return false;
}

function extractScriptPaths(command) {
	const scriptPaths = new Set();
	const runnerRegex = /(?:node|bun|tsx|python|python3|py|powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-[^\s]+\s+)*(?:"([^"]+\.(?:mjs|cjs|js|ts|py|ps1))"|'([^']+\.(?:mjs|cjs|js|ts|py|ps1))'|([^\s"'|&;]+\.(?:mjs|cjs|js|ts|py|ps1)))/gi;
	let scriptMatch;
	while ((scriptMatch = runnerRegex.exec(command)) !== null) {
		scriptPaths.add(scriptMatch[1] || scriptMatch[2] || scriptMatch[3]);
	}
	return [...scriptPaths];
}

function scriptRunnerPattern() {
	// `(?<!\.)` keeps the `*.py` FILE EXTENSION from matching `py`/`python` — else `git add critic.py`
	// reads as a python RUN and (with a `bench`/`migrate` keyword in a path) false-blocks a git command.
	// A real `py -m …` / `python x.py` still matches (its interpreter token has no leading dot). 2026-06-30
	return /\b(?:node|bun|tsx|powershell(?:\.exe)?|pwsh(?:\.exe)?)\b|(?<!\.)\b(?:python3?|py)\b/i;
}

function readProjectConfig(cwd) {
	const configPath = findUp(cwd, '.claude/long-running-script-guard.json');
	if (!configPath) return {};

	try {
		return JSON.parse(readFileSync(configPath, 'utf8'));
	} catch {
		return {};
	}
}

function findUp(startDirectory, relativePath) {
	let currentDirectory = resolve(startDirectory || process.cwd());
	while (true) {
		const candidatePath = resolve(currentDirectory, relativePath);
		if (existsSync(candidatePath)) return candidatePath;
		const parentDirectory = resolve(currentDirectory, '..');
		if (parentDirectory === currentDirectory) return null;
		currentDirectory = parentDirectory;
	}
}

function describeDetectedCommand(command) {
	return `Detected command:\n  ${command.slice(0, 240)}${command.length > 240 ? '...' : ''}\n\n`;
}

function deny(reason) {
	console.log(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason
		}
	}));
	process.exit(0);
}

// Entry-point guard so importing this for tests does not execute main() (which reads stdin and hangs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
