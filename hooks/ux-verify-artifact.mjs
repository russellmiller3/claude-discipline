#!/usr/bin/env node
// Stop hook — file-mtime sibling of visual-proof-required.mjs.
//
// The existing hook does TEXT matching ("did the reply mention 'screenshot'?")
// which an agent can game by writing the word without saving a file.
// This hook does FILE-MTIME matching PLUS a transcript tool-use check:
//   1. Collect the UI files this turn edited (.svelte/.tsx/.jsx/.vue/.html/.css/.scss).
//   2. Find the EARLIEST edit timestamp in the turn (or fall back to the turn's first event).
//   3. Walk every candidate `screenshots/` directory (cwd, project root, immediate parents)
//      and look for a *.png/*.jpg/*.jpeg/*.webp with mtime AFTER that edit.
//   4. ALSO accept a `mcp__Claude_Preview__preview_screenshot` tool_use appearing in the
//      transcript AFTER the earliest UI edit this turn as real visual proof — that tool
//      renders the image inline for Russell to see; it never writes a file to
//      `screenshots/` itself, but the verification is just as real (Russell, 2026-07-02:
//      this exact tool caught a mojibake/charset bug this session and still got
//      false-blocked here because nothing landed on disk).
//   5. Block on Stop only if NEITHER a fresh screenshot file NOR a post-edit
//      preview_screenshot tool_use exists.
//
// Russell (2026-05-28): "add global hook to always verify ux" + learnings
// bullet "Probe state BEFORE shipping a fix. Ship-before-verify costs more
// than verify-before-ship every time."
//
// This is a complement, not a replacement — the text hook catches transcripts
// where the agent mentioned a screenshot but lied; this hook catches all the
// transcripts where the agent didn't even mention one. Defense in depth.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

const VISUAL_FILE_RE = /\.(svelte|css|scss|html|htm|tsx|jsx|vue)$/i;
const SCREENSHOT_FILE_RE = /\.(png|jpe?g|webp)$/i;
const SCREENSHOT_DIR_NAMES = new Set(['screenshots', 'screenshot', 'visual-snapshots', 'snapshots']);
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const PREVIEW_SCREENSHOT_TOOL_RE = /^mcp__Claude_Preview__preview_screenshot$/i;
// Some agents legitimately write CSS-only fixes without UI surface change
// (theme tokens applied via existing components). Keep the bar at "any file
// that ends in a visual extension" — that's the simplest defensible rule.

function readHookEvent() {
	try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { return {}; }
}

function findProjectRoot(startDirectory) {
	let probeDirectory = startDirectory;
	for (let depthSteps = 0; depthSteps < 12; depthSteps++) {
		for (const markerName of ROOT_MARKERS) {
			if (existsSync(joinPath(probeDirectory, markerName))) return probeDirectory;
		}
		const parentDirectory = dirname(probeDirectory);
		if (parentDirectory === probeDirectory) return null;
		probeDirectory = parentDirectory;
	}
	return null;
}

import { readTranscript, roleOf, contentBlocks, toolUsesOf, currentTurnEntries } from './lib/transcript.mjs';

// Every tool_use in turn order, flattened with its entry INDEX (not wall-clock time — synthetic
// and even real transcripts can carry coarse/duplicate timestamps within one turn, so entry order
// is the unambiguous "before/after" signal both callers below rely on).
function toolUseSequence(turnEntries) {
	const sequence = [];
	turnEntries.forEach((entry, entryIndex) => {
		if (roleOf(entry) !== 'assistant') return;
		for (const toolUse of toolUsesOf(entry)) {
			sequence.push({ name: toolUse.name || '', input: toolUse.input || {}, entryIndex });
		}
	});
	return sequence;
}

function visualEditsInTurn(turnEntries) {
	const visualEdits = [];
	toolUseSequence(turnEntries).forEach(({ name, input, entryIndex }) => {
		if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(name)) return;
		const targetFilePath = input.file_path || input.path || '';
		if (!targetFilePath) return;
		if (!VISUAL_FILE_RE.test(targetFilePath)) return;
		visualEdits.push({ path: targetFilePath, entryIndex });
	});
	return visualEdits;
}

// True if a mcp__Claude_Preview__preview_screenshot tool_use appears in the turn AFTER
// (same-or-later entry index as) the earliest UI edit. That tool renders the image inline for
// Russell — genuine live visual proof — even though (unlike a Playwright script) it never writes
// a file to screenshots/ itself.
function hasPreviewScreenshotAfter(turnEntries, earliestEditIndex) {
	return toolUseSequence(turnEntries).some(
		({ name, entryIndex }) => PREVIEW_SCREENSHOT_TOOL_RE.test(name) && entryIndex >= earliestEditIndex
	);
}

