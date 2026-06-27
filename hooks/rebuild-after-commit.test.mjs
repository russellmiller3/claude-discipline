#!/usr/bin/env node
// rebuild-after-commit.test.mjs — locks the "any source edit must leave dist/ fresh" gate.
// Builds throwaway project dirs (buildable / not) with a src file + a dist file whose mtimes we
// control, plus a one-turn transcript that edits the src file, then asserts the Stop hook BLOCKS
// only when dist/ is stale (older than the edited file) in a buildable project.
//
// Run: node rebuild-after-commit.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Hermetic baseline store (set before importing the lib) so this test never pollutes the real one.
// The child hook process inherits this env, so parent recordBaseline + child freshnessOf share it.
process.env.BUILD_FINGERPRINT_STORE = join(mkdtempSync(join(tmpdir(), 'rb-store-')), 'fp.json');
const { recordBaseline, sourceFingerprint } = await import('./lib/buildFingerprint.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'rebuild-after-commit.mjs');

const failures = [];
const check = (label, condition) => { if (condition) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };
const cleanups = [];

// Make a temp project. buildable=true → package.json has a `build` script. distState:
//   'fresh' → dist file mtime AFTER the src edit (rebuilt); 'stale' → dist older; 'missing' → no dist.
// Returns the absolute src file path (what the transcript "edits").
function makeProject({ buildable = true, distState = 'stale' } = {}) {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'rebuild-'));
  cleanups.push(projectDirectory);
  const manifest = buildable ? { name: 'p', scripts: { build: 'vite build' } } : { name: 'p', scripts: { test: 'x' } };
  writeFileSync(join(projectDirectory, 'package.json'), JSON.stringify(manifest));
  mkdirSync(join(projectDirectory, 'src'), { recursive: true });
  const sourcePath = join(projectDirectory, 'src', 'App.svelte');
  writeFileSync(sourcePath, '<script></script>');

  const srcTime = 20_000; // seconds since epoch (arbitrary, fixed)
  utimesSync(sourcePath, srcTime, srcTime);

  if (distState !== 'missing') {
    mkdirSync(join(projectDirectory, 'dist', 'assets'), { recursive: true });
    const distFile = join(projectDirectory, 'dist', 'assets', 'panel.js');
    writeFileSync(distFile, '// built');
    const distTime = distState === 'fresh' ? srcTime + 100 : srcTime - 100; // after vs before the edit
    utimesSync(distFile, distTime, distTime);
  }
  return sourcePath;
}

// Feed a one-turn transcript whose assistant edited `sourcePath`; return whether the hook blocked.
function stopBlocksAfterEditing(sourcePath, { override = false } = {}) {
  const transcriptDirectory = mkdtempSync(join(tmpdir(), 'rebuild-tx-'));
  cleanups.push(transcriptDirectory);
  const transcriptPath = join(transcriptDirectory, 'transcript.jsonl');
  const assistantBlocks = [{ type: 'tool_use', name: 'Edit', input: { file_path: sourcePath } }];
  if (override) assistantBlocks.push({ type: 'text', text: 'rebuild-skip: pure lib, no bundle' });
  else assistantBlocks.push({ type: 'text', text: 'done' });
  writeFileSync(transcriptPath, [
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'fix it' }] }),
    JSON.stringify({ role: 'assistant', content: assistantBlocks }),
  ].join('\n'));
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    encoding: 'utf8',
  });
  return /"decision"\s*:\s*"block"/.test(proc.stdout || '');
}

// BLOCK: edited source, dist older than the edit (didn't rebuild).
check('buildable + stale dist → blocked',
  stopBlocksAfterEditing(makeProject({ buildable: true, distState: 'stale' })) === true);

// BLOCK: edited source, no dist at all (never built).
check('buildable + missing dist → blocked',
  stopBlocksAfterEditing(makeProject({ buildable: true, distState: 'missing' })) === true);

// ALLOW: dist newer than the edit (rebuilt).
check('buildable + fresh dist → allowed',
  stopBlocksAfterEditing(makeProject({ buildable: true, distState: 'fresh' })) === false);

// ALLOW: project has no build script — nothing to rebuild.
check('non-buildable + stale dist → allowed',
  stopBlocksAfterEditing(makeProject({ buildable: false, distState: 'stale' })) === false);

// ALLOW: explicit rebuild-skip override, even with stale dist.
check('buildable + stale dist + rebuild-skip → allowed',
  stopBlocksAfterEditing(makeProject({ buildable: true, distState: 'stale' }), { override: true }) === false);

// ALLOW: a turn that edited NO source (e.g. only a test/doc) — nothing to enforce.
(function noSourceEdited() {
  const transcriptDirectory = mkdtempSync(join(tmpdir(), 'rebuild-tx-'));
  cleanups.push(transcriptDirectory);
  const transcriptPath = join(transcriptDirectory, 'transcript.jsonl');
  writeFileSync(transcriptPath, [
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'tweak docs' }] }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:/p/README.md' } }, { type: 'text', text: 'done' }] }),
  ].join('\n'));
  const proc = spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }), encoding: 'utf8' });
  check('no source edited → allowed', !/"decision"\s*:\s*"block"/.test(proc.stdout || ''));
})();

// CONTENT VERDICT — the whole reason this rewrite exists.
// ALLOW: dist is STALE by mtime but the recorded fingerprint MATCHES the source (a git-merge artifact:
// the merge bumped the source mtime with zero real change). Content says fresh → must NOT block.
(function freshByContentDespiteStaleMtime() {
  const sourcePath = makeProject({ buildable: true, distState: 'stale' });
  const projectDirectory = dirname(dirname(sourcePath));
  recordBaseline(projectDirectory, sourceFingerprint(projectDirectory), ''); // dist was built from exactly this source
  check('stale-by-mtime but fresh-by-fingerprint → allowed (merge artifact, no false alarm)',
    stopBlocksAfterEditing(sourcePath) === false);
})();

// BLOCK: dist looks FRESH by mtime, but the source CONTENT changed since the recorded build (drift a
// same-turn mtime check would miss). Content says stale → must block.
(function staleByContentDespiteFreshMtime() {
  const sourcePath = makeProject({ buildable: true, distState: 'fresh' });
  const projectDirectory = dirname(dirname(sourcePath));
  recordBaseline(projectDirectory, sourceFingerprint(projectDirectory), ''); // baseline = the OLD source
  writeFileSync(sourcePath, '<script>const fixed = true;</script>');          // edit the content...
  utimesSync(sourcePath, 20_000, 20_000);                                     // ...but keep mtime "fresh" (older than dist)
  check('stale-by-fingerprint but fresh-by-mtime → blocked (catches drift mtime misses)',
    stopBlocksAfterEditing(sourcePath) === true);
})();

for (const path of cleanups) { try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ } }

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll rebuild-after-commit checks passed.');
