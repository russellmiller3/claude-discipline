#!/usr/bin/env node
// ledger-records-guard.test.mjs — locks the consolidated ledger record-integrity hook (was
// ledger-results-toc-on-touch + ledger-experiment-doc-sync + experiment-record-drift-guard). Unit-tests the
// verbatim-ported pure functions and integration-tests the PreToolUse deny/ask + Stop block dispatch.
//
// Run: node --test ledger-records-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { commitCheck, stopCheck } from './ledger-records-guard.mjs';
import { tocRegionWasTouched, addsNewExperimentHeading, missingSyncDocs, analyzeDrift, isLedgerRepo } from './lib/ledgerRecords.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'ledger-records-guard.mjs');
const git = (repoRoot, ...args) => execFileSync('git', ['-C', repoRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });

// A ledger repo: git-inited, with RESULTS.md + Truth-ledger.md + METHODS.md committed at root.
function makeLedgerRepo(resultsBody, { truth = 'Truth ledger.\n', methods = 'Methods.\n' } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ledger-guard-'));
  git(repoRoot, 'init', '-q');
  writeFileSync(join(repoRoot, 'RESULTS.md'), resultsBody, 'utf8');
  writeFileSync(join(repoRoot, 'Truth-ledger.md'), truth, 'utf8');
  writeFileSync(join(repoRoot, 'METHODS.md'), methods, 'utf8');
  git(repoRoot, 'add', '-A');
  git(repoRoot, 'commit', '-q', '-m', 'baseline');
  return repoRoot;
}

// ── unit: pure lib functions (prove the verbatim port) ──────────────────────────────────────────
test('tocRegionWasTouched: a change inside the TOC table -> true', () => {
  const newFile = '# RESULTS\n\n## Table of Contents\n| Exp | Date |\n| 13 | 2026-07-01 |\n| 14 | 2026-07-02 |\n\n## exp14\n';
  assert.equal(tocRegionWasTouched('@@ -5,0 +6 @@\n+| 14 | 2026-07-02 |\n', newFile), true);
});
test('tocRegionWasTouched: a section appended below the TOC, TOC untouched -> false', () => {
  const newFile = '# RESULTS\n\n## Table of Contents\n| Exp | Date |\n| 13 | 2026-07-01 |\n\n## exp14 new\nbody\n';
  assert.equal(tocRegionWasTouched('@@ -6,0 +7,2 @@\n+## exp14 new\n+body\n', newFile), false);
});
test('addsNewExperimentHeading + missingSyncDocs', () => {
  assert.equal(addsNewExperimentHeading('+## exp50 new run\n'), true);
  assert.equal(addsNewExperimentHeading('+ordinary added line\n'), false);
  assert.deepEqual(missingSyncDocs('RESULTS.md\nMETHODS.md\n'), ['Truth-ledger.md', 'explainer.html']);
  assert.deepEqual(missingSyncDocs('RESULTS.md\nMETHODS.md\nTruth-ledger.md\nexplainer.html\n'), []);
});
test('isLedgerRepo: marker pair present -> true; absent -> false', () => {
  const ledgerRoot = makeLedgerRepo('# RESULTS\n');
  assert.equal(isLedgerRepo(ledgerRoot), true);
  const other = mkdtempSync(join(tmpdir(), 'notledger-'));
  assert.equal(isLedgerRepo(other), false);
  rmSync(ledgerRoot, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});
test('analyzeDrift: a recent exp in RESULTS but not Truth -> a problem', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'drift-'));
  writeFileSync(join(repoRoot, 'RESULTS.md'), '## exp20 result\n', 'utf8');
  writeFileSync(join(repoRoot, 'Truth-ledger.md'), 'nothing about that run\n', 'utf8');
  writeFileSync(join(repoRoot, 'METHODS.md'), '', 'utf8');
  const report = analyzeDrift(repoRoot);
  assert.ok(report && report.problems.some((p) => p.expId === 20), 'exp20 must be flagged as drifted');
  rmSync(repoRoot, { recursive: true, force: true });
});

