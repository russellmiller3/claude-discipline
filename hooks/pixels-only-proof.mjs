#!/usr/bin/env node
// pixels-only-proof — Stop hook. For a visual / "not showing" / "looks wrong"
// bug, the ONLY proof it's fixed is a screenshot you actually LOOKED at, in
// which the element is visibly present where the user expects it.
//
// Why this exists: an element can be in the DOM, return innerText, pass
// toBeVisible(), and report a non-zero boundingBox() — and STILL be clipped to
// 0 height, off-screen, transparent, or behind another layer. The user sees
// PIXELS, not the DOM. "The assertion passed" is not the same as "I can see it."
//
// Blocks Stop when the last assistant message either:
//   (A) asserts DOM evidence is proof / pixels don't matter (the inversion), or
//   (B) claims a visual thing renders/shows/is-fixed while citing DOM-level
//       evidence (toBeVisible / innerText / boundingBox / querySelector /
//       "in the DOM" / .toContain) AND this turn did NOT view a screenshot
//       (a Read of a .png/.jpg, or a screenshot tool call).
//
// Conservative: only fires on a visual-SUCCESS claim, so ordinary turns pass.
// Override: PIXELS_PROOF_OVERRIDE=1, or include "not visually verified" /
// "pixels are the only proof" in the message (an honest disclaimer clears it).

import { readFileSync, existsSync } from 'node:fs';

const HERESY_PATTERNS = [
	/dom\s*(text|content|presence)[^.\n]{0,40}(stronger|better|more reliable|beats?)[^.\n]{0,20}pixel/i,
	/(stronger|better|more reliable)\s+proof\s+than\s+pixels/i,
	/pixels?\s+(don'?t|do not|aren'?t)\s+(matter|count|needed)/i,
	/innerText[^.\n]{0,40}(is|=)[^.\n]{0,20}(proof|stronger|enough|conclusive)/i,
];

