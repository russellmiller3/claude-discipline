#!/usr/bin/env node
// =============================================================================
// EXPERIMENT-PROPAGATION-REQUIRED — a landed result must reach the ledger NOW
// =============================================================================
//
// new-hook-category: Experiment record integrity — nearest existing hook is
// `methods-on-result` (which forces a METHODS doc when a result file lands).
// This one is strictly wider: METHODS is only ONE of four surfaces a result has
// to move, and the other three were exactly the ones that drifted.
//
// WHY (Russell, 2026-07-22, verbatim: "adjust your hooks s.t. you update lab nda
// and priority board and truth ledger and methods doc immediately after an
// experiment lands"): in a single session TWO complete experiments landed with
// full gate batteries, both got METHODS docs — and neither reached the truth
// ledger, the NDA brief, or the priority board. The brief kept advertising a
// weakness that had just been repaired, and the board kept prescribing a fix
// that had just been disproven. A buyer reading either would have been reading
// something false.
//
// The deeper failure mode this closes: writing the METHODS doc FEELS like
// finishing, so the propagation step gets deferred to "next session" and then
// inherited as debt. This is the same shape as the 4,300x headline that went 24
// hours with no journal-grade record.
//
// HOW IT WORKS: on Stop, detect experiments whose RESULT was touched this
// session (a `runs/<exp>/...result...` path, or a per-seed `runs/<exp>/*.json`).
// For each, require that all four ledger surfaces were written/edited this
// session: the experiment's own METHODS doc, the truth ledger, the NDA brief,
// and the priority board. Name the missing ones.
//
// TEETH: Stop decision 'block'. Escape: EXPERIMENT_PROPAGATION_OK=1 in env, or
// the token EXPERIMENT_PROPAGATION_OK in the reply (use when the run is still
// in flight and the numbers are not final). Respects stop_hook_active (never
// loops). FAILS OPEN on any error. basename entry-guard.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, toolUsesOf, lastAssistantText } from './lib/transcript.mjs';

const ENV_OVERRIDE = 'EXPERIMENT_PROPAGATION_OK';
const ESCAPE_TOKEN = /\bEXPERIMENT_PROPAGATION_OK\b/;

// A RESULT artifact: something under runs/<exp>/ that is a result file — either
// an explicit *result* name, or a per-seed .json/.jsonl the workers write.
// Deliberately NOT matched: plans/, scripts/, docs/, and live feeds (a live
// JSONL is a dashboard mirror, not a landed result).
const RESULT_PATH_RE = /runs[\/\\](exp\w+?)[\/\\][^\s"']*?(?:result[^\s"']*\.jsonl?|seed\d*[^\s"']*\.json)\b/gi;
const LIVE_FEED_RE = /[-_]live\.jsonl/i;

const SURFACES = [
  { label: 'truth ledger', test: (path) => /Marcus-Truth\.md$/i.test(path) },
  { label: 'NDA brief', test: (path) => /LAB-BRIEF-NDA\.html$/i.test(path) },
  { label: 'priority board', test: (path) => /LAB-PRIORITY-BOARD\.html$/i.test(path) },
];

/** Flatten a transcript into ordered tool-uses with the fields we care about. */
function toolUsesInOrder(entries) {
  const toolUses = [];
  for (const entry of entries || []) {
    for (const block of toolUsesOf(entry)) {
      toolUses.push({
        name: block?.name || '',
        command: block?.input?.command || '',
        filePath: block?.input?.file_path || '',
      });
    }
  }
  return toolUses;
}

/**
 * Experiment slugs whose RESULT artifact was touched this session.
 * Reading a result IS landing it for our purposes — you cannot report a number
 * you never read, and every real landing in practice reads the file.
 */
export function landedResultSlugs(entries) {
  const toolUses = Array.isArray(entries) && entries[0]?.name !== undefined
    ? entries : toolUsesInOrder(entries);
  const slugs = new Set();
  for (const toolUse of toolUses) {
    const haystack = `${toolUse.command || ''} ${toolUse.filePath || ''}`;
    for (const match of haystack.matchAll(RESULT_PATH_RE)) {
      if (LIVE_FEED_RE.test(match[0])) continue;   // a dashboard mirror, not a result
      slugs.add(match[1].toLowerCase());
    }
  }
  return [...slugs];
}

