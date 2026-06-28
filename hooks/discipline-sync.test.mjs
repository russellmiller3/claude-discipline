// Tests for discipline-sync's pure core. Run: node --test discipline-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hooksNeedingSync, changedHookBasenames } from './discipline-sync.mjs';

// ── hooksNeedingSync ──
test('flags a published hook whose live + kit copies differ as drift', () => {
  const readLive = (name) => ({ 'a.mjs': 'LIVE-A' }[name] ?? null);
  const readKit = (name) => ({ 'a.mjs': 'OLD-A' }[name] ?? null);
  assert.deepEqual(hooksNeedingSync(['a.mjs'], readLive, readKit), [{ basename: 'a.mjs', reason: 'drift' }]);
});

test('flags a NEW hook (no kit twin) as missing — must be published now', () => {
  const readLive = () => 'LIVE';
  const readKit = () => null;                 // not in the kit yet
  assert.deepEqual(hooksNeedingSync(['new-guard.mjs'], readLive, readKit), [{ basename: 'new-guard.mjs', reason: 'missing' }]);
});

test('flags a mix of missing + drift, skips in-sync', () => {
  const live = { 'a.mjs': '1', 'b.mjs': 'NEW', 'c.mjs': 'same' };
  const kit = { 'a.mjs': 'X', 'c.mjs': 'same' };          // b.mjs absent from kit
  const needing = hooksNeedingSync(['a.mjs', 'b.mjs', 'c.mjs'], (n) => live[n] ?? null, (n) => kit[n] ?? null);
  assert.deepEqual(needing.sort((x, y) => x.basename.localeCompare(y.basename)),
    [{ basename: 'a.mjs', reason: 'drift' }, { basename: 'b.mjs', reason: 'missing' }]);
});

test('does NOT flag a hook that is already in sync', () => {
  const same = () => 'IDENTICAL';
  assert.deepEqual(hooksNeedingSync(['a.mjs'], same, same), []);
});

test('does NOT flag when the live file is gone (deleted, not this guard\'s job)', () => {
  assert.deepEqual(hooksNeedingSync(['a.mjs'], () => null, () => 'KIT'), []);
});

// ── changedHookBasenames ──
const turn = (toolUses) => [{ role: 'assistant', message: { content: toolUses.map((t) => ({ type: 'tool_use', ...t })) } }];

test('detects a Write to a live hook file', () => {
  const got = changedHookBasenames(turn([{ name: 'Write', input: { file_path: 'C:/Users/rmill/.claude/hooks/foo-guard.mjs' } }]));
  assert.deepEqual(got, ['foo-guard.mjs']);
});

test('detects an Edit and includes .test.mjs', () => {
  const got = changedHookBasenames(turn([
    { name: 'Edit', input: { file_path: '/c/Users/rmill/.claude/hooks/bar.mjs' } },
    { name: 'Write', input: { file_path: '/c/Users/rmill/.claude/hooks/bar.test.mjs' } },
  ]));
  assert.deepEqual(got.sort(), ['bar.mjs', 'bar.test.mjs']);
});

test('detects a Bash cp that targets the live hooks dir', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: 'cp x ~/.claude/hooks/copied.mjs' } }]));
  assert.deepEqual(got, ['copied.mjs']);
});

test('ignores writes that are not in the hooks dir (no false positives)', () => {
  const got = changedHookBasenames(turn([
    { name: 'Write', input: { file_path: 'C:/Users/rmill/Desktop/programming/jarvis/src/app.mjs' } },
    { name: 'Edit', input: { file_path: 'C:/Users/rmill/.claude/hooks/HOOKBOOK.md' } },
  ]));
  assert.deepEqual(got, []);
});

// THE 2026-06-28 FIX: a hook edited in an EARLIER turn (with a later user turn in between) must still be detected —
// main() now scans the whole-session transcript, not just the current turn. Build a multi-turn transcript and assert
// the turn-1 hook edit is found even though turn 2 touched nothing relevant.
test('detects a hook edited in an earlier turn across a multi-turn session (the cross-turn miss)', () => {
  const sessionEntries = [
    { role: 'user', message: { content: 'go' } },
    ...turn([{ name: 'Edit', input: { file_path: 'C:/Users/rmill/.claude/hooks/agent-monitor-cadence.mjs' } }]),
    { role: 'user', message: { content: 'now do something unrelated' } },
    ...turn([{ name: 'Bash', input: { command: 'git status' } }]),
  ];
  assert.deepEqual(changedHookBasenames(sessionEntries), ['agent-monitor-cadence.mjs']);
});