// ── integration: PreToolUse commitCheck ──────────────────────────────────────────────────────────
test('commitCheck: RESULTS.md staged, TOC region NOT updated -> deny', () => {
  const repoRoot = makeLedgerRepo('# RESULTS\n\n## Table of Contents\n| Exp | Date |\n| 13 | 2026-07-01 |\n\n## exp13 body\n');
  writeFileSync(join(repoRoot, 'RESULTS.md'), '# RESULTS\n\n## Table of Contents\n| Exp | Date |\n| 13 | 2026-07-01 |\n\n## exp13 body\n## exp14 appended without a TOC row\n', 'utf8');
  git(repoRoot, 'add', 'RESULTS.md');
  const outcome = commitCheck({ tool_name: 'Bash', tool_input: { command: 'git commit -m "add exp14"' }, cwd: repoRoot });
  assert.ok(outcome && outcome.decision === 'deny', 'expected a deny for a RESULTS.md change that skips the TOC');
  rmSync(repoRoot, { recursive: true, force: true });
});
test('commitCheck: RESULTS_TOC_OK override + a body edit (no new exp heading) -> null', () => {
  const repoRoot = makeLedgerRepo('# RESULTS\n\n## Table of Contents\n| Exp | Date |\n| 13 | 2026-07-01 |\n\n## exp13\nsome body line\n');
  // Edit a NON-heading body line so addsNewExperimentHeading stays false; RESULTS_TOC_OK waives the TOC check.
  writeFileSync(join(repoRoot, 'RESULTS.md'), '# RESULTS\n\n## Table of Contents\n| Exp | Date |\n| 13 | 2026-07-01 |\n\n## exp13\nsome body line, edited\n', 'utf8');
  git(repoRoot, 'add', 'RESULTS.md');
  const outcome = commitCheck({ tool_name: 'Bash', tool_input: { command: 'RESULTS_TOC_OK=1 git commit -m "tweak"' }, cwd: repoRoot });
  assert.equal(outcome, null);
  rmSync(repoRoot, { recursive: true, force: true });
});
test('commitCheck: a non-commit / non-Bash / non-ledger event -> null', () => {
  const repoRoot = makeLedgerRepo('# RESULTS\n');
  assert.equal(commitCheck({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: repoRoot }), null);
  assert.equal(commitCheck({ tool_name: 'Edit', tool_input: {}, cwd: repoRoot }), null);
  const nonLedger = mkdtempSync(join(tmpdir(), 'nl-'));
  execFileSync('git', ['-C', nonLedger, 'init', '-q']);
  assert.equal(commitCheck({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: nonLedger }), null);
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(nonLedger, { recursive: true, force: true });
});

// ── integration: Stop stopCheck ──────────────────────────────────────────────────────────────────
test('stopCheck: a drifted ledger repo -> block; a clean one -> null', () => {
  const drifted = mkdtempSync(join(tmpdir(), 'stop-drift-'));
  writeFileSync(join(drifted, 'RESULTS.md'), '## exp20 result\n', 'utf8');
  writeFileSync(join(drifted, 'Truth-ledger.md'), 'no mention\n', 'utf8');
  writeFileSync(join(drifted, 'METHODS.md'), '', 'utf8');
  assert.ok(stopCheck({ cwd: drifted }), 'drift should block');

  const clean = mkdtempSync(join(tmpdir(), 'stop-clean-'));
  writeFileSync(join(clean, 'RESULTS.md'), '## exp20 result\n', 'utf8');
  writeFileSync(join(clean, 'Truth-ledger.md'), 'exp20 ran and produced a result\n', 'utf8');
  writeFileSync(join(clean, 'METHODS.md'), '', 'utf8');
  assert.equal(stopCheck({ cwd: clean }), null, 'in-sync records should not block');
  rmSync(drifted, { recursive: true, force: true });
  rmSync(clean, { recursive: true, force: true });
});
test('stopCheck: RECORD_DRIFT_OVERRIDE=1 -> null even when drifted', () => {
  const drifted = mkdtempSync(join(tmpdir(), 'stop-ovr-'));
  writeFileSync(join(drifted, 'RESULTS.md'), '## exp20 r\n', 'utf8');
  writeFileSync(join(drifted, 'Truth-ledger.md'), 'no mention\n', 'utf8');
  writeFileSync(join(drifted, 'METHODS.md'), '', 'utf8');
  const prev = process.env.RECORD_DRIFT_OVERRIDE;
  process.env.RECORD_DRIFT_OVERRIDE = '1';
  try { assert.equal(stopCheck({ cwd: drifted }), null); } finally { if (prev === undefined) delete process.env.RECORD_DRIFT_OVERRIDE; else process.env.RECORD_DRIFT_OVERRIDE = prev; }
  rmSync(drifted, { recursive: true, force: true });
});

// ── routing + safety ─────────────────────────────────────────────────────────────────────────────
test('malformed stdin -> fail open (exit 0)', () => {
  const run = spawnSync('node', [HOOK], { input: '{bad', encoding: 'utf8' });
  assert.equal(run.status, 0);
});
test('importing the hook does NOT execute main (basename entry guard)', () => {
  const probe = spawnSync('node', ['--input-type=module', '-e',
    `import(${JSON.stringify('file:///' + HOOK.replace(/\\/g, '/'))}).then(() => console.log('imported-ok'));`,
  ], { input: '', encoding: 'utf8', timeout: 15000 });
  assert.match((probe.stdout || '') + (probe.stderr || ''), /imported-ok/);
});
