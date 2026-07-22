#!/usr/bin/env node
/**
 * check-runs-before-claiming-unrun — PreToolUse(Write|Edit), TEETH.
 *
 * new-hook-category: Test / verify / root-cause — nearest existing hook is absence-claim-guard.
 * It does NOT cover this: absence-claim-guard is a STOP hook that inspects the final CHAT REPLY for
 * claims that a CODE CAPABILITY is absent, and is satisfied by a repo-wide GREP having run this turn.
 * This is a PreToolUse hook on DOC WRITES, about EXPERIMENT RUN ARTIFACTS, satisfied by a DIRECTORY
 * EXISTENCE check against runs/. Different event, different claim subject, different verification —
 * bolting a PreToolUse artifact-existence mode onto a Stop-time grep-detector would make both worse.
 *
 * WHY (Getty, 2026-07-21 — the same mistake TWICE in one session):
 *   1. Wrote "exp149b seeds 1-2 still open (~$3)" into the proof index. All three seeds had landed
 *      days earlier (runs/exp149b-full-seed{0,1,2}).
 *   2. Wrote "the scrambled-tool control never landed (CUDA-OOM), ~$0.50 to close" into the
 *      BUYER-FACING lab brief. It had actually RUN and FAILED its key gate — with wrong tool values
 *      injected the model still scored 0.958, revealing a memorization shortcut.
 *
 * Both came from quoting a FROZEN PLAN DOC instead of checking runs/ on disk. Plan docs freeze;
 * artifacts don't. Case 2 is the dangerous class: telling a buyer "missing control, $0.50" when the
 * truth is "control ran and exposed a shortcut" does not cost you one claim — it costs credibility
 * on every claim, because a reviewer who finds one misdescribed result re-examines all of them.
 *
 * THE RULE: block a Write/Edit that asserts an experiment is UNRUN / NOT STARTED / NEVER LANDED /
 * STILL OPEN when a run directory for that experiment EXISTS on disk. Go read the artifact and
 * describe what it actually says — including, especially, a failure.
 *
 * HONEST LIMIT: this proves only that a run directory EXISTS — not that the run succeeded, nor that
 * your description of it is accurate. It converts "assume it never ran" into "look at runs/ first",
 * cheaply and mechanically. It cannot make the reading correct.
 *
 * ESCAPE: `runs-verified: <what you checked>` in the content — a real acknowledgment, not a bypass.
 * FAILS OPEN on any parse error, missing runs/ dir, or malformed input.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Docs where a wrong "unrun" claim actually causes damage. Code + comments excluded.
const DOC_PATTERN = /(?:\.md|\.html)$/i;

// Phrasings that assert an experiment did not run.
const UNRUN_PHRASES = [
  /never\s+landed/i,
  /(?:has|have|had)\s+(?:not|never)\s+(?:been\s+)?(?:run|ran|started|landed)/i,
  /not\s+started/i,
  // Bare "still open" too — a table CELL is terse and drops the verb ("| exp149b | ~$3 | still
  // open |"), which is exactly the shape that slipped through on 2026-07-21.
  /\bstill\s+open\b/i,
  /\bunrun\b/i,
  /did\s+not\s+(?:run|land)/i,
  /no\s+result(?:s)?\s+(?:for|on|yet)/i,
  /never\s+ran\b/i,
];

const ESCAPE = /runs-verified\s*:/i;

/** Experiment ids mentioned in a passage, e.g. exp147c, exp149b, exp153. */
function experimentsIn(passage) {
  return [...new Set((passage.match(/\bexp\d+[a-z]?\b/gi) || []).map(id => id.toLowerCase()))];
}

/**
 * Does a run dir exist for this experiment? Matches `exp149b` against `exp149b-full-seed0` but NOT
 * `exp147z` against `exp147c-...` — the character after the id must be a separator or end-of-string,
 * never another id character, so a future sibling id cannot match an existing one by prefix.
 */
function hasRunDirectory(experiment, runsIndex) {
  const boundary = new RegExp(`^${experiment}(?:[-_./]|$)`, 'i');
  return runsIndex.some(entry => boundary.test(entry));
}

export function evaluate(input, opts = {}) {
  const allow = { block: false };
  try {
    const { toolName, filePath } = input || {};
    if (toolName !== 'Write' && toolName !== 'Edit') return allow;
    if (!filePath || !DOC_PATTERN.test(filePath)) return allow;

    const claimText = input.content || input.new_string || '';
    if (!claimText) return allow;
    if (ESCAPE.test(claimText)) return allow;

    const runsIndex = opts.runsIndex;
    if (!Array.isArray(runsIndex) || runsIndex.length === 0) return allow; // fail open

    // The unrun phrase and the experiment id must sit in the SAME sentence, so unrelated prose
    // elsewhere in a long document cannot manufacture a match.
    // NOTE: split on sentence-enders and NEWLINES only — never on `|`. A markdown table row is one
    // line, and `|` is its column delimiter; splitting on it tore "| exp149b | ... | still open |"
    // into separate fragments so the id and the phrase never met. That row shape is precisely where
    // these claims live (caught by TDD, 2026-07-21).
    for (const sentence of claimText.split(/(?<=[.!?\n])/)) {
      if (!UNRUN_PHRASES.some(phrase => phrase.test(sentence))) continue;
      for (const experiment of experimentsIn(sentence)) {
        if (hasRunDirectory(experiment, runsIndex)) {
          return { block: true, experiment, sentence: sentence.trim().slice(0, 160) };
        }
      }
    }
    return allow;
  } catch {
    return allow; // never block a legitimate write because the hook itself broke
  }
}

export function readRunsIndex(repositoryRoot) {
  try {
    const runsDirectory = join(repositoryRoot, 'runs');
    if (!existsSync(runsDirectory)) return null;
    return readdirSync(runsDirectory);
  } catch {
    return null;
  }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // fail open
  }
  const toolInput = payload?.tool_input || {};
  const repositoryRoot = payload?.cwd || process.cwd();
  const verdict = evaluate(
    {
      toolName: payload?.tool_name,
      filePath: toolInput.file_path,
      content: toolInput.content,
      new_string: toolInput.new_string,
    },
    { runsIndex: readRunsIndex(repositoryRoot) },
  );

  if (!verdict.block) process.exit(0);

  const reason =
    `CLAIMING AN EXPERIMENT IS UNRUN, BUT runs/${verdict.experiment}* EXISTS ON DISK.\n\n` +
    `  Your text: "${verdict.sentence}"\n\n` +
    `This is the exact mistake from 2026-07-21, made TWICE in one session — both times by quoting a\n` +
    `frozen plan doc instead of checking runs/. The second one wrote "the scrambled-tool control never\n` +
    `landed, ~$0.50 to close" into the BUYER-FACING lab brief, when that control had actually RUN and\n` +
    `FAILED its key gate. Telling a buyer "missing control" when the truth is "control ran and exposed\n` +
    `a shortcut" does not cost one claim — it costs credibility on every claim.\n\n` +
    `DO THIS: read the artifacts under runs/${verdict.experiment}* (and any matching docs/*METHODS*.md),\n` +
    `then describe what they ACTUALLY say — including a failure, if that is what happened.\n\n` +
    `If you HAVE checked and the directory is stale or empty, say so explicitly:\n` +
    `  runs-verified: <what you checked and what you found>`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
