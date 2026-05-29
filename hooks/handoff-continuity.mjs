#!/usr/bin/env node
// handoff-continuity — SessionStart + UserPromptSubmit + Stop. Keeps HANDOFF.md
// (the session-state snapshot) fresh so a fresh session — or a cheaper model —
// can resume without re-deriving state from chat or git logs.
//
//   SessionStart      → remind the agent to read HANDOFF.md before working.
//   UserPromptSubmit  → count turns; mark a checkpoint "due" every N turns, or
//                       immediately when the user says "handoff"/"save context"
//                       or reports a compaction.
//   Stop              → if a checkpoint is due and HANDOFF.md wasn't updated
//                       since it came due, BLOCK until it's written.
//
// A checkpoint is satisfied when HANDOFF.md's mtime is newer than the moment the
// checkpoint came due. Config: HANDOFF_CONTINUITY_TURN_INTERVAL (default 3),
// HANDOFF_CONTINUITY_STATE_PATH. Wrapped in try/catch → never wedges CC.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_TURN_INTERVAL = 3;
const turnInterval = Number(process.env.HANDOFF_CONTINUITY_TURN_INTERVAL || DEFAULT_TURN_INTERVAL);
const scriptPath = process.argv[1] || '';
const stateFolderName = scriptPath.includes('.codex') ? '.codex' : '.claude';
const checkpointStatePath =
	process.env.HANDOFF_CONTINUITY_STATE_PATH ||
	join(homedir(), stateFolderName, 'state', 'handoff-continuity.json');
