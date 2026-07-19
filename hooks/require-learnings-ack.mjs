#!/usr/bin/env node
// PreToolUse hook (Read / Edit / Write / MultiEdit) — enforce that a surfaced
// learning is actually READ before editing code.
//
// Russell, 2026-05-29: "how were you able to ignore the hook?" — because the
// learnings hooks only INJECT text (passive); nothing blocks. I was shown the
// exact relevant bullet ("overflow:hidden + flex collapses to 0") and edited
// the wrong file anyway. This makes it a HARD GATE:
//   - learnings-error-match.mjs drops a marker when it surfaces a learning.
//   - Reading any learnings.md clears the marker (acknowledged).
//   - Editing CODE while the marker is unacknowledged is BLOCKED.
//
// 2026-07-03 (TDD false-positive loop, ledger repo): acknowledgment had NO
// session memory. The agent full-file Read learnings.md at 19:58; minutes later
// an INTENTIONAL red test printed "AttributeError", learnings-error-match
// re-dropped the marker, and the gate blocked the next Edit claiming the
// "[global] Windows / Tooling Gotchas" section was "shown but not opened" —
// one wasted re-Read per red-green cycle. Fix: SESSION-SCOPED, SECTION-AWARE
// acknowledgment.
//   - Every Read of a learnings.md records which H2 sections its line range
//     covered (full-file read = every section, recorded as '*') into a
//     per-session ack file under ~/.claude/state/learnings-session-acks/.
//   - The gate filters marker sections against the session's acks: a section
//     read earlier in the session never re-blocks, no matter how many error
//     tokens re-arm the marker. Sections the session NEVER read still block.
//   - Partial reads credit only the sections their line range fully covers.
//
// Conservative: only blocks edits to source-code files, only while a fresh
// marker exists, and the block is cleared by Reading the listed section(s).

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';

const MARKER_RELATIVE = joinPath('.claude', 'state', 'learnings-ack-needed.json');
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const MARKER_TTL_MS = 6 * 60 * 60 * 1000; // ignore markers older than 6h
const ACK_FILE_TTL_MS = 48 * 60 * 60 * 1000; // prune session ack files older than 48h
const READ_DEFAULT_LIMIT = 2000; // the Read tool's default max lines per call
const CODE_EXTENSIONS = new Set([
	'.svelte', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.vue',
	'.css', '.scss', '.less', '.py', '.go', '.rs', '.java', '.rb', '.php'
]);

