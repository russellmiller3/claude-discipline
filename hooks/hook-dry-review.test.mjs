#!/usr/bin/env node
// hook-dry-review.test.mjs — proves the meta-guard BLOCKS a hook that hand-rolls a shared-lib helper,
// PASSES when the hook imports the lib (or the helper is genuinely absent), and honors every escape.
// Run: node hook-dry-review.test.mjs   (exits non-zero on failure)

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isPolicedHookFile, evaluateDry, evaluateNewHook } from './hook-dry-review.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'hook-dry-review.mjs');
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ── isPolicedHookFile ───────────────────────────────────────────────────────
ok(isPolicedHookFile('C:\\Users\\x\\.claude\\hooks\\foo.mjs'), 'a hooks/*.mjs is policed');
ok(isPolicedHookFile('/home/x/.claude/hooks/bar.mjs'), 'posix hooks/*.mjs is policed');
ok(!isPolicedHookFile('/home/x/.claude/hooks/foo.test.mjs'), 'a *.test.mjs is NOT policed');
ok(!isPolicedHookFile('/home/x/.claude/hooks/lib/transcript.mjs'), 'the shared lib itself is NOT policed');
ok(!isPolicedHookFile('/home/x/src/app.mjs'), 'a non-hook file is NOT policed');

// ── evaluateDry: BLOCK cases (≥3 differently-worded positives) ───────────────
ok(evaluateDry('function readTranscript(p) { return []; }').block, 'local readTranscript blocks');
ok(evaluateDry('function roleOf(e){return e.role;}\nfunction toolUsesOf(e){return [];}').block, 'local roleOf/toolUsesOf blocks');
ok(evaluateDry('const contentBlocks = (e) => e.content;').block, 'arrow-form contentBlocks blocks');
ok(evaluateDry('const currentTurnEntries = entries => entries;').block, 'arrow currentTurnEntries blocks');
{
  const verdict = evaluateDry('function readTranscript(){}\nfunction roleOf(){}');
  ok(verdict.block && verdict.reimplemented.includes('readTranscript') && verdict.reimplemented.includes('roleOf'), 'reports all re-implemented helpers');
}

// ── evaluateDry: PASS cases ─────────────────────────────────────────────────
ok(!evaluateDry("import { readTranscript, roleOf } from './lib/transcript.mjs';\n// use them").block, 'importing the lib passes');
ok(!evaluateDry('function detectDanger(command){return false;}').block, 'an unrelated helper passes');
ok(!evaluateDry('// just a comment, no helpers').block, 'empty-ish content passes');
ok(!evaluateDry('function readTranscript(){}\n// dry-reviewed: this parses a DIFFERENT log format').block, 'dry-reviewed override passes');

// ── end-to-end via stdin (real deny shape) ───────────────────────────────────
function runHook({ tool_name = 'Write', file_path, content, env = {} }) {
  const completed = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path, content } }),
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  return completed.stdout || '';
}

{
  const hookOutput = runHook({ file_path: '/home/x/.claude/hooks/new-guard.mjs', content: 'function readTranscript(){ return []; }' });
  ok(/permissionDecision/.test(hookOutput) && /deny/.test(hookOutput), 'e2e: hand-rolled helper is denied');
  ok(/transcript\.mjs/.test(hookOutput), 'e2e: denial points at the shared lib');
}
{
  // A NEW hook must pass BOTH gates: import the lib (DRY) AND declare its category (new-hook sweep).
  const hookOutput = runHook({ file_path: '/home/x/.claude/hooks/new-guard.mjs', content: "// new-hook-category: Meta — nearest is hookbook-sync; this does something else\nimport { roleOf } from './lib/transcript.mjs';" });
  ok(hookOutput.trim() === '', 'e2e: lib-importing hook WITH a category declaration is allowed (no output)');
}

// ── evaluateNewHook: the NEW-HOOK category sweep (2026-07-15) ─────────────────
ok(evaluateNewHook({ toolName: 'Write', fileExists: false, content: '// a brand-new hook, no category declared' }).block, 'new hook Write with no category declaration blocks');
ok(!evaluateNewHook({ toolName: 'Write', fileExists: false, content: '// new-hook-category: Git safety — nearest is no-write-to-main; different because X' }).block, 'new hook WITH a new-hook-category declaration passes');
ok(!evaluateNewHook({ toolName: 'Write', fileExists: false, content: '// dry-reviewed: genuinely distinct' }).block, 'the dry-reviewed override passes the new-hook gate too');
ok(!evaluateNewHook({ toolName: 'Write', fileExists: true, content: 'no category' }).block, 'a Write that OVERWRITES an existing hook is not a new hook -> passes');
ok(!evaluateNewHook({ toolName: 'Edit', fileExists: false, content: 'no category' }).block, 'an Edit (extend path) is never gated by the new-hook sweep');
{
  const hookOutput = runHook({ file_path: '/home/x/.claude/hooks/brand-new-idea.mjs', content: 'export function main(){}' });
  ok(/permissionDecision/.test(hookOutput) && /deny/.test(hookOutput), 'e2e: a brand-new hook with no category is denied');
  ok(/SWEEP THE EXISTING HOOKS|new-hook-category/.test(hookOutput), 'e2e: the denial forces the category sweep');
}
{
  const hookOutput = runHook({ file_path: '/home/x/.claude/hooks/new-guard.mjs', content: 'function readTranscript(){}', env: { HOOK_DRY_OVERRIDE: '1' } });
  ok(hookOutput.trim() === '', 'e2e: HOOK_DRY_OVERRIDE=1 allows it');
}
{
  const hookOutput = runHook({ file_path: '/home/x/.claude/hooks/lib/transcript.mjs', content: 'export function readTranscript(){}' });
  ok(hookOutput.trim() === '', 'e2e: the lib file itself is exempt');
}

console.log(`hook-dry-review.test.mjs — ${passed} checks passed`);
