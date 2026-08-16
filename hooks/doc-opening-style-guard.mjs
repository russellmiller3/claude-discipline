#!/usr/bin/env node
/**
 * doc-opening-style-guard — PreToolUse(Write|Edit). The style rules already applied to
 * CHAT, applied to the opening of a human-facing markdown file.
 *
 * WHY (Russell, 2026-08-17, twice in one session: "this reads like gibberish, what is your
 * goal here?"): both complaints were about text written INTO a file, not a chat message.
 * The style governor (lib/style-verdict.mjs) runs at Stop and grades the assistant's REPLY.
 * It never sees a Write or Edit, so chat stayed readable while HANDOFF.md, plans and docs
 * drifted into internal shorthand — commit hashes, function names, private jargon.
 *
 * ONE HOOK PER IDEA (HOOKBOOK "Output style / voice" swept first): jargon-gloss-guard,
 * wall-text-guard, style-governor and narration-cadence-guard are all Stop hooks grading
 * the reply — none can see a Write. tone-copy-check is the only Write-side prose guard and
 * it polices condescension toward an EXTERNAL recipient, a different rule entirely. So this
 * is a new hook, but the wall-of-text threshold is IMPORTED from lib/prose-shape.mjs rather
 * than re-implemented, and the gloss markers mirror the chat-side jargon guard.
 *
 * WHAT ACTUALLY SEPARATES THE TWO REAL FAILURES FROM THE GOOD REWRITE (measured against
 * the real git blobs, not imagined): the literal spec was "an opening that LEADS WITH a
 * symbol name or commit hash". Both real failures led with a perfectly plain sentence
 * ("Read top to bottom...") and then filled the opening SECTION with machine nouns. A
 * leads-with check would have caught neither. So the rule is DENSITY of UNGLOSSED machine
 * identifiers in the opening window:
 *   - failure A (HANDOFF.md before d4f07eb): fix/share-snapshot-derivations, 02b59f7,
 *     codeservo-wt/..., code_entries_for_snapshot, learnings.md, time_unnamed_remainder.py
 *   - failure B (HANDOFF.md before c7785de): finish_task, build_cockpit, d055b1d,
 *     _file_first_inventory, inspect_code
 *   - the good rewrite: 1 unglossed (every other identifier carries a dash-gloss)
 *
 * SCOPE — the part a person reads cold, nothing more:
 *   - Only HANDOFF.md, README*, and .md under a plans/ or docs/ segment.
 *   - Only the first OPENING_WORDS words of the body. Dense reference detail below is
 *     legitimately dense and stays allowed.
 *   - Never a code file, never a test.
 *   - On Edit, the RESULTING file text is graded (guard the STATE, not the fragment), so
 *     an edit far below the opening is free.
 *
 * Escape: env DOC_OPENING_STYLE_OK=1, the literal token in the text, or silently via
 *   node ~/.claude/scripts/quiet-override.mjs doc-opening-style "<why>"
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WALL_PARAGRAPH_WORDS, analyzeProseShape } from './lib/prose-shape.mjs';
import { overrideStated } from './lib/quiet-overrides.mjs';

const ENV_OVERRIDE = 'DOC_OPENING_STYLE_OK';
const ESCAPE_TOKEN = /\bDOC_OPENING_STYLE_OK\b/;

/** How much of the body counts as "the part Russell reads cold". */
export const OPENING_WORDS = 250;
/** How many unglossed machine identifiers the opening may carry before it reads as shorthand. */
export const MAX_UNGLOSSED_IDENTIFIERS = 3;

/** Same gloss markers the chat-side jargon guard uses — one definition of "explained nearby". */
const GLOSS_MARKERS = [
  /\([^)]{8,}\)/,
  /\s[-–—]\s+[a-z]/,
  /:\s+[a-z]/,
  /\b(which means|meaning|in other words|think of it like|basically|plain english|i\.e\.|that is,|a way (of|to)|a method for|a technique for)\b/i,
];

/** Is this a markdown file a person reads cold, top to bottom? */
export function isColdReadDoc(filePath) {
  const docPath = String(filePath || '').replace(/\\/g, '/');
  if (!docPath) return false;
  const fileName = basename(docPath);
  if (/^HANDOFF\.md$/i.test(fileName)) return true;
  if (/^README(\.md|\.markdown)?$/i.test(fileName)) return true;
  if (extname(fileName).toLowerCase() !== '.md') return false;
  return docPath.toLowerCase().split('/').slice(0, -1)
    .some((pathSegment) => pathSegment === 'plans' || pathSegment === 'docs');
}

/**
 * A MACHINE identifier: something with no meaning to a reader who has not seen the code.
 * Deliberately shape-based, so an ordinary capitalised English word in backticks
 * (`Write`, `Edit`, `Stop`) is NOT one — those are tool names Russell already reads daily.
 */
