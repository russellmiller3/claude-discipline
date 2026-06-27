#!/usr/bin/env node
/**
 * PreToolUse hook (Write + Edit) — block BULLSHIT TESTS.
 *
 * The "No Bullshit Tests" rule (~/.claude/CLAUDE.md):
 *   - Every test must verify behavior that could actually break.
 *   - A test that only checks "no errors" is a smoke test, not a correctness test.
 *   - Assert the real output, saved state, rendered result, security guard, or data flow.
 *
 * Fires ONLY on test files (the complement of forbidden-patterns.mjs, which SKIPS tests).
 *
 * HARD BLOCK (deny) — unambiguous, ~zero false-positive:
 *   - Tautological constant assertions: assert(true) / assert.ok(true) / assert.ok(1)
 *     / assert.equal(1, 1) / assert.equal(true, true) / assert.equal(x, x) (same token both sides).
 *   - Smoke "is it a function" checks as a test's ONLY assertion:
 *     assert.equal(typeof foo, 'function') with nothing else in the block.
 *
 * SOFT WARN (allow + message) — fuzzy, helper-driven harnesses are legit:
 *   - A test()/it() block that contains NO assertion call at all. Could be an
 *     assert-no-error smoke test, OR a harness that asserts inside a helper. Warn, don't block.
 *
 * Override a false positive: say "no-bullshit override: <reason>" and retry.
 * Fail-open on any error — never brick CC.
 */

import { readFileSync } from 'node:fs';

const TEST_PATH = /(\.test\.|\.spec\.|[/\\]tests?[/\\]|[/\\]__tests__[/\\])/i;

