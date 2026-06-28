#!/usr/bin/env node
/**
 * explain-as-you-work — make Claude narrate AS IT WORKS, Khan-Academy style, NOT dump a
 * dense summary at the end.
 *
 * Russell (2026-06-02, verbatim intent): "narrate high level AS YOU GO... explain jargon
 * and concepts at khan academy level... check I understand... don't write gibberish, don't
 * save it for the end."
 *
 * Dual-event hook (branches on hook_event_name):
 *   • UserPromptSubmit — injects the narration standard so it's LIVE the whole turn. This is
 *     the real lever: the instruction sits in context while Claude works, so narration is
 *     continuous instead of bolted on at the end.
 *   • Stop — backstop ONLY for the failure Russell named: real work done SILENTLY, with all
 *     the talking saved for one block at the very end. If narration was interleaved with the
 *     work (text between tool calls), the turn passes with NO end-summary demanded.
 *
 * Fail-open on any error. Override token in the reply: "explain-override: <reason>".
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The list of concepts Russell already knows. The hook injects it every turn so Claude skips the
// gloss on things he's told us he understands. Recorded by Claude when Russell says "I know X".
const KNOWN_CONCEPTS_PATH = join(homedir(), '.claude', 'known-concepts.txt');

function readKnownConcepts() {
  try {
    return readFileSync(KNOWN_CONCEPTS_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch { return []; }
}

// Does Russell's CURRENT message signal he already knows a concept? We deliberately DON'T try to
// extract the term with a regex (that records junk like "what"); we just detect the intent and let
// Claude — who actually understands the sentence — append the precise term to the known list.
const KNOWS_SIGNAL = /\b(i (?:already )?know (?:what|about|how)|i'?m familiar with|i (?:already )?(?:get|understand) (?:what|how)|(?:stop|don'?t|no need to|quit) explain|you don'?t (?:need|have) to explain|i know this)\b/i;

const NARRATION_STANDARD = `=== OUTPUT STYLE (Russell's rule, updated 2026-06-16) ===
Two modes — pick by what THIS turn actually is:
  • EXPLAINING / strategy / research / chat → SHORT: ≤2 short paragraphs unless asked. Short sentences. Say each point ONCE. No play-by-play of tool calls. No 4-line beat.
  • CODING / building (writing or editing code, running builds/tests, multi-step implementation) → NARRATE AS YOU GO LIKE A TEACHER. Before each chunk, one plain sentence that ties what you're about to do to THE BIG PICTURE — not "editing file X" but "here's the thing we're building, here's the piece I'm adding, here's why it matters and what it unlocks next." The story should compound so Russell always knows where we are in the whole and why this step earns its place. Keep it flowing; do NOT save it for an end dump.
Always: when you use a technical term, gloss it in a few plain words (coffee-shop level). The test: each narration should read like a teacher explaining how a part fits the whole — never like a changelog line. Show the full status beat only when code ships.`;

import { readTranscript, roleOf, contentBlocks, currentTurnEntries } from './lib/transcript.mjs';

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MUTATING_BASH = /\bgit\s+(commit|merge|push|cherry-pick|rebase|revert)\b|\bnpm\s+(i|install|ci)\b|\bnpx\s+husky\b/;

function isMutatingBlock(block) {
  if (block?.type !== 'tool_use') return false;
  const toolName = block.name || '';
  if (MUTATING_TOOLS.has(toolName)) return true;
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return MUTATING_BASH.test(block.input?.command || '');
  }
  return false;
}

// Count mutating tool calls, and detect whether ANY narration text appeared BEFORE the final
// assistant message — i.e. interleaved with the work, the "as you go" signal. A text block that
// sits before a tool_use in the same message also counts (text-then-act in one breath).
function analyzeTurn(turnEntries) {
  let mutatingCount = 0;
  let narratedAlong = false;

  // Index of the last assistant entry (its trailing text is the "end summary", not as-you-go).
  let lastAssistantIdx = -1;
  for (let i = turnEntries.length - 1; i >= 0; i--) {
    if (roleOf(turnEntries[i]) === 'assistant') { lastAssistantIdx = i; break; }
  }

  for (let i = 0; i < turnEntries.length; i++) {
    if (roleOf(turnEntries[i]) !== 'assistant') continue;
    const blocks = contentBlocks(turnEntries[i]);
    let sawToolThisEntry = false;
    for (const block of blocks) {
      if (isMutatingBlock(block)) mutatingCount++;
      if (block?.type === 'tool_use') sawToolThisEntry = true;
      // Narration counts as "along the way" if it's in any non-final assistant message, OR it's a
      // text block that precedes a tool call within the same message (you spoke, then acted).
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        const isFinalEntry = i === lastAssistantIdx;
        if (!isFinalEntry) narratedAlong = true;
      }
    }
    // text-before-tool within the SAME entry: spoke then acted = as-you-go.
    if (i === lastAssistantIdx && sawToolThisEntry) {
      const blocksSeq = blocks;
      const firstToolPos = blocksSeq.findIndex((b) => b?.type === 'tool_use');
      const textBeforeTool = blocksSeq.slice(0, firstToolPos).some((b) => b?.type === 'text' && b.text?.trim());
      if (textBeforeTool) narratedAlong = true;
    }
  }
  return { mutatingCount, narratedAlong };
}

function lastAssistantReply(turnEntries) {
  for (let i = turnEntries.length - 1; i >= 0; i--) {
    if (roleOf(turnEntries[i]) !== 'assistant') continue;
    let collected = '';
    for (const block of contentBlocks(turnEntries[i])) {
      if (block?.type === 'text' && typeof block.text === 'string') collected += block.text + '\n';
    }
    if (collected.trim()) return collected;
  }
  return '';
}

const OVERRIDE = /explain-override:/i;
// A second escape hatch specific to the brevity gate: when Russell genuinely wants the long form.
const STYLE_OVERRIDE = /style-override:/i;
// Only nag on genuinely multi-step silent work — a quick one-off edit doesn't need mid-narration.
const SILENT_WORK_THRESHOLD = 3;

// --- Brevity / anti-wall gate (Russell's "≤2 short paragraphs unless asked" + "no walls of text") ---
// EXPLAINING turns (no code shipped) must be tight. Two ways a reply trips the gate:
//   • a WALL — a single unbroken paragraph longer than WALL_PARA_WORDS (break it into bullets), or
//   • TOO LONG overall (> EXPLAIN_WORD_BUDGET) when Russell did NOT ask for depth.
const EXPLAIN_WORD_BUDGET = 220; // ~2 short paragraphs + a few bullets; walls are 400-600+
const WALL_PARA_WORDS = 110;     // one unbroken block this big is a wall on screen

// Russell explicitly asking for more — these lift the length cap (a wall still must be broken up).
const DEPTH_REQUEST = /\b(walk me through|in detail|more detail|go deep|deep[ -]dive|step[ -]by[ -]step|give me an example|examples?|explain everything|comprehensive|thorough|elaborate|expand on|long version|full (?:detail|breakdown|explanation)|break (?:it|this) down|more context|teach me)\b/i;

// The first real user message in the turn (skips tool_result entries) — used to detect a depth request.
function firstUserText(turnEntries) {
  for (const entry of turnEntries) {
    if (roleOf(entry) !== 'user') continue;
    let userMessage = '';
    for (const block of contentBlocks(entry)) {
      if (block?.type === 'text' && typeof block.text === 'string') userMessage += block.text + '\n';
    }
    if (userMessage.trim()) return userMessage;
  }
  return '';
}

// Measure a reply: total prose words (code fences excluded) and the longest non-bullet paragraph.
function proseMetrics(replyText) {
  const noCode = replyText.replace(/```[\s\S]*?```/g, ' ');
  const wordCount = (passage) => (passage.replace(/[#*_>`~-]/g, ' ').match(/\S+/g) || []).length;
  const totalWords = wordCount(noCode);
  let longestParaWords = 0;
  for (const block of noCode.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    // A block that is entirely bullets / numbered items / headers / quotes is structure, not a wall.
    const structured = lines.every((line) => /^([-*•>]|\d+[.)]|#{1,6}\s)/.test(line));
    if (structured) continue;
    const words = wordCount(block);
    if (words > longestParaWords) longestParaWords = words;
  }
  return { totalWords, longestParaWords };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  const event = payload.hook_event_name || payload.hookEventName || '';

  // FRONT of the turn: inject the standard so narration is continuous, not retrofitted.
  if (event === 'UserPromptSubmit') {
    let injected = NARRATION_STANDARD;

    const known = readKnownConcepts();
    if (known.length) {
      injected += `\n\nAlready known — do NOT re-explain these (Russell told us): ${known.join(', ')}.`;
    }

    // If this message signals new knowledge, tell Claude to record the exact term now — Claude
    // parses "I know what an embedding is" correctly where a regex would grab "what".
    const userMessage = payload.prompt || payload.user_prompt || '';
    if (KNOWS_SIGNAL.test(userMessage)) {
      injected += `\n\n→ Russell just signaled he already knows a concept. Append the EXACT term(s) he named (one per line, lowercased) to ${KNOWN_CONCEPTS_PATH} this turn, so it's skipped from now on. Then stop explaining it.`;
    }

    process.stdout.write(injected);
    return;
  }

  // END of the turn: only the silent-work failure Russell named gets a nudge.
  const entries = readTranscript(payload.transcript_path);
  const turnEntries = currentTurnEntries(entries);
  if (turnEntries.length === 0) return;

  const { mutatingCount, narratedAlong } = analyzeTurn(turnEntries);
  const reply = lastAssistantReply(turnEntries);

  // GATE 1 — brevity / anti-wall, for EXPLAINING turns (no code shipped this turn). This is the gate
  // Russell kept hitting: a chat answer that's a wall of text, which the soft reminder never enforced.
  if (mutatingCount === 0 && reply && !OVERRIDE.test(reply) && !STYLE_OVERRIDE.test(reply)) {
    const depthAsked = DEPTH_REQUEST.test(firstUserText(turnEntries));
    const { totalWords, longestParaWords } = proseMetrics(reply);
    const isWall = longestParaWords > WALL_PARA_WORDS;
    const isTooLong = totalWords > EXPLAIN_WORD_BUDGET && !depthAsked;
    if (isWall || isTooLong) {
      const brevityReason = `STOP — TOO LONG / a WALL OF TEXT (Russell's "≤2 short paragraphs unless asked", ADHD).

This is an explaining turn (no code shipped) and your reply ${isWall ? `has a ${longestParaWords}-word unbroken paragraph` : `runs ~${totalWords} words`}. Russell has to re-parse walls of text — it costs him energy he doesn't have.

Rewrite it SHORT before stopping:
  • Lead with the one-line answer. Reasoning second, detail third — skippable.
  • Bullets over prose. No paragraph longer than ~3 lines. Bold the load-bearing words.
  • Add a diagram/table/emoji only if it makes it FASTER to grasp — never as filler.
  • Say each point once. Cut anything that doesn't move the idea forward.
${depthAsked ? '' : '  • He did NOT ask for depth this turn — keep it to ≤2 short paragraphs.\n'}(If he genuinely asked for the long form, write "style-override: <why>".)`;
      process.stdout.write(JSON.stringify({ decision: 'block', reason: brevityReason }));
      return;
    }
  }

  // GATE 2 — narrate-as-you-go: only the silent multi-step-work failure Russell named gets a nudge.
  if (mutatingCount < SILENT_WORK_THRESHOLD) return; // not enough work to demand mid-narration
  if (narratedAlong) return;                         // you talked as you went — no end-dump required
  if (OVERRIDE.test(reply)) return;

  const reason = `STOP — you worked silently and saved the talking for the end (Russell's rule, 2026-06-02).

You ran ${mutatingCount} changes this turn but only narrated at the very end. Russell wants the story told AS YOU GO:
  • Before each chunk: one plain sentence — what you're about to do and why.
  • Explain every technical term the moment you use it (Khan-Academy level, coffee-shop plain).
  • He should never be surprised by what you did, because you said it before you did it.

This isn't a request for a bigger end-summary — it's the opposite. Narrate next time BETWEEN the steps, not after them.
(If this turn genuinely couldn't be narrated mid-stream, write "explain-override: <reason>".)`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

main().catch(() => process.exit(0));
