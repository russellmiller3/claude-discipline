#!/usr/bin/env node
// recommend-when-listing — Stop hook. When the last message lists alternatives
// but doesn't lead with a recommendation, block. A menu of equal options pushes
// the decision back onto the user; rank them and commit to one (they can always
// override). The sibling of never-stop-asking: that one catches "want me to…",
// this one catches the subtler "here are three options" with no opinion.
//
// Blocks when BOTH hold:
//   1. The message lists alternatives (Option A/B, "either X or Y", "your call",
//      "two/three approaches", etc.), AND
//   2. It contains NO recommendation verb ("I recommend", "I'd go with",
//      "going with X", "doing X unless", "the right call is", …).
//
// Suppressed when the user explicitly asked for survey/think mode ("just
// thinking", "what do you think", "research mode", "feedback only").
// Override: RECOMMEND_WHEN_LISTING_OVERRIDE=1. Fail-open on error.

import { readFileSync, existsSync } from 'node:fs';

const ALTERNATIVE_PATTERNS = [
	/\boption\s+[a-d1-4]\b/i,
	/\beither\s+\S+.{0,40}\s+or\s+\S+/i,
	/\b(your call|you decide|up to you|leave it to you|whichever you prefer)\b/i,
	/\b(two|three|four|a few|several)\s+(option|approach|path|way|route|strateg|choice)s?\b/i,
];

const RECOMMENDATION_PATTERNS = [
	/\bi\s+recommend\b/i,
	/\bi'?d\s+(go|do|pick|choose|recommend|opt|lean)\b/i,
	/\b(my\s+)?(call|pick|choice|recommendation|vote)\s*[:—-]/i,
	/\bgoing\s+with\s+\S/i,
	/\bdoing\s+\S+\s+unless/i,
	/\b\S+\s+wins\b/i,
	/\bthe\s+right\s+(call|move|answer|pick|choice)\s+is\b/i,
	/\bthe\s+winner\s+is\b/i,
	/\bshipping\s+\S+\s+(unless|now|next)/i,
	/\b\S+\s+is\s+the\s+way\s+to\s+go\b/i,
	/\bdefault\s+to\s+\S/i,
	/\bunless\s+you\s+(say|object|prefer|redirect|push back)/i,
	/\bi'?ll\s+(go|do|pick|choose|ship|use|take)\s+\S/i,
];

const SURVEY_MODE_PATTERNS = [
	/\bjust\s+(think|thinking|describe|describing|exploring|brainstorm)/i,
	/\b(research|survey|brainstorm|explore)\s+mode\b/i,
	/\b(don'?t|do not)\s+(take|do)\s+action\b/i,
	/\bfeedback\s+only\b/i,
	/\bjust\s+laying\s+out\b/i,
	/\bwhat\s+(do you think|are the options)\b/i,
];

function lastTextOf(transcriptPath, role) {
	if (!transcriptPath || !existsSync(transcriptPath)) return '';
	let content;
	try { content = readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
	const lines = content.trim().split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry;
		try { entry = JSON.parse(lines[i]); } catch { continue; }
		if (entry.type !== role) continue;
		const blocks = entry.message?.content;
		if (typeof blocks === 'string') return blocks;
		if (!Array.isArray(blocks)) continue;
		const joined = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
		if (joined) return joined;
	}
	return '';
}

async function main() {
	if (process.env.RECOMMEND_WHEN_LISTING_OVERRIDE === '1') { process.exit(0); return; }

	let stdinInput = '';
	for await (const chunk of process.stdin) stdinInput += chunk;
	let payload;
	try { payload = JSON.parse(stdinInput); } catch { payload = {}; }

	const assistantText = lastTextOf(payload.transcript_path, 'assistant');
	if (!assistantText) { process.exit(0); return; }

	if (SURVEY_MODE_PATTERNS.some(p => p.test(lastTextOf(payload.transcript_path, 'user')))) { process.exit(0); return; }

	const alternativeMatches = ALTERNATIVE_PATTERNS.filter(p => p.test(assistantText)).map(p => p.toString());
	if (alternativeMatches.length === 0) { process.exit(0); return; }
	if (RECOMMENDATION_PATTERNS.some(p => p.test(assistantText))) { process.exit(0); return; }

	const reason = `STOP-BLOCKED — alternatives listed without a recommendation.

Your last message listed multiple options (matched: ${alternativeMatches.join(', ')}) but contained
no recommendation verb. A menu of equal options pushes the decision back onto the user.

Rewrite shapes that pass:
  • "Options: A / B / C. Going with B because [reason]. Override by saying X."
  • "Three paths. I recommend the middle one — A and C have these costs."
  • "I'd default to B unless you object, because [reason]."

If the user explicitly asked for a survey ("just thinking", "what do you think",
"feedback only"), this hook stays quiet. Override: RECOMMEND_WHEN_LISTING_OVERRIDE=1.`;

	process.stdout.write(JSON.stringify({ decision: 'block', reason }));
	process.exit(0);
}

main().catch(() => process.exit(0));
