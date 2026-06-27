#!/usr/bin/env node
// stamp-build-fingerprint.test.mjs — a successful build records a content baseline; a non-build or a
// failed build records nothing. Run: node stamp-build-fingerprint.test.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'stamp-build-fingerprint.mjs');

const cleanups = [];
function buildProject() {
  const root = mkdtempSync(join(tmpdir(), 'stamp-'));
  cleanups.push(root);
  writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"vite build"}}');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.js'), 'const a = 1;');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'bundle.js'), '// built');
  return root;
}

// Run the hook against a Bash PostToolUse event; return the parsed baseline store (or {}).
function runStamp(root, command, buildOutput) {
  const storePath = join(mkdtempSync(join(tmpdir(), 'store-')), 'fp.json');
  cleanups.push(dirname(storePath));
  spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: root, tool_input: { command }, tool_response: buildOutput }),
    encoding: 'utf8',
    env: { ...process.env, BUILD_FINGERPRINT_STORE: storePath },
  });
  return existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {};
}

const failures = [];
const check = (label, condition) => { if (condition) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };

// A successful build → a baseline is recorded for the project.
{
  const root = buildProject();
  const store = runStamp(root, 'npm run build', 'vite v6\ndist/bundle.js  10 kB │ gzip: 3 kB\n✓ built in 800ms');
  check('successful build records a baseline', Object.keys(store).length === 1);
  check('baseline carries a source fingerprint', Object.values(store)[0]?.sourceFingerprint?.length > 0);
}

// A non-build command → nothing recorded.
check('non-build command records nothing',
  Object.keys(runStamp(buildProject(), 'npm run test', 'Tests: 5 passed')).length === 0);

// A FAILED build (failure marker in output) → nothing recorded (don't falsely mark fresh).
check('failed build records nothing',
  Object.keys(runStamp(buildProject(), 'npm run build', 'npm ERR! build failed\nError: boom')).length === 0);

// A build with UNCONFIRMABLE output (no success/failure marker) → nothing recorded (safe: stay unknown).
check('unconfirmable build output records nothing',
  Object.keys(runStamp(buildProject(), 'npm run build', 'some unrelated chatter')).length === 0);

for (const path of cleanups) { try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ } }

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll stamp-build-fingerprint checks passed.');
