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
//     drop a marker recording the failing test names. A FULL-suite green run
//     (npm test / test:all) clears the marker. Partial green runs do NOT clear
//     it (they might not have exercised the failing test).
//   Stop — if the marker exists, BLOCK. Can't stop with red tests, ever.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join as joinPath, dirname } from 'node:path';

const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const MARKER_RELATIVE = joinPath('.claude', 'state', 'tests-failing.json');

// Commands that run tests. Includes pytest (`pytest` / `py -m pytest`) and `node --test` so a
// pytest / node-test repo's runs are seen at all — without this the hook returned early on them,
// leaving a marker set by a TDD RED impossible to clear. (2026-07-16)
const TEST_COMMAND_RE = /\b(npm\s+(run\s+)?test|test:all|test:stores|test:clear|vitest|playwright\s+test|vite-node\s+\S*\.test|node\s+\S*\.test|\.spec\.|pytest|node\s+(?:--[a-z-]+\s+)*--test)/i;
// A full-suite run — only these may CLEAR the marker. `npm test`/`test:all`, OR a direct vitest run that
// is NOT scoped to specific test files (no `.test.`/`.spec.` path on the line) — i.e. the whole suite.
// Needed because npm.cmd is often unavailable here, so the suite is run as
// `node node_modules/vitest/vitest.mjs run --passWithNoTests`; a green one of those must clear the marker,
// while a file-scoped run (`... run lib/foo.test.js`) must NOT (it didn't exercise every test).
const FULL_SUITE_RE = /\bnpm\s+test\b|test:all|\bvitest(?:\.mjs)?\s+run\b(?![^\n]*\.(?:test|spec)\.)/i;

// A WHOLE-SUITE run trusted to clear the marker. Beyond FULL_SUITE_RE: an UNSCOPED pytest run (no `::`
// selector and no specific `*.py` file target — `pytest` / `py -m pytest` / `pytest tests/` runs every
// test), and `node --test` (discovers and runs the whole suite). A file-scoped run (`pytest foo.py`,
// `pytest foo.py::bar`, `node foo.test.mjs`) must NOT clear — it didn't exercise every test. (2026-07-16)
function isFullSuiteRun(command) {
	if (FULL_SUITE_RE.test(command)) return true;
	if (/\bpytest\b/i.test(command) && !/::/.test(command) && !/\bpytest\b[^\n|&;]*\S+\.py\b/i.test(command)) return true;
	if (/\bnode\s+(?:--[a-z-]+\s+)*--test\b/i.test(command)) return true;
	return false;
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

	const projectRoot = markerRoot(commandCwd(command, hookEvent.cwd || process.cwd()));
	if (!projectRoot) return;
	const markerPath = joinPath(projectRoot, MARKER_RELATIVE);

	const { failing, failingNames } = detectFailures(outputText);
	if (failing) {
		try {
			mkdirSync(joinPath(projectRoot, '.claude', 'state'), { recursive: true });
			writeFileSync(markerPath, JSON.stringify({ ts: Date.now(), command, names: failingNames }, null, 2));
		} catch { /* best-effort */ }
	} else if (isFullSuiteRun(command)) {
		// Only a full-suite green run is trusted to clear the marker.
		try { rmSync(markerPath, { force: true }); } catch { /* best-effort */ }
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
		'  2. Re-run the FULL suite: `npm test` (and `npm run test:all` if relevant).',
		'  3. A full-suite run with zero failures clears this marker automatically.',
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