// Any token that signals a real assertion is being made.
const ASSERTION_TOKEN = /\bassert\b|\bexpect\s*\(|\.should\b|\bt\.assert\b/;

// Tautological constant assertions — these verify nothing and never belong in a real test.
const TAUTOLOGY_PATTERNS = [
  // assert(true) / assert.ok(true) / assert.ok(1) / assert.ok(!!1)
  { re: /\bassert(?:\.ok)?\s*\(\s*(?:true|1|!!1)\s*[,)]/g, label: 'assert(true) / assert.ok(true)' },
  // assert.equal-family comparing two literals: assert.equal(1, 1), assert.strictEqual(true, true)
  { re: /\bassert\.\w*equal\w*\s*\(\s*(?:true|false|\d+|(['"`]).*?\1)\s*,\s*(?:true|false|\d+|(['"`]).*?\2)\s*\)/g, label: 'assert.equal(<literal>, <literal>)' },
  // assert.equal(x, x) — identical identifier/expression on both sides
  { re: /\bassert\.\w*equal\w*\s*\(\s*([A-Za-z_$][\w$.]*)\s*,\s*\1\s*[,)]/g, label: 'assert.equal(x, x)' },
];

// "is it a function" smoke check — weak unless paired with a behavioral assertion.
const TYPEOF_FUNCTION = /typeof\s+[\w$.[\]'"]+\s*(?:===?|,)\s*['"]function['"]|['"]function['"]\s*===?\s*typeof/;

function extractMatches(text, re) {
  const hits = [];
  const localRe = new RegExp(re.source, re.flags);
  let m;
  while ((m = localRe.exec(text)) !== null) {
    hits.push(m[0].replace(/\s+/g, ' ').slice(0, 80));
    if (hits.length >= 4) break;
    if (m.index === localRe.lastIndex) localRe.lastIndex++;
  }
  return hits;
}

// Segment the file at each test()/it() boundary. Each segment holds one test's body
// (plus any trailing helper code, which only ADDS assertions → conservative, never a false block).
function testSegments(text) {
  const boundary = /\b(?:test|it)(?:\.\w+)?\s*\(/g;
  const starts = [];
  let m;
  while ((m = boundary.exec(text)) !== null) starts.push(m.index);
  if (starts.length === 0) return [];
  const segments = [];
  for (let i = 0; i < starts.length; i++) {
    segments.push(text.slice(starts[i], starts[i + 1] ?? text.length));
  }
  return segments;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

  const tool = event.tool_name || '';
  if (tool !== 'Write' && tool !== 'Edit') process.exit(0);

  const input = event.tool_input || {};
  const path = (input.file_path || '').replace(/\\/g, '/');
  if (!TEST_PATH.test(path)) process.exit(0); // only police test files

  const text = tool === 'Write' ? (input.content || '') : (input.new_string || '');
  if (!text) process.exit(0);

  // Honor an explicit override anywhere in the surrounding intent.
  const allText = `${text}\n${input.old_string || ''}`;
  if (/no-bullshit\s+override:/i.test(allText)) process.exit(0);

  // ── DENY: tautological constants (anywhere in the written text) ──
  const tautologyHits = [];
  for (const p of TAUTOLOGY_PATTERNS) {
    const hits = extractMatches(text, p.re);
    if (hits.length) tautologyHits.push({ label: p.label, hits });
  }

  // ── DENY: a test block whose ONLY assertion is a typeof-is-a-function smoke check ──
  const smokeOnlyTests = [];
  for (const seg of testSegments(text)) {
    if (!TYPEOF_FUNCTION.test(seg)) continue; // only segments that DO a typeof-function check
    // A test is smoke-only when EVERY assertion line in it is either a typeof-function
    // check or a tautology — i.e. no line makes a real behavioral claim.
    const assertionLines = seg.split('\n').filter((ln) => ASSERTION_TOKEN.test(ln));
    const allSmoke = assertionLines.length > 0 && assertionLines.every(
      (ln) => TYPEOF_FUNCTION.test(ln) || TAUTOLOGY_PATTERNS.some((p) => new RegExp(p.re.source).test(ln)),
    );
    if (allSmoke) {
      const name = (seg.match(/^[^]*?\(\s*['"`]([^'"`]+)['"`]/) || [])[1] || '(unnamed)';
      smokeOnlyTests.push(name);
    }
  }

  const denyBlocks = [];
  if (tautologyHits.length) {
    denyBlocks.push(
      `  ❌ Tautological assertion(s) — these are always true and verify nothing:\n` +
      tautologyHits.map((t) => `     • ${t.label}: ${t.hits.map((h) => `"${h}"`).join(', ')}`).join('\n')
    );
  }
  if (smokeOnlyTests.length) {
    denyBlocks.push(
      `  ❌ Smoke-only test(s) — the ONLY assertion checks "is it a function", not behavior:\n` +
      smokeOnlyTests.map((n) => `     • ${n}`).join('\n')
    );
  }

  if (denyBlocks.length) {
    const reason =
      `Bullshit test — STOP before writing.\n\n` +
      `${denyBlocks.join('\n')}\n\n` +
      `The "No Bullshit Tests" rule: every test must verify behavior that could actually break.\n` +
      `Assert the REAL output, saved DB state, rendered/injected text, a guard's allow/deny, ordering, or\n` +
      `a specific error message — not a constant, not "it's a function", not "it didn't throw".\n` +
      `If this is a genuine false positive, say "no-bullshit override: <reason>" and retry.`;
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  }

  // ── WARN (allow): test block(s) with no assertion at all. Could be assert-no-error
  // smoke OR a legit helper-driven harness — surface it, don't block. ──
  const noAssertTests = [];
  for (const seg of testSegments(text)) {
    if (ASSERTION_TOKEN.test(seg)) continue;
    const name = (seg.match(/^[^]*?\(\s*['"`]([^'"`]+)['"`]/) || [])[1];
    if (name) noAssertTests.push(name);
  }
  if (noAssertTests.length) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          `No-Bullshit-Tests warning (allowed — check needed):\n` +
          `  ⚠️  Test(s) with no visible assertion: ${noAssertTests.map((n) => `"${n}"`).join(', ')}\n` +
          `If these run code and never assert the result, that's a smoke test, not a correctness test —\n` +
          `assert the real output/state. If assertions live in a shared helper, ignore this.`,
      },
    }));
  }

  process.exit(0);
}

try { main(); } catch { process.exit(0); }
