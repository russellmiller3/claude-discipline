#!/usr/bin/env node
/**
 * ledger-records-guard — ONE hook for the LEDGER repo's experiment-record integrity.
 *
 * Consolidated 2026-07-15 (Russell, "ledger 5->1"). Event-routed over lib/ledgerRecords.mjs:
 *   PreToolUse(Bash), on a `git commit` in the ledger repo:
 *     • TOC-on-touch  → DENY  if RESULTS.md changed but its Table-of-Contents region wasn't updated
 *                             (override RESULTS_TOC_OK).
 *     • doc-sync      → ASK   if the commit adds a new `## exp…` section but doesn't stage METHODS.md +
 *                             Truth-ledger.md + explainer.html (override EXP_DOC_SYNC_OK).
 *   Stop:
 *     • drift/clobber → BLOCK on cross-doc record drift (a recent exp not in both RESULTS + Truth) or a
 *                             large uncommitted deletion in a canonical doc (override RECORD_DRIFT_OVERRIDE).
 *
 * Retired: ledger-results-toc-on-touch, ledger-experiment-doc-sync, experiment-record-drift-guard. Also cleaned
 * two DANGLING settings.json registrations whose files no longer existed (methods-freshness-guard,
 * results-freshness-guard). Ledger-scoped — a silent no-op in every other repo. Fail-open on any error.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  effectiveDirectory, isLedgerRepo, tocRegionWasTouched,
  addsNewExperimentHeading, missingSyncDocs, analyzeDrift, buildDriftReason,
} from './lib/ledgerRecords.mjs';

const TOC_REASON = [
  'RESULTS.md changed but its TOC was not — blocked.',
  '',
  'Ledger rule ("Experiment Record + Explainer Discipline"): on ANY touch of RESULTS.md, ALWAYS update',
  'its Table of Contents (add or renumber the entry in the `| Exp | Date | … |` table near the top).',
  'The classic miss is appending a `## exp…` section without adding its TOC row — the index silently',
  'drifts out of sync with the log.',
  '',
  'Fix: add/renumber the RESULTS.md TOC row for this change, re-stage, and commit again.',
  '',
  'Override (rare — a RESULTS.md edit that genuinely does not warrant a TOC change): RESULTS_TOC_OK=1',
].join('\n');

function syncReason(missing) {
  return [
    'New experiment recorded in RESULTS.md, but the sync docs did NOT all move with it — confirm before committing.',
    '',
    `Missing from this commit: ${missing.join(', ')}`,
    '',
    'Ledger rule: on EVERY experiment (good OR failed) update RESULTS.md + METHODS.md + Truth-ledger.md +',
    'explainer.html in the SAME session. Two things silently ROT when this is skipped:',
    '  1. The NORTH STARS block at the TOP of Truth-ledger.md — THE SOURCE OF TRUTH. Did the affected row(s) move?',
    "  2. The explainer.html north-star SCORECARD + this experiment's own interactive — did they update?",
    '',
    'Stage them now (update the North Star rows + the explainer scorecard) and re-commit, or if they land',
    'later THIS session escape with: EXP_DOC_SYNC_OK=1',
  ].join('\n');
}

function gitCapture(args, workingDirectory) {
  return execSync(args, { encoding: 'utf8', cwd: workingDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** PreToolUse(Bash) commit-time checks. Returns { decision:'deny'|'ask', reason } or null. */
export function commitCheck(event) {
  if (event.tool_name !== 'Bash') return null;
  const command = (event.tool_input && event.tool_input.command) || '';
  if (typeof command !== 'string') return null;
  const normalizedCommand = command.replace(/\s+/g, ' ').trim();
  if (!/\bgit\s+commit\b/.test(normalizedCommand)) return null;

  const tocOverride = process.env.RESULTS_TOC_OK === '1' || /\bRESULTS_TOC_OK\b/.test(normalizedCommand);
  const syncOverride = process.env.EXP_DOC_SYNC_OK === '1' || /\bEXP_DOC_SYNC_OK\b/.test(normalizedCommand);
  if (tocOverride && syncOverride) return null;

  const targetDirectory = effectiveDirectory(normalizedCommand, event.cwd || process.cwd());
  let repoRoot;
  try { repoRoot = gitCapture('git rev-parse --show-toplevel', targetDirectory).trim(); } catch { return null; }
  if (!isLedgerRepo(repoRoot)) return null;

  let stagedNames;
  try { stagedNames = gitCapture('git diff --cached --name-only', repoRoot); } catch { return null; }
  if (!stagedNames.split('\n').some((name) => name.trim() === 'RESULTS.md')) return null;

  let stagedDiffForResults = '';
  let newResultsContents = '';
  try {
    stagedDiffForResults = gitCapture('git diff --cached -U0 -- RESULTS.md', repoRoot);
    newResultsContents = gitCapture('git show :RESULTS.md', repoRoot);
  } catch { return null; }

  // Check 1 — TOC (hard deny). Runs unless overridden.
  if (!tocOverride && !tocRegionWasTouched(stagedDiffForResults, newResultsContents)) {
    return { decision: 'deny', reason: TOC_REASON };
  }
  // Check 2 — new-experiment doc-sync (soft ask). Runs unless overridden.
  if (!syncOverride && addsNewExperimentHeading(stagedDiffForResults)) {
    const missing = missingSyncDocs(stagedNames);
    if (missing.length) return { decision: 'ask', reason: syncReason(missing) };
  }
  return null;
}

/** Stop drift/clobber check. Returns { reason } to block, or null. */
export function stopCheck(event) {
  if (process.env.RECORD_DRIFT_OVERRIDE === '1') return null;
  const driftReport = analyzeDrift(event.cwd || process.cwd());
  if (!driftReport) return null;
  if (!driftReport.problems.length && !driftReport.clobbers.length) return null;
  return { reason: buildDriftReason(driftReport) };
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); return; }
  const eventName = event.hook_event_name || event.hookEventName || '';
  try {
    if (eventName === 'PreToolUse') {
      const outcome = commitCheck(event);
      if (outcome) process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: outcome.decision, permissionDecisionReason: outcome.reason },
      }));
    } else if (eventName === 'Stop') {
      const outcome = stopCheck(event);
      if (outcome) process.stdout.write(JSON.stringify({ decision: 'block', reason: outcome.reason }));
    }
  } catch { /* fail open */ }
  process.exit(0);
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) main();
