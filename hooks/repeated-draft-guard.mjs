/**
 * repeated-draft-guard — detects a retry that copy-pastes the previously blocked draft
 * instead of patching it.
 *
 * new-hook-category: none — this is a STYLE_CHECKERS-shaped detector like
 * result-completeness-guard.mjs, not a standalone hook. It is deliberately NOT registered in
 * STYLE_CHECKERS itself (see style-verdict.mjs) because its one job — policing a retry that
 * happens AFTER the turn's general claim is already taken — requires it to run even when
 * turnAlreadyClaimed(turnKey) is true, which every other checker in the registry must not do.
 *
 * THE INCIDENT (2026-07-29, live session): Russell asked "what is fit-for-purpose routing,"
 * got a 2-paragraph answer, and a Stop hook blocked it for an unrelated narration violation.
 * The retry reproduced BOTH paragraphs verbatim and appended one "serial only:" line. Because
 * assistant text streams live as it's generated, Russell watched the same substantive content
 * stream past twice. Root cause confirmed directly from this session's own transcript
 * (59e1fb8b...jsonl, lines 1705 and 1713): the blocked draft and the retry are two distinct
 * assistant entries in the same turn window, and the retry's text was the prior draft's text,
 * fully intact, plus one appended line.
 *
 * DETECTION IS CONTIGUOUS CONTAINMENT, NOT OVERALL OVERLAP (red-team finding, 2026-07-29): an
 * earlier version scored overall shingle-set overlap between the two drafts. That false-positives
 * on exactly the CORRECT behavior this hook exists to encourage — a legitimate minimal patch that
 * rewrites one flagged sentence in the middle of a long reply and leaves the other 90% of the
 * wording genuinely, correctly unchanged also scores high overall overlap. The distinguishing
 * signal is CONTIGUITY: the incident shape is "the entire prior draft survives as ONE unbroken
 * run, with something appended/prepended around it" — a real internal edit SPLITS that run in
 * two, so neither remaining piece can be as long as the whole. Detection is therefore: the
 * longest contiguous word-run shared between the two drafts, as a fraction of the prior draft's
 * total length.
 *
 * Fails open on everything — a broken comparison must never be the reason a legitimate retry
 * gets blocked or a crash halts the turn.
 */

import { roleOf, contentBlocks } from './lib/transcript.mjs';

/** Below this many words in the PRIOR draft, natural short-answer convergence is not the target. */
const MIN_PRIOR_WORDS = 40;
/** The longest shared contiguous run must cover at least this fraction of the prior draft. */
const CONTIGUOUS_MATCH_THRESHOLD = 0.85;
/** Skip the O(n*m) comparison above this size — a hook must never be the reason a turn is slow. */
const MAX_COMPARABLE_WORDS = 4000;

function normalize(draftText) {
  return String(draftText || '')
    .toLowerCase()
    .replace(/[*_`#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordsOf(draftText) {
  const normalized = normalize(draftText);
  return normalized ? normalized.split(' ') : [];
}

/**
 * The longest run of PRIOR's words that appears contiguously, in order, inside CURRENT's words —
 * classic longest-common-substring, computed over words instead of characters. Rolling one row of
 * the DP table (O(min-length) space) since only the running best length is needed, not the text.
 */
function longestContiguousWordRun(priorWords, currentWords) {
  if (priorWords.length === 0 || currentWords.length === 0) return 0;
  let previousRow = new Array(currentWords.length + 1).fill(0);
  let longestRun = 0;
  for (let priorIndex = 1; priorIndex <= priorWords.length; priorIndex += 1) {
    const currentRow = new Array(currentWords.length + 1).fill(0);
    for (let currentIndex = 1; currentIndex <= currentWords.length; currentIndex += 1) {
      if (priorWords[priorIndex - 1] === currentWords[currentIndex - 1]) {
        currentRow[currentIndex] = previousRow[currentIndex - 1] + 1;
        if (currentRow[currentIndex] > longestRun) longestRun = currentRow[currentIndex];
      }
    }
    previousRow = currentRow;
  }
  return longestRun;
}

/**
 * Fraction of `priorDraft` that survives as ONE unbroken run inside `currentDraft`. 0 when prior
 * is empty, or when either draft is too large to compare cheaply (fails open, not slow).
 */
export function contiguousMatchRatio(priorDraft, currentDraft) {
  const priorWords = wordsOf(priorDraft);
  if (priorWords.length === 0) return 0;
  const currentWords = wordsOf(currentDraft);
  if (priorWords.length > MAX_COMPARABLE_WORDS || currentWords.length > MAX_COMPARABLE_WORDS) return 0;
  return longestContiguousWordRun(priorWords, currentWords) / priorWords.length;
}

/** Every assistant text entry in the turn, in generation order — one per draft/retry attempt. */
export function assistantDrafts(turnEntries) {
  const drafts = [];
  for (const entry of turnEntries || []) {
    if (roleOf(entry) !== 'assistant') continue;
    const draftText = contentBlocks(entry)
      .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
      .map((block) => block.text)
      .join('\n');
    if (draftText) drafts.push(draftText);
  }
  return drafts;
}

/**
 * `context` = { turnEntries, ... } — the same shape every STYLE_CHECKERS detector receives.
 * Compares the LAST two assistant drafts in the turn; silent when there's only one (nothing to
 * compare against yet — the common case, most turns never retry).
 */
export function repeatedDraftViolations(context) {
  try {
    const { turnEntries = [] } = context || {};
    const drafts = assistantDrafts(turnEntries);
    if (drafts.length < 2) return [];

    const priorDraft = drafts[drafts.length - 2];
    const currentDraft = drafts[drafts.length - 1];
    if (wordsOf(priorDraft).length < MIN_PRIOR_WORDS) return [];

    const ratio = contiguousMatchRatio(priorDraft, currentDraft);
    if (ratio < CONTIGUOUS_MATCH_THRESHOLD) return [];

    return [{
      kind: 'draft repeats the previous blocked attempt nearly verbatim',
      measure: `${Math.round(ratio * 100)}% of the prior draft survives unchanged as one unbroken run`,
      guidance: 'The previous draft already streamed to Russell in full — he saw it. Output ONLY the actual fix: the corrected line, or a short standalone addition. Never the whole message again.',
    }];
  } catch {
    return [];
  }
}
