#!/usr/bin/env node
// dist-freshness.test.mjs — locks the consolidated dist-freshness hook (was dist-staleness-check +
// stamp-build-fingerprint + rebuild-after-commit). Covers the Stop block logic, the PostToolUse stamp
// success/failure gate, event routing through the real hook process, and fail-open.
//
// Run: node --test dist-freshness.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { staleRootsThisTurn, stampBaselineAfterBuild } from './dist-freshness.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'dist-freshness.mjs');

function makeBuildableProject({ withDist = false } = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'dist-fresh-'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'p', scripts: { build: 'vite build' } }), 'utf8');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'app.js'), 'export const a = 1;\n', 'utf8');
  if (withDist) { mkdirSync(join(projectDir, 'dist')); writeFileSync(join(projectDir, 'dist', 'bundle.js'), 'x', 'utf8'); }
  return projectDir;
}
const assistantEditing = (filePath) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: filePath } }] } });
const assistantSaying = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('Stop: editing source in a buildable project with NO dist -> stale root', () => {
  const projectDir = makeBuildableProject({ withDist: false });
  const { staleRoots } = staleRootsThisTurn([assistantEditing(join(projectDir, 'src', 'app.js'))]);
  assert.ok(staleRoots.length >= 1, 'a source edit with no dist is stale');
  rmSync(projectDir, { recursive: true, force: true });
});

test('Stop: rebuild-skip override -> no stale roots even when stale', () => {
  const projectDir = makeBuildableProject({ withDist: false });
  const { overridden, staleRoots } = staleRootsThisTurn([
    assistantEditing(join(projectDir, 'src', 'app.js')),
    assistantSaying('rebuild-skip: pure library consumed from source, no bundle'),
  ]);
  assert.equal(overridden, true);
  assert.equal(staleRoots.length, 0);
  rmSync(projectDir, { recursive: true, force: true });
});

test('Stop: editing a NON-source file (README) -> no stale roots', () => {
  const projectDir = makeBuildableProject({ withDist: false });
  const { staleRoots } = staleRootsThisTurn([assistantEditing(join(projectDir, 'README.md'))]);
  assert.equal(staleRoots.length, 0);
  rmSync(projectDir, { recursive: true, force: true });
});

test('Stop: a source edit in a project with NO build script -> no stale roots', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'dist-fresh-nobuild-'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'lib' }), 'utf8'); // no build script
  writeFileSync(join(projectDir, 'index.js'), 'export const a = 1;\n', 'utf8');
  const { staleRoots } = staleRootsThisTurn([assistantEditing(join(projectDir, 'index.js'))]);
  assert.equal(staleRoots.length, 0);
  rmSync(projectDir, { recursive: true, force: true });
});

test('PostToolUse: a FAILED build output does not stamp', () => {
  const projectDir = makeBuildableProject({ withDist: true });
  assert.equal(stampBaselineAfterBuild({ tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_response: 'build failed\nnpm ERR! exit code 1', cwd: projectDir }), false);
  rmSync(projectDir, { recursive: true, force: true });
});

test('PostToolUse: a non-build command does not stamp', () => {
  const projectDir = makeBuildableProject({ withDist: true });
  assert.equal(stampBaselineAfterBuild({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: '', cwd: projectDir }), false);
  rmSync(projectDir, { recursive: true, force: true });
});

test('event routing: Stop with a stale project blocks via the real hook process', () => {
  const projectDir = makeBuildableProject({ withDist: false });
  const transcriptPath = join(projectDir, 'transcript.jsonl');
  writeFileSync(transcriptPath,
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }) + '\n'
    + JSON.stringify(assistantEditing(join(projectDir, 'src', 'app.js'))) + '\n', 'utf8');
  const hookRun = spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath, cwd: projectDir }), encoding: 'utf8' });
  assert.match((hookRun.stdout || '') + (hookRun.stderr || ''), /"decision"\s*:\s*"block"/);
  rmSync(projectDir, { recursive: true, force: true });
});

test('malformed stdin -> fail open (exit 0, no block)', () => {
  const hookRun = spawnSync('node', [HOOK], { input: '{bad json', encoding: 'utf8' });
  assert.equal(hookRun.status, 0);
  assert.doesNotMatch((hookRun.stdout || '') + (hookRun.stderr || ''), /block/);
});

// ── must-ALLOW: the Stop guard must NOT over-fire when no buildable source was edited ──
test('allows / does NOT fire on a turn that edited no buildable source', () => {
  assert.deepEqual(staleRootsThisTurn([]).staleRoots, [],
    'no source edits this turn -> nothing can be stale -> the guard must not block');
});

test('importing the hook does NOT execute main (basename entry guard)', () => {
  const importProbe = spawnSync('node', ['--input-type=module', '-e',
    `import(${JSON.stringify('file:///' + HOOK.replace(/\\/g, '/'))}).then(() => console.log('imported-ok'));`,
  ], { input: '', encoding: 'utf8', timeout: 15000 });
  assert.match((importProbe.stdout || '') + (importProbe.stderr || ''), /imported-ok/);
});
