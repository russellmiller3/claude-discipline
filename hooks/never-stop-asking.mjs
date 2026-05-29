#!/usr/bin/env node
// never-stop-asking — Stop hook. Enforces bias-to-action (the "Ross Perot" rule):
// lead, decide, ship; don't wait for permission on reversible work; don't wind
// down while there's obvious work left. These behaviors live in CLAUDE.md too,
// but advice slips on long sessions — this is the deterministic backstop.
//
// DEFAULT checks (always on):
//   1. asking-permission — "want me to / should I / if you'd rather" → block.
//      Lead with a decision ("doing X unless you object"), don't hand the user
//      a menu of equal options.
//   2. satisfaction-stop — the message reads like closing credits ("next session",
//      "TL;DR", "wrapping up"), OR names a "next move" while the turn made ZERO
//      working tool calls toward it. Either start the move now or drop the framing.
//
// OPT-IN checks (off unless the env flag is set — they encode a specific workflow):
//   NEVER_STOP_REQUIRE_BEAT=1  — a work-progressing turn must include an
//      orientation beat (where we are / just landed / next / why it matters).
//   NEVER_STOP_REQUIRE_QUEUE=1 — a work-progressing turn must have a session
//      priority queue at .claude/state/priority-queue.md to work off of.
//
// Suppressed when the user explicitly pauses (handoff / wrap / stop / save
// context) — their words override the keep-going defaults. (asking-permission
// still fires — even on handoff, asking permission is the wrong shape.)
//
// Override everything: NEVER_STOP_OVERRIDE=1. Fail-open on any error.

import { readFileSync, existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

const ASKING_PATTERNS = [
	/\bwant me to\b/i,
	/\bshould i\b/i,
	/\bdo you want (me to)?\b/i,
	/\bwhat('s| is) the call\b/i,
	/\bwhat do you want\b/i,
	/\bor (would you|i could|if you'?d)\b/i,
	/\bif you'?d rather\b/i,
	/\bplease (let me know|confirm|approve)\b/i,
	/\b(let me know|tell me) (if|whether|what)\b/i,
	/\bwaiting (for|on) (your|you)\b/i,
];

const ORIENTATION_PATTERNS = [
	/\bwhere we are\b/i,
	/\bjust landed\b/i,
	/\bnext (move|step|up)\b/i,
	/\bwhy (for|it matters)\b/i,
	/\bcritical path\b/i,
	/\bworkstream\b/i,
	/\bepic\b/i,
	/\b(in-flight|in flight)\b/i,
	/\b(handoff|roadmap)\b/i,
];

const STOP_TELL_PATTERNS = [
	/\bnext session\b/i,
	/\bfuture session\b/i,
	/\bsession (wrap|summary|recap|ending|close)\b/i,
	/\b(stopping|ending)\s+(here|the session|the stretch|the phase)\b/i,
	/\bTL;?DR\b/i,
	/\bwrap (up|things up|the session|this up)\b/i,
	/\bcall (it|this) (a session|a day|done|complete)\b/i,
	/\bsave (it|this) for (next session|later|tomorrow)\b/i,
	/\bdefer (this|that|it) to (the next|a future)\b/i,
];

const NEXT_MOVE_DESCRIPTION_PATTERNS = [
	/\bnext move\b/i,
	/\bnext up\s*:/i,
	/\bnext priority\b/i,
	/(?:^|[\s.,;\-*])\*{0,2}next\*{0,2}\s*:\s*\S/im,
];

const USER_PAUSE_PATTERNS = [
	/\bhandoff\b/i,
	/\bsave context\b/i,
	/\bwrap (up|things up|the session|this up)\b/i,
	/\bend (the )?(session|stretch|phase)\b/i,
	/\bcall (it|this) (a session|a day|done|complete)\b/i,
	/\bi'?m done (for now|here)\b/i,
	/\bstop (working|here|for now)\b/i,
	/\bwrite a resume prompt\b/i,
];

const WORKING_TOOLS = ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'Agent', 'NotebookEdit'];

function transcriptLines(transcriptPath) {
	if (!transcriptPath || !existsSync(transcriptPath)) return [];
	try { return readFileSync(transcriptPath, 'utf8').trim().split('\n'); } catch { return []; }
}

function lastTurnMovedWork(lines) {
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry;
		try { entry = JSON.parse(lines[i]); } catch { continue; }
		if (entry.type !== 'assistant') continue;
		const toolUses = (entry.message?.content || []).filter(b => b && b.type === 'tool_use');
		if (toolUses.length === 0) return false;
		return toolUses.some(t => WORKING_TOOLS.includes(t.name));
	}
	return false;
}

function lastAssistantText(lines) {
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry;
		try { entry = JSON.parse(lines[i]); } catch { continue; }
		if (entry.type !== 'assistant') continue;
		const textBlocks = (entry.message?.content || []).filter(b => b && b.type === 'text');
		if (textBlocks.length > 0) return textBlocks.map(b => b.text).join('\n');
	}
	return '';
}

