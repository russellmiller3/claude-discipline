#!/usr/bin/env node
// agent-spawn-guard.test.mjs — locks the consolidated PreToolUse(Agent) spawn validator.
//
// Proves PARITY with the seven hooks it replaced (agent-sidebar-only, background-on-agent-spawn,
// worktree-on-agent-spawn, cross-repo-worktree-on-agent-spawn, agent-commit-cadence, agent-handoff-required,
// widget-ux-not-cli): each gate's true-positive (blocks) AND true-negatives (allows / overrides), the
// first-deny-wins ordering, non-Agent/non-PreToolUse pass-through, and the global disable + fail-open.
//
// Run: node --test agent-spawn-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { decideAgentSpawn } from './agent-spawn-guard.mjs';
import { evaluateAgentSpawn, buildContext } from './lib/agentSpawnGates.mjs';

const hookDirectory = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hookDirectory, 'agent-spawn-guard.mjs');

// A worktree-shaped agent brief that satisfies EVERY durability gate (worktree + commit cadence + handoff file),
// so a single missing property is what a given test isolates.
const FULL_WORKTREE_BRIEF =
  'Maintain an AGENT-HANDOFF.md at your worktree root and commit WIP to your branch after every passing test.';

function decideFor(toolInput, { env = {}, workingDirectory } = {}) {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: toolInput, cwd: workingDirectory };
  return decideAgentSpawn(event, { ...process.env, ...env });
}
const isBlocked = (decision) => decision?.hookSpecificOutput?.permissionDecision === 'deny';
const reasonOf = (decision) => decision?.hookSpecificOutput?.permissionDecisionReason || '';

// A minimally-valid spawn: background + worktree + cadence + handoff, non-research → must ALLOW.
const VALID_SPAWN = { description: 'fix parser bug', prompt: FULL_WORKTREE_BRIEF, run_in_background: true, isolation: 'worktree' };

test('a fully-valid worktree spawn -> allows', () => {
  assert.equal(isBlocked(decideFor(VALID_SPAWN)), false);
});

// ── Gate: SIDEBAR-ONLY ─────────────────────────────────────────────────────────────────────────
test('research-shaped brief (READ-ONLY) -> blocks (sidebar-only)', () => {
  const decision = decideFor({ description: 'find best practices', prompt: 'READ-ONLY web-research one-shot. Report as your final message.', run_in_background: true });
  assert.equal(isBlocked(decision), true);
  assert.match(reasonOf(decision), /SIDEBAR/i);
});
test('research brief with SIDEBAR_OK (+ valid worktree brief) -> allows', () => {
  const decision = decideFor({ description: 'sweep', prompt: `READ-ONLY web-research. SIDEBAR_OK — main thread keeps building. ${FULL_WORKTREE_BRIEF}`, run_in_background: true, isolation: 'worktree' });
  assert.equal(isBlocked(decision), false);
});
test('AGENT_SIDEBAR_ONLY_OK=1 env (+ valid worktree brief) -> allows a research brief', () => {
  const decision = decideFor({ description: 'sweep', prompt: `web-research one-shot. ${FULL_WORKTREE_BRIEF}`, run_in_background: true, isolation: 'worktree' }, { env: { AGENT_SIDEBAR_ONLY_OK: '1' } });
  assert.equal(isBlocked(decision), false);
});
test('kit write-contract brief (safe-merge-to-main.sh) -> allows despite research words', () => {
  const decision = decideFor({ description: 'build feature', prompt: `${FULL_WORKTREE_BRIEF} When done, land via safe-merge-to-main.sh.`, run_in_background: true, isolation: 'worktree' });
  assert.equal(isBlocked(decision), false);
});

// ── Gate: BACKGROUND ───────────────────────────────────────────────────────────────────────────
test('missing run_in_background -> blocks (background gate)', () => {
  const decision = decideFor({ description: 'build', prompt: FULL_WORKTREE_BRIEF, isolation: 'worktree' });
  assert.equal(isBlocked(decision), true);
  assert.match(reasonOf(decision), /run_in_background/);
});
test('FOREGROUND_RUSSELL_OK -> allows a foreground spawn', () => {
  const decision = decideFor({ description: 'build', prompt: `${FULL_WORKTREE_BRIEF} FOREGROUND_RUSSELL_OK`, isolation: 'worktree' });
  assert.equal(isBlocked(decision), false);
});

// ── Gate: WORKTREE ─────────────────────────────────────────────────────────────────────────────
test('background write-agent missing isolation:worktree -> blocks (worktree gate)', () => {
  const decision = decideFor({ description: 'build', prompt: 'Commit WIP often; maintain AGENT-HANDOFF.md.', run_in_background: true });
  assert.equal(isBlocked(decision), true);
  assert.match(reasonOf(decision), /worktree-isolated/);
});
test('the worktree gate itself allows when FOREGROUND_OK is present (unit-level)', () => {
  const reason = evaluateAgentSpawn({ prompt: 'FOREGROUND_OK build', isolation: '' }, buildContext({}, process.env));
  assert.equal(/worktree-isolated/.test(reason || ''), false, 'FOREGROUND_OK must not reach a worktree block');
});
test('brief that sets up its own worktree add -> allows', () => {
  const decision = decideFor({ description: 'sibling build', prompt: `First run git worktree add ../wt -b feature/x main. ${FULL_WORKTREE_BRIEF}`, run_in_background: true });
  assert.equal(isBlocked(decision), false);
});