function isMachineIdentifier(word) {
  const bare = stripMarkup(word);
  if (bare.length < 4 || bare.length > 60) return false;
  if (/^[0-9a-f]{7,40}$/.test(bare)) return true;              // commit hash
  if (/[a-z0-9]_[a-z0-9]/i.test(bare)) return true;            // snake_case
  if (/^_[a-z]/i.test(bare)) return true;                      // _private
  if (/[a-z]\/[a-z0-9._-]/i.test(bare)) return true;           // a/path or a/branch
  if (/[a-z]\.[a-z]{2,4}$/i.test(bare)) return true;           // file.ext
  if (/^[a-z]+[A-Z]/.test(bare)) return true;                  // camelCase
  if (/\(\)$/.test(bare)) return true;                         // call()
  return false;
}

/** Strip markdown emphasis, backticks and trailing punctuation from one word. */
function stripMarkup(word) {
  return String(word || '').replace(/^[`*_"'([{<]+|[`*_"')\]}>.,;:!?]+$/g, '');
}

function sentencesOf(passage) {
  return String(passage || '').split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
}

/** The first OPENING_WORDS words of the body (the H1 title line is not body). */
export function openingWindow(docText) {
  const lines = String(docText || '').split('\n');
  const titleIndex = lines.findIndex((line) => /^#\s/.test(line.trim()));
  const bodyLines = lines.slice(titleIndex >= 0 ? titleIndex + 1 : 0);
  const kept = [];
  let wordCount = 0;
  for (const line of bodyLines) {
    kept.push(line);
    wordCount += (line.match(/\S+/g) || []).length;
    if (wordCount >= OPENING_WORDS) break;
  }
  return kept.join('\n');
}

/**
 * PURE core. Returns { block, reason? }. Never throws.
 * `docText` is the FULL resulting document, not an edit fragment.
 */
export function evaluate({ path = '', docText = '', envOk = false } = {}) {
  if (envOk) return { block: false };
  if (!isColdReadDoc(path)) return { block: false };
  if (ESCAPE_TOKEN.test(docText)) return { block: false };
  if (overrideStated('doc-opening-style', '')) return { block: false };

  const opening = openingWindow(docText);
  if (!opening.trim()) return { block: false };

  const sentences = sentencesOf(opening);
  const unglossed = [];
  const alreadyCounted = new Set();
  for (let index = 0; index < sentences.length; index++) {
    const nearbyText = sentences.slice(index, index + 2).join(' ');
    const isGlossed = GLOSS_MARKERS.some((marker) => marker.test(nearbyText));
    for (const word of sentences[index].split(/\s+/)) {
      if (!isMachineIdentifier(word)) continue;
      const key = stripMarkup(word).toLowerCase();
      if (alreadyCounted.has(key)) continue;
      alreadyCounted.add(key);
      if (!isGlossed) unglossed.push(key);
    }
  }

  const problems = [];
  if (unglossed.length > MAX_UNGLOSSED_IDENTIFIERS) {
    problems.push(
      `${unglossed.length} machine names in the opening with no plain-English gloss: `
      + unglossed.slice(0, 8).map((name) => `"${name}"`).join(', ')
    );
  }
  const { longestParagraphWords } = analyzeProseShape(opening);
  if (longestParagraphWords > WALL_PARAGRAPH_WORDS) {
    problems.push(`a ${longestParagraphWords}-word unbroken paragraph (cap is ${WALL_PARAGRAPH_WORDS})`);
  }
  if (problems.length === 0) return { block: false };

  return {
    block: true,
    reason: [
      `BLOCKED — the opening of ${basename(String(path).replace(/\\/g, '/'))} reads like internal shorthand.`,
      '',
      'Russell reads this file cold, the same way he reads chat. Found in the first '
        + `${OPENING_WORDS} words:`,
      ...problems.map((problem) => `  - ${problem}`),
      '',
      'Fix the OPENING only (dense reference detail further down is fine):',
      '  - Say what the thing IS in a plain sentence before naming any file, branch or symbol.',
      '  - Gloss each machine name where it first appears — a dash-clause or parenthetical is enough:',
      '      "the librarian (the part that answers questions about the repo)"',
      '  - Or move the hash/branch/path into a footnote below the opening, where it belongs.',
      '',
      'Legitimate exception, declared silently:',
      '  node ~/.claude/scripts/quiet-override.mjs doc-opening-style "<why>"',
    ].join('\n'),
  };
}

/** The document text this call will RESULT in — the state, not the fragment. */
export function resultingText(toolName, toolInput) {
  if (toolName === 'Write') return String(toolInput.content || '');
  let currentText = '';
  try { currentText = readFileSync(toolInput.file_path || '', 'utf8'); } catch { return ''; }
  const oldString = String(toolInput.old_string ?? '');
  const newString = String(toolInput.new_string ?? '');
  if (!oldString || !currentText.includes(oldString)) return ''; // can't model it -> fail open
  return toolInput.replace_all
    ? currentText.split(oldString).join(newString)
    : currentText.replace(oldString, newString);
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if (process.env[ENV_OVERRIDE] === '1') process.exit(0);

  const toolName = event.tool_name || '';
  if (toolName !== 'Write' && toolName !== 'Edit') process.exit(0);

  const toolInput = event.tool_input || {};
  const verdict = evaluate({
    path: toolInput.file_path || '',
    docText: resultingText(toolName, toolInput),
  });
  if (!verdict.block) process.exit(0);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason,
    },
  }));
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  try { main(); } catch { process.exit(0); } // fail open on any unexpected error
}