// Walk likely screenshot folders: project root, cwd, any folder named like
// "screenshots" reachable two levels deep from the project root or cwd.
function collectScreenshotCandidatePaths(seedDirectories) {
	const candidates = new Set();
	const visitedDirs = new Set();

	function isScreenshotDirName(directoryName) {
		const lowered = directoryName.toLowerCase();
		return SCREENSHOT_DIR_NAMES.has(lowered) || lowered.includes('screenshot');
	}

	function exploreDirectory(directoryPath, remainingDepth) {
		if (visitedDirs.has(directoryPath)) return;
		visitedDirs.add(directoryPath);
		let directoryEntries;
		try { directoryEntries = readdirSync(directoryPath, { withFileTypes: true }); }
		catch { return; }
		for (const entry of directoryEntries) {
			const childPath = joinPath(directoryPath, entry.name);
			if (entry.isDirectory()) {
				if (isScreenshotDirName(entry.name)) candidates.add(childPath);
				else if (remainingDepth > 0 && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
					exploreDirectory(childPath, remainingDepth - 1);
				}
			}
		}
	}

	for (const seedDir of seedDirectories) {
		if (!seedDir || !existsSync(seedDir)) continue;
		// The seed itself, plus two levels down — covers most repo layouts.
		exploreDirectory(seedDir, 2);
	}
	return [...candidates];
}

function newestScreenshotMtimeMs(screenshotDirectoryPaths) {
	let newestMtimeMs = 0;
	for (const directoryPath of screenshotDirectoryPaths) {
		let directoryEntries;
		try { directoryEntries = readdirSync(directoryPath, { withFileTypes: true }); }
		catch { continue; }
		for (const entry of directoryEntries) {
			if (!entry.isFile()) continue;
			if (!SCREENSHOT_FILE_RE.test(entry.name)) continue;
			const fullPath = joinPath(directoryPath, entry.name);
			try {
				const fileStat = statSync(fullPath);
				if (fileStat.mtimeMs > newestMtimeMs) newestMtimeMs = fileStat.mtimeMs;
			} catch { /* skip */ }
		}
	}
	return newestMtimeMs;
}

function main() {
	const hookEvent = readHookEvent();
	if (hookEvent.stop_hook_active) return;

	const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
	if (turnEntries.length === 0) return;

	const visualEdits = visualEditsInTurn(turnEntries);
	if (visualEdits.length === 0) return; // no UI surface touched -> nothing to verify

	const earliestEditIndex = Math.min(...visualEdits.map((edit) => edit.entryIndex));

	// Path A: a mcp__Claude_Preview__preview_screenshot tool_use fired after the edit — the image
	// was rendered inline for Russell. Genuine live proof; no disk file required.
	if (hasPreviewScreenshotAfter(turnEntries, earliestEditIndex)) return;

	// Path B (unchanged): a real screenshot FILE landed on disk after the edit.
	const cwdPath = process.cwd();
	const projectRoot = findProjectRoot(cwdPath);
	const seedDirectories = [
		cwdPath,
		projectRoot,
		projectRoot ? dirname(projectRoot) : null
	].filter(Boolean);

	const candidateDirs = collectScreenshotCandidatePaths(seedDirectories);
	const freshestScreenshotMs = newestScreenshotMtimeMs(candidateDirs);

	// Use the edit's wall-clock time (best-effort) only for the disk-mtime comparison — the file
	// system has no notion of "turn index", so this leg still needs a real timestamp.
	const earliestEditEntry = turnEntries[earliestEditIndex];
	const earliestEditTimestamp = earliestEditEntry?.timestamp || earliestEditEntry?.message?.timestamp;
	const earliestEditMs = earliestEditTimestamp ? Date.parse(earliestEditTimestamp) : Date.now();

	if (freshestScreenshotMs > earliestEditMs) return; // someone saved a real screenshot after the edit -> ok

	const editsList = [...new Set(visualEdits.map((edit) => edit.path))].slice(0, 6);
	const dirsList = candidateDirs.slice(0, 4);

	const blockReason = [
		'STOP — UX verification artifact missing.',
		'',
		'You edited UI source this turn but I cannot find a screenshot file on disk written',
		'after that edit, NOR a preview_screenshot tool call after the edit. Russell\'s rule',
		'(~/.claude/learnings.md "Probe state BEFORE shipping a fix"): every UI change must',
		'produce a real screenshot artifact, not just text claiming one was taken.',
		'',
		`Visual files edited in this turn: ${editsList.join(', ')}`,
		`Earliest edit at: ${new Date(earliestEditMs).toISOString()}`,
		`Newest screenshot at: ${freshestScreenshotMs ? new Date(freshestScreenshotMs).toISOString() : '(none found)'}`,
		`Screenshot directories searched: ${dirsList.length > 0 ? dirsList.join(', ') : '(none — create one at <project>/screenshots/)'}`,
		'',
		'Before stopping, do ONE of:',
		'  1. Run mcp__Claude_Preview__preview_screenshot AFTER this edit (the inline image counts as proof).',
		'  2. Run a Playwright script that calls page.screenshot({ path: "screenshots/<name>.png" }).',
		'  3. If this turn genuinely has no UI surface (backend-only / build/script-only),',
		'     state that explicitly in your reply — but verify it; tests do not count.'
	].join('\n');

	process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason }));
}

// Exported for ux-verify-artifact.test.mjs. main() stays the only side-effecting entry point.
export {
	VISUAL_FILE_RE,
	SCREENSHOT_FILE_RE,
	visualEditsInTurn,
	hasPreviewScreenshotAfter,
	toolUseSequence,
	newestScreenshotMtimeMs,
	collectScreenshotCandidatePaths,
};

if (process.argv[1] && fileURLToPath(import.meta.url).split(/[\\/]/).pop() === process.argv[1].split(/[\\/]/).pop()) {
	try { main(); } catch { process.exit(0); }
}
