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

	return longKeywords.some((keyword) => scannableCommand.includes(keyword.toLowerCase())) ||
		/\s(--all|--full|--everything|--entire|--batch|--sweep)\b/i.test(scannableCommand);
}

// Return the command with quoted-string literals and inline-code args (-c/-e/-p/-Command) blanked
// out, so keyword detection sees only the executable structure — never text inside quotes or code.
export function executableText(command) {
	let scannableCommand = String(command);
	scannableCommand = scannableCommand.replace(/(\s-(?:c|e|p)\b|\s--?command\b)\s*(["'])(?:\\.|(?!\2).)*\2/gi, '$1 ""');
	scannableCommand = scannableCommand.replace(/(\s-(?:c|e|p)\b|\s--?command\b)\s+[^\s"'|&;]+/gi, '$1 ');
	scannableCommand = scannableCommand.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
	return scannableCommand;
}

function looksLikeFanOutWork(command, cwd) {
	const loweredCommand = command.toLowerCase();
	const config = readProjectConfig(cwd);
	const fanOutKeywords = [
		'bench', 'benchmark', 'sweep', 'eval', 'batch', 'bulk', 'crawl', 'scrape',
		'train', 'generate', 'ingest', 'reindex', 'recompute',
		...(config.fanOutKeywords || [])
	];

	return fanOutKeywords.some((keyword) => loweredCommand.includes(keyword.toLowerCase())) ||
		/\s(--all|--full|--models|--scenarios|--workers?|--batch)\b/i.test(command);
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

function hasParallelEvidence(command, cwd) {
	if (
		/\bparallel\b/i.test(command) ||
		/\bconcurrency\b/i.test(command) ||
		/\b(CONCURRENCY|MAX_WORKERS|WORKERS)\s*=/i.test(command) ||
		/\bxargs\s+-P\b/i.test(command) ||
		/\bStart-Job\b/i.test(command) ||
		/\bForEach-Object\s+-Parallel\b/i.test(command)
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
		// An INLINE one-liner (`py -c "..."`, `node -e "..."`, `pwsh -Command "..."`) is a single
		// expression, never a long fan-out script — exempt regardless of keywords in its code string.
		/(?:^|[\s;&|(])(?:py|python3?|node|bun|deno|pwsh|powershell(?:\.exe)?)\s+(?:-[a-z]+\s+)*(?:-c|-e|-p|--?command)\b/i.test(loweredCommand)
	);
}

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
