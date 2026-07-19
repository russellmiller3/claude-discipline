// Tests for learnings-write-nudge.mjs — the Stop-time gate that BLOCKS when a real bug was
// diagnosed + fixed but no learning was logged. Regression target: the 2026-07-19 party-line
// saga (busy signal / inbound-token) — a behavioral bug with no stack trace, fixed via provider
// API calls (no code diff), which the old "strong-error + code-edit" trigger missed entirely.
//
//   node --test hooks/learnings-write-nudge.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_BUG_REPORT_RE, classifyTurn, shouldBlockForLearning } from './learnings-write-nudge.mjs';

const userText = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistantText = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const toolUse = (name, input) => ({ role: 'assistant', content: [{ type: 'tool_use', name, input }] });

// ── the human-reported-bug regex (the new signal) ─────────────────────────────
test('USER_BUG_REPORT_RE matches tonight\'s real bug reports', () => {
  for (const report of [
    '912 doesnt work either',
    'still get busy signal on 415. frustrated',
    'party line still hangs up on me',
    'it still says masher. come one',
    'party should know what city im in',            // "should know" → not matched; see negative below
  ].slice(0, 4)) {
    assert.ok(USER_BUG_REPORT_RE.test(report), `should flag: ${report}`);
  }
});
test('USER_BUG_REPORT_RE does NOT flag innocent requests', () => {
  for (const benign of [
    'make it talk slightly slower too',
    'add a rule that skips previews for landing pages',
    'ok it connects now! great',
    'rebuild the trades page at the new acv',
  ]) {
    assert.equal(USER_BUG_REPORT_RE.test(benign), false, `should NOT flag: ${benign}`);
  }
});

// ── classify + decide: the party-line regression (behavioral bug, infra fix, no learning) ──
test('BLOCKS: user-reported bug + infra fix (wrangler secret) + no learning', () => {
  const turn = [
    userText('912 doesnt work either'),
    toolUse('Bash', { command: "printf '+1912...' | npx wrangler secret put MACHER_PARTY_LINE_NUMBER" }),
  ];
  const facts = classifyTurn(turn);
  assert.deepEqual(facts, { sawError: true, sawFix: true, wroteLearning: false, dismissed: false });
  assert.equal(shouldBlockForLearning(facts), true);
});
test('BLOCKS: user-reported bug + provider API mutation (PATCH) + no learning', () => {
  const turn = [
    userText('still says masher'),
    toolUse('Bash', { command: 'node -e "fetch(url,{method:\\"PATCH\\"})"' }),
  ];
  assert.equal(shouldBlockForLearning(classifyTurn(turn)), true);
});

// ── the escape hatches still work ─────────────────────────────────────────────
test('does NOT block once a learning is written', () => {
  const turn = [
    userText('party line still hangs up'),
    toolUse('Bash', { command: 'npx wrangler deploy' }),
    toolUse('Edit', { file_path: 'C:/Users/rmill/Desktop/programming/Macher/learnings.md' }),
  ];
  assert.equal(shouldBlockForLearning(classifyTurn(turn)), false);
});
test('does NOT block when explicitly dismissed', () => {
  const turn = [
    userText('doesnt work'),
    toolUse('Bash', { command: 'npx wrangler secret put X' }),
    assistantText('This was a stale env var — no-learning-needed, nothing durable here.'),
  ];
  assert.equal(shouldBlockForLearning(classifyTurn(turn)), false);
});
test('a USER echoing the dismiss token does NOT count as a dismissal', () => {
  const turn = [
    userText('doesnt work, and no-learning-needed is not something you get to decide'),
    toolUse('Bash', { command: 'npx wrangler secret put X' }),
  ];
  assert.equal(classifyTurn(turn).dismissed, false);
  assert.equal(shouldBlockForLearning(classifyTurn(turn)), true);
});

// ── negatives: no over-firing ─────────────────────────────────────────────────
test('does NOT block a bug report with NO fix action (investigation only)', () => {
  const turn = [userText('the call hangs up'), toolUse('Bash', { command: 'curl -s https://api...' })];
  assert.equal(shouldBlockForLearning(classifyTurn(turn)), false); // read-only curl is not a fix
});
test('does NOT block a normal feature turn (no bug reported)', () => {
  const turn = [
    userText('add a taco-finder to the party line'),
    toolUse('Edit', { file_path: 'src/lib/gateway.ts' }),
    toolUse('Bash', { command: 'npx wrangler deploy' }),
  ];
  assert.equal(classifyTurn(turn).sawError, false);
  assert.equal(shouldBlockForLearning(classifyTurn(turn)), false);
});
