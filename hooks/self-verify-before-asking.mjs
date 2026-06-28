#!/usr/bin/env node
/**
 * self-verify-before-asking — Stop hook, HARD TEETH (decision:'block'): you tested it, or you say WHY you
 * genuinely can't — you never hand Russell the testing you could have done yourself.
 *
 * Russell's rule (2026-06-28): "there should be a hook that forces you to always test yourself rather than ask
 * me to test unless you genuinely can't. should be a hard hook." Claude has a habit of building something and
 * closing with "can you test this and let me know if it works?" — pushing the verification onto Russell when a
 * CLI run / unit test / smoke run was right there. This blocks that turn.
 *
 * Fires only in BUILDER MODE (this turn wrote/edited code or ran a build/commit) — asking someone to test is
 * only a dodge when you just made something testable. Blocks when the final reply ASKS RUSSELL TO TEST/VERIFY
 * (ask-shape × test-action, matched combinatorially so paraphrases trip it) and does NOT name a genuine
 * can't-self-test reason.
 *
 * Sibling, NOT a duplicate, of: no-premature-defer (hands back a PAID run), look-before-asking (asks for a
 * DISCOVERABLE fact), visual-proof-required / e2e-or-its-theatre (force an ARTIFACT). This one catches the
 * plain-prose "you test it for me" hand-off at Stop, which none of those see.
 *
 * Escape (a check only Russell's environment can run): name it — live/real Chrome or extension, "on your
 * machine / in your browser", mic/audio/speaker/camera, hardware, physical device, MFA, "needs your eyes" /
 * visual judgement — or the token `self-verify-override: <why>` / `cant-self-verify: <why>`. Fail-open.
 */

import { fileURLToPath } from 'node:url';
import { readTranscript, currentTurnEntries, toolUsesOf, roleOf, lastAssistantText, lastUserText } from './lib/transcript.mjs';

