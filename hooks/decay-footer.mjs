#!/usr/bin/env node
// decay-footer — Stop. If the agent wrote or edited code files this turn, the
// reply must end with a debt-surface footer. The footer keeps technical debt
// VISIBLE: the author honestly names what got worse, so it's a decision you can
// see rather than a surprise you find later.
//
// Required footer shape (the reply must contain these markers):
//   **Files touched:** …
//   **Invariants relied on:** …
//   **Smells introduced or worsened:** … (or "none")
//   **Suggested follow-up refactor:** … (or "none")
//
// Detection: scan this turn for Write/Edit on a code file; if found and the last
// reply lacks the footer markers, block. Fail-open on any error.
// Override for genuinely trivial edits: write
//   decay-footer override: trivial change — <what it was>

import { readFileSync, existsSync } from 'node:fs';

const CODE_EXTENSIONS = /\.(go|rs|js|ts|jsx|tsx|py|rb|java|kt|swift|c|cpp|h|cs|ex|exs|ml|hs|clj|scala|lua|php|sh|bash|mjs|cjs|svelte|vue)$/i;
const DOC_PATHS = /\.(md|txt|json|toml|yaml|yml|html?|css|svg)$/i;

function isCodeFile(filePath) {
	if (!filePath) return false;
	const normalized = filePath.replace(/\\/g, '/');
	if (DOC_PATHS.test(normalized)) return false;
	return CODE_EXTENSIONS.test(normalized);
}

const FOOTER_MARKERS = [
	/\*\*files touched\*\*/i,
	/\bfiles touched:/i,
	/\*\*invariants relied on\*\*/i,
	/\binvariants relied on:/i,
];
const OVERRIDE_MARKER = /decay-footer override:/i;

function hasFooter(replyText) {
	return FOOTER_MARKERS.some((re) => re.test(replyText)) || OVERRIDE_MARKER.test(replyText);
}

function main() {
	if (process.env.DECAY_FOOTER_OVERRIDE === '1') process.exit(0);

	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }
	if (event.stop_hook_active) process.exit(0);

	const transcriptPath = event.transcript_path;
	if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

	let transcriptText = '';
	try { transcriptText = readFileSync(transcriptPath, 'utf8'); } catch { process.exit(0); }
	if (!transcriptText) process.exit(0);

	const lines = transcriptText.split('\n').filter(Boolean);
	let lastAssistantText = '';
	let codeWasWritten = false;
	let inCurrentTurn = false;

	for (let i = lines.length - 1; i >= 0; i--) {
		let entry;
		try { entry = JSON.parse(lines[i]); } catch { continue; }
		const role = entry.message?.role || entry.role;
		const content = entry.message?.content || entry.content || [];

		if (role === 'assistant' && !lastAssistantText) {
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block?.type === 'text' && typeof block.text === 'string') lastAssistantText += block.text + '\n';
				}
			} else if (typeof content === 'string') {
				lastAssistantText = content;
			}
			inCurrentTurn = true;
			continue;
		}

		if (inCurrentTurn) {
			if (role === 'assistant' && Array.isArray(content)) {
				for (const block of content) {
					if (block?.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit' || block.name === 'MultiEdit')) {
						if (isCodeFile(block.input?.file_path || '')) codeWasWritten = true;
					}
				}
			}
			if (role === 'user') break;
		}
	}

	if (!codeWasWritten) process.exit(0);
	if (!lastAssistantText) process.exit(0);
	if (hasFooter(lastAssistantText)) process.exit(0);

	const reason = [
		'STOP — Decay Footer missing.',
		'',
		'You wrote or edited code files this turn but the reply lacks the debt-surface footer.',
		'Every code-changing reply must end with:',
		'',
		'**Files touched:** [every file you wrote/edited]',
		'**Invariants relied on:** [e.g. "view isolation", "typed records only", "messages-only concurrency"]',
		'**Smells introduced or worsened:** [honest list — new root-struct field, positional access,',
		'  string type-discriminator, shared mutation, file now >400 lines, switch with >7 arms — or "none"]',
		'**Suggested follow-up refactor:** [concrete suggestion or "none"]',
		'',
		'Add the footer before stopping. If the change was genuinely trivial (typo, rename, comment),',
		'write: decay-footer override: trivial change — <what it was>',
	].join('\n');

	console.log(JSON.stringify({ decision: 'block', reason }));
	process.exit(0);
}

try { main(); } catch { process.exit(0); }
