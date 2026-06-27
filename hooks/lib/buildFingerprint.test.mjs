#!/usr/bin/env node
// buildFingerprint.test.mjs — locks the content-based provenance primitive. Run: node buildFingerprint.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic: point the baseline store at a throwaway file BEFORE importing the lib (lazy storePath()
// reads this each call), so the test never writes to the real ~/.claude/state store.
process.env.BUILD_FINGERPRINT_STORE = join(mkdtempSync(join(tmpdir(), 'fp-store-')), 'fp.json');
const { sourceFingerprint, isBuildCommand, freshnessOf, recordBaseline, buildProjectsUnder } = await import('./buildFingerprint.mjs');

const cleanups = [];
function projectDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'fp-'));
  cleanups.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return root;
}

const failures = [];
const check = (label, condition) => { if (condition) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };

// 1. Fingerprint is deterministic, ignores test files, and CHANGES when real source changes.
{
  const root = projectDir({ 'package.json': '{"scripts":{"build":"vite build"}}', 'lib/a.js': 'export const x = 1;', 'lib/a.test.js': 'whatever' });
  const first = sourceFingerprint(root);
  check('fingerprint is non-empty + stable', first && first === sourceFingerprint(root));
  // touching mtime only must NOT change the fingerprint (the whole point — mtime immunity)
  const future = new Date('2030-01-01T00:00:00Z');
  utimesSync(join(root, 'lib/a.js'), future, future);
  check('mtime change alone does NOT change fingerprint', sourceFingerprint(root) === first);
  // editing a test file must NOT change it; editing real source MUST.
  writeFileSync(join(root, 'lib/a.test.js'), 'changed test body');
  check('editing a *.test.js does NOT change fingerprint', sourceFingerprint(root) === first);
  writeFileSync(join(root, 'lib/a.js'), 'export const x = 2;');
  check('editing real source DOES change fingerprint', sourceFingerprint(root) !== first);
}

// 2. Build-command detection across managers/tools.
check('detects npm run build', isBuildCommand('npm run build'));
check('detects vite build', isBuildCommand('npx vite build --mode prod'));
check('detects pnpm/yarn build', isBuildCommand('pnpm build') && isBuildCommand('yarn build'));
check('ignores a non-build command', !isBuildCommand('npm run test') && !isBuildCommand('git commit -m build'));

// 3. The fresh/stale/unknown verdict — the core of the whole thing.
{
  const root = projectDir({ 'package.json': '{"scripts":{"build":"vite build"}}', 'dist/bundle.js': 'built', 'src/main.js': 'const a = 1;' });
  check('no baseline yet → unknown (never cry stale without evidence)', freshnessOf(root).status === 'unknown');
  recordBaseline(root, sourceFingerprint(root), '');
  check('right after a build → fresh', freshnessOf(root).status === 'fresh');
  writeFileSync(join(root, 'src/main.js'), 'const a = 2; // fixed a bug');
  check('source edited since build → stale', freshnessOf(root).status === 'stale');
  recordBaseline(root, sourceFingerprint(root), '');
  check('re-built (baseline re-recorded) → fresh again', freshnessOf(root).status === 'fresh');
}

// 4. no dist/ at all → no-dist (nothing to be stale).
check('missing dist → no-dist', freshnessOf(projectDir({ 'package.json': '{"scripts":{"build":"x"}}', 'src/a.js': 'a' })).status === 'no-dist');

// 5. buildProjectsUnder finds root + nested app dirs with a build script.
{
  const root = projectDir({ 'package.json': '{"name":"top"}', 'extension/package.json': '{"scripts":{"build":"vite build"}}', 'extension/x.js': 'x' });
  const found = buildProjectsUnder(root);
  check('finds a nested buildable project (extension/)', found.some((path) => path.endsWith('extension')));
}

for (const path of cleanups) { try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ } }

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll buildFingerprint checks passed.');
