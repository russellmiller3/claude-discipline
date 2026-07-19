import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { evaluateAgentDelegation, matchesCore, readCoreGlobs } from './no-core-delegation-guard.mjs';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'no-core-delegation-guard.mjs');

// The Macher gateway core + the marcus experiment science, as their core-paths.txt would declare them.
const MACHER_CORE = ['cloudflare/retell-gateway/src/gateway.ts'];
const MARCUS_CORE = ['scripts/exp*.py', 'scripts/runpod_exp*.py', 'scripts/modal_*.py', 'scripts/train_qwen_*.py'];

// ── Gate A — per-session signoff (deny-by-default) ───────────────────────────
test('(a) DENIES a normal Agent spawn with no session signoff', () => {
  const verdict = evaluateAgentDelegation({ prompt: 'Refactor the caption renderer in ui/Caption.svelte', approved: false });
  assert.equal(verdict.block, true);
  assert.equal(verdict.gate, 'A');
});

test('(b) ALLOWS the same spawn once the session signoff is present', () => {
  const verdict = evaluateAgentDelegation({ prompt: 'Refactor the caption renderer in ui/Caption.svelte', approved: true });
  assert.equal(verdict.block, false);
});

test('(b2) ALLOWS when the AGENTS_APPROVED token is in the brief', () => {
  const verdict = evaluateAgentDelegation({ prompt: 'AGENTS_APPROVED — refactor ui/Caption.svelte', approved: false });
  assert.equal(verdict.block, false);
});

test('(c) DENIES even when the brief says "in parallel" (parallel is NOT signoff)', () => {
  const verdict = evaluateAgentDelegation({ prompt: 'Do these three refactors in parallel across the app', approved: false });
  assert.equal(verdict.block, true);
  assert.equal(verdict.gate, 'A');
});

// ── Gate B — never delegate CORE edits, even WITH a signoff ───────────────────
test('(d) blocks "extract executeTool from gateway.ts" (Macher core)', () => {
  const verdict = evaluateAgentDelegation({ prompt: 'Extract executeTool from cloudflare/retell-gateway/src/gateway.ts into its own module', approved: true, coreGlobs: MACHER_CORE });
  assert.equal(verdict.block, true);
  assert.equal(verdict.gate, 'B');
});

test('(e) blocks "port exp147c to Qwen 1.5B" (experiment science is core)', () => {
  const verdict = evaluateAgentDelegation({ prompt: 'Port exp147c and exp149 to Qwen 1.5B — reduce the load-bearing claim', approved: true, coreGlobs: MARCUS_CORE });
  assert.equal(verdict.block, true);
  assert.equal(verdict.gate, 'B');
});

test('(f) ALLOWS a read-only "audit gateway.ts" brief (reading core is fine)', () => {
  const verdict = evaluateAgentDelegation({ prompt: 'Audit cloudflare/retell-gateway/src/gateway.ts and summarize the tool-routing flow', approved: true, coreGlobs: MACHER_CORE });
  assert.equal(verdict.block, false);
});

test('(g) ALLOWS an edit brief touching only a peripheral file', () => {
  const verdict = evaluateAgentDelegation({ prompt: 'Refactor the marketing copy in src/routes/landing/+page.svelte', approved: true, coreGlobs: MACHER_CORE });
  assert.equal(verdict.block, false);
});

test('(h) ALLOWS a core edit brief that carries CORE_AGENT_OK (Russell approved)', () => {
  const verdict = evaluateAgentDelegation({ prompt: 'Extract executeTool from gateway.ts. CORE_AGENT_OK — Russell approved this delegation.', approved: true, coreGlobs: MACHER_CORE });
  assert.equal(verdict.block, false);
});

// ── matchesCore / core-paths behavior ────────────────────────────────────────
test('(i) respects .claude/core-paths.txt globs; short "exp" stem needs a digit (no false-fire)', () => {
  assert.ok(matchesCore('port exp147c to qwen', MARCUS_CORE), 'exp147c matches scripts/exp*.py');
  assert.equal(matchesCore('please explain the export flow and expand the docs', MARCUS_CORE), null, 'explain/export/expand do NOT match');
  assert.ok(matchesCore('touch gateway.ts', MACHER_CORE), 'gateway.ts matches by literal + stem');
});

test('readCoreGlobs reads and filters a repo core-paths.txt (comments + blanks skipped)', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'core-paths-'));
  mkdirSync(join(repoRoot, '.claude'), { recursive: true });
  writeFileSync(join(repoRoot, '.claude', 'core-paths.txt'), '# the brain\ncloudflare/retell-gateway/src/gateway.ts\n\nsrc/lib/engine/**\n');
  try {
    assert.deepEqual(readCoreGlobs(repoRoot), ['cloudflare/retell-gateway/src/gateway.ts', 'src/lib/engine/**']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── End-to-end: the hook process denies/allows via stdin, honoring the env signoff ──
function runHook(prompt, env = {}) {
  const childEnv = { ...process.env, AGENTS_APPROVED_THIS_SESSION: undefined, AGENTS_APPROVAL_SENTINEL: join(tmpdir(), 'no-such-sentinel-file'), ...env };
  const run = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt } }),
    encoding: 'utf8',
    env: childEnv,
  });
  return run.stdout || '';
}
const denied = (stdout) => /"permissionDecision"\s*:\s*"deny"/.test(stdout);

test('end-to-end: DENIES a spawn with no env signoff', () => {
  assert.equal(denied(runHook('refactor something')), true);
});
test('end-to-end: ALLOWS a spawn when AGENTS_APPROVED_THIS_SESSION=1', () => {
  assert.equal(denied(runHook('refactor something', { AGENTS_APPROVED_THIS_SESSION: '1' })), false);
});
