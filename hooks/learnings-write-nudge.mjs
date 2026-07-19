#!/usr/bin/env node
// PostToolUse hook (Bash) — after a `git commit` lands with a fix(...) or
// feat(...) prefix, nudge the agent to append a learning bullet if the
// commit captured a non-obvious lesson.
//
// Russell's intent (2026-05-27): "there also needs to be a hook to WRITE
// to them after applying a patch or building a feature."
//
// Heuristic: only nudge when the commit message looks like a real lesson
// candidate — has fix/feat prefix, message body has 50+ chars (i.e. the
// author explained why, not just "fix bug"), and the bullet count in the
// matching learnings file hasn't grown in the last hour (so we don't
// re-nudge on every commit in a streak).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GLOBAL_LEARNINGS_PATH = resolvePath(homedir(), '.claude', 'learnings.md');
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const COMMIT_VERB_RE = /^git\s+commit\b/;
const LESSON_WORTHY_PREFIX_RE = /\b(fix|feat|refactor|perf|chore\(scripts\))(\([^)]+\))?:/;
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
	try {
		const fileStat = statSync(filePath);
		return Date.now() - fileStat.mtimeMs < RECENT_WRITE_GRACE_MS;
	} catch {
		return false;
	}
}

function extractCommitSummary(toolOutputText) {
	// stdout from `git commit` includes a line like:
	//   [main 2a10d53] fix(ui): flex-shrink: 0 on .details-section ...
	const summaryLineMatch = toolOutputText.match(/\[[^\]]+\]\s+(.+)$/m);
	if (!summaryLineMatch) return null;
	const summaryLine = summaryLineMatch[1].trim();
	if (!LESSON_WORTHY_PREFIX_RE.test(summaryLine)) return null;
	return summaryLine;
}

// Heuristic: if the commit message body has a "Cause:" / "Why:" / "Mechanism:"
// or quotes a CSS property / a function name + colon, it's almost certainly a
// real lesson, not a typo fix.
function looksLikeRealLesson(toolOutputText) {
	return /\b(cause|mechanism|why|root cause|the trap|the bug|the trick)\b/i.test(toolOutputText)
		|| /[A-Za-z_]+:\s*[a-z0-9]+/.test(toolOutputText); // "overflow: hidden" / "flex-shrink: 0"
}

function suggestTargetScope(commitSummary) {
	// Cross-project meta-pattern signals (debugging method, prompt design, CSS quirks).
	const globalTopicRE =
		/\b(probe|repro|debug|whackamole|css|flex-shrink|overflow|prompt|llm|cache_control|hook)\b/i;
	// Otherwise project-scoped (this codebase's gotchas).
	return globalTopicRE.test(commitSummary) ? 'global-or-project' : 'project';
}

function onPostToolUse(hookEvent) {
	if (hookEvent.tool_name !== 'Bash') return;

	const invokedCommand = hookEvent.tool_input?.command || '';
	if (!COMMIT_VERB_RE.test(invokedCommand)) return;

	const toolResponse = hookEvent.tool_response || {};
	const toolOutputText = [toolResponse.stdout, toolResponse.stderr, toolResponse.output]
		.filter(Boolean).join('\n');
	if (!toolOutputText) return;

	const commitSummaryLine = extractCommitSummary(toolOutputText);
	if (!commitSummaryLine) return;
	if (!looksLikeRealLesson(toolOutputText)) return;

	const projectRoot = findProjectRoot(process.cwd());
	const projectLearningsPath = projectRoot ? joinPath(projectRoot, 'learnings.md') : null;
	if (isRecentWrite(GLOBAL_LEARNINGS_PATH)) return;
	if (projectLearningsPath && isRecentWrite(projectLearningsPath)) return;

	const targetScope = suggestTargetScope(commitSummaryLine);
	const outputLines = [
		'=== LEARNINGS WRITE NUDGE ===',
		`Commit just landed: ${commitSummaryLine}`,
		'',
		'The commit body has lesson-worthy language (cause/mechanism/non-obvious fix).',
		'Russell\'s rule: every non-obvious bug fix → one learnings bullet.',
		'',
		targetScope === 'global-or-project'
			? `Suggested target: BOTH may apply — project ${projectLearningsPath || '<none>'} / global ${GLOBAL_LEARNINGS_PATH}`
			: `Suggested target: ${projectLearningsPath || GLOBAL_LEARNINGS_PATH}`,
		'',
		'Append a one-bullet lesson. Skip ONLY if typo/cosmetic or already captured.',
	];
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: outputLines.join('\n') }
	}));
}

// ── Stop-time enforcement ────────────────────────────────────────────────
// The PostToolUse half only fires on `git commit`. Fixes that never hit a
// conventional commit escaped it entirely — e.g. the 2026-05-29 BOM fix was a
// `node -e` strip of ~/.claude files (never committed in any project repo), so
// no learning got logged until Russell asked why. This Stop branch is
// commit-independent: if this turn diagnosed a real error AND applied a fix AND
// no learnings.md was written, BLOCK until a lesson is logged (or explicitly
// dismissed as trivial). Mirrors Russell's other gates: enforce, with an out.

