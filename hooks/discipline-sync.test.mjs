// Tests for discipline-sync's pure core. Run: node --test discipline-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftedPublishedHooks, changedHookBasenames } from './discipline-sync.mjs';

// ── driftedPublishedHooks ──
test('flags a published hook whose live + kit copies differ', () => {
  const readLive = (name) => ({ 'a.mjs': 'LIVE-A' }[name] ?? null);
  const readKit = (name) => ({ 'a.mjs': 'OLD-A' }[name] ?? null);
  assert.deepEqual(driftedPublishedHooks(['a.mjs'], readLive, readKit), ['a.mjs']);
});

test('flags multiple drifted published hooks', () => {
  const live = { 'a.mjs': '1', 'b.mjs': '2', 'c.mjs': 'same' };
  const kit = { 'a.mjs': 'X', 'b.mjs': 'Y', 'c.mjs': 'same' };
  const drifted = driftedPublishedHooks(['a.mjs', 'b.mjs', 'c.mjs'], (n) => live[n] ?? null, (n) => kit[n] ?? null);
  assert.deepEqual(drifted.sort(), ['a.mjs', 'b.mjs']);
});

test('does NOT flag a hook that is not published (no kit twin)', () => {
  const readLive = () => 'LIVE';
  const readKit = () => null;                 // not in the kit
  assert.deepEqual(driftedPublishedHooks(['jarvis-local.mjs'], readLive, readKit), []);
});

test('does NOT flag a published hook that is already in sync', () => {
  const same = () => 'IDENTICAL';
  assert.deepEqual(driftedPublishedHooks(['a.mjs'], same, same), []);
});

test('does NOT flag when the live file is gone (deleted, not this guard\'s job)', () => {
  assert.deepEqual(driftedPublishedHooks(['a.mjs'], () => null, () => 'KIT'), []);
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
