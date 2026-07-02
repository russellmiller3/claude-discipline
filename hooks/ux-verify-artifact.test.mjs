// ux-verify-artifact.test.mjs — locks the file-mtime UX-proof gate PLUS the 2026-07-02 widen:
// a transcript-visible mcp__Claude_Preview__preview_screenshot tool_use (no disk file required)
// now counts as real visual proof too, alongside the pre-existing screenshots/-file check.
//
// Run: node hooks/ux-verify-artifact.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
	visualEditsInTurn,
	hasPreviewScreenshotAfter,
	toolUseSequence,
} from './ux-verify-artifact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'ux-verify-artifact.mjs');

const failures = [];
const check = (label, condition) => { if (condition) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };
const cleanups = [];

function workspace() {
	const workDirectory = mkdtempSync(join(tmpdir(), 'uxverify-'));
	cleanups.push(workDirectory);
	return workDirectory;
}

// ── unit-level checks on the pure helpers (no process spawn) ─────────────────

const assistantToolUse = (name, input = {}) => ({
	message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
});
const userText = (promptText) => ({ message: { role: 'user', content: [{ type: 'text', text: promptText }] } });

check('toolUseSequence flattens tool_use blocks with entry index',
	(() => {
		const flattenedToolUses = toolUseSequence([
			userText('do the ui edit'),
			assistantToolUse('Edit', { file_path: 'src/App.svelte' }),
			assistantToolUse('mcp__Claude_Preview__preview_screenshot'),
		]);
		return flattenedToolUses.length === 2
			&& flattenedToolUses[0].name === 'Edit' && flattenedToolUses[0].entryIndex === 1
			&& flattenedToolUses[1].entryIndex === 2;
	})());

check('visualEditsInTurn only picks up UI-extension Write/Edit/MultiEdit/NotebookEdit',
	(() => {
		const visualEdits = visualEditsInTurn([
			userText('go'),
			assistantToolUse('Edit', { file_path: 'src/App.svelte' }),
			assistantToolUse('Edit', { file_path: 'src/server.py' }),
			assistantToolUse('Write', { file_path: 'styles/app.css' }),
		]);
		return visualEdits.length === 2
			&& visualEdits.some((edit) => edit.path === 'src/App.svelte')
			&& visualEdits.some((edit) => edit.path === 'styles/app.css');
	})());

check('hasPreviewScreenshotAfter is true when preview_screenshot fires AFTER the edit index',
	(() => {
		const turnEntries = [
			userText('go'),
			assistantToolUse('Edit', { file_path: 'src/App.svelte' }),
			assistantToolUse('mcp__Claude_Preview__preview_screenshot'),
		];
		return hasPreviewScreenshotAfter(turnEntries, 1) === true;
	})());

check('hasPreviewScreenshotAfter is false when preview_screenshot only fired BEFORE the edit index',
	(() => {
		const turnEntries = [
			userText('go'),
			assistantToolUse('mcp__Claude_Preview__preview_screenshot'),
			assistantToolUse('Edit', { file_path: 'src/App.svelte' }),
		];
		// The edit is at index 2; the only preview_screenshot call is at index 1 (before it).
		return hasPreviewScreenshotAfter(turnEntries, 2) === false;
	})());

check('hasPreviewScreenshotAfter is false with no preview_screenshot tool_use at all',
	(() => {
		const turnEntries = [userText('go'), assistantToolUse('Edit', { file_path: 'src/App.svelte' })];
		return hasPreviewScreenshotAfter(turnEntries, 1) === false;
	})());

// ── process-level checks: spawn the real hook against a synthetic transcript ─

function transcriptLine(transcriptEntry) { return JSON.stringify(transcriptEntry); }

function runHook({ transcriptPath, workingDirectory }) {
	const hookProcess = spawnSync('node', [HOOK], {
		input: JSON.stringify({ transcript_path: transcriptPath, hook_event_name: 'Stop' }),
		encoding: 'utf8',
		cwd: workingDirectory || process.cwd(),
	});
	let hookDecision = null;
	try { hookDecision = JSON.parse(hookProcess.stdout || '{}'); } catch { /* no output -> allow */ }
	return { blocked: hookDecision?.decision === 'block', reason: hookDecision?.reason || '', hookProcess };
}

