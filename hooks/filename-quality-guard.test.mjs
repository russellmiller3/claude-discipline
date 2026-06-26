// Tests for filename-quality-guard's pure verdict. Run: node --test filename-quality-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessFilename } from './filename-quality-guard.mjs';

test('blocks the motivating typo: findigns -> findings', () => {
  const verdict = assessFilename('bench/voice-latency/findigns.md');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /findings/);
});

test('blocks common misspellings (near-miss, one edit away)', () => {
  for (const bad of ['recieve.js', 'lenght.ts', 'benchmrk.mjs', 'summery-report.md', 'transcrpit.txt']) {
    assert.equal(assessFilename(bad).ok, false, `expected BLOCK for ${bad}`);
  }
});

test('blocks lazy/scratch stems', () => {
  for (const bad of ['tmp.mjs', 'output2.js', 'asdf.txt', 'untitled.md', 'final.docx', 'stuff.json', 'foo.ts']) {
    assert.equal(assessFilename(bad).ok, false, `expected BLOCK for ${bad}`);
  }
});

test('blocks vowelless dropped-vowel tokens', () => {
  for (const bad of ['fndngs.md', 'bnchmrk.mjs', 'schdlr.js']) {
    assert.equal(assessFilename(bad).ok, false, `expected BLOCK for ${bad}`);
  }
});

test('blocks a placeholder token inside a compound name', () => {
  assert.equal(assessFilename('voice-tmp-runner.mjs').ok, false);
});

test('ALLOWS the real files we just created (no false positives)', () => {
  for (const good of [
    'bench/voice-latency/FINDINGS.md',
    'bench/voice-latency/realtimeClients.mjs',
    'bench/voice-latency/bakeoff.mjs',
    'bench/voice-latency/env.mjs',
    'bench/voice-latency/smoke.mjs',
    'bench/voice-latency/package.json',
    'filename-quality-guard.mjs',
  ]) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
});

test('ALLOWS conventional caps files and dotfiles', () => {
  for (const good of ['README.md', 'LICENSE', 'HANDOFF.md', 'CLAUDE.md', '.gitignore', '.env', 'tsconfig.json', 'index.ts']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good}`);
  }
});

test('ALLOWS unknown-but-plausible new domain words (only blocks CLOSE misspellings)', () => {
  for (const good of ['servoFormat.mjs', 'rhonda-orchestrator.js', 'meph-eval.mjs', 'kontext-loader.ts', 'zavient-api.js']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
});

test('camelCase and kebab tokenization both split correctly', () => {
  assert.equal(assessFilename('realtimeClients.mjs').ok, true);
  assert.equal(assessFilename('voice-latency-bakeoff.mjs').ok, true);
});
