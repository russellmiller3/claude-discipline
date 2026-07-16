#!/usr/bin/env node
/**
 * experiment-manifest-guard — GLOBAL: a new experiment RECORD must ship its reproduction manifest.
 *
 * new-hook-category: reproducibility-manifest — nearest existing hook is ledger-records-guard.mjs
 * (experiment-record cross-doc sync); doesn't cover this because that hook is LEDGER-scoped and only checks
 * doc PRESENCE / TOC, while THIS is a GLOBAL check (fires in ANY git repo) that a commit recording a new
 * experiment (a `## exp…` heading added to RESULTS.md) ALSO lands the four-part reproduction manifest
 * (PURPOSE / RECIPE / PROVENANCE / RESULT) in its markdown — enforcing the "Nature-Level Reproducibility"
 * rule (~/.claude/CLAUDE.md): a future agent, given ONLY the repo, can understand the experiment's purpose
 * and EXACTLY reproduce its result.
 *
 * PreToolUse(Bash) on a `git commit`, in ANY git repo:
 *   • DENY when the commit adds a new `## exp…` heading to RESULTS.md but the commit's staged markdown
 *     additions do NOT contain all four manifest labels.  Override: EXP_MANIFEST_OK.
 *
 * Fail-open on any error (no git, malformed stdin, non-repo). Escape token: EXP_MANIFEST_OK.
 * Scope note: v1 triggers on the RESULTS.md `## exp` record signal (Russell's cross-repo experiment
 * convention). Repos that record experiments a different way are covered by the CLAUDE.md rule + the
 * durable-run / runpod-run skill checklists; broaden the trigger here if a repo needs it.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveDirectory, addsNewExperimentHeading } from './lib/ledgerRecords.mjs';

export const MANIFEST_LABELS = ['PURPOSE', 'RECIPE', 'PROVENANCE', 'RESULT'];

// All four uppercase manifest field labels present. Case-SENSITIVE so ordinary prose ("result", "purpose")
// never counts — only the canonical uppercase labels the rule + the block message instruct.
export function hasAllManifestLabels(manifestText) {
  const manifestBody = String(manifestText || '');
  return MANIFEST_LABELS.every((label) => new RegExp(`\\b${label}\\b`).test(manifestBody));
}

// The ADDED lines of a unified diff (drop the `+++` header), stripped of the leading `+`.
export function addedLines(unifiedDiff) {
  return String(unifiedDiff || '')
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

function manifestReason() {
  return [
    'New experiment recorded in RESULTS.md, but its REPRODUCTION MANIFEST is not in this commit — blocked.',
    '',
    'Rule ("Nature-Level Reproducibility", ~/.claude/CLAUDE.md): every experiment/bench is reproducible to',
    'journal standard — a future agent, given ONLY the repo, can understand its PURPOSE and EXACTLY reproduce',
    'its result. A commit that records a new experiment must also land the four-part manifest in its markdown',
    '(the project spec home — e.g. METHODS.md):',
    '  • PURPOSE    — the exact question + the pass/fail bar that confirms vs falsifies it.',
    '  • RECIPE     — code commit/pin, seeds, dataset + hash, config, env (GPU / library pins), literal command.',
    '  • PROVENANCE — produced-artifact hashes + where each was rescued.',
    '  • RESULT     — numbers observed + verdict, bound to the producing commit.',
    '',
    'Prefer deterministic REGENERATION (pinned seeds + data + code) over hoarding artifacts.',
    '',
    'Fix: add the manifest (these four UPPERCASE labels) to METHODS.md / the spec home, stage it, commit again.',
    'Override (rare — the manifest was committed earlier this experiment, or genuinely N/A): EXP_MANIFEST_OK=1',
  ].join('\n');
}

function gitCapture(gitArgs, workingDirectory) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', cwd: workingDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** PreToolUse(Bash) commit-time check. Returns { decision:'deny', reason } or null. */
export function manifestCheck(event) {
  if (!event || event.tool_name !== 'Bash') return null;
  const command = (event.tool_input && event.tool_input.command) || '';
  if (typeof command !== 'string') return null;
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (!/\bgit\s+commit\b/.test(normalized)) return null;
  if (process.env.EXP_MANIFEST_OK === '1' || /\bEXP_MANIFEST_OK\b/.test(normalized)) return null;

  const targetDirectory = effectiveDirectory(normalized, event.cwd || process.cwd());
  let repoRoot;
  try { repoRoot = gitCapture(['rev-parse', '--show-toplevel'], targetDirectory).trim(); } catch { return null; }
  if (!repoRoot) return null;

  let stagedNameList;
  try { stagedNameList = gitCapture(['diff', '--cached', '--name-only'], repoRoot); } catch { return null; }
  const stagedNames = stagedNameList.split('\n').map((name) => name.trim()).filter(Boolean);
  if (!stagedNames.some((name) => name === 'RESULTS.md')) return null;

  let resultsDiff = '';
  try { resultsDiff = gitCapture(['diff', '--cached', '-U0', '--', 'RESULTS.md'], repoRoot); } catch { return null; }
  if (!addsNewExperimentHeading(resultsDiff)) return null;

  // Gather THIS commit's markdown additions across every staged .md file; require the manifest labels.
  const markdownFiles = stagedNames.filter((name) => name.toLowerCase().endsWith('.md'));
  let markdownDiff = '';
  try { markdownDiff = gitCapture(['diff', '--cached', '-U0', '--', ...markdownFiles], repoRoot); } catch { return null; }
  if (hasAllManifestLabels(addedLines(markdownDiff))) return null;

  return { decision: 'deny', reason: manifestReason() };
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); return; }
  const eventName = event.hook_event_name || event.hookEventName || '';
  try {
    if (eventName === 'PreToolUse') {
      const outcome = manifestCheck(event);
      if (outcome) process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: outcome.decision,
          permissionDecisionReason: outcome.reason,
        },
      }));
    }
  } catch { /* fail open */ }
  process.exit(0);
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) main();
