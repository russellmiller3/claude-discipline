#!/usr/bin/env node
// Stop hook — file-mtime sibling of visual-proof-required.mjs.
//
// The existing hook does TEXT matching ("did the reply mention 'screenshot'?")
// which an agent can game by writing the word without saving a file.
// This hook does FILE-MTIME matching:
//   1. Collect the UI files this turn edited (.svelte/.tsx/.jsx/.vue/.html/.css/.scss).
//   2. Find the EARLIEST edit timestamp in the turn (or fall back to the turn's first event).
//   3. Walk every candidate `screenshots/` directory (cwd, project root, immediate parents)
//      and look for a *.png/*.jpg/*.jpeg/*.webp with mtime AFTER that edit.
//   4. Block on Stop if no fresh screenshot artifact exists.
//
// Russell (2026-05-28): "add global hook to always verify ux" + learnings
// bullet "Probe state BEFORE shipping a fix. Ship-before-verify costs more
// than verify-before-ship every time."
//
// This is a complement, not a replacement — the text hook catches transcripts
// where the agent mentioned a screenshot but lied; this hook catches all the
// transcripts where the agent didn't even mention one. Defense in depth.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join as joinPath, resolve as resolvePath } from 'node:path';

const VISUAL_FILE_RE = /\.(svelte|css|scss|html|htm|tsx|jsx|vue)$/i;
const SCREENSHOT_FILE_RE = /\.(png|jpe?g|webp)$/i;
const SCREENSHOT_DIR_NAMES = new Set(['screenshots', 'screenshot', 'visual-snapshots', 'snapshots']);
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
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

function parseTranscript(transcriptPath) {
	if (!transcriptPath || !existsSync(transcriptPath)) return [];
	try {
		return readFileSync(transcriptPath, 'utf8')
			.split('\n').filter(Boolean)
			.map((entryLine) => { try { return JSON.parse(entryLine); } catch { return null; } })
			.filter(Boolean);
	} catch { return []; }
}

function roleOf(entry) {
	return entry.message?.role || entry.role || entry.type || '';
}

function contentBlocks(entry) {
	const blocks = entry.message?.content ?? entry.content ?? [];
	if (typeof blocks === 'string') return [{ type: 'text', text: blocks }];
	return Array.isArray(blocks) ? blocks : [];
}

function toolUsesFromEntry(entry) {
	return contentBlocks(entry).filter((blk) => blk?.type === 'tool_use');
}

function currentTurnEntries(allEntries) {
	let lastAssistantIdx = -1;
	for (let i = allEntries.length - 1; i >= 0; i--) {
		if (roleOf(allEntries[i]) === 'assistant') { lastAssistantIdx = i; break; }
	}
	if (lastAssistantIdx < 0) return [];
	let turnStartIdx = 0;
	for (let i = lastAssistantIdx - 1; i >= 0; i--) {
		if (roleOf(allEntries[i]) === 'user') { turnStartIdx = i; break; }
	}
	return allEntries.slice(turnStartIdx);
}

function visualEditsInTurn(turnEntries) {
	const visualEdits = [];
	for (const entry of turnEntries) {
		if (roleOf(entry) !== 'assistant') continue;
		const entryTimestamp = entry.timestamp || entry.message?.timestamp;
		const entryTimeMs = entryTimestamp ? Date.parse(entryTimestamp) : Date.now();
		for (const toolUse of toolUsesFromEntry(entry)) {
			if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(toolUse.name || '')) continue;
			const targetFilePath = toolUse.input?.file_path || toolUse.input?.path || '';
			if (!targetFilePath) continue;
			if (!VISUAL_FILE_RE.test(targetFilePath)) continue;
			visualEdits.push({ path: targetFilePath, atMs: entryTimeMs });
		}
	}
	return visualEdits;
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

	const turnEntries = currentTurnEntries(parseTranscript(hookEvent.transcript_path));
	if (turnEntries.length === 0) return;

	const visualEdits = visualEditsInTurn(turnEntries);
	if (visualEdits.length === 0) return; // no UI surface touched -> nothing to verify

	const earliestEditMs = Math.min(...visualEdits.map((edit) => edit.atMs));

	const cwdPath = process.cwd();
	const projectRoot = findProjectRoot(cwdPath);
	const seedDirectories = [
		cwdPath,
		projectRoot,
		projectRoot ? dirname(projectRoot) : null
	].filter(Boolean);

	const candidateDirs = collectScreenshotCandidatePaths(seedDirectories);
	const freshestScreenshotMs = newestScreenshotMtimeMs(candidateDirs);

	if (freshestScreenshotMs > earliestEditMs) return; // someone saved a real screenshot after the edit -> ok

	const editsList = [...new Set(visualEdits.map((edit) => edit.path))].slice(0, 6);
	const dirsList = candidateDirs.slice(0, 4);

	const blockReason = [
		'STOP — UX verification artifact missing.',
		'',
		'You edited UI source this turn but I cannot find a screenshot file',
		'on disk that was written after that edit. Russell\'s rule (~/.claude/learnings.md',
		'"Probe state BEFORE shipping a fix"): every UI change must produce a real',
		'screenshot artifact, not just text claiming one was taken.',
		'',
		`Visual files edited in this turn: ${editsList.join(', ')}`,
		`Earliest edit at: ${new Date(earliestEditMs).toISOString()}`,
		`Newest screenshot at: ${freshestScreenshotMs ? new Date(freshestScreenshotMs).toISOString() : '(none found)'}`,
		`Screenshot directories searched: ${dirsList.length > 0 ? dirsList.join(', ') : '(none — create one at <project>/screenshots/)'}`,
		'',
		'Before stopping, do ONE of:',
		'  1. Run preview_screenshot, then mention the saved file path.',
		'  2. Run a Playwright script that calls page.screenshot({ path: "screenshots/<name>.png" }).',
		'  3. If this turn genuinely has no UI surface (backend-only / build/script-only),',
		'     state that explicitly in your reply — but verify it; tests do not count.'
	].join('\n');

	process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason }));
}

try { main(); } catch { process.exit(0); }
