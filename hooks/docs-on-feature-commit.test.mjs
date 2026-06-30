#!/usr/bin/env node
// docs-on-feature-commit.test.mjs — locks the "every commit must move the available docs" gate.
//
//   • Stop branch (the hard gate): builds a throwaway transcript of one turn and asserts the hook
//     BLOCKS when a non-docs commit happened with no docs update, and ALLOWS every exempt case.
//   • PostToolUse branch (the nudge): builds a throwaway git repo, commits, and asserts the hook
//     nudges only when the commit didn't touch docs.
//
// Run: node docs-on-feature-commit.test.mjs   (exits non-zero on failure)

import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'docs-on-feature-commit.mjs');

const failures = [];
const check = (label, condition) => { if (condition) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };
const cleanups = [];

// ── Stop branch: feed a one-turn transcript, return whether the hook blocked ────
function stopBlocks(assistantBlocks) {
  const transcriptDirectory = mkdtempSync(join(tmpdir(), 'docs-stop-'));
  cleanups.push(transcriptDirectory);
  const transcriptPath = join(transcriptDirectory, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'do the thing' }] }),
    JSON.stringify({ role: 'assistant', content: assistantBlocks }),
  ];
  writeFileSync(transcriptPath, lines.join('\n'));
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    encoding: 'utf8',
  });
  return /"decision"\s*:\s*"block"/.test(proc.stdout || '');
}

const bash = (command) => ({ type: 'tool_use', name: 'Bash', input: { command } });
const edit = (file_path) => ({ type: 'tool_use', name: 'Edit', input: { file_path } });
const say = (text) => ({ type: 'text', text });

// BLOCK: a non-docs commit with no docs update anywhere in the turn.
check('non-docs commit, no docs update → blocked',
  stopBlocks([bash('git commit -m "fix(voice): reconnect on voice change"'), say('done')]) === true);

// ALLOW: same commit, but the turn also edited the README.
check('non-docs commit + README edit → allowed',
  stopBlocks([bash('git commit -m "fix(voice): x"'), edit('C:/proj/README.md')]) === false);

// ALLOW: the commit message itself says docs (it IS the docs commit).
check('docs commit (word "docs" in message) → allowed',
  stopBlocks([bash('git commit -m "docs: document the voice fixes"')]) === false);

// ALLOW: explicit docs-skip override in the reply.
check('non-docs commit + docs-skip override → allowed',
  stopBlocks([bash('git commit -m "chore: bump dep"'), say('docs-skip: dependency bump, no doc surface')]) === false);

// ALLOW: no commit at all this turn.
check('no commit → allowed',
  stopBlocks([edit('C:/proj/src/app.js'), say('edited but not committed')]) === false);

// ALLOW: a code commit AND a follow-up docs commit in the same turn.
check('non-docs commit + later docs commit → allowed',
  stopBlocks([bash('git commit -m "feat: thing"'), bash('git commit -m "docs: describe thing"')]) === false);

// BLOCK: a docs/ edit alone no longer satisfies — the README (front door) must move (2026-06-30).
check('non-docs commit + docs/ edit only → blocked (README required, not a docs/ file)',
  stopBlocks([bash('git commit -m "feat: thing"'), edit('C:/proj/docs/roadmap.md')]) === true);

// ALLOW: a CHANGELOG counts as a front-door doc.
check('non-docs commit + CHANGELOG edit → allowed',
  stopBlocks([bash('git commit -m "feat: thing"'), edit('C:/proj/CHANGELOG.md')]) === false);

// ── PostToolUse branch: real repo, returns whether the hook nudged ─────────────
function repoWithCommit(files, commitMessage) {
  const repoDirectory = mkdtempSync(join(tmpdir(), 'docs-post-'));
  cleanups.push(repoDirectory);
  const git = (args) => execSync(`git ${args}`, { cwd: repoDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init -q');
  git('config user.email t@t.t');
  git('config user.name t');
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(repoDirectory, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
    git(`add "${relativePath}"`);
  }
  git(`commit -q -m "${commitMessage}"`);
  return repoDirectory;
}
function nudged(repoDirectory, command) {
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repoDirectory }),
    encoding: 'utf8',
  });
  return /README WRITE NUDGE/.test(proc.stdout || '');
}

check('PostToolUse: commit shipped source, no docs → nudged',
  nudged(repoWithCommit({ 'src/app.js': 'export const x=1;' }, 'feat: x'), 'git commit -m "feat: x"') === true);

check('PostToolUse: commit included README → no nudge',
  nudged(repoWithCommit({ 'src/app.js': 'x', 'README.md': '# d' }, 'feat: x'), 'git commit -m "feat: x"') === false);

check('PostToolUse: docs commit → no nudge',
  nudged(repoWithCommit({ 'src/app.js': 'x' }, 'docs: notes'), 'git commit -m "docs: notes"') === false);

for (const path of cleanups) { try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ } }

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll docs-on-feature-commit checks passed.');
