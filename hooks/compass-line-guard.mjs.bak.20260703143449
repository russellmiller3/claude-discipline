#!/usr/bin/env node
/**
 * compass-line-guard — Stop hook. Forces every WORKING-turn reply to OPEN with one
 * plain-English big-picture line, because the advisory version of this rule
 * (injected instructions in explain-as-you-work.mjs / the /bigpicture skill) gets
 * compressed out under context pressure. Russell's own meta-rule: a hook must
 * enforce the OUTCOME, not just advise it — so this one BLOCKS.
 *
 * Russell, 2026-07-03 (verbatim intent): "every working reply needs to OPEN with
 * one plain-English big-picture line — Mission, this step, why. No jargon. All
 * existing mechanisms are advisory and get compressed out."
 *
 * RULE
 *   A "working turn" is any turn where the assistant called a tool that DOES
 *   something (Edit/Write/NotebookEdit/Bash/PowerShell/Agent/Workflow) — not a
 *   turn that only Read/Grep/Glob/ToolSearch'd around. On a working turn, the
 *   FIRST non-whitespace line of the final assistant text message must either:
 *     (a) start with the compass marker (U+1F9ED, the compass emoji), or
 *     (b) start with "## <compass-marker> TL;DR" — the /bigpicture skill's own
 *         format, which IS the compass content by construction.
 *   A pure chat/explaining turn (no working tool calls) is exempt — this hook
 *   never nags conversation.
 *
 * ANTI-LOOP RAIL
 *   Mirrors the convention used by ~15 sibling Stop hooks (never-idle.mjs,
 *   jargon-gloss-guard.mjs, no-backcompat.mjs, look-before-asking.mjs, ...):
 *   Claude Code sets `stop_hook_active: true` on the re-invocation caused by a
 *   Stop hook's OWN block — i.e. this exact hook already fired once this turn
 *   and the model responded again. On that re-entrant pass we never block a
 *   second time (avoids an infinite block loop); if the compass line is STILL
 *   missing, we let the turn end but say so, so the gap is visible instead of
 *   silently swallowed.
 *
 * Fails open (exit 0, no output) on any malformed/missing transcript, parse
 * error, or unexpected exception — this hook must never be the reason ALL work
 * grinds to a halt.
 */

import { readTranscript, roleOf, contentBlocks, currentTurnEntries } from './lib/transcript.mjs';
import { fileURLToPath } from 'node:url';

// The literal compass emoji, written as its codepoint so this file stays readable
// (and un-mangled) regardless of the editing tool's encoding handling.
export const COMPASS_MARKER = String.fromCodePoint(0x1f9ed);

// Tools that mean "this turn DID something" (mutated files, ran a command, or
// dispatched other work) as opposed to just looking around.
const WORKING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent', 'Workflow']);

/** Did this turn call any tool that actually DOES something (vs. just reading/searching)? */
export function turnDidWork(turnEntries) {
  for (const entry of turnEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const block of contentBlocks(entry)) {
      if (block?.type === 'tool_use' && WORKING_TOOLS.has(block.name || '')) return true;
    }
  }
  return false;
}

/** The final assistant text message in the turn (the reply Russell actually reads). */
export function finalReplyText(turnEntries) {
  for (let i = turnEntries.length - 1; i >= 0; i--) {
    if (roleOf(turnEntries[i]) !== 'assistant') continue;
    const textBlocks = contentBlocks(turnEntries[i]).filter(
      (block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim()
    );
    if (textBlocks.length) return textBlocks.map((block) => block.text).join('\n');
  }
  return '';
}

/** The first non-whitespace line of a reply (what Russell's eye actually lands on first). */
export function firstNonBlankLine(replyText) {
  const lines = (replyText || '').split('\n');
  for (const line of lines) {
    if (line.trim()) return line.trim();
  }
  return '';
}

// The /bigpicture skill's own header format — this line already IS the compass content,
// so it satisfies the rule by construction without also requiring the marker glyph.
const BIGPICTURE_HEADER_RE = /^##\s*(?:\p{Emoji_Presentation}\s*)?TL;?DR/iu;

/** Does the reply's opening line satisfy the compass-line rule? */
export function hasCompassOpening(replyText) {
  const firstLine = firstNonBlankLine(replyText);
  if (!firstLine) return false;
  if (firstLine.startsWith(COMPASS_MARKER)) return true;
  if (BIGPICTURE_HEADER_RE.test(firstLine)) return true;
  return false;
}

const BLOCK_REASON = `STOP — this was a WORKING turn (you edited/ran/dispatched something) but your reply doesn't open with a compass line (Russell's rule, 2026-07-03).

Advisory reminders get compressed out under context pressure, so this is enforced, not suggested. Prepend ONE line, before anything else, in plain English — no function names, no file paths, no jargon:

${COMPASS_MARKER} **Mission:** <what we're trying to do overall> · this step: <what just happened, in plain English> · why: <what it unlocks>

Then keep the rest of your reply as-is.`;

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { return; }

  const eventName = payload.hook_event_name || payload.hookEventName || '';
  if (eventName !== 'Stop') return;

  const entries = readTranscript(payload.transcript_path);
  const turnEntries = currentTurnEntries(entries);
  if (turnEntries.length === 0) return; // malformed/missing/empty transcript -> silent pass

  if (!turnDidWork(turnEntries)) return; // pure chat/explaining turn -> exempt, never nag

  const reply = finalReplyText(turnEntries);
  if (!reply) return; // no text reply to check (e.g. tool-only trailing message) -> nothing to enforce

  if (hasCompassOpening(reply)) return; // already compliant

  // Anti-loop rail: this hook already blocked once this turn (Claude Code re-invoked us after
  // its own block) — never block a second time. Let the turn end; the gap stays visible in the
  // reply itself rather than trapping the model in a block loop.
  if (payload.stop_hook_active) return;

  process.stdout.write(JSON.stringify({ decision: 'block', reason: BLOCK_REASON }));
}

// Entry-point guard: only read stdin and run when invoked directly as the hook process, never
// when this module is merely IMPORTED (e.g. by its own test file to reach the exported
// primitives) — importing must not block on a stdin read that will never arrive.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => process.exit(0));
}
