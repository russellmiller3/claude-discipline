#!/usr/bin/env node
// no-write-to-main.test.mjs — locks the Bash write-on-main guard, especially the cp/mv
// DESTINATION parsing: the destination is the LAST positional argument; sources are reads.
// (Regression 2026-07-01: `cp a.mjs b.mjs c.mjs d.mjs kitDir/` grabbed the 2nd token — a
// SOURCE on main — and blocked a legit copy into another repo's feature branch.)
//
// Run: node no-write-to-main.test.mjs   (exits non-zero on failure)

import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const hooksDirectory = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hooksDirectory, 'no-write-to-main.mjs');

const failures = [];
const check = (label, condition) => { if (condition) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };
const cleanups = [];

function gitRepo({ branch }) {
  const repoDirectory = mkdtempSync(join(tmpdir(), 'nwtm-'));
  cleanups.push(repoDirectory);
  const git = (gitArguments) => execSync(`git ${gitArguments}`, { cwd: repoDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init -b main');
  git('-c user.email=t@t -c user.name=t commit --allow-empty -m init');
  if (branch !== 'main') git(`switch -c ${branch}`);
  writeFileSync(join(repoDirectory, 'inside.md'), 'doc');
  return repoDirectory;
}

// Returns true if the hook DENIED the command. (`cwd` stays as the JSON key — harness schema.)
function denied({ command, workingDirectory, environmentOverrides = {} }) {
  const hookProcess = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: workingDirectory }),
    encoding: 'utf8',
    env: { ...process.env, WRITE_MAIN_OVERRIDE: '', ...environmentOverrides },
  });
  return /"permissionDecision":\s*"deny"/.test(hookProcess.stdout);
}

const mainBranchRepo = gitRepo({ branch: 'main' });
const featureBranchRepo = gitRepo({ branch: 'feature/x' });
const outsideDirectory = mkdtempSync(join(tmpdir(), 'nwtm-outside-'));
cleanups.push(outsideDirectory);

// THE REGRESSION: multi-source cp on main whose DESTINATION is OUTSIDE the repo → allowed.
// (Sources live in the main-branch repo; they are reads, not writes.)
check('multi-source cp, dest outside repo → allowed',
  denied({ command: `cp a.mjs b.mjs c.mjs d.mjs ${outsideDirectory.replace(/\\/g, '/')}/`, workingDirectory: mainBranchRepo }) === false);

// Still blocked: cp of a code file to a path INSIDE the repo while on main.
check('cp code file into repo on main → denied',
  denied({ command: 'cp helper.mjs src/lib/helper.mjs', workingDirectory: mainBranchRepo }) === true);

// Multi-source cp landing INSIDE the repo on main: destination (last arg) is code → denied.
check('multi-source cp into repo on main → denied',
  denied({ command: 'cp a.mjs b.mjs src/lib/merged.mjs', workingDirectory: mainBranchRepo }) === true);

// Doc files stay allowed on main.
check('cp doc file into repo on main → allowed',
  denied({ command: 'cp HANDOFF.md plans/HANDOFF.md', workingDirectory: mainBranchRepo }) === false);

// On a feature branch everything is allowed.
check('cp code file on a feature branch → allowed',
  denied({ command: 'cp helper.mjs src/lib/helper.mjs', workingDirectory: featureBranchRepo }) === false);

// Redirects to code files inside the repo on main stay blocked.
check('redirect to code file on main → denied',
  denied({ command: 'node gen.mjs > src/out.js', workingDirectory: mainBranchRepo }) === true);

// Env override passes.
check('override env → allowed',
  denied({ command: 'cp helper.mjs src/lib/helper.mjs', workingDirectory: mainBranchRepo, environmentOverrides: { WRITE_MAIN_OVERRIDE: '1' } }) === false);

for (const cleanupPath of cleanups) { try { rmSync(cleanupPath, { recursive: true, force: true }); } catch { /* ignore */ } }

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll no-write-to-main checks passed.');
