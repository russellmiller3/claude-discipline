#!/usr/bin/env node
// file-size-guard — PostToolUse(Write). Warns (never blocks) when a newly
// written code file crosses structural size limits: too many lines (owns too
// much), an over-long function, or a switch/match with too many arms (the next
// arm probably wants to be a new type). Injects an advisory so the agent can
// surface the smell honestly (e.g. in a decay-footer, if you use that hook).
//
// Fires on Write only (Edit doesn't carry full file content). Warn-only by
// design — size is a smell, not an error; a hard block here would fight
// legitimate large files.
//
// Config (env): FILE_SIZE_MAX_LINES (default 400), FILE_SIZE_MAX_FN (default 80),
// FILE_SIZE_MAX_ARMS (default 7). Disable entirely: FILE_SIZE_GUARD_OFF=1.

import { readFileSync } from 'node:fs';

const MAX_LINES = Number(process.env.FILE_SIZE_MAX_LINES) || 400;
const MAX_FN = Number(process.env.FILE_SIZE_MAX_FN) || 80;
const MAX_ARMS = Number(process.env.FILE_SIZE_MAX_ARMS) || 7;

const CODE_EXTENSIONS = /\.(go|rs|js|ts|jsx|tsx|py|rb|java|kt|swift|c|cpp|h|cs|ex|exs|ml|hs|clj|scala|lua|php|sh|bash|mjs|cjs)$/i;
const DOC_PATHS = /\.(md|txt|json|toml|ya?ml|html?|css|svg)$/i;

function countSwitchArms(sourceText) {
	const matches = sourceText.match(/^\s*(case\b|when\b|=>\s|default:)/gm) || [];
	return matches.length;
}

function longestFunction(sourceText) {
	const funcStartRe = /^[ \t]*(func|fn |def |function |async function |\w+\s+func\s+)/gm;
	const starts = [];
	let m;
	const totalLines = sourceText.split('\n').length;
	while ((m = funcStartRe.exec(sourceText)) !== null) {
		starts.push(sourceText.slice(0, m.index).split('\n').length);
	}
	if (starts.length < 2) return 0;
	let maxLen = 0;
	for (let i = 0; i < starts.length - 1; i++) maxLen = Math.max(maxLen, starts[i + 1] - starts[i]);
	return Math.max(maxLen, totalLines - starts[starts.length - 1]);
}

function main() {
	if (process.env.FILE_SIZE_GUARD_OFF === '1') process.exit(0);

	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

	if ((event.tool_name || '') !== 'Write') process.exit(0);
	const input = event.tool_input || {};
	const path = (input.file_path || '').replace(/\\/g, '/');
	if (DOC_PATHS.test(path) || !CODE_EXTENSIONS.test(path)) process.exit(0);

	const content = input.content || '';
	if (!content) process.exit(0);

	const lineCount = content.split('\n').length;
	const switchArms = countSwitchArms(content);
	const longestFn = longestFunction(content);

	const smells = [];
	if (lineCount > MAX_LINES) smells.push(`File is ${lineCount} lines (limit ${MAX_LINES}). Probably owns too much — consider splitting.`);
	if (switchArms > MAX_ARMS) smells.push(`switch/match has ~${switchArms} arms (limit ${MAX_ARMS}). The next addition probably wants to be a new type, not another arm.`);
	if (longestFn > MAX_FN) smells.push(`Longest function is ~${longestFn} lines (limit ${MAX_FN}). Consider extracting helpers.`);

	if (smells.length === 0) process.exit(0);

	const shortPath = path.split('/').slice(-2).join('/');
	const advisory = `[file-size-guard] Structural size advisory for ${shortPath}:\n`
		+ smells.map(s => `  - ${s}`).join('\n')
		+ `\nSurface these honestly (e.g. in your decay footer if you use one).`;

	process.stdout.write(JSON.stringify({
		hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: advisory },
	}));
	process.exit(0);
}

try { main(); } catch { process.exit(0); }
