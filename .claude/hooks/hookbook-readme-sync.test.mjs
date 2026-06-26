// hookbook-readme-sync.test.mjs — the repo-local guard that keeps README + docs/HOOKBOOK.md in sync with the
// hooks/ directory. Russell 2026-06-26: "repo should always be in sync with hookbook; readme never stale."
// Run: node hookbook-readme-sync.test.mjs   (exits non-zero on failure)

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { shippedHookStems, undocumentedStems, coverageVerdict } from './hookbook-readme-sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'hookbook-readme-sync.mjs');

const failures = [];
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else { console.log(`FAIL  ${label}`); failures.push(label); }
}

// ── pure helpers ─────────────────────────────────────────────────────────────
{
  const fakeDir = (names) => () => names;
  check('shippedHookStems lists .mjs hooks, drops *.test.mjs',
    JSON.stringify(shippedHookStems('x', fakeDir(['a.mjs', 'a.test.mjs', 'b.mjs']))) === JSON.stringify(['a', 'b']));

  check('undocumentedStems finds the stem absent from the doc',
    JSON.stringify(undocumentedStems(['a', 'b'], 'docs mention `a` only')) === JSON.stringify(['b']));

  const verdict = coverageVerdict({ stems: ['a', 'b'], readmeText: '`a`', hookbookText: '`a` `b`' });
  check('coverageVerdict reports per-doc gaps (README missing b, HOOKBOOK complete)',
    JSON.stringify(verdict.missingFromReadme) === JSON.stringify(['b']) && verdict.missingFromHookbook.length === 0);
}

// ── end-to-end (stdin → block / pass) ────────────────────────────────────────
function fakeRepo({ hooks, readme, hookbook }) {
  const root = mkdtempSync(join(tmpdir(), 'kit-repo-'));
  mkdirSync(join(root, 'hooks'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (const name of hooks) writeFileSync(join(root, 'hooks', `${name}.mjs`), '// hook');
  writeFileSync(join(root, 'README.md'), readme);
  writeFileSync(join(root, 'docs', 'HOOKBOOK.md'), hookbook);
  return root;
}
function runHook(root) {
  const event = JSON.stringify({ hook_event_name: 'Stop', cwd: root });
  const run = spawnSync('node', [HOOK], { input: event, encoding: 'utf8' });
  return (run.stdout || '').trim();
}
const isBlocked = (out) => /"decision"\s*:\s*"block"/.test(out);

check('BLOCKS when a shipped hook is missing from the README',
  isBlocked(runHook(fakeRepo({ hooks: ['alpha', 'beta'], readme: '`alpha`', hookbook: '`alpha` `beta`' }))));

check('BLOCKS when a shipped hook is missing from the HOOKBOOK',
  isBlocked(runHook(fakeRepo({ hooks: ['alpha', 'beta'], readme: '`alpha` `beta`', hookbook: '`alpha`' }))));

check('PASSES when every hook is in BOTH docs',
  !isBlocked(runHook(fakeRepo({ hooks: ['alpha', 'beta'], readme: '`alpha` `beta`', hookbook: '`alpha` `beta`' }))));

check('does NOT fire in a non-kit dir (no hooks/ or README)',
  runHook(mkdtempSync(join(tmpdir(), 'not-a-kit-'))) === '');

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll hookbook-readme-sync checks passed.');
