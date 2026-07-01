import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'new-repo-scaffold.mjs');

function runHook({ command, repoDir }) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: repoDir, tool_input: { command } }),
    encoding: 'utf8',
  });
}

function makeRepoDir() {
  return mkdtempSync(join(tmpdir(), 'new-repo-'));
}

test('git init scaffolds README (north star) + HANDOFF.md + learnings.md when missing', () => {
  const repoDir = makeRepoDir();
  const hookRun = runHook({ command: 'git init', repoDir });

  assert.equal(hookRun.status, 0);
  assert.ok(existsSync(join(repoDir, 'README.md')), 'README.md should be created');
  assert.ok(existsSync(join(repoDir, 'HANDOFF.md')), 'HANDOFF.md should be created');
  assert.ok(existsSync(join(repoDir, 'learnings.md')), 'learnings.md should be created');
  const readmeText = readFileSync(join(repoDir, 'README.md'), 'utf8');
  assert.match(readmeText, /North Star/, 'README must carry a North Star section');
  assert.match(readmeText, /Go-to-market/i, 'README must carry a GTM section');
  assert.match(readmeText, /Roadmap/i, 'README must carry a roadmap section');
  const scaffoldOutput = JSON.parse(hookRun.stdout);
  assert.match(scaffoldOutput.hookSpecificOutput.additionalContext, /INTERVIEW Russell/i, 'must tell me to interview Russell on the stack');
});

test('a non-git-init command is a no-op (no files, no output)', () => {
  const repoDir = makeRepoDir();
  const hookRun = runHook({ command: 'git status', repoDir });

  assert.equal(hookRun.status, 0);
  assert.equal(hookRun.stdout, '');
  assert.equal(existsSync(join(repoDir, 'HANDOFF.md')), false);
});

test('a Python repo also gets a pre-commit config + install next-step', () => {
  const repoDir = makeRepoDir();
  writeFileSync(join(repoDir, 'requirements.txt'), 'numpy\n', 'utf8');
  const hookRun = runHook({ command: 'git init', repoDir });

  assert.equal(hookRun.status, 0);
  assert.ok(existsSync(join(repoDir, '.pre-commit-config.yaml')), 'pre-commit config should be scaffolded for Python');
  assert.match(JSON.parse(hookRun.stdout).hookSpecificOutput.additionalContext, /pre_commit install/);
});

test('existing HANDOFF.md is never overwritten', () => {
  const repoDir = makeRepoDir();
  writeFileSync(join(repoDir, 'HANDOFF.md'), '# my real handoff\n', 'utf8');
  const hookRun = runHook({ command: 'git init', repoDir });

  assert.equal(hookRun.status, 0);
  assert.equal(readFileSync(join(repoDir, 'HANDOFF.md'), 'utf8'), '# my real handoff\n', 'must not clobber an existing handoff');
  assert.ok(existsSync(join(repoDir, 'learnings.md')), 'still creates the missing learnings.md');
});
