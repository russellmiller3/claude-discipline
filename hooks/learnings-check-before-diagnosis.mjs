#!/usr/bin/env node
// =============================================================================
// LEARNINGS-CHECK-BEFORE-DIAGNOSIS — a verdict-recording doc may not gain a
// root-cause claim unless learnings.md was actually read/grepped this session.
// =============================================================================
//
// new-hook-category: Learnings system — nearest existing hooks are
// require-learnings-ack (blocks CODE edits while a surfaced-learning marker is
// unacknowledged) and learnings-to-hooks-nudge (nudges a recurring lesson
// toward a hook). Neither guards the INVERSE failure: writing a fresh
// diagnosis into a verdict doc WITHOUT ever having opened learnings.md this
// session. require-learnings-ack only fires once something ELSE already
// surfaced a matching learnings bullet into context (an error-keyword match);
// it does nothing when the diagnosis is MY OWN reasoning from tool output,
// which is exactly the gap that let the repeat mistake below ship twice.
//
// WHY (Russell, 2026-07-21): exp167d's held-out gate collapsed to a
// degenerate "always refuse unfamiliar" policy. A full root-cause diagnosis
// got written into docs/exp167d-spawn-judgment-3arm-METHODS.md and
// Marcus-Truth.md treating it as a fresh finding — without checking
// learnings.md first. It was already there: the EXACT pattern ("the gate
// found a shortcut feature unrelated to difficulty," a binary-collapse from
// exp147d v3 self-assess + exp167 take 4) was logged a day earlier, from two
// prior attempts. Russell caught it ("sorry try again... this looks like a
// repeat mistake").
//
// HOW IT WORKS
// ============
// Fires PreToolUse on Write|Edit of a VERDICT-RECORDING doc — a `*METHODS*.md`,
// `*-Truth.md`, `*findings*.md`, or `learnings.md` itself (global or project;
// writing NEW diagnostic content there without reading the EXISTING content
// first is the same mistake). BLOCKS when the added content contains
// DIAGNOSTIC language (a root-cause claim, a "why it failed" explanation)
// UNLESS learnings.md was actually Read, or Grepped with a path that targets
// the file itself, SOMEWHERE EARLIER in this session's transcript.
//
// SCOPE (honest): this can't verify the diagnosis is ACTUALLY correct or that
// the read was thorough — it only proves learnings.md was opened this session
// before the claim shipped. Same class of forcing-function as
// `no-blind-rerun-without-rootcause`: convert "diagnose reflexively" into
// "must touch the source of truth first," cheaply and mechanically — not a
// guarantee of good diagnosis.
//
// TEETH: permissionDecision 'deny'. Escape: a `learnings-checked:` token in
// the file content OR the reply (states what was checked — a real
// acknowledgment, not a bypass), or LEARNINGS_CHECK_OK=1 for a genuinely new
// project/repo with no learnings.md yet. FAILS OPEN on any error.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, toolUsesOf, currentTurnEntries, lastAssistantText } from './lib/transcript.mjs';

const ENV_OVERRIDE = 'LEARNINGS_CHECK_OK';
const ESCAPE_TOKEN = /\blearnings-checked\s*:/i;

// A doc basename matching one of the four verdict-recording patterns:
// **/*METHODS*.md, **/*-Truth.md, **/*findings*.md, **/learnings.md itself.
export function isVerdictRecordingDoc(filePath) {
  const base = basename(String(filePath || '').replace(/\\/g, '/'));
  if (!/\.md$/i.test(base)) return false;
  if (/^learnings\.md$/i.test(base)) return true;
  if (/methods/i.test(base)) return true;
  if (/-truth\.md$/i.test(base)) return true;
  if (/findings/i.test(base)) return true;
  return false;
}

// Diagnostic-language CLASS, not one fixed phrase — interchangeable phrasings
// of the same claim: "I have determined the root cause / why this failed."
const DIAGNOSTIC_PATTERNS = [
  [/\broot[\s-]?caus/i, 'root cause'],
  [/\bdiagnos(?:is|ed|e|ing)\b/i, 'diagnosis'],
  [/\bcollapsed\s+because\b/i, 'collapsed because'],
  [/\bthe\s+reason\s+(?:it|this)\s+fail/i, 'the reason it/this fails'],
  [/\bwhy\s+it\s+fail/i, 'why it failed'],
  // "first-principles" only counts as diagnostic when it's a CLAIMED
  // derivation ("...analysis shows/reveals/proves...") — a bare mention
  // (e.g. "ran /first-principles") is not itself a diagnosis.
  [/\bfirst[\s-]principles?\b[\s\S]{0,60}?\b(?:shows?|reveals?|proves?|confirms?|found|concludes?|demonstrates?)\b/i, 'first-principles derivation'],
];

