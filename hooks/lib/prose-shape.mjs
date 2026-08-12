/**
 * prose-shape — THE single implementation of Russell's length / wall-of-text rule.
 *
 * WHY THIS MODULE EXISTS (2026-07-26): the same CLAUDE.md rule ("NEVER a wall of text.
 * Hard cap: 2 short paragraphs OR a tight bullet list/table. No paragraph >3 lines.
 * <=2 short paragraphs per reply unless I ask for more.") was implemented TWICE, in two
 * hooks that each blocked independently:
 *   • explain-as-you-work.mjs GATE 1 — word budgets (220 explaining / 400 shipping) and a
 *     110-word "unbroken paragraph" wall test.
 *   • wall-text-guard.mjs — a prose-PARAGRAPH count cap of 2 and a 3-line paragraph cap.
 * Different thresholds, different wording, two separate Stop blocks for one rule. On
 * 2026-07-26 Russell watched them fire back to back and saw his reply rewritten twice for
 * the same offence.
 *
 * There is now ONE threshold set and ONE message. Both hooks call this module; neither
 * owns a private copy of the rule any more.
 */

// --- THE ONE THRESHOLD SET -------------------------------------------------------------
/** Hard cap on prose paragraphs (bullets/tables/code are the allowed alternative). */
export const MAX_PROSE_PARAGRAPHS = 2;
/** A single prose paragraph longer than this many LINES is over-long. */
export const MAX_PARAGRAPH_LINES = 3;
/** A single unbroken prose paragraph longer than this many WORDS is a wall on screen. */
export const WALL_PARAGRAPH_WORDS = 110;
/** Total prose-word budget on an EXPLAINING turn (no code shipped). */
export const EXPLAIN_WORD_BUDGET = 220;
/** Total prose-word budget on a SHIPPING turn — wider (there's a real status beat), never unlimited. */
export const SHIP_WORD_BUDGET = 400;

/** Russell explicitly asking for depth — lifts the total-word budget (a wall still must be broken up). */
export const DEPTH_REQUEST_RE =
  /\b(walk me through|in detail|more detail|go deep|deep[ -]dive|step[ -]by[ -]step|give me an example|examples?|explain everything|comprehensive|thorough|elaborate|expand on|long version|full (?:detail|breakdown|explanation)|break (?:it|this) down|more context|teach me)\b/i;

/**
 * Russell asking a MECHANISM question — why something works/broke, how a design
 * behaves, or saying outright that he doesn't follow. Teaching needs room, and
 * this hook was the machinery that kept denying it.
 *
 * Why this exists (2026-08-11, Russell: "epicycles on epicycles"): CLAUDE.md had
 * FIFTEEN overlapping voice rules, two verbatim duplicates, and they contradicted
 * each other — "WRITE LESS: 3-5 lines" against "Human First: understanding
 * outranks brevity". This checker only ever measured LENGTH, so every collision
 * got resolved toward terse-and-dense: correct, compressed, unreadable. Russell's
 * verdict was literal — "I dont understand this. you should know that." A
 * length-only gate structurally cannot tell "terse and clear" from "terse and
 * impenetrable", so it kept pushing the wrong way.
 *
 * The consolidated rule (`HOW TO TALK TO RUSSELL`) puts first-read understanding
 * ABOVE brevity and requires Khan format — concrete picture first, table last —
 * with the length cap explicitly OFF when the job is making him understand. This
 * regex is that rule's teeth: it reads HIS question, never my own reply, so the
 * exemption cannot be self-granted by writing something that merely looks like a
 * lesson.
 */
export const TEACHING_REQUEST_RE =
  /(\bwhy\b|\bhow (?:come|does|do|did|is|are|can)\b|\bexplain\b|\bwhat(?:'s| is| are) (?:the )?(?:the )?(?:point|idea|difference|tradeoff|mechanism|reason)\b|\bdon'?t (?:really )?(?:understand|get|follow)\b|\bdoesn'?t make sense\b|\bconfus(?:ed|ing)\b|\bthoughts\?|\bwdyt\b|\bmake sense\?|\bi'?m lost\b|\bno idea\b|\bplainly\b|\bplain english\b|\bkhan\b)/i;

/** Escape tokens that waive this rule for one reply. */
export const PROSE_OVERRIDE_RE = /explain-override:|style-override:/i;

/** Classify one line of a reply for paragraph counting. */
export function classifyLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return 'blank';
  if (trimmed.startsWith('```')) return 'codefence';
  if (/^#{1,6}\s/.test(trimmed)) return 'heading';
  if (/^\s*[-*+•]\s/.test(trimmed)) return 'bullet';
  if (/^\s*\d+[.)]\s/.test(trimmed)) return 'bullet';
  if (/^\|.*\|/.test(trimmed)) return 'table';
  if (/^\s*>\s/.test(trimmed)) return 'quote';
  return 'prose';
}

