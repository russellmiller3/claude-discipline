import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const hookPath = fileURLToPath(new URL('./local-server-lifecycle.mjs', import.meta.url));

function runHook(hookPayload, envPatch = {}) {
	const hookRun = spawnSync(process.execPath, [hookPath], {
		input: JSON.stringify(hookPayload),
		encoding: 'utf8',
		env: { ...process.env, ...envPatch },
	});
	return {
		status: hookRun.status,
		stdout: hookRun.stdout.trim(),
		stderr: hookRun.stderr.trim(),
	};
}

function writePayload(filePath, content) {
	return {
		tool_name: 'Write',
		tool_input: { file_path: filePath, content },
	};
}

function decisionOf(hookRun) {
	if (!hookRun.stdout) return null;
	return JSON.parse(hookRun.stdout).hookSpecificOutput.permissionDecision;
}

test('allows non-server edits', () => {
	const hookRun = runHook(writePayload('notes.md', '# Plain notes\n'));
	assert.equal(hookRun.status, 0);
	assert.equal(hookRun.stdout, '');
});

test('allows a doc edit that DESCRIBES a desktop app (prose is not an app surface)', () => {
	// A README mentioning "drive a real app" / "the desktop panel" must not trip the
	// desktop-open classifier — doc files describe apps, they are never the app surface.
	const hookRun = runHook(writePayload('README.md',
		'The Chat panel can drive a real app, not just reply — open the desktop widget and it operates the app.'));
	assert.equal(hookRun.status, 0);
	assert.equal(hookRun.stdout, '');
});

test('blocks a localhost server with no shutdown or stale-owner handling', () => {
	const hookRun = runHook(writePayload('src/server.mjs', `
import http from 'node:http';
const server = http.createServer((request, reply) => reply.end('ok'));
server.listen(8765, '127.0.0.1');
`));

	assert.equal(decisionOf(hookRun), 'deny');
	assert.match(hookRun.stdout, /shutdown path/);
	assert.match(hookRun.stdout, /stale port-owner/);
});

test('blocks a desktop launcher that opens a visible app without app-close shutdown evidence', () => {
	const launcherPath = path.join('scripts', 'start-local-app.cmd');
	const hookRun = runHook(writePayload(launcherPath, `
@echo off
node src\\cli.mjs app
`));

	assert.equal(decisionOf(hookRun), 'deny');
	assert.match(hookRun.stdout, /visible app close signal/);
});

test('allows a local app server with shutdown, stale-owner, and browser-close evidence', () => {
	const hookRun = runHook(writePayload('src/server.mjs', `
import http from 'node:http';
const server = http.createServer((request, reply) => {
  if (request.url === '/app-heartbeat') reply.end('ok');
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') process.kill(findStalePortOwner());
});
server.listen(8765, '127.0.0.1');
window.addEventListener('pagehide', () => navigator.sendBeacon('/app-closed'));
process.once('SIGINT', () => server.close());
`));

	assert.equal(hookRun.status, 0);
	assert.equal(hookRun.stdout, '');
});

test('allows an explicit lifecycle override', () => {
	const hookRun = runHook(writePayload('src/server.mjs', `
// local-server-lifecycle-ok: external supervisor owns this daemon.
server.listen(8765, '127.0.0.1');
`));

	assert.equal(hookRun.status, 0);
	assert.equal(hookRun.stdout, '');
});