// Test seams: both overridable via env so the regression tests never touch real state.
function globalLearningsPath() {
	return process.env.LEARNINGS_GLOBAL_PATH || resolvePath(homedir(), '.claude', 'learnings.md');
}
function sessionAckDir() {
	return process.env.LEARNINGS_ACK_DIR || joinPath(homedir(), '.claude', 'state', 'learnings-session-acks');
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

// Walk up and return the innermost directory containing a `.git` — the repo that holds `start`.
// Used to BOUND the marker sweep to a single repo (never the whole home dir).
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

// ---------- section coverage (what did this Read actually show?) ----------

function normalizePathForCompare(somePath) {
	return resolvePath(somePath).replace(/\\/g, '/').toLowerCase();
}

// The marker tags sections as "[global] Title" / "[project] Title" (see
// learnings-error-match.mjs). Map the file being Read onto that scope.
function scopeForLearningsPath(readPath) {
	return normalizePathForCompare(readPath) === normalizePathForCompare(globalLearningsPath())
		? 'global' : 'project';
}

// 1-based inclusive line ranges of every `## Section` in the file.
function parseSectionRanges(learningsContent) {
	const lines = learningsContent.split(/\r?\n/);
	const sections = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const h2Match = lines[lineIndex].match(/^##\s+(.+?)\s*$/);
		if (h2Match) sections.push({ title: h2Match[1].trim(), start: lineIndex + 1, end: lines.length });
	}
	for (let s = 0; s + 1 < sections.length; s++) sections[s].end = sections[s + 1].start - 1;
	return { sections, totalLines: lines.length };
}

// Which sections did a Read(offset, limit) fully cover? Defaults mirror the Read
// tool: offset absent/0/1 = top of file, limit absent = 2000 lines.
function computeCoverage(learningsContent, offset, limit) {
	const { sections, totalLines } = parseSectionRanges(learningsContent);
	const startLine = Math.max(1, Number(offset) || 1);
	const lineBudget = Math.max(1, Number(limit) || READ_DEFAULT_LIMIT);
	const endLine = Math.min(totalLines, startLine + lineBudget - 1);
	const isFullFile = startLine <= 1 && endLine >= totalLines;
	// A section counts as "shown" if the read window includes its HEADER line — you were
	// shown the section and can scroll. Requiring the read to FULLY contain the section
	// (start..end) was too strict: a read that showed the header but stopped before the
	// body ended (e.g. `offset 22 limit 30` over a section running past line 51) never
	// credited it and the gate looped forever (2026-07-19, Macher).
	const coveredTitles = sections
		.filter((section) => section.start >= startLine && section.start <= endLine)
		.map((section) => section.title);
	return { coveredTitles, isFullFile };
}

// ---------- session ack store (the fix for the TDD false-positive loop) ----------

function sessionAckFilePath(sessionId) {
	const safeName = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
	return joinPath(sessionAckDir(), `${safeName}.json`);
}

function loadSessionAcks(sessionId) {
	if (!sessionId) return { global: {}, project: {} };
	try {
		const parsed = JSON.parse(readFileSync(sessionAckFilePath(sessionId), 'utf8'));
		return { global: parsed.global || {}, project: parsed.project || {} };
	} catch { return { global: {}, project: {} }; }
}

function saveSessionAcks(sessionId, acks) {
	if (!sessionId) return; // no session id -> in-memory only (legacy behavior, real sessions always have one)
	const ackFile = sessionAckFilePath(sessionId);
	try {
		mkdirSync(dirname(ackFile), { recursive: true });
		writeFileSync(ackFile, JSON.stringify({ ts: Date.now(), global: acks.global, project: acks.project }, null, 2));
	} catch { /* best-effort */ }
	pruneStaleAckFiles(dirname(ackFile), ackFile);
}

function pruneStaleAckFiles(ackDirectory, keepFile) {
	let entries;
	try { entries = readdirSync(ackDirectory); } catch { return; }
	for (const entryName of entries) {
		if (!entryName.endsWith('.json')) continue;
		const entryPath = joinPath(ackDirectory, entryName);
		if (entryPath === keepFile) continue;
		try {
			if (Date.now() - statSync(entryPath).mtimeMs > ACK_FILE_TTL_MS) rmSync(entryPath, { force: true });
		} catch { /* best-effort */ }
	}
}

// Marker sections look like "[global] Title" / "[project] Title" (or bare "Title"
// from older markers — those match either scope). Acked = the session read that
// exact section, or full-file-read the file that owns it ('*').
function isSectionAcked(markerSection, acks) {
	const scopedMatch = String(markerSection).match(/^\[(global|project)\]\s*(.*)$/i);
	const title = (scopedMatch ? scopedMatch[2] : String(markerSection)).trim().toLowerCase();
	const scopes = scopedMatch ? [scopedMatch[1].toLowerCase()] : ['global', 'project'];
	return scopes.some((scope) => acks[scope] && (acks[scope]['*'] === true || acks[scope][title] === true));
}

function remainingUnackedSections(markerSections, acks) {
	return markerSections.filter((section) => !isSectionAcked(section, acks));
}

// ---------- marker reconciliation ----------

const SWEEP_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.svelte-kit', 'coverage', '.claude']);

// Drop every marker SECTION the session has acknowledged; delete the marker file
// once nothing unread remains. Markers with no section info (legacy) are deleted
// outright — the original contract was "any learnings read clears".
function reconcileMarkerFile(markerFile, acks) {
	if (!existsSync(markerFile)) return;
	let marker;
	try { marker = JSON.parse(readFileSync(markerFile, 'utf8')); }
	catch { try { rmSync(markerFile, { force: true }); } catch { /* best-effort */ } return; }
	const markerSections = Array.isArray(marker.sections) ? marker.sections : [];
	const remainingSections = remainingUnackedSections(markerSections, acks);
	if (remainingSections.length === 0) {
		try { rmSync(markerFile, { force: true }); } catch { /* best-effort */ }
		return;
	}
	if (remainingSections.length !== markerSections.length) {
		try { writeFileSync(markerFile, JSON.stringify({ ...marker, sections: remainingSections }, null, 2)); } catch { /* best-effort */ }
	}
}

// Reconcile EVERY learnings-ack marker beneath `root`. The marker that blocks an edit lives at
// findProjectRoot(editTarget), which is a NESTED package root (e.g. `extension/` has its own
// package.json) when the edited file sits inside a sub-package. Sweeping the whole repo subtree
// guarantees "I read the learning" reaches the gate everywhere (the ~10-turn bug from 2026-06-01,
// recurring 2026-06-22 with a 3rd root: jarvis/extension).
function reconcileMarkersUnder(root, acks, depth = 0) {
	if (!root || depth > 6) return;
	reconcileMarkerFile(joinPath(root, MARKER_RELATIVE), acks);
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
	for (const entry of entries) {
		if (!entry.isDirectory() || SWEEP_SKIP_DIRS.has(entry.name)) continue;
		reconcileMarkersUnder(joinPath(root, entry.name), acks, depth + 1);
	}
}

// The sweep above skips `.claude` dirs while RECURSING, but the marker itself lives at
// <root>/.claude/state — reconcileMarkerFile handles that path directly, so nothing is missed.

function main() {
	let hookEvent;
	try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }

	const toolName = hookEvent.tool_name || '';
	const toolInput = hookEvent.tool_input || {};
	const targetPath = toolInput.file_path || toolInput.path || '';
	const startDirectory = targetPath ? dirname(targetPath) : (hookEvent.cwd || process.cwd());
	const projectRoot = findProjectRoot(startDirectory);
	if (!projectRoot) process.exit(0);
	const markerPath = joinPath(projectRoot, MARKER_RELATIVE);
	const sessionId = hookEvent.session_id || '';

	// Reading a learnings.md acknowledges the sections the read actually covered —
	// recorded per-session so later error tokens can't re-arm the gate for them.
	if (toolName === 'Read') {
		if (targetPath && basename(targetPath).toLowerCase() === 'learnings.md') {
			const scope = scopeForLearningsPath(targetPath);
			let coveredTitles = [];
			let isFullFile = true; // unreadable file -> treat as full ack (never brick the gate)
			try {
				const learningsContent = readFileSync(targetPath, 'utf8');
				({ coveredTitles, isFullFile } = computeCoverage(learningsContent, toolInput.offset, toolInput.limit));
			} catch { /* fall through with full-ack default */ }

			const acks = loadSessionAcks(sessionId);
			for (const title of coveredTitles) acks[scope][title.toLowerCase()] = true;
			if (isFullFile) acks[scope]['*'] = true;
			saveSessionAcks(sessionId, acks);

			// Reconcile the marker at the read-file's project root, then sweep the ENTIRE
			// repo subtree (cwd's git root) so a marker dropped at a NESTED package root —
			// e.g. extension/.claude/state when editing extension/lib/foo.js — is handled too.
			reconcileMarkerFile(markerPath, acks);
			const cwdGitRoot = findGitRoot(hookEvent.cwd || process.cwd());
			if (cwdGitRoot) reconcileMarkersUnder(cwdGitRoot, acks);
			// And the read-file's repo, if different (rare: the learnings file lives in another repo).
			const readGitRoot = findGitRoot(startDirectory);
			if (readGitRoot && readGitRoot !== cwdGitRoot) reconcileMarkersUnder(readGitRoot, acks);
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

	// SESSION ACK CHECK (2026-07-03 fix): sections already read this session do not
	// re-block, even if error tokens re-armed the marker after the read (TDD reds).
	const acks = loadSessionAcks(sessionId);
	const markerSections = Array.isArray(marker.sections) ? marker.sections : [];
	const remainingSections = remainingUnackedSections(markerSections, acks);
	const sessionFullyReadSomething = acks.global['*'] === true || acks.project['*'] === true;
	if ((markerSections.length > 0 && remainingSections.length === 0) ||
		(markerSections.length === 0 && sessionFullyReadSomething)) {
		try { rmSync(markerPath, { force: true }); } catch { /* best-effort */ }
		process.exit(0);
		return;
	}

	const sectionList = remainingSections.map((s) => `  • ${s}`).join('\n') || '  • (see learnings.md)';
	const fileList = (marker.files || []).map((f) => `  - ${f}`).join('\n') || '  - learnings.md';
	const reason = [
		'STOP-BLOCKED — read the surfaced learning before editing code.',
		'',
		`A relevant learning was surfaced this session (error tokens: ${(marker.tokens || []).join(', ') || 'n/a'}).`,
		'You were shown matching bullets but have not opened the section this session. This is the',
		'exact failure mode from 2026-05-29: shown "overflow:hidden + flex collapses to 0", ignored it,',
		'edited the wrong file, accomplished nothing.',
		'',
		'Unread sections:',
		sectionList,
		'',
		'Read the learnings file(s) first (a Read covering those sections clears this gate',
		'for the rest of the session — no re-read needed after later red tests):',
		fileList,
		'',
		'Then apply the lesson. If genuinely irrelevant, Read the file anyway to acknowledge and proceed.',
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