// ── Gate: COMMIT-CADENCE + HANDOFF (worktree agents only) ────────────────────────────────────────
test('worktree agent with no commit-cadence -> blocks (cadence gate)', () => {
  const decision = decideFor({ description: 'build', prompt: 'Maintain an AGENT-HANDOFF.md at your worktree root.', run_in_background: true, isolation: 'worktree' });
  assert.equal(isBlocked(decision), true);
  assert.match(reasonOf(decision), /COMMIT-CADENCE/i);
});
test('worktree agent with no handoff file -> blocks (handoff gate)', () => {
  const decision = decideFor({ description: 'build', prompt: 'Commit WIP to your branch after every passing test.', run_in_background: true, isolation: 'worktree' });
  assert.equal(isBlocked(decision), true);
  assert.match(reasonOf(decision), /HANDOFF-FILE/i);
});
test('COMMIT_CADENCE_OK + AGENT_HANDOFF_OK -> allows a bare worktree brief', () => {
  const decision = decideFor({ description: 'one-shot', prompt: 'Do the thing. COMMIT_CADENCE_OK AGENT_HANDOFF_OK', run_in_background: true, isolation: 'worktree' });
  assert.equal(isBlocked(decision), false);
});
test('non-worktree agent is exempt from cadence + handoff gates', () => {
  const decision = decideFor({ description: 'compute', prompt: 'Run a bounded computation and return the number. git worktree add covered.', run_in_background: true });
  assert.equal(isBlocked(decision), false);
});

// ── Gate: CROSS-REPO (needs real sibling repo on disk) ───────────────────────────────────────────
test('brief driving a SIBLING repo by absolute path, no worktree add -> blocks (cross-repo gate)', () => {
  const parentDirectory = mkdtempSync(join(tmpdir(), 'agent-spawn-siblings-'));
  const sessionRepo = join(parentDirectory, 'session'); mkdirSync(join(sessionRepo, '.git'), { recursive: true });
  const siblingRepo = join(parentDirectory, 'sibling'); mkdirSync(join(siblingRepo, '.git'), { recursive: true });
  const decision = decideFor(
    { description: 'edit sibling', prompt: `${FULL_WORKTREE_BRIEF} Then edit and commit files in ${siblingRepo} directly.`, run_in_background: true, isolation: 'worktree' },
    { workingDirectory: sessionRepo },
  );
  assert.equal(isBlocked(decision), true);
  assert.match(reasonOf(decision), /SIBLING repo/);
  rmSync(parentDirectory, { recursive: true, force: true });
});
test('read-only mention of a sibling repo -> allows (read/write intent carve-out)', () => {
  const parentDirectory = mkdtempSync(join(tmpdir(), 'agent-spawn-siblings-'));
  const sessionRepo = join(parentDirectory, 'session'); mkdirSync(join(sessionRepo, '.git'), { recursive: true });
  const siblingRepo = join(parentDirectory, 'sibling'); mkdirSync(join(siblingRepo, '.git'), { recursive: true });
  const decision = decideFor(
    { description: 'read sibling for reference', prompt: `${FULL_WORKTREE_BRIEF} Read ${siblingRepo} for reference, then build entirely in the session repo.`, run_in_background: true, isolation: 'worktree' },
    { workingDirectory: sessionRepo },
  );
  assert.equal(isBlocked(decision), false);
  rmSync(parentDirectory, { recursive: true, force: true });
});

// 2026-07-16 FALSE-BLOCK: a brief referencing a sibling ONLY read-only (a sys.path import shim
// `export SRC=<sibling>/src`, reading reference lines) was blocked because the shim clause carries
// neither a read nor write cue. A self-declared `SIBLING_READ_ONLY:` marker + no git-write clears it.
test('SIBLING_READ_ONLY marker on a read-only shim (no git-write in sibling) -> allows', () => {
  const parentDirectory = mkdtempSync(join(tmpdir(), 'agent-spawn-siblings-'));
  const sessionRepo = join(parentDirectory, 'session'); mkdirSync(join(sessionRepo, '.git'), { recursive: true });
  const siblingRepo = join(parentDirectory, 'sibling'); mkdirSync(join(siblingRepo, '.git'), { recursive: true });
  const decision = decideFor(
    { description: 'import shim', prompt: `${FULL_WORKTREE_BRIEF} export SKAFFEN_SRC=${siblingRepo}/src for imports. SIBLING_READ_ONLY: ${siblingRepo}`, run_in_background: true, isolation: 'worktree' },
    { workingDirectory: sessionRepo },
  );
  assert.equal(isBlocked(decision), false);
  rmSync(parentDirectory, { recursive: true, force: true });
});
test('SIBLING_READ_ONLY marker does NOT disarm a real git-write in the sibling -> still blocks', () => {
  const parentDirectory = mkdtempSync(join(tmpdir(), 'agent-spawn-siblings-'));
  const sessionRepo = join(parentDirectory, 'session'); mkdirSync(join(sessionRepo, '.git'), { recursive: true });
  const siblingRepo = join(parentDirectory, 'sibling'); mkdirSync(join(siblingRepo, '.git'), { recursive: true });
  const decision = decideFor(
    { description: 'sneaky write', prompt: `${FULL_WORKTREE_BRIEF} SIBLING_READ_ONLY: ${siblingRepo}. Then git -C ${siblingRepo} checkout -b feature/x.`, run_in_background: true, isolation: 'worktree' },
    { workingDirectory: sessionRepo },
  );
  assert.equal(isBlocked(decision), true);
  assert.match(reasonOf(decision), /SIBLING repo/);
  rmSync(parentDirectory, { recursive: true, force: true });
});

