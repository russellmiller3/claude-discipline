#!/usr/bin/env node
/**
 * hook-must-enforce — PreToolUse(Write|Edit) META-GUARD: a hook that CLAIMS to enforce must actually have
 * TEETH. Blocks writing a hook file that emits a refusal/guard message (BLOCKED / deny / STOP / "must enforce")
 * but never actually denies, blocks, exits non-zero, or performs a side-effect. A hook with no teeth is a
 * comment with extra steps — it enforces the PRESENCE of a suggestion, not the OUTCOME.
 *
 * Why: it's easy to write a "guardrail" that only prints advice — a hook that "enforced" that a brief SAID to
 * commit, while the agent ignored it and lost work. This meta-hook makes the rule mechanical: present-as-
 * enforcement + no-teeth = blocked at write time. A hook must ENFORCE the OUTCOME, not nudge toward it.
 *
 * Scope: only files under a `hooks/` dir ending in `.mjs` (and not `*.test.mjs`). Override (rare — a genuinely
 * informational context-injector that only adds additionalContext and is NOT pretending to block): put the
 * marker `ADVISORY_ONLY_OK` in the file. Fail-open on any error.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The hook PRESENTS itself as enforcement if it writes a refusal/guard signal.
const SIGNALS_ENFORCEMENT = /\bBLOCKED\b|permissionDecision|["']deny["']|\bSTOP\b|must ENFORCE|\bdecision["']?\s*:\s*["']block/;

// Real TEETH — the hook can actually CAUSE the outcome, not just describe it:
const TEETH = [
  /permissionDecision\s*:\s*['"](deny|ask)['"]/,        // PreToolUse hard decision
  /["']?decision["']?\s*:\s*['"]block['"]/,             // block decision
  /process\.exit\(\s*2\s*\)/,                            // exit 2 = block
  /\b(execFileSync|execSync|spawnSync|exec|spawn)\s*\(/, // performs a real action (git commit, etc.)
  /\b(writeFileSync|appendFileSync|rmSync|renameSync|mkdirSync|unlinkSync)\s*\(/, // mutates the filesystem
];

// Pure verdict so the rule is unit-testable. A hook is "fake enforcement" iff it presents as enforcement but
// has no teeth (and hasn't opted out as advisory-only).
export function evaluateHookTeeth(content) {
  const hookSource = String(content || '');
  if (/ADVISORY_ONLY_OK/.test(hookSource)) return { ok: true, reason: 'opted out: advisory-only' };
  const signalsEnforcement = SIGNALS_ENFORCEMENT.test(hookSource);
  const hasTeeth = TEETH.some((pattern) => pattern.test(hookSource));
  if (signalsEnforcement && !hasTeeth) {
    return { ok: false, signalsEnforcement, hasTeeth, reason: 'presents as enforcement but has no teeth' };
  }
  return { ok: true, signalsEnforcement, hasTeeth, reason: 'has teeth or is not claiming to enforce' };
}

// Is this a hook source file we should police? (a .mjs under a hooks/ dir, not a test)
export function isHookFile(filePath) {
  const path = String(filePath || '').replace(/\\/g, '/');
  return /\/hooks\/[^/]+\.mjs$/.test(path) && !/\.test\.mjs$/.test(path);
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  if (!['Write', 'Edit', 'MultiEdit'].includes(event.tool_name || '')) process.exit(0);

  const input = event.tool_input || {};
  if (!isHookFile(input.file_path)) process.exit(0);

  // The content being written: Write gives the whole file; Edit/MultiEdit give the replacement text.
  const content = input.content
    || input.new_string
    || (Array.isArray(input.edits) ? input.edits.map((edit) => edit.new_string || '').join('\n') : '')
    || '';

  const verdict = evaluateHookTeeth(content);
  if (verdict.ok) process.exit(0);

  const reason = `Hook write BLOCKED — "${String(input.file_path).split(/[\\/]/).pop()}" presents as enforcement but has NO TEETH.

It writes a refusal/guard message (BLOCKED / deny / STOP / "must enforce") but never actually:
  - returns permissionDecision: 'deny' | 'ask', or
  - returns decision: 'block', or
  - exits with process.exit(2), or
  - performs a real side-effect (execFileSync/git commit, writeFileSync, etc.).

The rule: a hook must ENFORCE the OUTCOME, not nudge toward it. A hook that only prints advice is a comment
with extra steps — a guard that "enforced" that a brief SAID to commit while the agent ignored it and lost
work is no guard at all. Give this hook real teeth (deny / block / exit 2 / DO the thing).

Override (rare — a genuinely informational context-injector that is NOT pretending to block): add the marker
ADVISORY_ONLY_OK to the file.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Only run when executed directly as a hook — importing (e.g. from the test) must NOT block on stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