function lastUserText(lines) {
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry;
		try { entry = JSON.parse(lines[i]); } catch { continue; }
		if (entry.type !== 'user') continue;
		const blocks = entry.message?.content;
		if (typeof blocks === 'string') return blocks;
		if (!Array.isArray(blocks)) continue;
		const textBlocks = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string');
		if (textBlocks.length > 0) return textBlocks.map(b => b.text).join('\n');
	}
	return '';
}

function priorityQueueExists(cwd) {
	return existsSync(pathJoin(cwd, '.claude', 'state', 'priority-queue.md'));
}

async function main() {
	if (process.env.NEVER_STOP_OVERRIDE === '1') { process.exit(0); return; }

	let stdinInput = '';
	for await (const chunk of process.stdin) stdinInput += chunk;
	let payload;
	try { payload = JSON.parse(stdinInput); } catch { payload = {}; }

	const lines = transcriptLines(payload.transcript_path);
	const cwd = payload.cwd || process.cwd();
	const assistantText = lastAssistantText(lines);
	if (!assistantText) { process.exit(0); return; }

	const userSaidPause = USER_PAUSE_PATTERNS.some(p => p.test(lastUserText(lines)));

	const askingMatches = ASKING_PATTERNS.filter(p => p.test(assistantText));
	const stopTellMatches = STOP_TELL_PATTERNS.filter(p => p.test(assistantText));
	const nextMoveDescribed = NEXT_MOVE_DESCRIPTION_PATTERNS.some(p => p.test(assistantText));
	const movedWork = lastTurnMovedWork(lines);
	const hasOrientation = ORIENTATION_PATTERNS.some(p => p.test(assistantText));

	const requireBeat = process.env.NEVER_STOP_REQUIRE_BEAT === '1';
	const requireQueue = process.env.NEVER_STOP_REQUIRE_QUEUE === '1';

	const violations = [];

	if (askingMatches.length > 0) {
		violations.push(`asking-permission: lead with a decision instead of asking. Matched: ${askingMatches.map(p => p.toString()).join(', ')}. Rewrite as "doing X unless you object."`);
	}
	if (stopTellMatches.length > 0 && !userSaidPause) {
		violations.push(`satisfaction-stop (winding-down language): ${stopTellMatches.map(p => p.toString()).join(', ')}. Rewrite as "just landed X, starting Y now" and actually start Y this turn.`);
	}
	if (nextMoveDescribed && !movedWork && !userSaidPause) {
		violations.push('next-move-described-not-started: you named a "next" move but made no working tool call (Bash/Write/Edit/Agent) toward it. Start it now or drop the "next:" framing.');
	}
	if (requireBeat && movedWork && !hasOrientation && !userSaidPause) {
		violations.push('missing-orientation: this turn moved work but did not orient (where we are / just landed / next / why it matters). NEVER_STOP_REQUIRE_BEAT is on.');
	}
	if (requireQueue && movedWork && !priorityQueueExists(cwd) && !userSaidPause) {
		violations.push(`no-priority-queue: NEVER_STOP_REQUIRE_QUEUE is on but ${cwd}/.claude/state/priority-queue.md is missing. Build a prioritized queue and work off it.`);
	}

	if (violations.length === 0) { process.exit(0); return; }

	const reason = [
		`STOP-BLOCKED — ${violations.length} bias-to-action rule(s) violated:`,
		'',
		...violations.map(v => `  • ${v}`),
		'',
		'The principle (the "Ross Perot" rule): lead, decide, ship. Don\'t wait for',
		'permission on reversible work, and don\'t wind down while there\'s obvious work',
		'left. If the next step genuinely needs the user (irreversible / costs money /',
		'their credentials) — SKIP it and do the next thing, or say so plainly.',
		'',
		'Override: NEVER_STOP_OVERRIDE=1.',
	].join('\n');

	process.stdout.write(JSON.stringify({ decision: 'block', reason }));
	process.exit(0);
}

main().catch(() => process.exit(0));
