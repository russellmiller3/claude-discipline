#!/usr/bin/env node
// Dual hook (PostToolUse:Bash + Stop) — NO failing test may survive a turn.
//
// Russell, 2026-05-29 (furious): "NEVER allow pre-existing failures to stay
// failures. EVER. Write a hook and ensure it ALWAYS fires." I had run the
// suite, seen `❌ cv(100, 110, 90)` fail, and waved it off as "pre-existing,
// out of scope." That is forbidden. A red test is a red test — fix it.
//
// Mechanism (same shape as require-learnings-ack):
//   PostToolUse:Bash — when a test command runs, scan its output. Any failure →
//     drop a marker recording the failing command and test names. A green run
//     clears the marker when its normalized file/directory scope covers the red
//     scope (or when it runs the full suite).
//   Stop — if the marker exists, BLOCK. Can't stop with red tests, ever.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join as joinPath, dirname, resolve as resolvePath, relative as relativePath, isAbsolute, extname, sep } from 'node:path';

const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const MARKER_RELATIVE = joinPath('.claude', 'state', 'tests-failing.json');

// Commands that run tests. Includes pytest (`pytest` / `py -m pytest`) and `node --test` so a
// pytest / node-test repo's runs are seen at all — without this the hook returned early on them,
// leaving a marker set by a TDD RED impossible to clear. (2026-07-16)
const TEST_COMMAND_RE = /\b(npm\s+(run\s+)?test|test:all|test:stores|test:clear|vitest|jest|playwright\s+test|vite-node\s+\S*\.test|node\s+\S*\.test|\.spec\.|pytest|node\s+(?:--[a-z-]+\s+)*--test)/i;
const FULL_NPM_SUITE_RE = /\bnpm\s+test\b|test:all/i;
const TEST_FILE_RE = /(?:\.py|\.(?:test|spec)\.[cm]?[jt]sx?)$/i;
const SHELL_CONTROL_TOKENS = new Set(['&&', '||', '|', ';']);
const RUNNER_WORDS = new Set(['run', 'watch']);
const OPTIONS_WITH_VALUES = new Set([
	'-k', '-m', '-t', '--config', '--root', '--rootdir', '--confcutdir', '--basetemp',
	'--tb', '--maxfail', '--durations', '--junitxml', '--testnamepattern', '--test-name-pattern',
	'--testpathpatterns', '--project', '--pool', '--environment',
]);
const NARROWING_OPTIONS = new Set([
	'-k', '-m', '-t', '--testnamepattern', '--test-name-pattern', '--testpathpatterns',
	'--lf', '--last-failed', '--ff', '--failed-first', '--changed', '--onlychanged', '--findrelatedtests',
]);

