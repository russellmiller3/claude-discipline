#!/usr/bin/env node
// =============================================================================
// EXPERIMENT-NAME-GLOSS — a bare experiment number must never reach Russell
// =============================================================================
//
// new-hook-category: Communication discipline — nearest existing hooks are the
// narration/compass guards; none of them check WHAT an experiment is called, only
// how much narration surrounds it.
//
// WHY (Russell, 2026-07-19 rule, re-stated angrily 2026-07-22: "refer to
// experiments by their function not just name. makes me angry."): he does not
// remember what a number maps to. "exp147e" forces him to go look it up, burning
// energy he does not have. The project CLAUDE.md rule and a memory both said this
// already — and both were violated all night, because advice without teeth is
// advice. This hook is the teeth.
//
// HOW IT WORKS: on Stop, scan the assistant's reply for experiment mentions
// (exp147e, 169a). A mention is SATISFIED when plain-English words describing what
// it DOES sit within a short window before or after it — "the lying-tool control
// fix (exp147e)" passes; "exp147e is at step 1950" does not. Code contexts are
// exempt: a file path (scripts/exp147e_*.py), a URL, or a fenced code block is
// machinery, not a claim to Russell.
//
// TEETH: Stop decision 'block'. Escape: EXPERIMENT_NAME_GLOSS_OK=1 in env, or the
// literal token EXPERIMENT_NAME_GLOSS_OK in the reply. Respects stop_hook_active
// (never loops). FAILS OPEN on any error. basename entry-guard.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, lastAssistantText } from './lib/transcript.mjs';

const ENV_OVERRIDE = 'EXPERIMENT_NAME_GLOSS_OK';
const ESCAPE_TOKEN = /\bEXPERIMENT_NAME_GLOSS_OK\b/;

// An experiment mention: `exp147e` / `exp169a` / `exp150`, or the bare shorthand
// `169a` / `147e` Russell and the docs both use. A 3-digit number ALONE (no letter)
// is too ambiguous to claim without the exp prefix, so bare `147` is not matched.
const MENTION_RE = /\bexp\d{2,4}[a-z]?\b|\b\d{3}[a-z]\b/gi;

// How many characters on either side of a mention count as "next to" it.
const GLOSS_WINDOW = 90;

// Plain-English words that describe what an experiment DOES. Any of these near the
// mention means Russell can tell what it is without looking it up. Deliberately
// broad — the goal is "did you say anything about its function", not vocabulary
// policing.
const GLOSS_RE = /\b(?:tool|control|register|program|variable|track(?:ing)?|sort(?:ing)?|deduct|recursion|spawn|judgment|memento|substrate|inject|opaque|scrambl|lying|value|receipt|endpoint|router|dispatch|expert|probe|mri|mask|wall|isolation|first[- ]program|one[- ]pass|held[- ]out|fix|arm|run|leg|experiment that|which tests?|proves?|collapse)\w*/i;

// Contexts where a bare number is machinery, not a claim: file paths, URLs,
// artifact/dir references, and fenced code. Stripped BEFORE scanning.
const CODE_FENCE_RE = /```[\s\S]*?```|`[^`\n]*`/g;
const PATH_OR_URL_RE = /\S*[\/\\]\S*|https?:\/\/\S+|\b\w*exp\d{2,4}[a-z]?[-_]\w+/gi;

/**
 * Experiment mentions in the reply that carry NO plain-English gloss nearby.
 * Returns the offending mention strings (deduped, original case).
 */
export function bareExperimentMentions(replyText) {
  const prose = String(replyText || '')
    .replace(CODE_FENCE_RE, ' ')
    .replace(PATH_OR_URL_RE, ' ');
  const flagged = new Set();
  for (const match of prose.matchAll(MENTION_RE)) {
    const mention = match[0];
    const start = Math.max(0, match.index - GLOSS_WINDOW);
    const end = Math.min(prose.length, match.index + mention.length + GLOSS_WINDOW);
    const neighborhood = prose.slice(start, end).replace(mention, ' ');
    if (!GLOSS_RE.test(neighborhood)) flagged.add(mention);
  }
  return [...flagged];
}

const reasonFor = (mentions) => `BARE EXPERIMENT NUMBER — Russell cannot decode it.

Unglossed: ${mentions.join(', ')}

Russell's rule (project CLAUDE.md 2026-07-19, re-stated angrily 2026-07-22: "refer to
experiments by their function not just name. makes me angry."): he does NOT remember what a
number maps to, and looking it up costs energy he does not have. The number is a SUFFIX; the
plain-English purpose is the actual NAME.

  WRONG: "exp147e is at step 1950"
  RIGHT: "the lying-tool control fix (exp147e) is at step 1950"

  WRONG: "169a looks good"
  RIGHT: "the variable-tracking first program — register file vs one-pass control — looks good"

Rewrite each mention above with a few plain words saying what it DOES, then stop.
Escape (genuinely internal, e.g. quoting a filename): ${ENV_OVERRIDE} in your reply, or ${ENV_OVERRIDE}=1.`;

/**
 * PURE core. Returns { block, reason? }. Never throws on malformed input.
 */
export function evaluate({ replyText = '', stopHookActive = false, envOk = false } = {}) {
  if (envOk || stopHookActive) return { block: false };
  if (ESCAPE_TOKEN.test(replyText || '')) return { block: false };
  const mentions = bareExperimentMentions(replyText);
  if (mentions.length === 0) return { block: false };
  return { block: true, reason: reasonFor(mentions) };
}

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') process.exit(0);
    const payload = readPayload();
    if (payload.stop_hook_active) process.exit(0);
    const entries = readTranscript(payload.transcript_path || payload.transcriptPath || '');
    const verdict = evaluate({ replyText: lastAssistantText(entries) });
    if (!verdict.block) process.exit(0);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate stop
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
