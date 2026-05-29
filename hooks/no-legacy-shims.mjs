#!/usr/bin/env node
// no-legacy-shims — PreToolUse(Edit|Write) + Stop. For a pre-1.0 project with no
// external users, refuse backward-compatibility shims: deprecation warnings,
// "the old form still works" branches, soft-deprecation paths kept alive "just
// in case." Before you have users, the cost of those shims (dead code, two ways
// to do everything, tests pinned to the old shape) outweighs any benefit.
// Replace the old thing outright; update the callers and tests.
//
//   PreToolUse(Edit|Write) — blocks a write whose new text introduces
//     backcompat language.
//   Stop — blocks the turn if the last reply rationalized keeping a legacy path
//     (so you rewrite the reply AND rip out the shim it described).
//
// This is TIER 3 / opinionated: it's correct for early-stage projects and WRONG
// for shipped libraries with real consumers. Toggle it off (or set the override)
// once you have users you can't break.
//
// Override: BACKCOMPAT_OVERRIDE=1, or the literal "intentional backcompat" in
// the text. Use only when keeping the old path is a deliberate, stated decision.

import { readFileSync, existsSync } from 'node:fs';

const PATTERNS = [
	/\bback[\s-]?compat(?:ibility|ible)?\b/i,
	/\bbackwards?\s*compat/i,
	/\bdeprecat(?:e|es|ed|ion|ing)\b/i,
	/\bsoft[\s-]?deprecat/i,
	/\bexisting\s+(?:apps?|code|tests?|callers?)\s+(?:don'?t|do\s+not)\s+break/i,
	/\b(?:old|legacy|previous|prior)\s+(?:form|shape|syntax|API|interface)\s+still\s+(?:compiles?|works?|parses?)/i,
	/\bstill\s+(?:compiles?|works?|parses?)\s+(?:cleanly|fine)\b/i,
	/\bkeep\s+(?:parsing|emitting|the\s+old)\b/i,
	/\b(?:migration|deprecation)\s+(?:hint|warning|notice|marker)\b/i,
];

const OVERRIDE_PATTERNS = [/\bintentional\s+backcompat\b/i, /BACKCOMPAT_OVERRIDE\s*=\s*1/i];

function isOverride(candidateText) {
	if (process.env.BACKCOMPAT_OVERRIDE === '1') return true;
	return OVERRIDE_PATTERNS.some((re) => re.test(candidateText));
}

function findHits(bodyText) {
	if (!bodyText || typeof bodyText !== 'string') return [];
	if (isOverride(bodyText)) return [];
	const hits = [];
	for (const re of PATTERNS) {
		const matched = bodyText.match(re);
		if (matched) hits.push({ pattern: re.source, sample: matched[0] });
	}
	return hits;
}

function reasonText(hits, where) {
	const matchLines = hits.slice(0, 5).map((h) => `  - matched /${h.pattern}/: "${h.sample}"`).join('\n');
	return `STOP — no legacy shims (pre-1.0, no external users).

Detected backcompat-friendly language in ${where}:

${matchLines}

Before you have users, keeping an old form working "for back-compat" — a
deprecation warning, a soft-deprecation branch, a "still compiles" disclaimer —
just adds dead code and a second way to do everything. Do the right thing once.

Instead:
  1. RIP OUT the old syntax / API / behavior. Don't leave it.
  2. Update the code to accept ONLY the new form.
  3. Rewrite every test and caller that used the old form.
  4. Update docs to show only the new form. Skip the deprecation warning.

This hook is opinionated and TIME-BOUND: once you have users you can't break,
turn it off. Override now (deliberate, stated decision only): include
"intentional backcompat" in the text, or set BACKCOMPAT_OVERRIDE=1.`;
}

function lastAssistantText(transcriptPath) {
	if (!transcriptPath || !existsSync(transcriptPath)) return '';
	let fileBody;
	try { fileBody = readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
	const lines = fileBody.trim().split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.type !== 'assistant') continue;
			const textBlocks = (entry.message?.content || []).filter((b) => b && b.type === 'text');
			if (textBlocks.length > 0) return textBlocks.map((b) => b.text).join('\n');
		} catch { continue; }
	}
	return '';
}

function main() {
	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); return; }
	const eventName = event.hook_event_name || event.hookEventName || '';

	if (eventName === 'PreToolUse') {
		const toolName = event.tool_name || '';
		if (toolName !== 'Edit' && toolName !== 'Write') { process.exit(0); return; }
		const input = event.tool_input || {};
		const hits = findHits(input.new_string || input.content || '');
		if (hits.length === 0) { process.exit(0); return; }
		process.stdout.write(JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'deny',
				permissionDecisionReason: reasonText(hits, 'your file edit'),
			},
		}));
		process.exit(0);
		return;
	}

	if (eventName === 'Stop') {
		if (event.stop_hook_active) { process.exit(0); return; }
		const hits = findHits(lastAssistantText(event.transcript_path));
		if (hits.length === 0) { process.exit(0); return; }
		process.stdout.write(JSON.stringify({ decision: 'block', reason: reasonText(hits, 'your last reply') }));
		process.exit(0);
		return;
	}

	process.exit(0);
}

main();
