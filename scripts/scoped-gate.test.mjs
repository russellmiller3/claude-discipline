#!/usr/bin/env node
// Regression net for the shared gate scoper.
//
// The bug it exists to prevent is not "the gate is slow" -- it is "the gate skipped something it
// should have run". Every test below that matters is about the SKIP direction being conservative:
// unknown input, mixed input, and broken config must all land on the full gate.
//
// Run: node --test scoped-gate.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { readGateTiers, selectGateCommands, stagedPaths, configRelativePath, runGateCommand, terminateProcessTree } =
  await import('./scoped-gate.mjs');

const silent = () => {};

function projectWithConfig(contents) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scoped-gate-'));
  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  writeFileSync(join(projectRoot, configRelativePath), contents);
  return projectRoot;
}

const macherLikeTiers = {
  full: ['npm test', 'npm run check'],
  tiers: [{
    name: 'server-only',
    paths: ['^cloudflare/', '^scripts/', '^supabase/', '\\.md$'],
    commands: ['npm run test:node'],
  }],
};

// --- THE HEADLINE: a commit that cannot reach the browser does not pay for the browser ---------

test('a server-only commit runs just that tier', () => {
  const selection = selectGateCommands([
    'cloudflare/retell-gateway/src/macher-runtime.ts',
    'scripts/voice-forensics.mjs',
    'learnings.md',
  ], macherLikeTiers, { warn: silent });
  assert.deepEqual(selection, { name: 'server-only', commands: ['npm run test:node'] });
});

// --- THE DANGEROUS DIRECTION: everything ambiguous must land on the full gate ------------------

test('ONE unmatched file drags the whole commit back to the full gate', () => {
  const selection = selectGateCommands([
    'cloudflare/retell-gateway/src/macher-runtime.ts',
    'src/routes/talk/+page.svelte',
  ], macherLikeTiers, { warn: silent });
  assert.equal(selection.name, 'full');
});

test('nothing staged means the full gate, never a skip', () => {
  // An amend, a hook re-entry, or a failed `git diff` all look like this. "I could not tell what
  // changed" must never be read as "nothing changed, so nothing can break".
  assert.equal(selectGateCommands([], macherLikeTiers, { warn: silent }).name, 'full');
  assert.equal(selectGateCommands(null, macherLikeTiers, { warn: silent }).name, 'full');
});

test('a tier with an invalid regex is skipped, not obeyed', () => {
  const selection = selectGateCommands(['cloudflare/worker.ts'], {
    full: ['npm test'],
    tiers: [{ name: 'broken', paths: ['^cloudflare/['], commands: ['npm run fast'] }],
  }, { warn: silent });
  assert.equal(selection.name, 'full');
});

test('a tier missing its commands is skipped, not obeyed', () => {
  const selection = selectGateCommands(['cloudflare/worker.ts'], {
    full: ['npm test'],
    tiers: [{ name: 'empty', paths: ['^cloudflare/'], commands: [] }],
  }, { warn: silent });
  assert.equal(selection.name, 'full');
});

test('the first matching tier wins, so order expresses priority', () => {
  const selection = selectGateCommands(['docs/readme.md'], {
    full: ['npm test'],
    tiers: [
      { name: 'docs', paths: ['\\.md$'], commands: ['npm run lint:md'] },
      { name: 'server', paths: ['\\.md$', '^cloudflare/'], commands: ['npm run test:node'] },
    ],
  }, { warn: silent });
  assert.equal(selection.name, 'docs');
});

test('Windows-separated paths match a config written with forward slashes', () => {
  const selection = selectGateCommands(
    ['cloudflare\\retell-gateway\\src\\macher-runtime.ts'], macherLikeTiers, { warn: silent },
  );
  assert.equal(selection.name, 'server-only');
});

// --- CONFIG READING: a broken config degrades to the full gate, it never fails the commit ------

test('a project with no config gets no opinion, which callers treat as the full gate', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scoped-gate-none-'));
  assert.equal(readGateTiers(projectRoot, { warn: silent }), null);
  assert.equal(selectGateCommands(['anything.ts'], null, { warn: silent }), null);
});

