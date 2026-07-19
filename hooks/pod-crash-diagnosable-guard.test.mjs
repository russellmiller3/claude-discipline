import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { evaluateBlindFix, flagsDeleteWithoutCopyback } from './pod-crash-diagnosable-guard.mjs';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'pod-crash-diagnosable-guard.mjs');

// ── Stop half: blind-fix block (pure) ────────────────────────────────────────
test('(a) BLOCKS a worker edit after a pod crash with NO traceback read', () => {
  const verdict = evaluateBlindFix({ crashSignalSeen: true, workerFileEdited: true, tracebackRead: false });
  assert.equal(verdict.block, true);
});
test('(b) ALLOWS once the crash traceback was read', () => {
  assert.equal(evaluateBlindFix({ crashSignalSeen: true, workerFileEdited: true, tracebackRead: true }).block, false);
});
test('ALLOWS a worker edit with no crash signal this session (normal feature work)', () => {
  assert.equal(evaluateBlindFix({ crashSignalSeen: false, workerFileEdited: true, tracebackRead: false }).block, false);
});
test('ALLOWS a crash with no worker edit (just observing)', () => {
  assert.equal(evaluateBlindFix({ crashSignalSeen: true, workerFileEdited: false, tracebackRead: false }).block, false);
});
test('(d) ALLOWS with the pod-blind-fix-ok override in the reply', () => {
  assert.equal(evaluateBlindFix({ crashSignalSeen: true, workerFileEdited: true, tracebackRead: false, replyText: 'pod-blind-fix-ok: the exit string names CUDA OOM exactly' }).block, false);
});

// ── PreToolUse(Edit) half: copyback-before-delete (pure) ─────────────────────
test('(c) flags a crash-branch force-delete with NO copyback before it', () => {
  const content = 'if returncode != 0:\n    # crash — clean up\n    provider.delete_resource(pod_id)';
  assert.equal(flagsDeleteWithoutCopyback(content), true);
});
test('ALLOWS a crash-branch delete that copies artifacts back first', () => {
  const content = 'if returncode != 0:\n    copy_results(pod, local_dir)\n    provider.delete_resource(pod_id)';
  assert.equal(flagsDeleteWithoutCopyback(content), false);
});
test('ALLOWS a success-path delete not in a crash branch', () => {
  const content = 'def finalize(pod):\n    aggregate(pod)\n    provider.delete_resource(pod.id)';
  assert.equal(flagsDeleteWithoutCopyback(content), false);
});
test('ALLOWS with the override', () => {
  const content = '# pod-blind-fix-ok: results already streamed live, nothing left on pod\nif exited != 0:\n    delete_resource(p)';
  assert.equal(flagsDeleteWithoutCopyback(content), false);
});

// ── End-to-end ───────────────────────────────────────────────────────────────
function makeTranscript(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'pod-crash-tx-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
  return { path, dir };
}
const asst = (blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const user = (blocks) => ({ type: 'user', message: { role: 'user', content: blocks } });

test('end-to-end Stop: crash signal + worker edit + no traceback read -> block', () => {
  const { path, dir } = makeTranscript([
    user([{ type: 'tool_result', content: 'training pod abc123 exited 1' }]),
    asst([{ type: 'tool_use', name: 'Edit', input: { file_path: 'scripts/runpod_exp147.py' } }, { type: 'text', text: 'patched the device' }]),
  ]);
  try {
    const run = spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }), encoding: 'utf8' });
    assert.match(run.stdout || '', /"decision"\s*:\s*"block"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('end-to-end Stop: crash + worker edit + a traceback Read -> allowed', () => {
  const { path, dir } = makeTranscript([
    user([{ type: 'tool_result', content: 'training pod abc123 exited 1' }]),
    asst([{ type: 'tool_use', name: 'Read', input: { file_path: 'runs/exp147_results.jsonl' } }]),
    user([{ type: 'tool_result', content: '{"error":"...","traceback":"Traceback (most recent call last)..."}' }]),
    asst([{ type: 'tool_use', name: 'Edit', input: { file_path: 'scripts/runpod_exp147.py' } }, { type: 'text', text: 'fixed the real cause' }]),
  ]);
  try {
    const run = spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }), encoding: 'utf8' });
    assert.equal((run.stdout || '').trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('end-to-end PreToolUse: fail-open on malformed input', () => {
  const run = spawnSync(process.execPath, [hookPath], { input: 'not json', encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal((run.stdout || '').trim(), '');
});
