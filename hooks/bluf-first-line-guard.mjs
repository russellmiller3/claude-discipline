#!/usr/bin/env node
/**
 * new-hook-category: reply-shape — nearest existing hook is wall-text-guard.mjs; it doesn't cover
 * this because it caps reply SIZE (paragraph count and paragraph length), while this checks WHERE
 * the answer sits. A reply can be one short paragraph, pass wall-text-guard cleanly, and still
 * bury the answer in the last sentence. Size and answer-position are distinct invariants with
 * distinct remedies, so this is a sibling in the same family, not a duplicate.
 *
 * bluf-first-line-guard — Stop hook. When Russell asked a DIRECT QUESTION, the reply's first line
 * must be the answer.
 *
 * Why this exists (Getty rule, approved by Russell 2026-07-26): Russell asked "what changes did you
 * make, high level? is anything left? or should we do rye next or try zinc again?" and got a reply
 * that opened with a status table. He came back with "sorry didnt follow." Across that one session
 * the wall-of-text hooks fired FIVE times — they caught the length every time, and the answer still
 * wasn't in the first line, because length and ordering are different failures.
 *
 * CLAUDE.md already mandates it (Voice & Format): "BLUF — FIRST LINE IS THE ANSWER (≤15 words).
 * Lead with the decision/verdict. Never make Russell read to find the answer." This makes it
 * mechanical.
 *
 * Deliberately NARROW — it only fires when all of these hold:
 *   1. Russell's message contained a direct question (a "?" or a leading interrogative/choice word).
 *   2. The reply's first non-trivial line is NOT a plausible answer: it is too long (>25 words), or
 *      it is a heading/table/bullet/code line, or it is throat-clearing ("Let me...", "I'll...").
 * A compass line (🧭) is skipped, since another hook requires it to lead.
 *
 * Fails open (exit 0, silent) on anything malformed — this hook must never be the reason all work
 * halts. Anti-loop rail: never blocks twice on the same turn (stop_hook_active).
 */

import { readTranscript, roleOf, contentBlocks, currentTurnEntries, lastUserText } from './lib/transcript.mjs';
import { fileURLToPath } from 'node:url';

/** CLAUDE.md says ≤15 words. Allow headroom so only genuinely un-answer-like openers trip. */
const MAX_FIRST_LINE_WORDS = 25;

/** Russell asked something that wants an answer, not a status report. */
const DIRECT_QUESTION = /\?/;
const INTERROGATIVE_OPENER = /^\s*(?:what|which|who|when|where|why|how|is|are|was|were|do|does|did|can|could|should|would|will|shall|any|anything|got|have|has)\b/i;
/** "X or Y" / "A vs B" — a choice being put to us even without a question mark. */
const CHOICE_SHAPED = /\b(?:or should|should we|or do we|or try|versus|\bvs\.?\b|which one|either)\b/i;

/** Lines that cannot themselves be an answer. */
const STRUCTURAL_LINE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```|>|\s*$)/;
/** Announcing rather than answering. */
const THROAT_CLEARING = /^\s*(?:ok(?:ay)?\b|so\b|alright\b|sure\b|got it\b|let me\b|i'?ll\b|i'?m going to\b|i'?m about to\b|first,?\b|starting\b|checking\b|looking\b|here'?s (?:what|the)\b|quick )/i;
/** The compass line is required to lead by another hook — never judge it as the answer. */
const COMPASS_LINE = /^\s*(?:🧭|\*\*?Northstar)/;

/** The final assistant text message in the turn — what Russell actually reads. */
function finalReplyText(turnEntries) {
  for (let index = turnEntries.length - 1; index >= 0; index--) {
    if (roleOf(turnEntries[index]) !== 'assistant') continue;
    const textBlocks = contentBlocks(turnEntries[index]).filter(
      (block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim()
    );
    if (textBlocks.length) return textBlocks.map((block) => block.text).join('\n');
  }
  return '';
}

export function askedDirectQuestion(userMessage) {
  const asked = String(userMessage ?? '').trim();
  if (!asked) return false;
  if (DIRECT_QUESTION.test(asked)) return true;
  if (CHOICE_SHAPED.test(asked)) return true;
  return INTERROGATIVE_OPENER.test(asked);
}

/** The first line that could plausibly carry the answer (compass line skipped). */
export function answerBearingLine(reply) {
  const lines = String(reply ?? '').split(/\r?\n/u);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (COMPASS_LINE.test(line)) continue;
    return line;
  }
  return '';
}

function wordCount(line) {
  return line.trim().split(/\s+/u).filter(Boolean).length;
}

/** Strip markdown emphasis so bolded answers are judged on their words, not their asterisks. */
function plainText(line) {
  return line.replace(/[*_`]+/gu, '').trim();
}

