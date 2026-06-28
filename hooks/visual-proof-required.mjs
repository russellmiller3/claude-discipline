#!/usr/bin/env node
/**
 * visual-proof-required — ONE Stop gate with TEETH for "a visual change/claim needs a REAL screenshot."
 *
 * Consolidates three near-duplicate hooks (2026-06-28, Russell: "can these be consolidated"):
 *   • verify-change-with-screenshot — edited a UI surface → must screenshot the running app
 *   • ux-screenshot-required        — claimed a UX/browser bug fixed → must screenshot
 *   • pixels-only-proof             — claimed a visual thing renders, citing DOM evidence → must screenshot
 * (Left separate, different proof modality: echo-fix-needs-live-verify = audio; owed-live-gate-reminder = nag ledger.)
 *
 * Fixes the two gaps that let it miss the claude-voice widget this session:
 *   GAP 1 — .html blind spot: the teeth-hook only matched .svelte/.css, but the whole widget UI is widget.html.
 *           Now the UI pattern is the UNION (.svelte/.css/.scss/.html/.vue/.tsx/.jsx + component/route/e2e paths).
 *   GAP 2 — "tool fired ≠ image produced": a preview_screenshot that was INVOKED but TIMED OUT used to satisfy
 *           the gate. Now proof requires a REAL captured image — an image in a tool RESULT, a Read of a .png, a
 *           SendUserFile image, or a harness result printing a .png path. A screenshot tool that returned an
 *           error/timeout (no image) does NOT count.
 *
 * THE TRIGGER — BLOCK on Stop iff, IN THIS TURN, NOT overridden, NO real screenshot, AND any of:
 *   (A) edited a UI surface (union pattern above); OR
 *   (B) claimed a visual element renders/shows/is-fixed while citing DOM-level evidence (toBeVisible / innerText /
 *       boundingBox / querySelector / .toContain / "in the DOM") with no disclaimer; OR
 *   (C) uttered the heresy that DOM/innerText is proof, or pixels don't matter (blocks regardless of screenshot).
 *
 * Override: put  visual-proof-skip: <why>  (or the legacy  verify-change-skip: )  in the final reply — for a
 * genuinely non-visual change (a CSS var rename, a comment, a test-only edit) or a surface that can't render
 * headlessly. Fail open on any error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UI_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SKIP_RE = /(?:visual-proof-skip|verify-change-skip)\s*:/i;

// A visual surface whose look a screenshot (not a unit test) must confirm — the UNION of the old triggers.
const UI_FILE_RE = /(\.svelte|\.css|\.scss|\.html|\.vue|\.tsx|\.jsx)$|playwright\.config\.js$|(?:tests[\\/]+e2e[\\/])|(?:components[\\/])|(?:routes[\\/])/i;
export function isUiFile(filePath) {
  return UI_FILE_RE.test(String(filePath || ''));
}

// Claim-side triggers (lifted from pixels-only-proof) — a visual-success claim leaning on DOM "proof".
const HERESY_PATTERNS = [
  /dom\s*(text|content|presence)[^.\n]{0,40}(stronger|better|more reliable|beats?)[^.\n]{0,20}pixel/i,
  /(stronger|better|more reliable)\s+proof\s+than\s+pixels/i,
  /pixels?\s+(don'?t|do not|aren'?t)\s+(matter|count|needed)/i,
  /innerText[^.\n]{0,40}(is|=)[^.\n]{0,20}(proof|stronger|enough|conclusive)/i,
];
const VISUAL_SUCCESS_PATTERNS = [
  /\b(renders?|rendering)\b[^.\n]{0,40}\b(now|correctly|fine|fully|properly)\b/i,
  /\b(now|does)\b[^.\n]{0,30}\b(renders?|shows?|displays?|appears?|visible)\b/i,
  /\b(forecast|table|chart|card|banner|panel|button|element|component|widget|orb|meter|pill)\b[^.\n]{0,40}\b(renders?|shows?|displays?|visible|appears?)\b/i,
  /\b(fixed|resolved|verified|confirmed|proven|proof)\b[^.\n]{0,40}\b(renders?|shows?|displays?|visible|visual|UI|on[- ]screen)\b/i,
  /\bit('?s| is)\s+(rendering|showing|visible|there|fixed)\b/i,
];
const DOM_EVIDENCE_PATTERNS = [
  /\btoBeVisible\b/i, /\binnerText\b/i, /\btextContent\b/i, /\bboundingBox\b/i,
  /\bquerySelector\b/i, /\bin the DOM\b/i, /\bDOM (has|contains|shows|element)\b/i, /\.toContain\b/i,
];
const DISCLAIMER_PATTERNS = [
  /\b(haven'?t|not|could ?n'?t|can'?t)\s+(visually )?(verif|confirm|proven|seen|view|captured?|screenshot)/i,
  /\bneeds? (a )?(pixel )?screenshot\b/i, /\bnot (visual )?proof\b/i, /\bpixels? are the only proof\b/i,
];
const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif)\b/i;

// Did this turn produce a REAL screenshot — an actual captured image, not just a screenshot tool that fired?
// (GAP 2 fix: a tool_use of preview_screenshot is NOT enough; its RESULT must carry an image, OR we must see a
//  .png read/sent/printed.)
export function realScreenshotThisTurn(turnEntries) {
  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      // (1) a tool result that actually carried an image back
      if (block.type === 'tool_result' && resultHasImage(block)) return true;
      // (2) a tool result whose text printed a screenshot .png path (a live harness reporting where it wrote it)
      if (block.type === 'tool_result') {
        const resultText = toolResultText(block);
        if (resultText && IMAGE_FILE_RE.test(resultText) && /screenshot|shot|\.png/i.test(resultText)) return true;
      }
      // (3) the agent Read a .png (looked at it) or SendUserFile'd an image
      if (block.type === 'tool_use') {
        const toolInput = block.input || {};
        if (block.name === 'Read' && IMAGE_FILE_RE.test(toolInput.file_path || toolInput.path || '')) return true;
        if (block.name === 'SendUserFile' && IMAGE_FILE_RE.test(JSON.stringify(toolInput.files || ''))) return true;
      }
    }
  }
  return false;
}

// An image actually came back inside a tool_result's content (the gold signal of a successful capture).
function resultHasImage(block) {
  const inner = block.content;
  if (Array.isArray(inner)) return inner.some((part) => part && part.type === 'image');
  return false;
}

// Pure verdict (exported for the test).
export function shouldBlock({ editedUi, domAsProof, heresy, realScreenshot, overridden }) {
  if (overridden) return false;
  if (heresy) return true;                                  // a wrong claim — a screenshot doesn't redeem it
  if (realScreenshot) return false;                         // visual change/claim is backed by a real image
  return Boolean(editedUi) || Boolean(domAsProof);
}

import {
  readTranscript, roleOf, contentBlocks, toolResultText, isHumanPrompt, currentTurnEntries, lastAssistantText,
} from './lib/transcript.mjs';

function onStop(hookEvent) {
  const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
  if (turnEntries.length === 0) return;

  let overridden = false;
  const editedUiFiles = new Set();
  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text' && SKIP_RE.test(block.text || '')) overridden = true;
      if (block.type !== 'tool_use' || !UI_EDIT_TOOLS.has(block.name || '')) continue;
      const filePath = (block.input || {}).file_path || (block.input || {}).path || '';
      if (isUiFile(filePath)) editedUiFiles.add(filePath);
    }
  }

  const assistantText = lastAssistantText(turnEntries);
  const heresy = HERESY_PATTERNS.some((re) => re.test(assistantText));
  const domAsProof = VISUAL_SUCCESS_PATTERNS.some((re) => re.test(assistantText))
    && DOM_EVIDENCE_PATTERNS.some((re) => re.test(assistantText))
    && !DISCLAIMER_PATTERNS.some((re) => re.test(assistantText));

  if (!shouldBlock({
    editedUi: editedUiFiles.size > 0,
    domAsProof, heresy,
    realScreenshot: realScreenshotThisTurn(turnEntries),
    overridden,
  })) return;

  const fileLines = [...editedUiFiles].map((filePath) => `  • ${filePath.replace(/\\/g, '/').split('/').pop()}`).join('\n');
  const reason = heresy ? [
    'STOP-BLOCKED — Pixels Are the ONLY Proof for Visual Bugs.',
    'Your message implied DOM/innerText is proof, or that pixels don\'t matter. DELETE that claim — the user sees PIXELS, not the DOM.',
  ].join('\n') : [
    'VERIFY THE CHANGE WITH A REAL SCREENSHOT — you changed/claimed a visual surface this turn but never VIEWED a captured image of the running app.',
    'Green unit tests and DOM assertions are NOT visual proof (Russell: "DOM / innerText / toBeVisible are NEVER visual proof").',
    editedUiFiles.size > 0 ? '\nChanged visual file(s):\n' + fileLines : '',
    '',
    'A screenshot tool that merely FIRED (or timed out) does NOT count — the proof is an actual image:',
    '  • preview_screenshot that RETURNS an image, then Read the .png and LOOK at it, or',
    '  • a live harness (test/live/*Shot.mjs / page.screenshot) that writes a .png you view.',
    'Confirm the exact element is VISIBLY present where the user expects it.',
    '',
    'Override (genuinely non-visual — a var rename, a comment, a test-only edit, or a surface that can\'t render',
    'headlessly): put  visual-proof-skip: <why>  in your final reply.',
  ].filter(Boolean).join('\n');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if (hookEvent.stop_hook_active) { process.exit(0); }
  const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
  if (eventName === 'Stop') onStop(hookEvent);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url).split(/[\\/]/).pop() === process.argv[1].split(/[\\/]/).pop()) main();