/** Ledger surfaces NOT written/edited this session for this experiment. */
export function missingSurfaces(entries, slug) {
  const toolUses = Array.isArray(entries) && entries[0]?.name !== undefined
    ? entries : toolUsesInOrder(entries);
  const writtenPaths = toolUses
    .filter((toolUse) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolUse.name))
    .map((toolUse) => toolUse.filePath || '');

  const missing = [];
  // The METHODS doc must belong to THIS experiment — a sibling's doc does not count.
  const methodsRe = new RegExp(`${slug}[\\w-]*METHODS\\.md$`, 'i');
  if (!writtenPaths.some((path) => methodsRe.test(path))) missing.push('METHODS doc');
  for (const surface of SURFACES) {
    if (!writtenPaths.some((path) => surface.test(path))) missing.push(surface.label);
  }
  return missing;
}

// What to do about each surface — only the MISSING ones are printed, so the
// instructions never tell you to redo work you already did this session.
const SURFACE_GUIDANCE = {
  'METHODS doc': '  - METHODS doc     docs/<exp>-*-METHODS.md   purpose / recipe / provenance / result',
  'truth ledger': '  - truth ledger    Marcus-Truth.md           the PROOF INDEX row for this claim',
  'NDA brief': '  - NDA brief       docs/LAB-BRIEF-NDA.html   move the not-proven row, or add the caveat',
  'priority board': '  - priority board  docs/LAB-PRIORITY-BOARD.html  re-rank or correct the item this result touched',
};

const reasonFor = (gapsBySlug) => {
  const lines = gapsBySlug
    .map(({ slug, missing }) => `  ${slug} -> still missing: ${missing.join(', ')}`)
    .join('\n');
  const stillMissing = [...new Set(gapsBySlug.flatMap((gap) => gap.missing))];
  const guidance = stillMissing.map((surface) => SURFACE_GUIDANCE[surface]).filter(Boolean).join('\n');
  return `EXPERIMENT RESULT NOT PROPAGATED — the ledger still says something false.

${lines}

Russell's rule (2026-07-22, verbatim: "update lab nda and priority board and truth ledger and
methods doc immediately after an experiment lands"). In ONE session two complete experiments
landed with full gate batteries, both got METHODS docs, and NEITHER reached the truth ledger,
the brief, or the board. The brief kept advertising a weakness that had just been repaired; the
board kept prescribing a fix that had just been disproven. A buyer reading either was reading
something false.

Writing the METHODS doc FEELS like finishing — that is exactly why the rest gets deferred to
"next session" and inherited as debt.

Update each missing surface now:
${guidance}

HOW to update them (Russell, 2026-07-22 — these are DELETE-and-MOVE rules, not append rules):
  - NDA brief: a proven item is DELETED from "What is not proven" ENTIRELY — not re-labelled, not
    struck through, not left with a "repaired" badge. Its evidence moves UP into the architecture
    table where the claim itself lives, and the CORE CLAIM in that row is rewritten to state what is
    now true. A shrinking list is the point; that section is the honest remainder, not a changelog.
  - priority board: a proven item LEAVES the ranked list and moves to the "Done" table, and every
    item below it is RENUMBERED so the ranked list is always only the work that remains.
  - truth ledger + METHODS doc: these are where correction history belongs — strike-throughs, the
    prescription that turned out wrong, and the honest scope of what the result does NOT prove.

Escape (the run is still in flight and the numbers are NOT final): put ${ENV_OVERRIDE} in your
reply, or set ${ENV_OVERRIDE}=1.`;
};

/**
 * PURE core. Returns { block, reason? }. Never throws on malformed input.
 */
export function evaluate({ entries = [], replyText = '', stopHookActive = false, envOk = false } = {}) {
  if (envOk || stopHookActive) return { block: false };
  if (ESCAPE_TOKEN.test(replyText || '')) return { block: false };

  const toolUses = toolUsesInOrder(entries);
  const slugs = landedResultSlugs(toolUses);
  if (slugs.length === 0) return { block: false };

  const gapsBySlug = slugs
    .map((slug) => ({ slug, missing: missingSurfaces(toolUses, slug) }))
    .filter((gap) => gap.missing.length > 0);
  if (gapsBySlug.length === 0) return { block: false };
  return { block: true, reason: reasonFor(gapsBySlug) };
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
    const verdict = evaluate({ entries, replyText: lastAssistantText(entries) });
    if (!verdict.block) process.exit(0);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate stop
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
