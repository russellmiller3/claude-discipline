#!/usr/bin/env node
// require-learnings-ack — PreToolUse(Read|Edit|Write|MultiEdit). Enforce that a
// surfaced learning is actually READ before editing code.
//
// The problem it fixes: passive injection (learnings-error-match drops a
// relevant bullet into context) is trivially ignored — the agent can be shown
// the exact lesson and still edit the wrong file. So:
//   - learnings-error-match.mjs drops a marker when it surfaces a learning.
//   - Reading any learnings.md clears the marker (acknowledged).
//   - Editing CODE while the marker is unacknowledged is BLOCKED.
//
// Conservative: only blocks edits to source-code files, only while a fresh
// marker exists, and clears the moment you Read the learnings file.
// Marker TTL 6h (env: LEARNINGS_ACK_TTL_HOURS). Override: LEARNINGS_ACK_OVERRIDE=1.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join as joinPath, dirname, basename, extname } from 'node:path';

const MARKER_RELATIVE = joinPath('.claude', 'state', 'learnings-ack-needed.json');
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const MARKER_TTL_MS = (Number(process.env.LEARNINGS_ACK_TTL_HOURS) || 6) * 60 * 60 * 1000;
const CODE_EXTENSIONS = new Set([
	'.svelte', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.vue',
	'.css', '.scss', '.less', '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.h',
]);

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

function main() {
	if (process.env.LEARNINGS_ACK_OVERRIDE === '1') { process.exit(0); return; }

	let hookEvent;
	try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }

	const toolName = hookEvent.tool_name || '';
	const targetPath = (hookEvent.tool_input && (hookEvent.tool_input.file_path || hookEvent.tool_input.path)) || '';
	const startDirectory = targetPath ? dirname(targetPath) : (hookEvent.cwd || process.cwd());
	const projectRoot = findProjectRoot(startDirectory);
	if (!projectRoot) process.exit(0);
	const markerPath = joinPath(projectRoot, MARKER_RELATIVE);

	// Reading a learnings.md acknowledges the surfaced learning — clear the gate.
	if (toolName === 'Read') {
		if (targetPath && basename(targetPath).toLowerCase() === 'learnings.md') {
			try { rmSync(markerPath, { force: true }); } catch { /* best-effort */ }
		}
		process.exit(0);
		return;
	}

	if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) process.exit(0);
	if (!existsSync(markerPath)) process.exit(0);

	// Only gate edits to source CODE. Docs/markdown/json/learnings edits flow freely.
	if (!CODE_EXTENSIONS.has(extname(targetPath).toLowerCase())) process.exit(0);

	let marker;
	try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); }
	catch { process.exit(0); }

	// Stale marker → drop it, don't block forever.
	if (!marker.ts || (Date.now() - marker.ts) > MARKER_TTL_MS) {
		try { rmSync(markerPath, { force: true }); } catch { /* best-effort */ }
		process.exit(0);
		return;
	}

	const sectionList = (marker.sections || []).map((s) => `  • ${s}`).join('\n') || '  • (see learnings.md)';
	const fileList = (marker.files || []).map((f) => `  - ${f}`).join('\n') || '  - learnings.md';
	const reason = [
		'STOP-BLOCKED — read the surfaced learning before editing code.',
		'',
		`A relevant learning was surfaced this session (error tokens: ${(marker.tokens || []).join(', ') || 'n/a'}).`,
		'You were shown matching bullets but have not opened the section. Editing code now',
		'risks repeating a mistake you already wrote down the answer to.',
		'',
		'Matched sections:',
		sectionList,
		'',
		'Read the learnings file(s) first (the Read clears this gate):',
		fileList,
		'',
		'Then apply the lesson. If genuinely irrelevant, Read the file anyway to acknowledge and proceed.',
		'Override (rare): LEARNINGS_ACK_OVERRIDE=1',
	].join('\n');

	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason,
		},
	}));
	process.exit(0);
}

main();
