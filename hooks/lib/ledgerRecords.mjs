/**
 * ledgerRecords — the LEDGER-repo experiment-record integrity core, one library.
 *
 * Consolidated 2026-07-15 (Russell, "ledger 5->1"): the ledger repo's record-sync hooks were separate files
 * that shared `effectiveDirectory` + `isLedgerRepo` + the commit-diff scaffolding verbatim. They're one idea —
 * "the ledger's experiment records stay complete and in sync." This lib holds every pure function (ported
 * VERBATIM from the tested originals, so the risk is only in the dispatcher wiring); ledger-records-guard.mjs
 * event-routes them. Retired: ledger-results-toc-on-touch, ledger-experiment-doc-sync, experiment-record-drift-guard.
 * (Also cleaned two DANGLING registrations whose files no longer existed: methods-freshness-guard,
 * results-freshness-guard.)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

// ── shared: repo resolution + ledger scoping (was identical in both PreToolUse hooks) ────────────────────────
// Resolve the directory a `git commit` actually runs in: the LAST `cd <dir>` before the first commit, else
// `git -C <dir>`, else the session dir (same proven resolution as no-commit-to-main.mjs).
export function effectiveDirectory(normalizedCommand, sessionDirectory) {
  const commitIndex = normalizedCommand.search(/\bgit\s+commit\b/);
  const beforeCommit = commitIndex === -1 ? normalizedCommand : normalizedCommand.slice(0, commitIndex);
  const cdMatches = [...beforeCommit.matchAll(/(?:^|&&|;)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/g)];
  if (cdMatches.length) {
    const lastCd = cdMatches[cdMatches.length - 1];
    return lastCd[1] || lastCd[2] || lastCd[3];
  }
  const dashCMatch = normalizedCommand.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (dashCMatch) return dashCMatch[1] || dashCMatch[2] || dashCMatch[3];
  return sessionDirectory;
}

// The ledger repo: basename `ledger`, OR the marker pair RESULTS.md + Truth-ledger.md both at the root.
export function isLedgerRepo(repoRoot) {
  if (!repoRoot) return false;
  if (basename(repoRoot).toLowerCase() === 'ledger') return true;
  return existsSync(join(repoRoot, 'RESULTS.md')) && existsSync(join(repoRoot, 'Truth-ledger.md'));
}

// ── PreToolUse check 1 — RESULTS.md TOC touched on any RESULTS.md change (was ledger-results-toc-on-touch) ────
// Did any ADDED/REMOVED diff line fall inside RESULTS.md's Table-of-Contents region? Reconstructs the new
// file's line numbers from hunk headers. No TOC region at all => conservative "touched" (don't block).
export function tocRegionWasTouched(stagedDiffForResults, newFileContents) {
  if (!stagedDiffForResults) return false;
  const newLines = String(newFileContents || '').split('\n');
  let tocStart = -1;
  for (let i = 0; i < newLines.length; i++) {
    if (/^##\s+Table of Contents/i.test(newLines[i])) { tocStart = i; break; }
  }
  if (tocStart === -1) return true;
  let tocEnd = tocStart;
  let sawTable = false;
  for (let i = tocStart + 1; i < newLines.length; i++) {
    const line = newLines[i];
    if (/^\s*\|/.test(line)) { sawTable = true; tocEnd = i; continue; }
    if (!sawTable && line.trim() === '') continue;
    if (sawTable && line.trim() === '') break;
    if (sawTable) break;
  }
  const changedNewLineIndices = new Set();
  let newLineCursor = 0;
  for (const diffLine of String(stagedDiffForResults).split('\n')) {
    const hunkHeader = diffLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkHeader) { newLineCursor = parseInt(hunkHeader[1], 10) - 1; continue; }
    if (diffLine.startsWith('+++') || diffLine.startsWith('---')) continue;
    if (diffLine.startsWith('+')) { changedNewLineIndices.add(newLineCursor); newLineCursor++; }
    else if (diffLine.startsWith('-')) { changedNewLineIndices.add(newLineCursor); }
    else if (diffLine.startsWith(' ')) { newLineCursor++; }
  }
  for (const changedIndex of changedNewLineIndices) {
    if (changedIndex >= tocStart && changedIndex <= tocEnd) return true;
  }
  return false;
}

// ── PreToolUse check 2 — new experiment must move its sync docs (was ledger-experiment-doc-sync) ─────────────
export const REQUIRED_SYNC_DOCS = ['METHODS.md', 'Truth-ledger.md', 'explainer.html'];

export function addsNewExperimentHeading(stagedDiffForResults) {
  if (!stagedDiffForResults) return false;
  for (const diffLine of String(stagedDiffForResults).split('\n')) {
    if (diffLine.startsWith('+++')) continue;
    if (!diffLine.startsWith('+')) continue;
    if (/^\s*##\s+exp/i.test(diffLine.slice(1))) return true;
  }
  return false;
}

export function missingSyncDocs(stagedFileNames) {
  const stagedSet = new Set(String(stagedFileNames || '').split('\n').map((name) => name.trim()).filter(Boolean));
  return REQUIRED_SYNC_DOCS.filter((doc) => !stagedSet.has(doc));
}

// ── Stop check — cross-doc drift + clobber (was experiment-record-drift-guard) ───────────────────────────────
const DOCS = ['Truth-ledger.md', 'RESULTS.md', 'METHODS.md'];
const MIN_EXP_ID = 13;
const MAX_EXP_ID = 99;
const FRONTIER_WINDOW = 15;
const NOT_RUN_CUE = /\b(queued|planned|not run|unrun|never run|will run|to run|owed|to-?do|next mountain|built[^.]{0,20}\bnot\b)\b/i;
const isValidExpId = (expId) => expId >= MIN_EXP_ID && expId <= MAX_EXP_ID;
const keepValid = (ids) => new Set([...ids].filter(isValidExpId));

export function allExpIds(docBody) {
  const ids = new Set();
  for (const [, digits] of String(docBody).matchAll(/\bexp(\d+)\b/gi)) {
    if (isValidExpId(Number(digits))) ids.add(Number(digits));
  }
  return ids;
}

export function resultsEntryIds(resultsBody) {
  const ids = new Set();
  for (const line of String(resultsBody).split(/\r?\n/)) {
    const header = /^##\s+.*\bexp(\d+)\b/i.exec(line);
    if (header) ids.add(Number(header[1]));
    const tocRow = /^\|\s*(\d+)\s*\|\s*20\d\d-\d\d-\d\d\b/.exec(line);
    if (tocRow) ids.add(Number(tocRow[1]));
  }
  return keepValid(ids);
}

export function methodsEntryIds(methodsBody) {
  const ids = new Set();
  for (const line of String(methodsBody).split(/\r?\n/)) {
    const header = /^###\s+.*\bexp(\d+)\b/i.exec(line);
    if (header) ids.add(Number(header[1]));
    const tocRow = /^\|\s*§?8\.\d+\s*\|\s*exp(\d+)\b/i.exec(line);
    if (tocRow) ids.add(Number(tocRow[1]));
  }
  return keepValid(ids);
}

export function truthRealIds(truthBody) {
  const realIds = new Set();
  const mentionRe = /\bexp(\d+)\b/gi;
  let mention;
  while ((mention = mentionRe.exec(String(truthBody))) !== null) {
    const expId = Number(mention[1]);
    if (!isValidExpId(expId)) continue;
    const window = String(truthBody).slice(Math.max(0, mention.index - 120), mention.index + 120);
    if (!NOT_RUN_CUE.test(window)) realIds.add(expId);
  }
  return realIds;
}

function clobberedDocs(root) {
  const hits = [];
  let numstat;
  try {
    numstat = execFileSync('git', ['-C', root, 'diff', '--numstat', '--', ...DOCS], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return hits; }
  for (const line of numstat.split(/\r?\n/)) {
    const numstatRow = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!numstatRow) continue;
    const [, insertionsField, deletionsField, file] = numstatRow;
    const insertions = insertionsField === '-' ? 0 : Number(insertionsField);
    const deletions = deletionsField === '-' ? 0 : Number(deletionsField);
    if (deletions >= 30 && insertions * 3 < deletions) hits.push({ file, insertions, deletions });
  }
  return hits;
}

export function analyzeDrift(root, readDoc = (path) => readFileSync(path, 'utf8')) {
  if (!DOCS.every((doc) => existsSync(join(root, doc)))) return null; // gate: only a Legible-style ledger repo
  const inResults = resultsEntryIds(readDoc(join(root, 'RESULTS.md')));
  const inMethods = methodsEntryIds(readDoc(join(root, 'METHODS.md')));
  const truthText = readDoc(join(root, 'Truth-ledger.md'));
  const realInTruth = truthRealIds(truthText);
  const mentionedInTruth = allExpIds(truthText);
  const universe = new Set([...inResults, ...realInTruth]);
  if (universe.size === 0) return { problems: [], methodsAdvisory: [], clobbers: clobberedDocs(root) };
  const frontier = Math.max(...universe);
  const windowFloor = frontier - FRONTIER_WINDOW;
  const canonical = [...universe].filter((expId) => expId >= windowFloor).sort((first, second) => first - second);
  const problems = [];
  for (const expId of canonical) {
    const missing = [];
    if (!inResults.has(expId)) missing.push('RESULTS.md (no `## …expN` entry or dated TOC row)');
    if (!mentionedInTruth.has(expId)) missing.push('Truth-ledger.md (not mentioned at all)');
    if (missing.length) problems.push({ expId, missing });
  }
  const methodsAdvisory = canonical.filter((expId) => !inMethods.has(expId));
  return { problems, methodsAdvisory, clobbers: clobberedDocs(root) };
}

export function buildDriftReason({ problems, methodsAdvisory, clobbers }) {
  const lines = [];
  if (clobbers.length) {
    lines.push('RECORD CLOBBER — a canonical doc has a large UNCOMMITTED deletion (stale-tree revert shape):');
    for (const clobber of clobbers) lines.push(`  • ${clobber.file}: ${clobber.deletions} lines deleted, ${clobber.insertions} inserted (uncommitted).`);
    lines.push('  FIX: `git checkout HEAD -- <file>` to restore the committed version, verify the entries are back, THEN stop.');
    lines.push('');
  }
  if (problems.length) {
    lines.push('EXPERIMENT RECORD DRIFT — a recent experiment is not recorded in both comprehensive docs.');
    lines.push('(Rule: every run gets its OWN entry in RESULTS.md AND a Truth-ledger mention.)');
    lines.push('');
    for (const problem of problems) lines.push(`  • exp${problem.expId} — missing from: ${problem.missing.join('; ')}`);
    lines.push('');
    lines.push('FIX: add the missing standalone entry (not just an inline mention), then stop.');
    lines.push('If exp is BUILT-but-NEVER-RUN, mark it queued/planned in Truth-ledger (it is then excluded).');
    lines.push('');
  }
  if ((clobbers.length || problems.length) && methodsAdvisory.length) {
    lines.push(`ADVISORY (not blocking) — recent experiments with no METHODS §8.x entry: ${methodsAdvisory.map((expId) => 'exp' + expId).join(', ')}.`);
    lines.push('METHODS is selective by convention, so this is a nudge, not a block — add a §8.x entry if the experiment warrants a reproducibility spec.');
    lines.push('');
  }
  lines.push('Override (rare): set RECORD_DRIFT_OVERRIDE=1 in the environment.');
  return lines.join('\n');
}