// Strip inline/code-fenced spans so QUOTING a trigger (e.g. explaining this hook) doesn't false-fire.
function stripCodeSpans(textBody) {
  return String(textBody || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

// ── ask-shape × verify-action (combinatorial; a paraphrase still trips it) ────
const ASK_SHAPE = /\b(can|could|would|will)\s+you\b|\bplease\b|\byou(?:'|’)?ll\s+(?:need|want|have)\s+to\b|\byou\s+(?:should|can|could|might\s+want\s+to)\b|\b(?:go\s+ahead\s+and|feel\s+free\s+to)\b|\blet\s+me\s+know\b|\b(?:tell|lmk)\b|\bmind\s+(?:testing|checking|verifying|running)\b|\bif\s+you\s+(?:can|could)\b/i;
const VERIFY_ACTION = /\btest(?:ing|s|ed)?\b|\bverif(?:y|ies|ied|ication)\b|\bconfirm(?:s|ed|ing)?\b|\bcheck(?:s|ed|ing)?\b|\btry\s+(?:it|this|that|running|reloading)\b|\brun\s+(?:it|the|this|that|npm|yarn|the\s+tests?)\b|\bsee\s+if\s+it\s+works\b|\bmake\s+sure\s+it\s+works\b|\b(?:whether|if)\s+it\s+works\b/i;

// High-confidence standalone hand-offs (the exact shapes Claude reaches for).
const DIRECT_HANDOFF = [
  /\blet\s+me\s+know\s+if\s+(?:it|this|that|everything)\s+works\b/i,
  /\b(?:tell|lmk)\s+(?:me\s+)?if\s+(?:it|this|that)\s+works\b/i,
  /\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:test|verify|confirm|check|try|run)\b/i,
  /\byou(?:'|’)?ll\s+(?:need|want|have)\s+to\s+(?:test|verify|confirm|check|run)\b/i,
  /\bplease\s+(?:test|verify|confirm|check|run\s+the\s+tests?)\b/i,
  /\b(?:go\s+ahead\s+and|feel\s+free\s+to)\s+(?:test|verify|try|run)\b/i,
];

// Genuine can't-self-verify reasons — Russell's environment, hardware, or human judgement is the only way.
const CANT_SELF_VERIFY = /\b(?:on|in)\s+your\s+(?:machine|browser|chrome|device|end|setup)\b|\blive\s+(?:chrome|extension|browser|reload|mic)\b|\breal\s+(?:chrome|extension|device|hardware|browser)\b|\byour\s+eyes\b|\bvisual(?:ly)?\b|\bmic(?:rophone)?\b|\bspeakers?\b|\baudio\b|\bcamera\b|\bwebcam\b|\bheadphones?\b|\bhardware\b|\bphysical\b|\bMFA\b|\b2fa\b|\bhardware\s+key\b|\bneeds?\s+(?:a\s+)?(?:human|you|your)\b|\bonly\s+you\s+can\b|\bi\s+can(?:'|’)?t\s+(?:see|hear|access|reach)\b/i;

const OVERRIDE = /\b(?:self-verify-override|cant-self-verify|self-verify-skip)\s*:/i;
const USER_PAUSE = /\b(handoff|wrap\s*up|stop(?:\s+(?:here|for\s+now))?|that'?s\s+enough|done\s+for\s+now|i'?ll\s+(?:test|take\s+it)|leave\s+it)\b/i;

// Builder mode = this turn made something testable: a code edit, or a build/commit/install command.
const BUILD_COMMAND = /\b(npm|pnpm|yarn|vite|tsc|webpack|rollup|esbuild)\b.*\bbuild\b|\bgit\s+commit\b|\b(npm|pnpm|yarn)\s+(i|install|ci)\b/i;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function turnIsBuilderMode(turnEntries) {
  for (const entry of turnEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const toolUse of toolUsesOf(entry)) {
      if (EDIT_TOOLS.has(toolUse.name || '')) return true;
      if ((toolUse.name === 'Bash' || toolUse.name === 'PowerShell') && BUILD_COMMAND.test(JSON.stringify(toolUse.input || ''))) return true;
    }
  }
  return false;
}

// Pure verdict so the rule is unit-testable.
export function asksRussellToVerify(reply) {
  const cleaned = stripCodeSpans(reply);
  if (!cleaned.trim()) return false;
  if (OVERRIDE.test(cleaned)) return false;
  if (CANT_SELF_VERIFY.test(cleaned)) return false;
  if (DIRECT_HANDOFF.some((pattern) => pattern.test(cleaned))) return true;
  // Generic: an ask-shape and a verify-action in the same sentence-ish window.
  return ASK_SHAPE.test(cleaned) && VERIFY_ACTION.test(cleaned)
    && /(?:can|could|would|will|please|let\s+me\s+know|tell|you(?:'|’)?ll|go\s+ahead|feel\s+free|if\s+you)[^.!?]{0,60}?(?:test|verif|confirm|check|try|run|works)/i.test(cleaned);
}

export function shouldBlock({ reply, builderMode, userPaused }) {
  if (userPaused) return false;
  if (!builderMode) return false;
  return asksRussellToVerify(reply);
}

const REASON = [
  'STOP-BLOCKED — you built something this turn and asked Russell to TEST it instead of verifying it yourself.',
  '',
  "Russell's rule (2026-06-28): always test yourself rather than ask Russell to test, unless you GENUINELY can't.",
  'A CLI run, a unit test, a smoke run, or a build was right there. Do it, then report the real result.',
  '',
  'Before stopping, DO ONE:',
  '  1. Actually run the verification (node test, npm test, a CLI/smoke run, a real screenshot) and report what happened.',
  "  2. If it genuinely needs Russell's environment — live/real Chrome or extension, his machine/browser, mic/audio/",
  '     camera, hardware, a physical device, MFA, or human visual judgement — SAY that specifically (that lifts the block).',
  '  3. Override token for a misjudged case:  self-verify-override: <why this is not self-verifiable>',
].join('\n');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }
  if (payload.stop_hook_active) return;

  const turnEntries = currentTurnEntries(readTranscript(payload.transcript_path));
  if (turnEntries.length === 0) return;

  const verdict = shouldBlock({
    reply: lastAssistantText(turnEntries),
    builderMode: turnIsBuilderMode(turnEntries),
    userPaused: USER_PAUSE.test(lastUserText(turnEntries)),
  });
  if (!verdict) return;

  process.stdout.write(JSON.stringify({ decision: 'block', reason: REASON }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => process.exit(0));