const rootMarkers = ['.git', 'HANDOFF.md', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const handoffPatterns = [
	/\b\/?handoff\b/i,
	/\$\s*handoff/i,
	/\bsave context\b/i,
	/\bwrite a resume prompt\b/i,
	/\bwrap up\b/i,
];
const compactionPatterns = [
	/\bcompact(?:ion|ed|ing)?\b/i,
	/\bcontext was summarized\b/i,
	/\bsummary after compaction\b/i,
];

function readHookInput() {
	try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function parseHookInput(rawHookInput) {
	if (!rawHookInput.trim()) return {};
	try { return JSON.parse(rawHookInput); } catch { return { rawHookInput }; }
}

function ensureParentDirectory(filePath) { mkdirSync(dirname(filePath), { recursive: true }); }

function readStoredState(filePath) {
	try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return { projects: {} }; }
}

function writeStoredState(filePath, checkpointState) {
	ensureParentDirectory(filePath);
	writeFileSync(filePath, JSON.stringify(checkpointState, null, 2) + '\n', 'utf8');
}

function pathHasRootMarker(projectPath) {
	return rootMarkers.some((markerName) => existsSync(join(projectPath, markerName)));
}

function findProjectRoot(startPath) {
	let currentPath = resolve(startPath || process.cwd());
	while (true) {
		if (pathHasRootMarker(currentPath)) return currentPath;
		const parentPath = dirname(currentPath);
		if (parentPath === currentPath) return resolve(startPath || process.cwd());
		currentPath = parentPath;
	}
}

function firstExistingMentionedPath(promptBody) {
	// Match both Windows (C:\…) and POSIX (/…) absolute paths the user may name.
	const mentionedPaths = promptBody.match(/(?:[A-Za-z]:\\|\/)[^\n`"')]+/g) || [];
	for (const mentionedPath of mentionedPaths) {
		const trimmedPath = mentionedPath.trim().replace(/[.,;:]+$/, '');
		if (existsSync(trimmedPath)) return trimmedPath;
	}
	return null;
}

function promptBodyFromHookInput(hookInput) {
	const candidateBodies = [hookInput.prompt, hookInput.user_prompt, hookInput.input, hookInput.message, hookInput.rawHookInput];
	for (const candidateBody of candidateBodies) {
		if (typeof candidateBody === 'string') return candidateBody;
		if (candidateBody && typeof candidateBody.content === 'string') return candidateBody.content;
	}
	if (Array.isArray(hookInput.messages) && hookInput.messages.length > 0) {
		const latestMessage = hookInput.messages[hookInput.messages.length - 1];
		if (typeof latestMessage?.content === 'string') return latestMessage.content;
		if (Array.isArray(latestMessage?.content)) {
			return latestMessage.content.map((contentPart) => contentPart?.text || contentPart?.content || '').join('\n');
		}
	}
	return '';
}

function eventNameFromHookInput(hookInput) {
	return hookInput.hook_event_name || hookInput.hookEventName || hookInput.event || '';
}

function handoffUpdatedAfter(handoffPath, checkpointTime) {
	if (!existsSync(handoffPath)) return false;
	try { return statSync(handoffPath).mtimeMs >= checkpointTime; } catch { return false; }
}

function buildContextMessage(eventName, projectRoot, checkpointReason) {
	const handoffPath = join(projectRoot, 'HANDOFF.md');
	if (eventName === 'SessionStart') {
		return [
			'HANDOFF CONTINUITY: Before substantive work, read/check HANDOFF.md for this project.',
			`Project root detected: ${projectRoot}`,
			`Expected handoff path: ${handoffPath}`,
			'If this is a post-compaction continuation, treat HANDOFF.md as the source of truth before resuming.',
			'Keep HANDOFF.md updated every few turns and whenever the user says handoff, save context, wrap up, or mentions compaction.',
		].join('\n');
	}
	return [
		'HANDOFF CHECKPOINT DUE: Update HANDOFF.md before continuing or stopping.',
		`Reason: ${checkpointReason}.`,
		`Project root detected: ${projectRoot}`,
		`Expected handoff path: ${handoffPath}`,
		'Keep it short, priority-first, and useful after compaction.',
		'If the user invoked handoff, write the handoff and then stop.',
	].join('\n');
}

function emitAdditionalContext(eventName, contextMessage) {
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: { hookEventName: eventName, additionalContext: contextMessage },
	}));
}

function emitStopBlock(blockReason) {
	process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason }));
}

function projectKey(projectRoot) { return projectRoot.toLowerCase(); }

function checkpointRecord(checkpointState, projectRoot) {
	const key = projectKey(projectRoot);
	checkpointState.projects ||= {};
	checkpointState.projects[key] ||= { projectRoot, turnsSinceCheckpoint: 0, dueSince: null, dueReason: null };
	checkpointState.projects[key].projectRoot = projectRoot;
	return checkpointState.projects[key];
}

function clearSatisfiedCheckpoint(record, handoffPath) {
	if (record.dueSince && handoffUpdatedAfter(handoffPath, record.dueSince)) {
		record.turnsSinceCheckpoint = 0;
		record.dueSince = null;
		record.dueReason = null;
		return true;
	}
	return false;
}

function main() {
	const hookInput = parseHookInput(readHookInput());
	const eventName = eventNameFromHookInput(hookInput);
	const promptBody = promptBodyFromHookInput(hookInput);
	const mentionedPath = firstExistingMentionedPath(promptBody);
	const projectRoot = findProjectRoot(mentionedPath || hookInput.cwd || hookInput.workspace?.cwd || process.cwd());
	const handoffPath = join(projectRoot, 'HANDOFF.md');
	const checkpointState = readStoredState(checkpointStatePath);
	const record = checkpointRecord(checkpointState, projectRoot);

	clearSatisfiedCheckpoint(record, handoffPath);

	if (eventName === 'SessionStart') {
		record.lastSessionStart = Date.now();
		writeStoredState(checkpointStatePath, checkpointState);
		emitAdditionalContext(eventName, buildContextMessage(eventName, projectRoot, 'session start'));
		return;
	}

	if (eventName === 'UserPromptSubmit') {
		record.turnsSinceCheckpoint = Number(record.turnsSinceCheckpoint || 0) + 1;
		const handoffAsked = handoffPatterns.some((pattern) => pattern.test(promptBody));
		const compactionReported = compactionPatterns.some((pattern) => pattern.test(promptBody));
		let checkpointReason = null;

		if (handoffAsked) checkpointReason = 'user invoked handoff';
		else if (compactionReported) checkpointReason = 'user reported compaction';
		else if (record.turnsSinceCheckpoint >= turnInterval) checkpointReason = `${turnInterval}-turn checkpoint`;

		if (checkpointReason && !record.dueSince) {
			record.dueSince = Date.now();
			record.dueReason = checkpointReason;
		}

		writeStoredState(checkpointStatePath, checkpointState);
		if (record.dueSince) {
			emitAdditionalContext(eventName, buildContextMessage(eventName, projectRoot, record.dueReason || checkpointReason));
		}
		return;
	}

	if (eventName === 'Stop') {
		if (record.dueSince && !handoffUpdatedAfter(handoffPath, record.dueSince)) {
			emitStopBlock(buildContextMessage('Stop', projectRoot, record.dueReason || 'handoff checkpoint'));
			return;
		}
		if (record.dueSince) {
			record.turnsSinceCheckpoint = 0;
			record.dueSince = null;
			record.dueReason = null;
			writeStoredState(checkpointStatePath, checkpointState);
		}
	}
}

try { main(); } catch { process.exit(0); }