function shellTokens(command) {
	return [...String(command || '').matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
		.map((match) => match[1] ?? match[2] ?? match[3]);
}

function executableName(token) {
	return String(token || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function runnerTargetStart(tokens) {
	for (let index = 0; index < tokens.length; index++) {
		const executable = executableName(tokens[index]);
		if (/^(?:pytest(?:\.exe)?|vitest(?:\.mjs)?|jest(?:\.(?:mjs|cjs|js))?)$/.test(executable)) {
			return index + 1;
		}
		if (executable !== 'node' && executable !== 'node.exe') continue;
		for (let next = index + 1; next < tokens.length && !SHELL_CONTROL_TOKENS.has(tokens[next]); next++) {
			if (tokens[next] === '--test') return next + 1;
			if (TEST_FILE_RE.test(tokens[next])) return next;
			if (!tokens[next].startsWith('-')) break;
		}
	}
	return -1;
}

function comparablePath(pathText) {
	const resolved = resolvePath(pathText);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizedTarget(rawTarget, workingDirectory) {
	const selectorParts = String(rawTarget).split('::');
	const pathText = selectorParts.shift();
	if (!pathText) return null;
	const pathWithNativeSeparators = pathText.replace(/[\\/]+/g, sep);
	return {
		path: comparablePath(resolvePath(workingDirectory, pathWithNativeSeparators)),
		isDirectory: /[\\/]$/.test(pathText) || extname(pathText) === '',
		selector: selectorParts.join('::'),
	};
}

function testScope(command, workingDirectory) {
	const tokens = shellTokens(command);
	const targetStart = runnerTargetStart(tokens);
	if (targetStart < 0) return { recognized: false, isFullSuite: FULL_NPM_SUITE_RE.test(command), targets: [] };

	const targets = [];
	let narrowedWithoutPath = false;
	let skipOptionValue = false;
	for (let index = targetStart; index < tokens.length; index++) {
		const token = tokens[index];
		if (SHELL_CONTROL_TOKENS.has(token)) break;
		if (skipOptionValue) {
			skipOptionValue = false;
			continue;
		}
		const lowerToken = token.toLowerCase();
		if (RUNNER_WORDS.has(lowerToken)) continue;
		const optionName = lowerToken.split('=')[0];
		if (NARROWING_OPTIONS.has(optionName)) narrowedWithoutPath = true;
		if (lowerToken.startsWith('-')) {
			if (!lowerToken.includes('=') && OPTIONS_WITH_VALUES.has(optionName)) skipOptionValue = true;
			continue;
		}
		const target = normalizedTarget(token, workingDirectory);
		if (target) targets.push(target);
	}

	return { recognized: true, isFullSuite: targets.length === 0 && !narrowedWithoutPath, targets };
}

function targetCovers(coveringTarget, requiredTarget) {
	if (coveringTarget.path === requiredTarget.path) {
		if (!coveringTarget.selector) return true;
		if (!requiredTarget.selector) return false;
		return requiredTarget.selector === coveringTarget.selector
			|| requiredTarget.selector.startsWith(`${coveringTarget.selector}::`);
	}
	if (!coveringTarget.isDirectory) return false;
	const relative = relativePath(coveringTarget.path, requiredTarget.path);
	return Boolean(relative) && !relative.startsWith('..') && !isAbsolute(relative);
}

function scopeCovers(greenScope, requiredTargets) {
	return requiredTargets.length > 0
		&& requiredTargets.every((requiredTarget) => greenScope.targets.some((greenTarget) => targetCovers(greenTarget, requiredTarget)));
}

function failureNameTargets(names, workingDirectory) {
	if (!Array.isArray(names) || names.length === 0) return null;
	const targets = [];
	for (const name of names) {
		const pathMatch = String(name).match(/((?:[A-Za-z]:)?[^\s"'()[\]]+?(?:\.py|\.(?:test|spec)\.[cm]?[jt]sx?)(?:::[^\s]+)?)/i);
		if (!pathMatch) return null;
		const target = normalizedTarget(pathMatch[1], workingDirectory);
		if (!target) return null;
		targets.push(target);
	}
	return targets;
}

function greenRunCoversMarker(command, commandDirectory, marker, projectRoot) {
	const markerDirectory = marker.cwd || commandCwd(marker.command, projectRoot);
	const greenScope = testScope(command, commandDirectory);
	if (greenScope.isFullSuite) return true;
	if (shellTokens(command).join('\0') === shellTokens(marker.command).join('\0')
		&& comparablePath(commandDirectory) === comparablePath(markerDirectory)) return true;
	if (greenScope.targets.length === 0) return false;

	const namedTargets = failureNameTargets(marker.names, markerDirectory);
	if (namedTargets) return scopeCovers(greenScope, namedTargets);

	const redScope = testScope(marker.command, markerDirectory);
	return !redScope.isFullSuite && scopeCovers(greenScope, redScope.targets);
}

// The directory the command actually runs in: a leading `cd <path> && …` (single/double-quoted or bare)
// overrides the session cwd, so a `cd otherRepo && <test>` files the marker in otherRepo — not the
// session's repo. Stop has no command, so it falls through to the session cwd. (2026-07-16, Bug 2)
function commandCwd(command, fallbackCwd) {
	const cdMatch = String(command || '').match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&|;]+))\s*&&/i);
	return (cdMatch && (cdMatch[1] || cdMatch[2] || cdMatch[3])) || fallbackCwd;
}

function findProjectRoot(startDirectory) {
	let probeDirectory = startDirectory;
	for (let depthSteps = 0; depthSteps < 14; depthSteps++) {
		for (const markerName of ROOT_MARKERS) {
			if (existsSync(joinPath(probeDirectory, markerName))) return probeDirectory;
		}
		const parentDirectory = dirname(probeDirectory);
		if (parentDirectory === probeDirectory) return null;
		probeDirectory = parentDirectory;
	}
	return null;
}

// The REPO root (innermost `.git`). The marker must live at ONE consistent place per repo: a test command
// run from a nested package dir (e.g. `cd extension && node vitest…`) resolves findProjectRoot to that
// nested dir (it has its own package.json), so SET-from-root and CLEAR-from-subdir would target different
// markers and the gate sticks forever. Keying the marker to the git root makes set/clear/stop agree.
function findGitRoot(startDirectory) {
	let probeDirectory = startDirectory;
	for (let depthSteps = 0; depthSteps < 14; depthSteps++) {
		if (existsSync(joinPath(probeDirectory, '.git'))) return probeDirectory;
		const parentDirectory = dirname(probeDirectory);
		if (parentDirectory === probeDirectory) return null;
		probeDirectory = parentDirectory;
	}
	return null;
}

// One resolver for the marker's project root, used by BOTH set and clear and stop so they always agree.
function markerRoot(startDirectory) {
	return findGitRoot(startDirectory) || findProjectRoot(startDirectory);
}

// Pull failing-test signals out of mixed test-runner output.
function detectFailures(outputText) {
	if (!outputText) return { failing: false, failingNames: [] };
	const failingNames = [];
	// Custom runner: a line "❌ <test name>" that is NOT the "❌ Failed: N" summary.
	for (const lineMatch of outputText.matchAll(/(?:^|\n)\s*❌\s+(?!Failed:)(.+)/g)) {
		failingNames.push(lineMatch[1].trim());
	}
	// Custom-runner summary: "❌ Failed: N" with N >= 1.
	let summaryFailCount = 0;
	for (const summaryMatch of outputText.matchAll(/❌\s*Failed:\s*(\d+)/g)) summaryFailCount += Number(summaryMatch[1]);
	// Playwright / vitest: "N failed".
	let runnerFailCount = 0;
	for (const runnerMatch of outputText.matchAll(/(\d+)\s+failed\b/gi)) runnerFailCount += Number(runnerMatch[1]);
	const failing = failingNames.length > 0 || summaryFailCount > 0 || runnerFailCount > 0;
	return { failing, failingNames: [...new Set(failingNames)].slice(0, 12) };
}

function onPostToolUse(hookEvent) {
	if (hookEvent.tool_name !== 'Bash' && hookEvent.tool_name !== 'PowerShell') return;
	const command = (hookEvent.tool_input && hookEvent.tool_input.command) || '';
	if (!TEST_COMMAND_RE.test(command)) return;

	const toolResponse = hookEvent.tool_response || {};
	const outputText = [toolResponse.stdout, toolResponse.stderr, toolResponse.output, typeof toolResponse === 'string' ? toolResponse : null]
		.filter(Boolean).join('\n');
	if (!outputText) return;

	const commandDirectory = commandCwd(command, hookEvent.cwd || process.cwd());
	const projectRoot = markerRoot(commandDirectory);
	if (!projectRoot) return;
	const markerPath = joinPath(projectRoot, MARKER_RELATIVE);

	const { failing, failingNames } = detectFailures(outputText);
	if (failing) {
		try {
			mkdirSync(joinPath(projectRoot, '.claude', 'state'), { recursive: true });
			writeFileSync(markerPath, JSON.stringify({ ts: Date.now(), command, cwd: commandDirectory, names: failingNames }, null, 2));
		} catch { /* best-effort */ }
	} else if (existsSync(markerPath)) {
		let marker = {};
		try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { /* malformed markers still need a full suite */ }
		if (greenRunCoversMarker(command, commandDirectory, marker, projectRoot)) {
			try { rmSync(markerPath, { force: true }); } catch { /* best-effort */ }
		}
	}
}

function onStop(hookEvent) {
	const projectRoot = markerRoot(hookEvent.cwd || process.cwd());
	if (!projectRoot) return;
	const markerPath = joinPath(projectRoot, MARKER_RELATIVE);
	if (!existsSync(markerPath)) return;

	let marker = {};
	try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { /* still block */ }
	const failingList = (marker.names || []).map((testName) => `  • ${testName}`).join('\n') || '  • (see last test run)';
	const reason = [
		'STOP-BLOCKED — failing tests must be fixed before stopping. NO EXCEPTIONS.',
		'',
		'Failing test(s) seen this session:',
		failingList,
		'',
		'"Pre-existing" / "unrelated" / "out of scope" is NEVER a reason to leave a red test.',
		'A red test is a red test. (Russell, 2026-05-29.)',
		'',
		'To clear this gate:',
		'  1. FIX every failing test (or, if a test is genuinely obsolete, delete it deliberately).',
		'  2. Re-run the recorded failing scope or a broader scope that contains it.',
		'  3. A covering run with zero failures clears this marker automatically.',
	].join('\n');

	process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

function main() {
	let hookEvent;
	try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }
	const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
	if (eventName === 'Stop') onStop(hookEvent);
	else onPostToolUse(hookEvent);
	process.exit(0);
}

main();
