#!/usr/bin/env node
/**
 * PreToolUse hook - local app/server launch code must not leave orphan processes.
 *
 * Generic user-level hook. It blocks edits that create or modify local server /
 * desktop launcher surfaces unless the edited source shows:
 *   1. a shutdown path, and
 *   2. stale-owner handling, and
 *   3. browser/app-close handling when it opens a visible localhost app.
 *
 * Override: LOCAL_SERVER_LIFECYCLE_OK=1, or include:
 *   local-server-lifecycle-ok: <reason>
 */

import { existsSync, readFileSync } from 'node:fs';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const OVERRIDE_RE = /local-server-lifecycle-ok\s*:/i;

const SERVER_START_RE =
	/\b(createServer|createHttpServer|express\s*\(|fastify\s*\(|Bun\.serve|Deno\.serve|serveStatic|listen\s*\(|\.listen\s*\(|start[A-Za-z]*Server|run[A-Za-z]*Server)\b/i;
const LOCAL_APP_RE = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|loopback|port)\b/i;
const LAUNCHER_PATH_RE = /\.(cmd|bat|ps1|sh|desktop|plist|service)$/i;
const LAUNCHER_SOURCE_RE =
	/\b(node|bun|deno|python|python3|py|npm(?:\.cmd)?|pnpm|yarn)\b[\s\S]{0,140}\b(app|server|serve|dev|start)\b/i;
const DESKTOP_OPEN_RE =
	/\b(openBrowser|window\.open|shell\.CreateShortcut|Start-Process|xdg-open|cmd(?:\.exe)?\s+\/c\s+start|\.lnk|desktop shortcut)\b/i;

const SHUTDOWN_RE =
	/\b(server\.close|close\s*\(|dispose\s*\(|cleanup|shutdown|SIGINT|SIGTERM|AbortController|taskkill|Stop-Process|process\.kill|killProcess)\b/i;
const STALE_OWNER_RE =
	/\b(EADDRINUSE|address already in use|already running|detectRunning|stale|orphan|pid|lockfile|liveness|healthcheck|health check|probe|api\/summary|port owner|port.*in use|taskkill|Stop-Process|process\.kill)\b/i;
const BROWSER_CLOSE_RE =
	/\b(sendBeacon|pagehide|beforeunload|visibilitychange|heartbeat|lastHeartbeat|client.*disconnect|browser.*exit|child.*exit|window.*closed|app.*closed|app.*close|inactive.*close|idle.*shutdown)\b/i;

function readHookPayload() {
	let rawHookInput = '';
	try {
		rawHookInput = readFileSync(0, 'utf8');
	} catch {
		return {};
	}
	try {
		return JSON.parse(rawHookInput || '{}');
	} catch {
		return {};
	}
}

function main() {
	if (process.env.LOCAL_SERVER_LIFECYCLE_OK === '1') process.exit(0);

	const hookPayload = readHookPayload();
	const toolName = hookPayload.tool_name || hookPayload.toolName || '';
	if (!EDIT_TOOLS.has(toolName)) process.exit(0);

	const toolInput = hookPayload.tool_input || hookPayload.toolInput || {};
	const targetPath = toolInput.file_path || toolInput.path || '';
	// Documentation files DESCRIBE apps; they are never an app/server surface themselves.
	// Prose like "drive a real app" / "the desktop panel" otherwise trips the desktop-open
	// classifier on a plain README edit. Skip doc extensions outright.
	if (/\.(md|markdown|mdx|txt|rst|adoc)$/i.test(targetPath)) process.exit(0);
	const candidateSource = candidateSourceFor(toolName, toolInput, targetPath);
	if (!candidateSource || OVERRIDE_RE.test(candidateSource)) process.exit(0);

	const appSurface = classifyLocalServerSurface(targetPath, candidateSource);
	if (!appSurface.isLocalServerSurface) process.exit(0);

	const missingSignals = lifecycleMissingSignals(appSurface, candidateSource);
	if (missingSignals.length === 0) process.exit(0);

	deny(
		`Local server lifecycle blocked this edit.\n\n` +
		`Russell's rule: a visible local app must not leave an old server process behind. ` +
		`Closing the app should stop the helper, and launchers must handle stale port owners instead of crashing.\n\n` +
		`Missing evidence:\n${missingSignals.map((signal) => `- ${signal}`).join('\n')}\n\n` +
		`Add lifecycle proof before editing this surface. Good evidence includes: server.close/SIGINT cleanup, ` +
		`EADDRINUSE stale-owner handling, PID/lockfile liveness checks, heartbeat + pagehide/sendBeacon from the browser app, ` +
		`or waiting on a tracked browser child process.\n\n` +
		`Target: ${targetPath || '(unknown file)'}\n` +
		`Override only with LOCAL_SERVER_LIFECYCLE_OK=1 or "local-server-lifecycle-ok: <reason>".`
	);
}

function candidateSourceFor(toolName, toolInput, targetPath) {
	if (toolName === 'Write') return String(toolInput.content || '');

	const existingSource = readExistingSource(targetPath);
	if (toolName === 'Edit') {
		return applySingleEdit(existingSource, toolInput);
	}
	if (toolName === 'MultiEdit') {
		return applyMultipleEdits(existingSource, toolInput.edits || []);
	}
	return '';
}

function readExistingSource(targetPath) {
	if (!targetPath || !existsSync(targetPath)) return '';
	try {
		return readFileSync(targetPath, 'utf8');
	} catch {
		return '';
	}
}

function applySingleEdit(existingSource, toolInput) {
	const previousSnippet = String(toolInput.old_string || toolInput.oldString || '');
	const replacementSnippet = String(toolInput.new_string || toolInput.newString || '');
	if (!existingSource || !previousSnippet) return `${existingSource}\n${replacementSnippet}`;
	return existingSource.replace(previousSnippet, replacementSnippet);
}

function applyMultipleEdits(existingSource, edits) {
	let simulatedSource = existingSource;
	for (const editOperation of edits) {
		simulatedSource = applySingleEdit(simulatedSource, editOperation || {});
	}
	return simulatedSource;
}

function classifyLocalServerSurface(targetPath, candidateSource) {
	const pathLooksLauncher = LAUNCHER_PATH_RE.test(targetPath || '');
	const sourceStartsServer = SERVER_START_RE.test(candidateSource) && LOCAL_APP_RE.test(candidateSource);
	const sourceLaunchesDesktopApp =
		DESKTOP_OPEN_RE.test(candidateSource) && (LOCAL_APP_RE.test(candidateSource) || /\b(app|browser|desktop)\b/i.test(candidateSource));
	const launcherStartsApp = pathLooksLauncher && LAUNCHER_SOURCE_RE.test(candidateSource);

	return {
		isLocalServerSurface: sourceStartsServer || sourceLaunchesDesktopApp || launcherStartsApp,
		startsServer: sourceStartsServer || launcherStartsApp,
		opensVisibleApp: sourceLaunchesDesktopApp || launcherStartsApp,
	};
}

function lifecycleMissingSignals(appSurface, candidateSource) {
	const missingSignals = [];
	if (appSurface.startsServer && !SHUTDOWN_RE.test(candidateSource)) {
		missingSignals.push('shutdown path for the server/helper process');
	}
	if (appSurface.startsServer && !STALE_OWNER_RE.test(candidateSource)) {
		missingSignals.push('stale port-owner / already-running handling');
	}
	if (appSurface.opensVisibleApp && !BROWSER_CLOSE_RE.test(candidateSource)) {
		missingSignals.push('visible app close signal that stops the helper');
	}
	return missingSignals;
}

function deny(reason) {
	console.log(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason,
		},
	}));
	process.exit(0);
}

main();