const STRONG_ERROR_RE = /\b(SyntaxError|TypeError|ReferenceError|RangeError|Traceback)\b|❌\s*Failed:\s*[1-9]|\bException\b/;
// A behavioral bug throws no stack trace — the human reports it. When RUSSELL says something is broken
// ("doesn't work", "still hangs", "busy signal", "why does it…"), that IS the error signal. Without this,
// an hour-long debugging saga with no exception (e.g. the inbound-token / busy-signal fix) escaped the gate.
export const USER_BUG_REPORT_RE = /\b(does(?:n'?t| not) work|not working|still (?:broke|broken|fails?|failing|hang|hangs|busy|wrong|says)|broken|hangs? up|busy signal|no (?:answer|sound|audio)|can'?t (?:call|connect|hear)|keeps? (?:saying|doing|failing)|wrong (?:number|name|city)|frustrat|why (?:is|does|won'?t|are|can'?t)|it'?s wrong)\b/i;
const CODE_FILE_RE = /\.(mjs|cjs|js|ts|jsx|tsx|svelte|vue|py|css|svx)\b/i;
const FILE_WRITE_BASH_RE = /writeFileSync|sed\s+-i|Out-File|Set-Content|tee\b|>\s*["']?\S|\.slice\(1\)/;
// A fix isn't always a code-file edit. Infra/config fixes (a wrangler secret, a deploy, a provider API
// mutation, a fix/feat commit) leave no source diff — but they ARE the fix. Without this, the whole class
// of live-service debugging (e.g. the inbound-token / party-line fixes) escapes the gate.
const FIX_ACTION_RE = /wrangler\s+(?:secret\s+put|deploy)|\/(?:update|create|publish|delete)-[a-z-]+|method['"\\:\s]+(?:PATCH|POST|PUT|DELETE)|update-phone-number|\bfix\([^)]*\):|\bfeat\([^)]*\):/i;
const LEARNINGS_RE = /learnings\.md/i;
const DISMISS_RE = /\b(no-learning-needed|trivial-fix-no-learning|no learning needed)\b/i;

import { readTranscript, roleOf, contentBlocks, currentTurnEntries } from './lib/transcript.mjs';

/**
 * PURE classifier — scan this turn's entries into the four booleans the block decision needs.
 * Works on plain transcript-entry objects, so it's unit-testable with synthetic fixtures.
 */
export function classifyTurn(turnEntries) {
	let sawError = false, sawFix = false, wroteLearning = false, dismissed = false;
	for (const entry of turnEntries || []) {
		const entryRole = roleOf(entry);
		for (const block of contentBlocks(entry)) {
			// A human-reported bug is an error signal too — no stack trace needed. Only the USER's own
			// words count (not my echo of them), so quoting the symptom back doesn't self-trigger.
			if (entryRole === 'user' && block.type === 'text' && USER_BUG_REPORT_RE.test(block.text || '')) sawError = true;
			// tool_result outputs — count an error ONLY when the tool call actually FAILED (is_error) and
			// names a strong error. Matching error words in any stdout would false-fire constantly.
			if (block.type === 'tool_result' && block.is_error === true) {
				const resultText = typeof block.content === 'string' ? block.content
					: Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('\n') : '';
				if (STRONG_ERROR_RE.test(resultText)) sawError = true;
			}
			// assistant text (dismiss token) — only the assistant can dismiss, not the user.
			if (entryRole !== 'user' && block.type === 'text' && DISMISS_RE.test(block.text || '')) dismissed = true;
			// assistant tool_uses (fix actions + learnings writes)
			if (block.type === 'tool_use') {
				const inputStr = JSON.stringify(block.input || '');
				if (LEARNINGS_RE.test(inputStr)) wroteLearning = true;
				const filePath = block.input?.file_path || block.input?.path || '';
				if (['Edit', 'Write', 'MultiEdit'].includes(block.name) && CODE_FILE_RE.test(filePath)) sawFix = true;
				if (['Bash', 'PowerShell'].includes(block.name) && FILE_WRITE_BASH_RE.test(inputStr) && CODE_FILE_RE.test(inputStr)) sawFix = true;
				// infra/config fix (no source diff) — wrangler secret/deploy, provider API mutation, fix/feat commit.
				if (['Bash', 'PowerShell'].includes(block.name) && FIX_ACTION_RE.test(inputStr)) sawFix = true;
			}
		}
	}
	return { sawError, sawFix, wroteLearning, dismissed };
}

/** PURE decision — block only when a real bug got fixed and no lesson was logged (and not dismissed). */
export function shouldBlockForLearning({ sawError, sawFix, wroteLearning, dismissed }) {
	return Boolean(sawError && sawFix && !wroteLearning && !dismissed);
}

function onStop(hookEvent) {
	const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
	if (turnEntries.length === 0) return;

	if (!shouldBlockForLearning(classifyTurn(turnEntries))) return;

	process.stdout.write(JSON.stringify({
		decision: 'block',
		reason: [
			'LEARNINGS WRITE REQUIRED — you diagnosed a real error and applied a fix this turn, but wrote no learning.',
			'',
			'Russell\'s rule (Getty): every non-obvious fix → one learnings bullet, so it never bites twice.',
			'This fires regardless of whether the fix was committed (the BOM fix escaped because it was never a git commit).',
			'',
			'Do ONE of:',
			'  1. Append a one-bullet lesson to the right learnings.md (project gotcha → project file; cross-project method → ~/.claude/learnings.md). Add the TOC row AND the section body.',
			'  2. If this fix is genuinely trivial/cosmetic or already captured, say so with the literal token: no-learning-needed',
		].join('\n'),
	}));
}

function main() {
	let hookEvent;
	try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }
	const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
	if (eventName === 'Stop') onStop(hookEvent);
	else onPostToolUse(hookEvent);
	process.exit(0);
}

// Entry-guard: run only when invoked directly (piped a hook payload), not when imported by a test.
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
