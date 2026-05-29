#!/usr/bin/env node
// hookbook-sync — Stop. The system documents itself. If you change a hook file
// this turn but don't update HOOKBOOK.md, block until you do. A meta-hook that
// guards the guardrails — the per-hook reference can't silently drift out of
// date, because the gate won't let the turn end until it's current.
//
// It enforces TWO things:
//   1. A hook .mjs changed this turn → HOOKBOOK.md must be touched this turn too
//      (you write the human judgment: what the hook does, its clear-path).
//   2. The "N hooks" headline count in HOOKBOOK.md must match the number of
//      hooks actually registered in settings.json (mechanical — auto-verified).
//
// Paths are configurable:
//   HOOKBOOK_PATH   (default ~/.claude/hooks/HOOKBOOK.md)
//   HOOK_SETTINGS_PATH (default ~/.claude/settings.json)
// Override: HOOKBOOK_SYNC_OVERRIDE=1.
//
// Note: do NOT bail on stop_hook_active — when another Stop hook blocks first,
// the re-evaluation sets that flag, and bailing here would let hook changes slip
// through unrecorded. It can't loop forever: updating HOOKBOOK.md clears it.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOKS_DIR_RE = /[/\\](?:\.claude|hooks)[/\\][^/\\]+\.mjs/i;
const HOOKBOOK_RE = /HOOKBOOK\.md/i;
const HOOKBOOK_PATH = process.env.HOOKBOOK_PATH || join(homedir(), '.claude', 'hooks', 'HOOKBOOK.md');
const SETTINGS_PATH = process.env.HOOK_SETTINGS_PATH || join(homedir(), '.claude', 'settings.json');

function readTranscript(transcriptPath) {
	if (!transcriptPath || !existsSync(transcriptPath)) return [];
	try {
		return readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
			.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
	} catch { return []; }
}

function roleOf(entry) { return entry.message?.role || entry.role || entry.type || ''; }
function contentBlocks(entry) {
	const blocks = entry.message?.content ?? entry.content ?? [];
	if (typeof blocks === 'string') return [{ type: 'text', text: blocks }];
	return Array.isArray(blocks) ? blocks : [];
}
function toolUsesOf(entry) { return contentBlocks(entry).filter((b) => b?.type === 'tool_use'); }

function currentTurnEntries(entries) {
	let lastAssistant = -1;
	for (let i = entries.length - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'assistant') { lastAssistant = i; break; } }
	if (lastAssistant < 0) return [];
	let turnStart = 0;
	for (let i = lastAssistant - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'user') { turnStart = i; break; } }
	return entries.slice(turnStart);
}

function hookFileChangedThisTurn(turnEntries) {
	for (const entry of turnEntries) {
		if (roleOf(entry) !== 'assistant') continue;
		for (const toolUse of toolUsesOf(entry)) {
			const inputStr = JSON.stringify(toolUse.input || '');
			if (['Write', 'Edit', 'MultiEdit'].includes(toolUse.name || '')) {
				const filePath = toolUse.input?.file_path || toolUse.input?.path || '';
				if (HOOKS_DIR_RE.test(filePath)) return true;
			}
			if (['Bash', 'PowerShell'].includes(toolUse.name || '')) {
				if (HOOKS_DIR_RE.test(inputStr) && /cat\s*>|Out-File|Set-Content|tee\b|>\s*["']/.test(inputStr)) return true;
			}
		}
	}
	return false;
}

function hookbookUpdatedThisTurn(turnEntries) {
	for (const entry of turnEntries) {
		if (roleOf(entry) !== 'assistant') continue;
		for (const toolUse of toolUsesOf(entry)) {
			if (HOOKBOOK_RE.test(JSON.stringify(toolUse.input || ''))) return true;
		}
	}
	return false;
}

// Mechanically derive the truth: count unique hooks/<name>.mjs referenced in
// settings.json, compare to the "N hooks" headline in HOOKBOOK.md.
function getCountDrift() {
	try {
		const settingsText = readFileSync(SETTINGS_PATH, 'utf8');
		const hookbookText = readFileSync(HOOKBOOK_PATH, 'utf8');
		const registered = new Set([...settingsText.matchAll(/hooks\/([a-z0-9-]+)\.mjs/gi)].map((m) => m[1])).size;
		const headlineMatch = hookbookText.match(/(\d+)\s+hooks\b/i);
		if (!headlineMatch) return null;
		const headline = Number(headlineMatch[1]);
		return headline === registered ? null : { headline, registered };
	} catch {
		return null;
	}
}

async function main() {
	if (process.env.HOOKBOOK_SYNC_OVERRIDE === '1') return;

	let stdinText = '';
	for await (const chunk of process.stdin) stdinText += chunk;
	let payload;
	try { payload = JSON.parse(stdinText); } catch { payload = {}; }

	const turnEntries = currentTurnEntries(readTranscript(payload.transcript_path));
	if (turnEntries.length === 0) return;
	if (!hookFileChangedThisTurn(turnEntries)) return;

	const rowMissing = !hookbookUpdatedThisTurn(turnEntries);
	const drift = getCountDrift();
	if (!rowMissing && !drift) return;

	const blockLines = ['HOOKBOOK UPDATE REQUIRED — a hook file changed this turn.', '', `HOOKBOOK lives at: ${HOOKBOOK_PATH}`, ''];
	if (rowMissing) blockLines.push('• Add or update the row for the changed hook (under the right event section).');
	if (drift) blockLines.push(`• Fix the headline count: it says "${drift.headline} hooks" but ${drift.registered} are registered in settings.json. Update it to ${drift.registered}.`);
	blockLines.push('', 'Override (rare): HOOKBOOK_SYNC_OVERRIDE=1');
	process.stdout.write(JSON.stringify({ decision: 'block', reason: blockLines.join('\n') }));
}

main().catch(() => process.exit(0));