export function analyzeFirstLine(reply) {
  const line = answerBearingLine(reply);
  if (!line) return { verdict: 'no-text', line: '' };
  if (STRUCTURAL_LINE.test(line)) return { verdict: 'structural', line };
  const bare = plainText(line);
  if (THROAT_CLEARING.test(bare)) return { verdict: 'throat-clearing', line: bare };
  const words = wordCount(bare);
  if (words > MAX_FIRST_LINE_WORDS) return { verdict: 'too-long', line: bare, words };
  return { verdict: 'ok', line: bare, words };
}

/** Detector for the shared style registry (hooks/lib/style-checkers.mjs).
 *
 *  This rule does NOT block on its own. A sibling session built `style-governor.mjs` on the same
 *  day this hook was written, for a defect this hook would otherwise have made worse: four style
 *  hooks blocked SEQUENTIALLY on one turn, so Russell read four stacked rewrites of the same reply.
 *  Registering a fifth independent Stop block would recreate exactly that. So the rule ships as a
 *  detector and joins the ONE combined verdict. */
export function blufViolations({ entries = [], turnEntries = [], reply = '' } = {}) {
  if (!turnEntries.length || !reply) return [];

  const userMessage = lastUserText(entries);
  if (!askedDirectQuestion(userMessage)) return [];

  const analysis = analyzeFirstLine(reply);
  if (analysis.verdict === 'ok') return [];

  const measure = {
    structural: 'first line is a heading, bullet, table row, or code fence',
    'throat-clearing': 'first line announces what you will do instead of answering',
    'too-long': `first line runs ${analysis.words} words (cap ${MAX_FIRST_LINE_WORDS})`,
    'no-text': 'no answer-bearing line at all'
  }[analysis.verdict] ?? 'first line is not the answer';

  return [{
    kind: 'the answer is not in the first line (Russell asked a direct question)',
    measure,
    quote: analysis.line.slice(0, 160),
    guidance: 'Put the ANSWER on the first line after any compass line — name the option, or start '
      + 'with YES/NO, then one line of why. Keep the table and bullets; just move the answer above them.'
  }];
}

function blockReason(analysis, userMessage) {
  const why = {
    structural: 'it opens with a heading, bullet, table row, or code fence — a structural line cannot be an answer',
    'throat-clearing': 'it opens by announcing what you are about to do instead of answering',
    'too-long': `its first line runs ${analysis.words} words (cap ${MAX_FIRST_LINE_WORDS}) — the answer is buried inside it`,
    'no-text': 'it has no answer-bearing line at all'
  }[analysis.verdict] ?? 'its first line is not the answer';

  return `STOP — BLUF violation. Russell asked a direct question and your first line is not the answer.

He asked:
  "${String(userMessage ?? '').trim().slice(0, 200)}"

Your reply fails because ${why}:
  "${analysis.line.slice(0, 160)}"

Russell's rule (CLAUDE.md Voice & Format):
  "BLUF — FIRST LINE IS THE ANSWER (≤15 words). Lead with the decision/verdict.
   Reasoning + detail go BELOW, skippable. Never make Russell read to find the answer."
  "Yes/no question → first word is YES or NO, then one line why."

Rewrite so the FIRST line (after any 🧭 compass line) answers what he asked:
  - Asked which option? Name the option: "Rye — the injunction kills the Servo path."
  - Asked yes/no? First word is YES or NO.
  - Asked what changed? One line of what changed, in plain English, before any table.
  - Asked if anything is left? Say what is left in one line.

Keep the table, keep the bullets — just put the ANSWER above them.

This is enforced because a correct answer Russell cannot find costs him the energy the
answer was supposed to save. wall-text-guard caps how LONG the reply is; this one checks
that the answer is FIRST.`;
}

/** Standalone entry, kept for direct invocation and for the end-to-end wiring probe.
 *
 *  In settings.json this file is NOT registered — `style-governor.mjs` runs every style rule
 *  through the registry and emits one merged verdict. Running this file directly still produces a
 *  correct block, which is what the wiring probe exercises. */
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { return; }

  const eventName = payload.hook_event_name || payload.hookEventName || '';
  if (eventName !== 'Stop') return;

  // Anti-loop rail: never block twice on the same turn.
  if (payload.stop_hook_active) return;

  const entries = readTranscript(payload.transcript_path);
  const turnEntries = currentTurnEntries(entries);
  if (turnEntries.length === 0) return;

  const reply = finalReplyText(turnEntries);
  const violations = blufViolations({ entries, turnEntries, reply });
  if (violations.length === 0) return;

  const userMessage = lastUserText(entries);
  const analysis = analyzeFirstLine(reply);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(analysis, userMessage) }));
}

// Entry-point guard: only read stdin when invoked directly as the hook process.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => process.exit(0));
}

export { finalReplyText, MAX_FIRST_LINE_WORDS };
