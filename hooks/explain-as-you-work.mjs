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

// Russell, 2026-08-16, verbatim: "I need you to always speak in terms of the higher level goal, as
// a global rule. otherwise I lose my place." He had just read a reply that was technically correct
// and completely unnavigable. The failure is NOT length -- it is a missing anchor. Without a Goal
// line he cannot tell a legitimate sub-step from a rabbit hole, so he has to stop and ask, which
// spends the energy this whole standard exists to protect. The template is therefore the FIRST
// thing in this injection, above the two modes, not a footnote below them.
const NARRATION_STANDARD = `=== OUTPUT STYLE (Russell's rule, updated 2026-08-16) ===

THE ANCHOR — every working message opens with these lines, in this order, no exceptions:
  Goal: <the OUTCOME Russell wants, in his words, never the system's> (e.g. "Hear Macher's voice")
  Task: <the one thing being worked right now, plain English, one line>
  Doing now:
    <emoji> <one short line>
    <emoji> <one short line>
Then, when it teaches: "This is like <a concrete everyday scene, or a real business / science /
engineering story>" — plus a small emoji diagram whenever a shape, flow, or contrast is the point.

The Goal line never changes just because a sub-step did. If it WOULD change, that is drift — say so
out loud instead of quietly rewriting it.

Two modes for the BODY under that anchor — pick by what THIS turn actually is:
  • EXPLAINING / strategy / research / chat → SHORT: ≤2 short paragraphs unless asked. Short sentences. Say each point ONCE. No play-by-play of tool calls. No 4-line beat.
  • CODING / building (writing or editing code, running builds/tests, multi-step implementation) → give a 2-3 sentence high-level update every few minutes or at a real milestone. State what moved, why it matters, and the next gate. Put each sentence on its own line. Do NOT narrate each tool, test, or wait. Every 4-5 updates, restate the North Star and how this task advances it.
Always: when you use a technical term, gloss it in a few plain words (coffee-shop level). The test: each narration should read like a teacher explaining how a part fits the whole — never like a changelog line. Show the full status beat only when code ships.`;

import { roleOf, contentBlocks } from './lib/transcript.mjs';

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
export function analyzeTurn(turnEntries) {
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

// (The "read the final reply" helper lives in lib/style-verdict.mjs now — the governor hands
// every detector the reply text, so this file no longer walks the transcript for it.)

const OVERRIDE = /explain-override:/i;
// Only nag after a meaningful work chunk — a few edits do not justify commentary chatter.
const SILENT_WORK_THRESHOLD = 12;

// --- THE BREVITY / ANTI-WALL RULE NOW LIVES IN ONE PLACE -------------------------------------
// It used to be implemented HERE (word budgets + a 110-word wall test) *and* independently in
// wall-text-guard.mjs (a 2-paragraph cap + a 3-line paragraph cap) — two hooks, two threshold
// sets, two block messages, for ONE CLAUDE.md rule. On 2026-07-26 they fired back to back and
// Russell watched the same reply get rewritten twice for the same offence. Both now call
// hooks/lib/prose-shape.mjs, which owns the single threshold set and the single message.
// The DEPTH_REQUEST regex moved there too (exported as DEPTH_REQUEST_RE).

// The first real user message in the turn (skips tool_result entries) — used to detect a depth request.
export function firstUserText(turnEntries) {
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

/**
 * PURE DETECTOR for the shared style governor (hooks/lib/style-verdict.mjs) — the
 * "you worked silently and saved the talking for the end" rule (GATE 2). The brevity/wall
 * half of this hook (GATE 1) is now supplied to the governor by hooks/lib/prose-shape.mjs.
 * Returns [] or ONE violation; it never writes a block itself.
 */
export function silentWorkViolations({ turnEntries = [], reply = '' } = {}) {
  if (!turnEntries.length) return [];
  const { mutatingCount, narratedAlong } = analyzeTurn(turnEntries);
  if (mutatingCount < SILENT_WORK_THRESHOLD) return []; // not enough work to demand mid-narration
  if (narratedAlong) return [];                         // you talked as you went
  if (OVERRIDE.test(reply)) return [];

  return [{
    kind: 'worked silently, saved the talking for the end',
    measure: `${mutatingCount} changes this turn, narrated only at the very end`,
    guidance: `Russell wants high-level milestones, not a tool-by-tool transcript:
  • Every few minutes or at a real milestone: 2-3 sentences on what moved, why it matters, and the next gate.
  • Every 4-5 updates: restate the North Star and how the current task advances it.
  • Explain a technical term only when it helps the decision (Khan-Academy level, coffee-shop plain).

This is not a request for a bigger end-summary. Give a few useful milestones while the work unfolds.
(If this turn genuinely couldn't be narrated mid-stream, write "explain-override: <reason>".)`,
  }];
}

/**
 * Deliver the style verdict held from the previous turn.
 *
 * Russell, 2026-08-17: "But I want i ony want to see 1 version, not 2." The
 * style governor no longer blocks, because a block leaves the rejected draft in
 * his transcript and he reads the answer twice. It records its findings instead,
 * and they arrive here — before the next reply is written rather than after the
 * last one was sent. Same feedback, one version on his screen.
 */
function deferredStyleVerdict() {
  const held = takeDeferredVerdict();
  if (!held) return '';
  return `=== STYLE VERDICT ON YOUR LAST REPLY (deferred so Russell saw only one version) ===
`
    + `${held}
`
    + `Apply this to the reply you are about to write. Do not apologise for the last one and `
    + `do not restate it.
`;
}

// `for await` over stdin is only legal inside an async function. Without the keyword the whole
// MODULE fails to parse, so the hook dies before it can inject anything -- and a hook that never
// runs is indistinguishable from a hook with nothing to say. Found 2026-08-16.
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

  // END of the turn: this hook no longer blocks on its own. It delegates to the SHARED STYLE
  // GOVERNOR, which runs every style checker (brevity/wall, silent-work, compass line, narration
  // cadence) and emits ONE combined verdict per turn. See hooks/lib/style-verdict.mjs for why —
  // four hooks blocking sequentially made Russell read four stacked drafts (2026-07-26).
  // The registry import is DYNAMIC so the hook -> registry -> hook module cycle resolves cleanly.
  const { runStyleGovernor } = await import('./lib/style-verdict.mjs');
  const { STYLE_CHECKERS } = await import('./lib/style-checkers.mjs');
  const verdict = runStyleGovernor(payload, { checkers: STYLE_CHECKERS });
  if (verdict) process.stdout.write(JSON.stringify(verdict));
}

// Entry-point guard: only read stdin and run when invoked directly as the hook process — never
// when merely IMPORTED (by the style-checker registry, or by a test reaching the primitives).
// Basename comparison stays stable across MSYS `/c/...` vs `C:\...` path spellings.
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeDeferredVerdict } from './lib/style-verdict.mjs';
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main().catch(() => process.exit(0));
}
