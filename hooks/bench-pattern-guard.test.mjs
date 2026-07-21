// bench-pattern-guard.test.mjs — run: node --test ~/.claude/hooks/bench-pattern-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRunner, missingMarkers } from './bench-pattern-guard.mjs';

const RUNNER = `import { TASKS } from './suite.mjs';
async function runOneTask(task){ await brain.runAgent(task.prompt); }
for (const task of TASKS) { await runOneTask(task); }`;

const GOOD_RUNNER = `import { TASKS } from './suite.mjs';
import { createTaskPulse } from './pulse.mjs'; // agent-pulse
async function runPool(queue, limit){ await Promise.all([...]); }
appendFileSync(runFile, JSON.stringify(row)); // .jsonl, --resume supported
let attempt = 0;
while (attempt < maxAttempts) { try { break; } catch (e) { attempt++; await sleep(1000); } }
await runOneTask(task); brain.runAgent(p);`;

const GOOD_RUNNER_LIBRARY = `import { TASKS } from './suite.mjs';
import { DurableRunner, retrying_http_call } from '../../../durable-run/durable_runner.py';
// runner.run(resume=True, concurrency=4) -- pool + pulse + jsonl resume all inside DurableRunner
appendFileSync(runFile, JSON.stringify(row)); // .jsonl, --resume supported, agent-pulse
async function runPool(queue, limit){ await Promise.all([...]); }
await runOneTask(task); brain.runAgent(p);`;

const DURABLE_BUT_NO_RETRY_RUNNER = `import { TASKS } from './suite.mjs';
import { createTaskPulse } from './pulse.mjs'; // agent-pulse
async function runPool(queue, limit){ await Promise.all([...]); }
appendFileSync(runFile, JSON.stringify(row)); // .jsonl, --resume supported
try { await runOneTask(task); } catch (e) { row.error = e.message; }
brain.runAgent(p);`;

const HELPER = `export function buildSeed(){ return { messages: [] }; }`;

test('a bench runner (iterates tasks + calls the agent) is detected', () => {
  assert.equal(looksLikeRunner('extension/bench/realworld/harness.mjs', RUNNER), true);
});

test('a helper module under bench/ is NOT a runner', () => {
  assert.equal(looksLikeRunner('extension/bench/realworld/fixtures.mjs', HELPER), false);
});

test('a runner OUTSIDE a bench path is not guarded', () => {
  assert.equal(looksLikeRunner('extension/lib/foo.mjs', RUNNER), false);
});

test('a test file is not a runner', () => {
  assert.equal(looksLikeRunner('bench/x/harness.test.mjs', RUNNER), false);
});

test('a serial runner is missing all four markers', () => {
  const missing = missingMarkers(RUNNER);
  assert.equal(missing.length, 4);
  assert.ok(missing.some((entry) => entry.startsWith('PARALLEL')));
  assert.ok(missing.some((entry) => entry.startsWith('EVENTS')));
  assert.ok(missing.some((entry) => entry.startsWith('DURABLE')));
  assert.ok(missing.some((entry) => entry.startsWith('RETRY')));
});

test('a runner with parallel + events + durable + hand-rolled retry passes', () => {
  assert.deepEqual(missingMarkers(GOOD_RUNNER), []);
});

test('a runner importing the durable-run library passes on parallel/events/durable/retry all at once', () => {
  assert.deepEqual(missingMarkers(GOOD_RUNNER_LIBRARY), []);
});

test('a runner that is durable (JSONL + resume) but has no retry loop is still flagged on RETRY specifically', () => {
  const missing = missingMarkers(DURABLE_BUT_NO_RETRY_RUNNER);
  assert.equal(missing.length, 1);
  assert.ok(missing[0].startsWith('RETRY'));
});

// --- Negative / ALLOW cases for the new RETRY marker specifically (2026-07-13) ---
// A hook that can DENY must prove it does NOT over-fire — these assert legitimate
// inputs are NOT wrongly caught by the new marker.

test('ALLOWS: a runner that just MENTIONS "retry" in a comment/string with no real backoff loop is still flagged (no false ALLOW from a bare keyword)', () => {
  const mentionsRetryOnly = `import { TASKS } from './suite.mjs';
import { createTaskPulse } from './pulse.mjs'; // agent-pulse
async function runPool(queue, limit){ await Promise.all([...]); }
appendFileSync(runFile, JSON.stringify(row)); // .jsonl, --resume supported
// TODO: add retry and backoff later
await runOneTask(task); brain.runAgent(p);`;
  const missing = missingMarkers(mentionsRetryOnly);
  assert.ok(missing.some((entry) => entry.startsWith('RETRY')),
    'a bare comment mentioning retry/backoff must not satisfy the marker');
});

test('ALLOWS: a non-bench file with real retry-shaped code is not touched at all (RETRY marker does not widen detection scope)', () => {
  const utilityFileWithRetry = `export async function fetchWithRetry(url) {
  let attempt = 0;
  while (attempt < maxAttempts) { try { return await fetch(url); } catch (e) { attempt++; await sleep(1000); } }
}`;
  assert.equal(looksLikeRunner('lib/httpClient.mjs', utilityFileWithRetry), false);
});

test('ALLOWS: the reference durable-run example script passes all four markers with zero denial', () => {
  const referenceExampleShape = `import { TASKS } from './suite.mjs';
from durable_runner import DurableRunner, retrying_http_call
# runner.run(resume=True, concurrency=4)  -- agent-pulse, .jsonl, --resume all inside DurableRunner
async function runPool(queue, limit){ await Promise.all([...]); }
await runOneTask(task); brain.runAgent(p);`;
  assert.deepEqual(missingMarkers(referenceExampleShape), []);
});