/** All diagnostic phrasings matched in content, as human-readable labels. Pure. */
export function matchedDiagnosticPhrases(content) {
  const body = String(content || '');
  return DIAGNOSTIC_PATTERNS.filter(([pattern]) => pattern.test(body)).map(([, label]) => label);
}

/**
 * Was learnings.md (global or project) actually Read, or Grepped with a path
 * that targets the file itself, ANYWHERE earlier in this session? A broad
 * repo-wide Grep with no path (or a directory path) does NOT count — the
 * gate is deliberately narrow: it forces an EXPLICIT check of learnings.md,
 * not credit for a search that happened to sweep past it.
 */
export function wasLearningsChecked(entries) {
  for (const entry of entries || []) {
    for (const call of toolUsesOf(entry)) {
      const name = call?.name || '';
      const input = call?.input || {};
      if (name === 'Read' && /(^|[\\/])learnings\.md$/i.test(String(input.file_path || ''))) return true;
      if (name === 'Grep' && /(^|[\\/])learnings\.md$/i.test(String(input.path || ''))) return true;
    }
  }
  return false;
}

// PURE core — returns { block, matched }. `learningsChecked` and
// `replyHasToken` are precomputed by main() from the real transcript (I/O
// stays out of this function so it's directly testable).
export function evaluate({ toolName, filePath, content, learningsChecked, replyHasToken }) {
  if (toolName !== 'Write' && toolName !== 'Edit') return { block: false };
  if (!filePath || !isVerdictRecordingDoc(filePath)) return { block: false };
  if (!content) return { block: false };
  if (ESCAPE_TOKEN.test(content)) return { block: false };
  if (replyHasToken) return { block: false };

  const matched = matchedDiagnosticPhrases(content);
  if (matched.length === 0) return { block: false };
  if (learningsChecked) return { block: false };

  return { block: true, matched };
}

function denialReason(filePath, matched) {
  return `DIAGNOSIS WITHOUT CHECKING LEARNINGS.MD — you're about to write a root-cause claim into
${basename(filePath)} (matched: ${matched.join(', ')}), but learnings.md was never Read or Grepped
(targeting the file itself) anywhere earlier this session.

This is the exact repeat mistake from 2026-07-21: exp167d's held-out gate collapsed to a degenerate
"always refuse unfamiliar" policy, and a full root-cause diagnosis was written into
docs/exp167d-spawn-judgment-3arm-METHODS.md and Marcus-Truth.md treating it as a fresh finding — but
the EXACT pattern ("the gate found a shortcut feature unrelated to difficulty") was already logged in
learnings.md a day earlier, from two prior attempts (exp147d v3 self-assess + exp167 take 4). Russell
caught it: "sorry try again... this looks like a repeat mistake."

Read or grep learnings.md for the relevant topic FIRST. If the pattern is already there, your
diagnosis should say so and EXTEND it, not restate it as novel.

If you've genuinely already checked it (e.g. earlier in a compacted context window), add
\`learnings-checked: <what you found or confirmed nothing matched>\` to your reply or this file's
content and write again. Escape for a genuinely new project/repo with no learnings.md yet:
${ENV_OVERRIDE}=1.`;
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') { process.exit(0); }
    const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const toolName = payload.tool_name || '';
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    const content = input.new_string || input.content || '';

    const entries = readTranscript(payload.transcript_path);
    const learningsChecked = wasLearningsChecked(entries);
    const replyText = lastAssistantText(currentTurnEntries(entries));
    const replyHasToken = ESCAPE_TOKEN.test(replyText);

    const verdict = evaluate({ toolName, filePath, content, learningsChecked, replyHasToken });
    if (!verdict.block) { process.exit(0); }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denialReason(filePath, verdict.matched),
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate doc write
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
