// Tests for agent-monitor-cadence — the two pure detectors the Stop gate keys on.
// Run: node --test agent-monitor-cadence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { activeAgentCount, recentlyCheckedAgents } from './agent-monitor-cadence.mjs';

const spawnBlock = (id) => `{"id":"${id}","name":"Agent","input":{"run_in_background":true,"prompt":"do a thing"}}`;
const completedNotification = (id) => `<task-notification><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>`;

test('activeAgentCount counts a spawned background agent', () => {
  assert.equal(activeAgentCount(spawnBlock('toolu_abc')), 1);
});

test('activeAgentCount clears an agent once its completed task-notification arrives', () => {
  const transcript = spawnBlock('toolu_abc') + '\n' + completedNotification('toolu_abc');
  assert.equal(activeAgentCount(transcript), 0);
});

test('activeAgentCount counts two live and subtracts one completed', () => {
  const transcript = spawnBlock('toolu_a') + '\n' + spawnBlock('toolu_b') + '\n' + completedNotification('toolu_a');
  assert.equal(activeAgentCount(transcript), 1);
});

test('activeAgentCount is 0 with no background agents', () => {
  assert.equal(activeAgentCount('just some chatter, no agents here'), 0);
});

test('recentlyCheckedAgents true when the transcript tail has a git agent-branch check', () => {
  const path = resolve(tmpdir(), `monitor-test-checked-${process.pid}.jsonl`);
  writeFileSync(path, 'ran: git log --oneline -1 worktree-agent-a58c888e7f2f19313');
  try {
    assert.equal(recentlyCheckedAgents(path), true);
  } finally {
    rmSync(path, { force: true });
  }
});

test('recentlyCheckedAgents false when no agent-branch check is present', () => {
  const path = resolve(tmpdir(), `monitor-test-unchecked-${process.pid}.jsonl`);
  writeFileSync(path, 'ran: npm test and edited a file, no agent branch inspected');
  try {
    assert.equal(recentlyCheckedAgents(path), false);
  } finally {
    rmSync(path, { force: true });
  }
});

test('recentlyCheckedAgents false for a missing path (fail-open)', () => {
  assert.equal(recentlyCheckedAgents(resolve(tmpdir(), 'does-not-exist-xyz.jsonl')), false);
});