test('malformed JSON warns and falls back rather than throwing', () => {
  const warnings = [];
  const projectRoot = projectWithConfig('{ not json');
  assert.equal(readGateTiers(projectRoot, { warn: (line) => warnings.push(line) }), null);
  assert.match(warnings[0], /not valid JSON/);
});

test('a config with no full command list falls back', () => {
  const warnings = [];
  const projectRoot = projectWithConfig(JSON.stringify({ tiers: [] }));
  assert.equal(readGateTiers(projectRoot, { warn: (line) => warnings.push(line) }), null);
  assert.match(warnings[0], /no "full" command list/);
});

test('a valid config round-trips', () => {
  const projectRoot = projectWithConfig(JSON.stringify(macherLikeTiers));
  const gateTiers = readGateTiers(projectRoot, { warn: silent });
  assert.deepEqual(gateTiers.full, ['npm test', 'npm run check']);
  assert.equal(gateTiers.tiers[0].name, 'server-only');
});

// --- PROCESS OWNERSHIP: the gate must not orphan what it started -------------------------------
//
// Killing the shell is not the same as killing the work. `npm test` spawns vitest, which spawns
// workers; on Windows those are grandchildren of a cmd.exe that can die without them. A gate that
// "timed out" while a runner keeps burning CPU is worse than one that hangs visibly, because
// nothing on screen says work is still happening.

/** A child that never ends on its own — only the deadline can stop it. */
const neverEndingChild = () => ({ pid: 4242, exitCode: null, on: () => {}, kill: () => {} });

/** A child that closes with `code` on the next tick, the way a fast suite would. */
const childClosingWith = (code) => () => {
  const handlers = {};
  setTimeout(() => handlers.close?.(code), 0);
  return { pid: 99, exitCode: null, kill: () => {}, on: (event, handler) => { handlers[event] = handler; } };
};

test('a command that overruns its deadline is killed, and the TREE is torn down', async () => {
  const killed = [];
  const exitCode = await runGateCommand('sleep 60', {
    projectRoot: process.cwd(),
    timeoutMs: 40,
    spawnChild: neverEndingChild,
    onTimeout: async (gateChild) => { killed.push(gateChild.pid); },
  });
  assert.equal(exitCode, 124, 'a timeout must report the conventional timeout code, not success');
  assert.deepEqual(killed, [4242], 'the tree teardown must actually run before the promise settles');
});

test('a command that finishes on its own is never force-killed', async () => {
  const killed = [];
  const exitCode = await runGateCommand('npm test', {
    projectRoot: process.cwd(),
    timeoutMs: 5_000,
    spawnChild: childClosingWith(0),
    onTimeout: async (gateChild) => { killed.push(gateChild.pid); },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(killed, [], 'a healthy run must never be torn down');
});

test('a failing command surfaces its exit code, so the commit is blocked', async () => {
  const exitCode = await runGateCommand('npm test', {
    projectRoot: process.cwd(), timeoutMs: 5_000, spawnChild: childClosingWith(1),
  });
  assert.equal(exitCode, 1);
});

test('LIVE: a real spawned process is actually gone after terminateProcessTree', async () => {
  // The fakes above prove the WIRING; this proves the kill itself works on this machine.
  const longRunner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', detached: process.platform !== 'win32',
  });
  await new Promise((resolve) => longRunner.once('spawn', resolve));
  assert.equal(longRunner.exitCode, null, 'fixture must be alive before we kill it');

  await terminateProcessTree(longRunner);
  await new Promise((resolve) => longRunner.once('exit', resolve));

  assert.throws(() => process.kill(longRunner.pid, 0), 'the pid must no longer exist');
});

test('terminateProcessTree on an already-finished or missing child is a no-op, never a throw', async () => {
  await terminateProcessTree({ pid: 1, exitCode: 0 });
  await terminateProcessTree(null);
  await terminateProcessTree(undefined);
});

// --- STAGED PATHS -----------------------------------------------------------------------------

test('staged paths are split on NUL, and a failed git read yields none (so: full gate)', () => {
  const paths = stagedPaths('/anywhere', {
    run: () => ({ status: 0, stdout: 'a.ts\0b/c.ts\0' }),
  });
  assert.deepEqual(paths, ['a.ts', 'b/c.ts']);
  assert.deepEqual(stagedPaths('/anywhere', { run: () => ({ status: 128, stdout: '' }) }), []);
});