function countWords(passage) {
  return (String(passage ?? '').replace(/[#*_>`~-]/g, ' ').match(/\S+/g) || []).length;
}

/**
 * Measure a reply's shape in ONE pass.
 * Returns { totalWords, proseParagraphs, longestParagraphWords, longParagraphCount }.
 *   - Fenced code blocks are excluded from every measure (quoted machinery isn't prose).
 *   - Bullets / numbered items / tables / headings / block quotes are structure, not prose:
 *     they close the current paragraph and are never counted as one.
 */
export function analyzeProseShape(replyText) {
  const lines = String(replyText ?? '').split('\n');
  let totalWords = 0;
  let proseParagraphs = 0;
  let longestParagraphWords = 0;
  let longParagraphCount = 0;
  let inCodeBlock = false;
  let paragraphLines = 0;
  let paragraphWords = 0;

  const closeParagraph = () => {
    if (paragraphLines > 0) {
      proseParagraphs += 1;
      if (paragraphLines > MAX_PARAGRAPH_LINES) longParagraphCount += 1;
      if (paragraphWords > longestParagraphWords) longestParagraphWords = paragraphWords;
    }
    paragraphLines = 0;
    paragraphWords = 0;
  };

  for (const line of lines) {
    const kind = classifyLine(line);
    if (inCodeBlock) {
      if (kind === 'codefence') inCodeBlock = false;
      continue; // code never counts toward prose OR the word budget
    }
    if (kind === 'codefence') {
      closeParagraph();
      inCodeBlock = true;
      continue;
    }
    if (kind === 'blank' || kind === 'heading' || kind === 'bullet' || kind === 'table' || kind === 'quote') {
      closeParagraph();
      // Structure lines still count toward the TOTAL word budget — a 900-word bullet list is
      // still 900 words Russell has to read. They just aren't "paragraphs".
      totalWords += countWords(line);
      continue;
    }
    const words = countWords(line);
    paragraphLines += 1;
    paragraphWords += words;
    totalWords += words;
  }
  closeParagraph();

  return { totalWords, proseParagraphs, longestParagraphWords, longParagraphCount };
}

/**
 * The ONE verdict for the length/wall rule. Returns an array of violation objects
 * (possibly empty) — the shared style governor turns them into a single message.
 *
 * @param {object} args
 * @param {string} args.reply        the final assistant reply text
 * @param {boolean} args.shipped     did this turn actually mutate files / ship code?
 * @param {boolean} args.depthAsked  did Russell ask for depth this turn?
 */
export function proseShapeViolations({
  reply, shipped = false, depthAsked = false, teachingAsked = false,
} = {}) {
  const replyText = String(reply ?? '');
  if (!replyText.trim()) return [];
  if (PROSE_OVERRIDE_RE.test(replyText)) return [];

  const shape = analyzeProseShape(replyText);
  const wordBudget = shipped ? SHIP_WORD_BUDGET : EXPLAIN_WORD_BUDGET;
  const violations = [];

  // LOOSENED 2026-08-11 (Russell: "epicycles on epicycles", and before that "I
  // dont understand this. you should know that."). A teaching answer needs the
  // Khan shape -- picture, then walk it, then the surprise, then the mapping --
  // which is structurally 3-4 paragraphs. Capping it at 2 forced exactly the
  // compressed, unreadable tables he kept rejecting.
  //
  // The teeth that DO NOT move: the wall check below still fires on any unbroken
  // >110-word block, on every turn including teaching ones. That check is what
  // protects readability; paragraph COUNT never did. So this relaxes how many
  // paragraphs a lesson may have, never whether it may be a slab. `teachingAsked`
  // reads RUSSELL's question, never my own reply, so it cannot be self-granted
  // by writing something that merely looks like a lesson.
  const teachingRoom = teachingAsked && !shipped;

  if (shape.longestParagraphWords > WALL_PARAGRAPH_WORDS) {
    violations.push({
      rule: 'prose-shape',
      kind: 'wall of text',
      measure: `${shape.longestParagraphWords}-word unbroken paragraph (cap is ${WALL_PARAGRAPH_WORDS})`,
    });
  }
  if (shape.proseParagraphs > MAX_PROSE_PARAGRAPHS && !teachingRoom) {
    violations.push({
      rule: 'prose-shape',
      kind: 'too many prose paragraphs',
      measure: `${shape.proseParagraphs} prose paragraphs (cap is ${MAX_PROSE_PARAGRAPHS})`,
    });
  }
  if (shape.longParagraphCount > 0) {
    violations.push({
      rule: 'prose-shape',
      kind: 'over-long paragraph',
      measure: `${shape.longParagraphCount} paragraph(s) over ${MAX_PARAGRAPH_LINES} lines`,
    });
  }
  if (shape.totalWords > wordBudget && !depthAsked && !teachingRoom) {
    violations.push({
      rule: 'prose-shape',
      kind: 'too long overall',
      measure: `~${shape.totalWords} words (budget is ${wordBudget} on ${shipped ? 'a shipping' : 'an explaining'} turn)`,
    });
  }

  if (violations.length === 0) return [];

  // ONE message for the whole rule, however many ways the reply tripped it.
  violations[0].guidance = [
    `Russell's rule (CLAUDE.md Voice & Format): NEVER a wall of text. Hard cap: ${MAX_PROSE_PARAGRAPHS} short`,
    `paragraphs OR a tight bullet list/table. No paragraph >${MAX_PARAGRAPH_LINES} lines. <=${MAX_PROSE_PARAGRAPHS} short paragraphs`,
    'per reply unless Russell asks for more. He has ADHD — correct-but-dense answers do not land.',
    '',
    'Rewrite it SHORT before stopping:',
    '  • BLUF first line — the answer, <=15 words. Reasoning second, detail third (skippable).',
    '  • Bullets/table over prose. Bold the load-bearing words. Say each point once.',
    `  • No paragraph past ${MAX_PARAGRAPH_LINES} lines; break the rest into bullets.`,
    depthAsked ? '' : '  • He did NOT ask for depth this turn — keep it tight.',
    '(If he genuinely asked for the long form, declare it silently: node ~/.claude/scripts/quiet-override.mjs style-override "<why>")',
  ].filter((line) => line !== '').join('\n');

  return violations;
}
