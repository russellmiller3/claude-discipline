#!/usr/bin/env node
// tests-must-pass — dual hook (PostToolUse:Bash + Stop). No failing test may
// survive a turn. "Pre-existing" / "unrelated" / "out of scope" is never a
// reason to leave a red test — that rationalization is exactly how a broken
// suite rots. A red test is a red test.
//
// Mechanism (the marker pattern — see docs/WRITING-HOOKS.md):
//   PostToolUse:Bash — when a test command runs, scan its output. Any failure
//     drops a marker recording the failing test names. A FULL-suite green run
//     clears it; partial green runs do NOT (they may not exercise the failure).
//   Stop — if the marker exists, BLOCK with the failing names + how to clear.
//
// Config (optional env): TESTS_FULL_SUITE_RE overrides which command counts as
// a full-suite run that may clear the marker (default: `npm test` / test:all).

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join as joinPath, dirname } from 'node:path';

const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const MARKER_RELATIVE = joinPath('.claude', 'state', 'tests-failing.json');
const TEST_COMMAND_RE = /\b((npm|yarn|pnpm)\s+(run\s+)?test|test:all|vitest|jest|mocha|playwright\s+test|vite-node\s+\S*\.test|node\s+\S*\.test|pytest|go\s+test|cargo\s+test|\.spec\.|\.test\.)/i;
const FULL_SUITE_RE = process.env.TESTS_FULL_SUITE_RE
	? new RegExp(process.env.TESTS_FULL_SUITE_RE, 'i')
	: /\bnpm\s+test\b|test:all|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b/i;

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

function detectFailures(outputText) {
	if (!outputText) return { failing: false, failingNames: [] };
	const failingNames = [];
	for (const lineMatch of outputText.matchAll(/(?:^|\n)\s*(?:❌|✗|FAIL(?:ED)?)\s+(?!Failed:|0\b)(.+)/g)) {
		failingNames.push(lineMatch[1].trim().slice(0, 120));
	}
	let summaryFailCount = 0;
	for (const summaryMatch of outputText.matchAll(/(?:❌\s*)?Failed:\s*(\d+)/g)) summaryFailCount += Number(summaryMatch[1]);
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

	const projectRoot = findProjectRoot(hookEvent.cwd || process.cwd());
	if (!projectRoot) return;
	const markerPath = joinPath(projectRoot, MARKER_RELATIVE);

	const { failing, failingNames } = detectFailures(outputText);
	if (failing) {
		try {
			mkdirSync(joinPath(projectRoot, '.claude', 'state'), { recursive: true });
			writeFileSync(markerPath, JSON.stringify({ ts: Date.now(), command, names: failingNames }, null, 2));
		} catch { /* best-effort */ }
	} else if (FULL_SUITE_RE.test(command)) {
		try { rmSync(markerPath, { force: true }); } catch { /* best-effort */ }
	}
}

function onStop(hookEvent) {
	const projectRoot = findProjectRoot(hookEvent.cwd || process.cwd());
	if (!projectRoot) return;
	const markerPath = joinPath(projectRoot, MARKER_RELATIVE);
	if (!existsSync(markerPath)) return;

	let marker = {};
	try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { /* still block */ }
	const failingList = (marker.names || []).map((testName) => `  • ${testName}`).join('\n') || '  • (see the last test run)';
	const reason = [
		'STOP-BLOCKED — failing tests must be fixed before stopping. NO EXCEPTIONS.',
		'',
		'Failing test(s) seen this session:',
		failingList,
		'',
		'"Pre-existing" / "unrelated" / "out of scope" is NEVER a reason to leave a red test.',
		'',
		'To clear this gate:',
		'  1. FIX every failing test (or delete a genuinely obsolete test deliberately).',
		'  2. Re-run the FULL suite (e.g. `npm test`).',
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