const VISUAL_SUCCESS_PATTERNS = [
	/\b(renders?|rendering)\b[^.\n]{0,40}\b(now|correctly|fine|fully|properly)\b/i,
	/\b(now|does)\b[^.\n]{0,30}\b(renders?|shows?|displays?|appears?|visible)\b/i,
	/\b(table|chart|card|banner|panel|button|modal|menu|icon|element|component|layout)\b[^.\n]{0,40}\b(renders?|shows?|displays?|visible|appears?)\b/i,
	/\b(fixed|resolved|verified|confirmed|proven|proof)\b[^.\n]{0,40}\b(renders?|shows?|displays?|visible|visual|UI|on[- ]screen)\b/i,
	/\bit('?s| is)\s+(rendering|showing|visible|there|fixed)\b/i,
];

const DOM_EVIDENCE_PATTERNS = [
	/\btoBeVisible\b/i,
	/\binnerText\b/i,
	/\btextContent\b/i,
	/\bboundingBox\b/i,
	/\bquerySelector\b/i,
	/\bin the DOM\b/i,
	/\bDOM (has|contains|shows|element)\b/i,
	/\.toContain\b/i,
	/\bassertion passed\b/i,
];

const DISCLAIMER_PATTERNS = [
	/\b(haven'?t|not|could ?n'?t|can'?t)\s+(visually )?(verif|confirm|proven|seen|view|captured?|screenshot)/i,
	/\bneeds? (a )?(pixel )?screenshot\b/i,
	/\bnot (visual )?proof\b/i,
	/\bpixels? are the only proof\b/i,
];

function readTranscriptLines(transcriptPath) {
	if (!transcriptPath || !existsSync(transcriptPath)) return [];
	let fileBody;
	try { fileBody = readFileSync(transcriptPath, 'utf8'); } catch { return []; }
	return fileBody.trim().split('\n');
}

function lastAssistantText(transcriptLines) {
	for (let i = transcriptLines.length - 1; i >= 0; i--) {
		let entry;
		try { entry = JSON.parse(transcriptLines[i]); } catch { continue; }
		if (entry.type !== 'assistant') continue;
		const blocks = entry.message?.content || [];
		const textBlocks = blocks.filter(b => b && b.type === 'text');
		if (textBlocks.length > 0) return textBlocks.map(b => b.text).join('\n');
	}
	return '';
}

// Did the most recent assistant turn VIEW a screenshot? (Read of an image file,
// or an image-returning screenshot tool.)
function lastTurnViewedScreenshot(transcriptLines) {
	for (let i = transcriptLines.length - 1; i >= 0; i--) {
		let entry;
		try { entry = JSON.parse(transcriptLines[i]); } catch { continue; }
		if (entry.type !== 'assistant') continue;
		const toolUses = (entry.message?.content || []).filter(b => b && b.type === 'tool_use');
		if (toolUses.length === 0) return false;
		return toolUses.some(toolCall => {
			const toolName = toolCall.name || '';
			const filePath = (toolCall.input && (toolCall.input.file_path || toolCall.input.path)) || '';
			if (/screenshot/i.test(toolName)) return true;
			return /\.(png|jpg|jpeg|webp|gif)$/i.test(filePath);
		});
	}
	return false;
}

function main() {
	if (process.env.PIXELS_PROOF_OVERRIDE === '1') { process.exit(0); return; }

	let payload;
	try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { payload = {}; }
	const transcriptLines = readTranscriptLines(payload.transcript_path);
	const assistantText = lastAssistantText(transcriptLines);
	if (!assistantText) { process.exit(0); return; }

	const hasHeresy = HERESY_PATTERNS.some(re => re.test(assistantText));
	const claimsVisualSuccess = VISUAL_SUCCESS_PATTERNS.some(re => re.test(assistantText));
	const citesDomEvidence = DOM_EVIDENCE_PATTERNS.some(re => re.test(assistantText));
	const hasDisclaimer = DISCLAIMER_PATTERNS.some(re => re.test(assistantText));
	const viewedShot = lastTurnViewedScreenshot(transcriptLines);

	let violation = null;
	if (hasHeresy) violation = 'heresy';
	else if (claimsVisualSuccess && citesDomEvidence && !hasDisclaimer && !viewedShot) violation = 'dom-as-proof';

	if (!violation) { process.exit(0); return; }

	const reason = [
		'STOP-BLOCKED — Pixels Are the ONLY Proof for Visual Bugs.',
		'',
		violation === 'heresy'
			? 'Your message implied DOM/innerText is proof, or that pixels don\'t matter. That is the exact inversion — DELETE that claim.'
			: 'Your message claims a visual element renders/shows/is-fixed, but the proof cited is DOM-level (toBeVisible / innerText / boundingBox / .toContain / "in the DOM") and this turn did NOT view a screenshot.',
		'',
		'NEVER visual proof: DOM presence, innerText/textContent, querySelector, toBeVisible(),',
		'boundingBox(), .toContain(), "assertion passed". An element can satisfy ALL of them and',
		'still be clipped to 0 height, off-screen, transparent, or behind another layer.',
		'The user sees PIXELS, not the DOM.',
		'',
		'To proceed:',
		'  1. Screenshot the actual rendered flow.',
		'  2. READ the .png with the Read tool and LOOK at it.',
		'  3. Confirm the exact element is VISIBLY present where the user expects it.',
		'  4. If the screenshot cannot frame it, that is a RED FLAG it is clipped/hidden —',
		'     chase the CSS (overflow:hidden / height:0 / flex collapse / z-index). Do NOT hand-wave.',
		'',
		'If you cannot capture it, SAY SO ("not visually verified") — never imply it is fixed.',
		'Override: PIXELS_PROOF_OVERRIDE=1',
	].join('\n');

	process.stdout.write(JSON.stringify({ decision: 'block', reason }));
	process.exit(0);
}

main();
