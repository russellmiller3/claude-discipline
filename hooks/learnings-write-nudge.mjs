#!/usr/bin/env node
// learnings-write-nudge — PostToolUse(Bash) + Stop. Close the loop: when a real
// lesson was learned this turn, make sure it gets written down.
//
//   PostToolUse(Bash) — after a fix/feat commit whose body has lesson-worthy
//     language (cause / mechanism / why), NUDGE to append a learnings bullet.
//   Stop — commit-independent backstop: if this turn diagnosed a real error AND
//     applied a fix AND no learnings.md was written, BLOCK until a lesson is
//     logged (or explicitly dismissed as trivial with the token below).
//
// Why both: the commit nudge misses fixes that never become a conventional
// commit (a one-off script edit, a config tweak). The Stop gate catches those.
// No-ops cleanly if there's nothing to nudge about.
//
// Dismiss token (for genuinely trivial/cosmetic fixes): no-learning-needed
// Override: LEARNINGS_NUDGE_OVERRIDE=1

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath, dirname } from 'node:path';
import { homedir } from 'node:os';

const GLOBAL_LEARNINGS_PATH = resolvePath(homedir(), '.claude', 'learnings.md');
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const COMMIT_VERB_RE = /^git\s+commit\b/;
const LESSON_WORTHY_PREFIX_RE = /\b(fix|feat|refactor|perf)(\([^)]+\))?:/;
const RECENT_WRITE_GRACE_MS = 60 * 60 * 1000; // 1 hour

function findProjectRoot(startDirectory) {
	let probeDirectory = startDirectory;
	for (let depthSteps = 0; depthSteps < 12; depthSteps++) {
		for (const markerName of ROOT_MARKERS) {
			if (existsSync(joinPath(probeDirectory, markerName))) return probeDirectory;
		}
		const parentDirectory = dirname(probeDirectory);
		if (parentDirectory === probeDirectory) return null;
		probeDirectory = parentDirectory;
	}
	return null;
}

function isRecentWrite(filePath) {
	if (!existsSync(filePath)) return false;
	try { return Date.now() - statSync(filePath).mtimeMs < RECENT_WRITE_GRACE_MS; } catch { return false; }
}

function extractCommitSummary(toolOutputText) {
	// `git commit` stdout includes a line like: [main 2a10d53] fix(ui): …
	const summaryLineMatch = toolOutputText.match(/\[[^\]]+\]\s+(.+)$/m);
	if (!summaryLineMatch) return null;
	const summaryLine = summaryLineMatch[1].trim();
	if (!LESSON_WORTHY_PREFIX_RE.test(summaryLine)) return null;
	return summaryLine;
}

// Heuristic: a "Cause:"/"Why:"/"Mechanism:" word or a quoted property (foo: bar)
// signals a real lesson, not a typo fix.
function looksLikeRealLesson(toolOutputText) {
	return /\b(cause|mechanism|why|root cause|the trap|the bug|the trick|gotcha)\b/i.test(toolOutputText)
		|| /[A-Za-z_]+:\s*[a-z0-9]+/.test(toolOutputText);
}

function onPostToolUse(hookEvent) {
	if (hookEvent.tool_name !== 'Bash' && hookEvent.tool_name !== 'PowerShell') return;

	const invokedCommand = hookEvent.tool_input?.command || '';
	if (!COMMIT_VERB_RE.test(invokedCommand)) return;

	const toolResponse = hookEvent.tool_response || {};
	const toolOutputText = [toolResponse.stdout, toolResponse.stderr, toolResponse.output].filter(Boolean).join('\n');
	if (!toolOutputText) return;

	const commitSummaryLine = extractCommitSummary(toolOutputText);
	if (!commitSummaryLine) return;
	if (!looksLikeRealLesson(toolOutputText)) return;

	const projectRoot = findProjectRoot(hookEvent.cwd || process.cwd());
	const projectLearningsPath = projectRoot ? joinPath(projectRoot, 'learnings.md') : null;
	if (isRecentWrite(GLOBAL_LEARNINGS_PATH)) return;
	if (projectLearningsPath && isRecentWrite(projectLearningsPath)) return;

	const outputLines = [
		'=== LEARNINGS WRITE NUDGE ===',
		`Commit just landed: ${commitSummaryLine}`,
		'',
		'The commit body has lesson-worthy language (cause / mechanism / non-obvious fix).',
		'The rule: every non-obvious bug fix → one learnings bullet, so it never bites twice.',
		'',
		`Suggested target: ${projectLearningsPath || GLOBAL_LEARNINGS_PATH}`,
		'  (codebase-specific gotcha → project file; cross-project method → ~/.claude/learnings.md)',
		'',
		'Append a one-bullet lesson. Skip ONLY if typo/cosmetic or already captured.',
	];
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: outputLines.join('\n') },
	}));
}