// ── Gate: WIDGET-UX (needs a widget.html on disk) ────────────────────────────────────────────────
test('brief exposing UX via a CLI in a project with widget.html -> blocks (widget-ux gate)', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agent-spawn-widget-'));
  mkdirSync(join(projectRoot, '.git'), { recursive: true });
  writeFileSync(join(projectRoot, 'widget.html'), '<html></html>', 'utf8');
  const decision = decideFor(
    { description: 'surface UX', prompt: `${FULL_WORKTREE_BRIEF} Expose the UX via a python -m app.chat CLI.`, run_in_background: true, isolation: 'worktree' },
    { workingDirectory: projectRoot },
  );
  assert.equal(isBlocked(decision), true);
  assert.match(reasonOf(decision), /WIDGET/i);
  rmSync(projectRoot, { recursive: true, force: true });
});
test('UX_CLI_OK -> allows a CLI-UX brief', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agent-spawn-widget-'));
  mkdirSync(join(projectRoot, '.git'), { recursive: true });
  writeFileSync(join(projectRoot, 'widget.html'), '<html></html>', 'utf8');
  const decision = decideFor(
    { description: 'surface UX', prompt: `${FULL_WORKTREE_BRIEF} Expose the UX via a python -m CLI. UX_CLI_OK — dev tool only.`, run_in_background: true, isolation: 'worktree' },
    { workingDirectory: projectRoot },
  );
  assert.equal(isBlocked(decision), false);
  rmSync(projectRoot, { recursive: true, force: true });
});

// ── ordering: first-deny-wins ────────────────────────────────────────────────────────────────────
test('a brief failing MULTIPLE gates blocks on the FIRST (sidebar before background)', () => {
  const decision = decideFor({ description: 'research', prompt: 'READ-ONLY web-research one-shot.' }); // research + missing background
  assert.equal(isBlocked(decision), true);
  assert.match(reasonOf(decision), /SIDEBAR/i, 'sidebar-only fires before the background gate');
});

// ── pass-through + safety ────────────────────────────────────────────────────────────────────────
test('non-Agent tool -> allows (null)', () => {
  assert.equal(decideAgentSpawn({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
});
test('non-PreToolUse event -> allows (null)', () => {
  assert.equal(decideAgentSpawn({ hook_event_name: 'Stop', tool_name: 'Agent', tool_input: {} }), null);
});
test('AGENT_SPAWN_GUARD_OFF=1 -> allows everything', () => {
  const decision = decideFor({ description: 'research', prompt: 'READ-ONLY web-research' }, { env: { AGENT_SPAWN_GUARD_OFF: '1' } });
  assert.equal(isBlocked(decision), false);
});
test('end-to-end through stdin: a research spawn is denied via the real hook process', () => {
  const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'r', prompt: 'READ-ONLY web-research one-shot' } });
  const hookProcess = spawnSync('node', [HOOK_PATH], { input: event, encoding: 'utf8' });
  assert.match((hookProcess.stdout || '') + (hookProcess.stderr || ''), /"permissionDecision"\s*:\s*"deny"/);
});
test('malformed stdin -> silent pass (fail-open)', () => {
  const hookProcess = spawnSync('node', [HOOK_PATH], { input: '{not json', encoding: 'utf8' });
  assert.equal(hookProcess.status, 0);
  assert.doesNotMatch((hookProcess.stdout || '') + (hookProcess.stderr || ''), /deny/);
});
test('importing the hook does NOT execute main (basename entry guard)', () => {
  const importProbe = spawnSync('node', ['--input-type=module', '-e',
    `import(${JSON.stringify('file:///' + HOOK_PATH.replace(/\\/g, '/'))}).then(() => console.log('imported-ok'));`,
  ], { input: '', encoding: 'utf8', timeout: 15000 });
  assert.match((importProbe.stdout || '') + (importProbe.stderr || ''), /imported-ok/);
});