// Scenario 1: a UI edit with NO screenshot file and NO preview_screenshot call -> still BLOCKS.
// (Must-still-block case per the task brief — the widen only ADDS an accepted path.)
{
	const work = workspace();
	const uiFilePath = join(work, 'App.svelte');
	writeFileSync(uiFilePath, '<div>hi</div>');
	const transcriptPath = join(work, 'transcript.jsonl');
	writeFileSync(transcriptPath, [
		transcriptLine({ role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'style the button' }] } }),
		transcriptLine({ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: uiFilePath } }] } }),
	].join('\n'));
	const hookOutcome = runHook({ transcriptPath, workingDirectory: work });
	check('UI edit + no screenshot file + no preview_screenshot -> BLOCKS (regression guard)', hookOutcome.blocked === true);
}

// Scenario 2 (THE NEW ACCEPTED CASE): a UI edit followed by a preview_screenshot tool_use in the
// transcript, with NO screenshot file ever written to disk -> ALLOWS.
{
	const work = workspace();
	const uiFilePath = join(work, 'App.svelte');
	writeFileSync(uiFilePath, '<div>hi</div>');
	const transcriptPath = join(work, 'transcript.jsonl');
	writeFileSync(transcriptPath, [
		transcriptLine({ role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'style the button' }] } }),
		transcriptLine({ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: uiFilePath } }] } }),
		transcriptLine({ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__Claude_Preview__preview_screenshot', input: { serverId: 'abc123' } }] } }),
	].join('\n'));
	const hookOutcome = runHook({ transcriptPath, workingDirectory: work });
	check('UI edit + preview_screenshot tool_use after edit, NO disk file -> ALLOWS (the new accepted case)', hookOutcome.blocked === false);
}

// Scenario 3: preview_screenshot fired BEFORE the UI edit (stale proof, e.g. checked the OLD UI,
// then changed it and never re-verified) -> still BLOCKS.
{
	const work = workspace();
	const uiFilePath = join(work, 'App.svelte');
	writeFileSync(uiFilePath, '<div>hi</div>');
	const transcriptPath = join(work, 'transcript.jsonl');
	writeFileSync(transcriptPath, [
		transcriptLine({ role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'style the button' }] } }),
		transcriptLine({ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__Claude_Preview__preview_screenshot', input: {} }] } }),
		transcriptLine({ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: uiFilePath } }] } }),
	].join('\n'));
	const hookOutcome = runHook({ transcriptPath, workingDirectory: work });
	check('preview_screenshot BEFORE the edit (stale, no re-verify) -> still BLOCKS', hookOutcome.blocked === true);
}

// Scenario 4 (existing behavior, unchanged): a real screenshot FILE newer than the edit still
// allows, with no preview_screenshot call at all — the old disk-file path must not regress.
{
	const work = workspace();
	const uiFilePath = join(work, 'App.svelte');
	writeFileSync(uiFilePath, '<div>hi</div>');
	const screenshotsDirectory = join(work, 'screenshots');
	mkdirSync(screenshotsDirectory);
	const screenshotFilePath = join(screenshotsDirectory, 'proof.png');
	writeFileSync(screenshotFilePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	// Force the screenshot's mtime comfortably after "now" so it's newer than the edit event.
	const futureTimestamp = new Date(Date.now() + 60_000);
	utimesSync(screenshotFilePath, futureTimestamp, futureTimestamp);

	const transcriptPath = join(work, 'transcript.jsonl');
	writeFileSync(transcriptPath, [
		transcriptLine({ role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'style the button' }] } }),
		transcriptLine({ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: uiFilePath } }] } }),
	].join('\n'));
	const hookOutcome = runHook({ transcriptPath, workingDirectory: work });
	check('UI edit + fresh screenshot FILE on disk (no preview_screenshot call) -> ALLOWS (old path unchanged)', hookOutcome.blocked === false);
}

// Scenario 5: no UI file edited this turn at all -> ALLOWS (nothing to verify).
{
	const work = workspace();
	const transcriptPath = join(work, 'transcript.jsonl');
	writeFileSync(transcriptPath, [
		transcriptLine({ role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the backend query' }] } }),
		transcriptLine({ role: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(work, 'server.py') } }] } }),
	].join('\n'));
	const hookOutcome = runHook({ transcriptPath, workingDirectory: work });
	check('non-UI edit only -> ALLOWS (nothing to verify)', hookOutcome.blocked === false);
}

for (const workspacePath of cleanups) { try { rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ } }

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll ux-verify-artifact checks passed.');
