#!/usr/bin/env node
// experiment-manifest-guard.test.mjs — locks the GLOBAL reproduction-manifest guard.
// A commit that records a new experiment (`## exp…` in RESULTS.md) must land the four-part manifest.
//
// Run: node --test experiment-manifest-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestCheck, hasAllManifestLabels, addedLines } from './experiment-manifest-guard.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'experiment-manifest-guard.mjs');
const git = (repoRoot, ...args) =>
  execFileSync('git', ['-C', repoRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });

// A repo with a baseline RESULTS.md (+ optional METHODS.md) committed at root.
function makeRepo(resultsBody, { methods = null } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'manifest-guard-'));
  git(repoRoot, 'init', '-q');
  writeFileSync(join(repoRoot, 'RESULTS.md'), resultsBody, 'utf8');
  if (methods !== null) writeFileSync(join(repoRoot, 'METHODS.md'), methods, 'utf8');
  git(repoRoot, 'add', '-A');
  git(repoRoot, 'commit', '-q', '-m', 'baseline');
  return repoRoot;
}

const A_FULL_MANIFEST = [
  '### exp151 — Reproduction manifest',
  '- **PURPOSE:** does the reader track meaning? bar: >=90% follow accuracy on edited-but-valid rows.',
  '- **RECIPE:** commit abc123, seeds 1337/42/7, data sha256 deadbeef, A5000, torch 2.8, `py -3 run.py`.',
  '- **PROVENANCE:** reader.pt sha256 c0ffee, rescued to runs/exp151/.',
  '- **RESULT:** 91.2% follow accuracy; verdict PASS; bound to commit abc123.',
  '',
].join('\n');

// ── unit: pure functions ──────────────────────────────────────────────────────────────────────
test('hasAllManifestLabels: all four uppercase labels -> true', () => {
  assert.equal(hasAllManifestLabels(A_FULL_MANIFEST), true);
});
test('hasAllManifestLabels: one label missing -> false', () => {
  assert.equal(hasAllManifestLabels('PURPOSE and RECIPE and PROVENANCE but no verdict'), false);
});
test('hasAllManifestLabels: ordinary lowercase prose never counts', () => {
  assert.equal(hasAllManifestLabels('the purpose here, our recipe, provenance and the result were good'), false);
});
test('addedLines: keeps + lines, drops the +++ header and context', () => {
  assert.equal(addedLines('+++ b/RESULTS.md\n@@ -0,0 +1 @@\n+kept line\n-removed\n unchanged\n'), 'kept line');
});

// ── integration: manifestCheck ─────────────────────────────────────────────────────────────────
test('DENY: a new ## exp heading with no manifest in the commit', () => {
  const repoRoot = makeRepo('# RESULTS\n\n## exp13 body\n');
  writeFileSync(join(repoRoot, 'RESULTS.md'), '# RESULTS\n\n## exp13 body\n## exp151 shiny new run\nit worked great\n', 'utf8');
  git(repoRoot, 'add', 'RESULTS.md');
  const outcome = manifestCheck({ tool_name: 'Bash', tool_input: { command: 'git commit -m "record exp151"' }, cwd: repoRoot });
  assert.ok(outcome && outcome.decision === 'deny', 'a manifest-less experiment record must be denied');
  rmSync(repoRoot, { recursive: true, force: true });
});
test('ALLOW: a new ## exp heading WITH the four-part manifest staged in METHODS.md', () => {
  const repoRoot = makeRepo('# RESULTS\n\n## exp13 body\n', { methods: '# METHODS\n' });
  writeFileSync(join(repoRoot, 'RESULTS.md'), '# RESULTS\n\n## exp13 body\n## exp151 shiny new run\nit worked great\n', 'utf8');
  writeFileSync(join(repoRoot, 'METHODS.md'), '# METHODS\n\n' + A_FULL_MANIFEST, 'utf8');
  git(repoRoot, 'add', 'RESULTS.md', 'METHODS.md');
  const outcome = manifestCheck({ tool_name: 'Bash', tool_input: { command: 'git commit -m "record exp151 + manifest"' }, cwd: repoRoot });
  assert.equal(outcome, null, 'a fully-manifested experiment record must pass');
  rmSync(repoRoot, { recursive: true, force: true });
});
test('ALLOW: a RESULTS.md body edit that adds no new ## exp heading', () => {
  // Edit a NON-heading body line: the ## exp13 heading is untouched, so addsNewExperimentHeading stays false.
  const repoRoot = makeRepo('# RESULTS\n\n## exp13\nsome body line\n');
  writeFileSync(join(repoRoot, 'RESULTS.md'), '# RESULTS\n\n## exp13\nsome body line, corrected\n', 'utf8');
  git(repoRoot, 'add', 'RESULTS.md');
  assert.equal(manifestCheck({ tool_name: 'Bash', tool_input: { command: 'git commit -m "typo"' }, cwd: repoRoot }), null);
  rmSync(repoRoot, { recursive: true, force: true });
});
test('ALLOW: a code-only commit that does not stage RESULTS.md', () => {
  const repoRoot = makeRepo('# RESULTS\n\n## exp13 body\n');
  writeFileSync(join(repoRoot, 'train.py'), 'print("train")\n', 'utf8');
  git(repoRoot, 'add', 'train.py');
  assert.equal(manifestCheck({ tool_name: 'Bash', tool_input: { command: 'git commit -m "refactor trainer"' }, cwd: repoRoot }), null);
  rmSync(repoRoot, { recursive: true, force: true });
});
test('ALLOW: EXP_MANIFEST_OK escape token in the command', () => {
  const repoRoot = makeRepo('# RESULTS\n\n## exp13 body\n');
  writeFileSync(join(repoRoot, 'RESULTS.md'), '# RESULTS\n\n## exp13 body\n## exp151 new run\nno manifest here\n', 'utf8');
  git(repoRoot, 'add', 'RESULTS.md');
  const outcome = manifestCheck({ tool_name: 'Bash', tool_input: { command: 'EXP_MANIFEST_OK=1 git commit -m "manifest lands later this session"' }, cwd: repoRoot });
  assert.equal(outcome, null, 'the escape token must waive the block');
  rmSync(repoRoot, { recursive: true, force: true });
});
test('ALLOW: a non-commit / non-Bash / non-repo event', () => {
  const repoRoot = makeRepo('# RESULTS\n');
  assert.equal(manifestCheck({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: repoRoot }), null);
  assert.equal(manifestCheck({ tool_name: 'Edit', tool_input: {}, cwd: repoRoot }), null);
  const notARepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
  assert.equal(manifestCheck({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: notARepo }), null);
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(notARepo, { recursive: true, force: true });
});

// ── routing + safety ───────────────────────────────────────────────────────────────────────────
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
