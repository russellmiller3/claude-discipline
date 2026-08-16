#!/usr/bin/env node
// Regression net for the commit-gate bootstrap hook.
//
// This hook REWRITES a file in someone's repo without asking, so the tests that matter most are
// the refusals: the shapes it must leave alone, and the guarantee that a migration it does perform
// changes nothing about what runs. A wrong migration silently weakens a test gate, and a weakened
// gate is invisible until something broken ships.
//
// Run: node --test husky-on-new-projects.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'husky-on-new-projects.mjs');
const { commandsFromPreCommit, inferTiers, planMigration } = await import('./husky-on-new-projects.mjs');

function repoWith({ preCommit, packageJson = { name: 'demo', scripts: {} }, directories = [] }) {
  const projectDir = mkdtempSync(join(tmpdir(), 'commit-gate-'));
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify(packageJson));
  if (preCommit !== undefined) {
    mkdirSync(join(projectDir, '.husky'), { recursive: true });
    writeFileSync(join(projectDir, '.husky', 'pre-commit'), preCommit);
  }
  for (const name of directories) mkdirSync(join(projectDir, name), { recursive: true });
  return projectDir;
}

const sessionStart = (projectDir) => spawnSync('node', [hookPath], {
  input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: projectDir }),
  encoding: 'utf8', timeout: 20000,
});

// --- THE REFUSALS: shapes this hook must never rewrite -----------------------------------------

test('REFUSES a pre-commit containing shell logic', () => {
  // `a && b` and ["a","b"] agree only while both succeed. What a gate does on FAILURE is the
  // whole point of it, so anything with real shell semantics is left exactly as written.
  for (const script of [
    'npm test && npm run check',
    'if [ -f x ]; then npm test; fi',
    'npm test || exit 1',
    'RESULT=$(npm test)',
    'npm test | tee log.txt',
    'for f in *.ts; do npm test; done',
  ]) {
    assert.equal(commandsFromPreCommit(script), null, `must refuse: ${script}`);
  }
});

test('REFUSES to touch a repo it already migrated', () => {
  const projectDir = repoWith({ preCommit: 'node ~/.claude/scripts/scoped-gate.mjs\n' });
  assert.equal(planMigration(projectDir).action, 'skip');
});

test('REFUSES to touch a repo that already has a gate config', () => {
  const projectDir = repoWith({ preCommit: 'npm test\n' });
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(join(projectDir, '.claude', 'gate-tiers.json'), '{}');
  assert.equal(planMigration(projectDir).action, 'skip');
});

test('REFUSES a repo with no pre-commit at all', () => {
  assert.equal(planMigration(repoWith({})).action, 'skip');
});

// --- THE GUARANTEE: a migration preserves exactly what ran before -------------------------------

test('the generated full gate is verbatim what pre-commit ran before', () => {
  const projectDir = repoWith({ preCommit: '#!/bin/sh\n\n# the gate\nnpm test\nnpm run check\n' });
  const plan = planMigration(projectDir);
  assert.equal(plan.action, 'migrate');
  assert.deepEqual(plan.config.full, ['npm test', 'npm run check']);
});

test('no unambiguous split means NO tier, so behaviour is identical', () => {
  // A backend-only repo, a frontend-only repo, and a split repo with no narrow script all infer
  // nothing. "I am not sure" must cost time, never coverage.
  assert.deepEqual(inferTiers({ directories: ['cloudflare'], packageScripts: { 'test:node': 'vitest' } }), []);
  assert.deepEqual(inferTiers({ directories: ['src'], packageScripts: { 'test:node': 'vitest' } }), []);
  assert.deepEqual(inferTiers({ directories: ['src', 'cloudflare'], packageScripts: { test: 'vitest' } }), []);
});

test('a tier is inferred only from the repo OWN narrow script, never an invented one', () => {
  const tiers = inferTiers({
    directories: ['src', 'cloudflare'],
    packageScripts: { 'test:node': 'vitest run --config vitest.node.config.ts' },
  });
  assert.equal(tiers.length, 1);
  assert.equal(tiers[0].name, 'server-only');
  assert.deepEqual(tiers[0].commands, ['npm run test:node']);
  assert.ok(tiers[0].paths.includes('^cloudflare/'));
  assert.ok(!tiers[0].paths.some((pattern) => pattern.includes('src')), 'the frontend must never be inside a server tier');
});

// --- END TO END: the installed hook actually rewrites a real repo --------------------------------

test('LIVE: the installed hook migrates a real repo and keeps the original recoverable', () => {
  const projectDir = repoWith({
    preCommit: '#!/bin/sh\nnpm test\nnpm run check\n',
    packageJson: { name: 'demo', scripts: { 'test:node': 'vitest run --config node.config.ts' } },
    directories: ['src', 'cloudflare'],
  });

  const finished = sessionStart(projectDir);
  assert.equal(finished.status, 0, 'a bootstrap hook must never fail the session');
  assert.match(finished.stdout, /migrated/i);

  assert.equal(readFileSync(join(projectDir, '.husky', 'pre-commit'), 'utf8').trim(),
    'node ~/.claude/scripts/scoped-gate.mjs');
  assert.ok(existsSync(join(projectDir, '.husky', 'pre-commit.pre-scoped-gate')), 'one mv must undo this');

  const written = JSON.parse(readFileSync(join(projectDir, '.claude', 'gate-tiers.json'), 'utf8'));
  assert.deepEqual(written.full, ['npm test', 'npm run check'], 'the full gate must survive verbatim');
  assert.equal(written.tiers[0].name, 'server-only');

  // Idempotent: a second session must not re-wrap what it already rewrote.
  assert.equal(sessionStart(projectDir).stdout.trim(), '', 'an already-migrated repo must be silent');
});

test('LIVE: a shell-logic pre-commit is reported and left byte-identical', () => {
  const original = '#!/bin/sh\nnpm test && npm run check\n';
  const projectDir = repoWith({ preCommit: original });
  const finished = sessionStart(projectDir);
  assert.equal(finished.status, 0);
  assert.match(finished.stdout, /left alone/i);
  assert.equal(readFileSync(join(projectDir, '.husky', 'pre-commit'), 'utf8'), original);
  assert.ok(!existsSync(join(projectDir, '.claude', 'gate-tiers.json')));
});

test('LIVE: a Node repo with no husky still gets the original husky nudge', () => {
  assert.match(sessionStart(repoWith({})).stdout, /HUSKY MISSING/);
});

test('LIVE: a non-git or non-Node directory is ignored entirely', () => {
  const bare = mkdtempSync(join(tmpdir(), 'commit-gate-bare-'));
  assert.equal(sessionStart(bare).stdout.trim(), '');
});
