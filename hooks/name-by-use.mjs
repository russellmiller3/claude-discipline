#!/usr/bin/env node
// name-by-use — PreToolUse(Write|Edit). Block fresh identifiers named after
// their TYPE (text, list, data, result, tmp) instead of their ROLE.
//
// A type-named variable says nothing about what it carries. A reader hitting
// `result` or `data` has to scroll up to learn what it is; a reader hitting
// `approval_count` or `stripe_event` already knows. Name by use, not by type,
// and the code documents itself.
//
// Fires on Write/Edit to .js/.mjs/.cjs/.ts/.tsx/.jsx/.py and BLOCKS when it spots
// a fresh binding/parameter named from the banned list. Cheap line-based regex:
// false negatives are fine (it's a nudge, not a compiler); false positives clear
// via the override.
//
// Allowed: single-letter loop counters i, j, k.
// Override: include "name-by-use-override" in the text, or NAME_BY_USE_OVERRIDE=1.
// Extend BANNED_NAMES freely — each entry is a lesson someone learned.

import { readFileSync } from 'node:fs';

const BANNED_NAMES = new Set([
	'text', 'string', 'str',
	'number', 'num',
	'list', 'arr', 'array', 'items',
	'obj', 'object', 'thing',
	'val', 'value',
	'result', 'response', 'resp',
	'data', 'datum',
	'tmp', 'temp', 'foo', 'bar', 'baz',
	'item',
	'output', 'out',
	'res', 'ret', 'retval',
]);

const LOOP_COUNTERS = new Set(['i', 'j', 'k']);

function isOverride(text) {
	if (process.env.NAME_BY_USE_OVERRIDE === '1') return true;
	return /name-by-use-override/i.test(text) || /NAME_BY_USE_OVERRIDE\s*=\s*1/i.test(text);
}

// Scan source text for bindings / parameters to banned identifiers.
function findHits(text, filePath) {
	if (!text || typeof text !== 'string') return [];
	if (isOverride(text)) return [];
	const ext = (filePath || '').toLowerCase().split('.').pop();
	const hits = [];
	const lines = text.split('\n');

	const jsBinding = /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*[=,;]/g;
	const jsParamList = /\b(?:function\s+\w*\s*|=>\s*|\(\s*)\(([^)]*)\)/g;

	const pyBinding = /^\s*([a-zA-Z_][\w]*)\s*=\s*[^=]/;
	const pyDefParams = /\bdef\s+\w+\s*\(([^)]*)\)/g;
	const pyForLoop = /\bfor\s+([a-zA-Z_][\w]*)\s+in\b/;

	const flag = (line, name, sample, kind) => {
		if (LOOP_COUNTERS.has(name)) return;
		if (!BANNED_NAMES.has(name.toLowerCase())) return;
		hits.push({ line, name, sample: sample.slice(0, 120), kind });
	};

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const ln = lines[lineIndex];
		const lineNo = lineIndex + 1;

		if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)) {
			let m;
			while ((m = jsBinding.exec(ln)) !== null) flag(lineNo, m[1], ln.trim(), 'js-binding');
			jsBinding.lastIndex = 0;
			while ((m = jsParamList.exec(ln)) !== null) {
				for (const raw of m[1].split(',')) {
					const param = raw.trim().split(/[=:\s]/)[0];
					if (param && /^[a-zA-Z_$][\w$]*$/.test(param)) flag(lineNo, param, ln.trim(), 'js-param');
				}
			}
			jsParamList.lastIndex = 0;
			continue;
		}

		if (ext === 'py') {
			let m = ln.match(pyBinding);
			if (m) flag(lineNo, m[1], ln.trim(), 'py-binding');
			while ((m = pyDefParams.exec(ln)) !== null) {
				for (const raw of m[1].split(',')) {
					const param = raw.trim().split(/[=:\s]/)[0];
					if (param && /^[a-zA-Z_][\w]*$/.test(param) && param !== 'self' && param !== 'cls') {
						flag(lineNo, param, ln.trim(), 'py-param');
					}
				}
			}
			pyDefParams.lastIndex = 0;
			m = ln.match(pyForLoop);
			if (m) flag(lineNo, m[1], ln.trim(), 'py-for');
		}
	}

	return hits;
}

function reasonText(hits, filePath) {
	const top = hits.slice(0, 5)
		.map((h) => `  - line ${h.line}: \`${h.name}\` (${h.kind})\n      ${h.sample}`)
		.join('\n');
	const more = hits.length > 5 ? `\n  …and ${hits.length - 5} more.` : '';
	return `STOP — name-by-use violation in ${filePath || 'this file'}.

You're introducing type-named identifiers:

${top}${more}

A type name (text, list, data, result, tmp) says nothing about what the
variable carries. Name it by its ROLE so the name IS the meaning:

  text   → command, user_message, question, address
  list   → open_tasks, recent_logs, matching_rows
  num    → age, price, approval_count, quantity
  result → grade, approved_deal, save_response
  data   → incoming_signup, raw_payload, stripe_event
  obj    → current_user, selected_record, pending_approval
  val    → new_threshold, chosen_color, refund_amount
  tmp    → draft_caption, partial_summary
  item   → approved_deal, shipped_order

Loop counters i, j, k are fine for loops only.

Override (rare — the identifier truly IS about its type):
  include "name-by-use-override" in the text, or set NAME_BY_USE_OVERRIDE=1.`;
}

function main() {
	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); return; }

	const eventName = event.hook_event_name || event.hookEventName || '';
	if (eventName !== 'PreToolUse') { process.exit(0); return; }
	const toolName = event.tool_name || '';
	if (toolName !== 'Edit' && toolName !== 'Write') { process.exit(0); return; }

	const input = event.tool_input || {};
	const filePath = input.file_path || '';
	const ext = filePath.toLowerCase().split('.').pop();
	if (!['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py'].includes(ext)) { process.exit(0); return; }

	const text = input.new_string || input.content || '';
	if (!text) { process.exit(0); return; }

	const hits = findHits(text, filePath);
	if (hits.length === 0) { process.exit(0); return; }

	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reasonText(hits, filePath),
		},
	}));
	process.exit(0);
}

main();