// ── Stop-time enforcement (commit-independent) ─────────────────────────────
const STRONG_ERROR_RE = /\b(SyntaxError|TypeError|ReferenceError|RangeError|Traceback)\b|Failed:\s*[1-9]|\bException\b/;
const CODE_FILE_RE = /\.(mjs|cjs|js|ts|jsx|tsx|svelte|vue|py|css|go|rs|rb|php)\b/i;
const FILE_WRITE_BASH_RE = /writeFileSync|sed\s+-i|Out-File|Set-Content|tee\b|>\s*["']?\S/;
const LEARNINGS_RE = /learnings\.md/i;
const DISMISS_RE = /\b(no-learning-needed|trivial-fix-no-learning|no learning needed)\b/i;

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
function currentTurnEntries(entries) {
	let lastAssistant = -1;
	for (let i = entries.length - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'assistant') { lastAssistant = i; break; } }
	if (lastAssistant < 0) return [];
	let turnStart = 0;
	for (let i = lastAssistant - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'user') { turnStart = i; break; } }
	return entries.slice(turnStart);
}

function onStop(hookEvent) {
	const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
	if (turnEntries.length === 0) return;

	let sawError = false, sawFix = false, wroteLearning = false, dismissed = false;
	for (const entry of turnEntries) {
		for (const block of contentBlocks(entry)) {
			// Count an error ONLY when a tool call actually FAILED (is_error) and named a
			// strong error. Matching error words in arbitrary stdout (grep hits, test data)
			// would false-fire constantly and train reflexive dismissal — the anti-pattern.
			if (block.type === 'tool_result' && block.is_error === true) {
				const resultText = typeof block.content === 'string' ? block.content
					: Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('\n') : '';
				if (STRONG_ERROR_RE.test(resultText)) sawError = true;
			}
			if (block.type === 'text' && DISMISS_RE.test(block.text || '')) dismissed = true;
			if (block.type === 'tool_use') {
				const inputStr = JSON.stringify(block.input || '');
				if (LEARNINGS_RE.test(inputStr)) wroteLearning = true;
				const filePath = block.input?.file_path || block.input?.path || '';
				if (['Edit', 'Write', 'MultiEdit'].includes(block.name) && CODE_FILE_RE.test(filePath)) sawFix = true;
				if (['Bash', 'PowerShell'].includes(block.name) && FILE_WRITE_BASH_RE.test(inputStr) && CODE_FILE_RE.test(inputStr)) sawFix = true;
			}
		}
	}

	if (!(sawError && sawFix) || wroteLearning || dismissed) return;

	process.stdout.write(JSON.stringify({
		decision: 'block',
		reason: [
			'LEARNINGS WRITE REQUIRED — you diagnosed a real error and applied a fix this turn, but wrote no learning.',
			'',
			'The rule (Getty): every non-obvious fix → one learnings bullet, so it never bites twice.',
			'This fires whether or not the fix was committed (one-off script/config fixes escape commit-based nudges).',
			'',
			'Do ONE of:',
			'  1. Append a one-bullet lesson to the right learnings.md (codebase gotcha → project file;',
			'     cross-project method → ~/.claude/learnings.md). Add the TOC row AND the section body.',
			'  2. If genuinely trivial/cosmetic or already captured, say so with the literal token: no-learning-needed',
		].join('\n'),
	}));
}

function main() {
	if (process.env.LEARNINGS_NUDGE_OVERRIDE === '1') { process.exit(0); return; }
	let hookEvent;
	try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }
	const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
	if (eventName === 'Stop') onStop(hookEvent);
	else onPostToolUse(hookEvent);
	process.exit(0);
}

main();
