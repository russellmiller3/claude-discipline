// bench-pattern-guard.test.mjs — run: node --test bench-pattern-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRunner, missingMarkers } from './bench-pattern-guard.mjs';

const RUNNER = `import { TASKS } from './suite.mjs';
async function runOneTask(task){ await brain.runAgent(task.prompt); }
for (const task of TASKS) { await runOneTask(task); }`;

const GOOD_RUNNER = `import { TASKS } from './suite.mjs';
import { createTaskPulse } from './pulse.mjs'; // progress
async function runPool(queue, limit){ await Promise.all([...]); }
appendFileSync(runFile, JSON.stringify(row)); // .jsonl, --resume supported
await runOneTask(task); brain.runAgent(p);`;

const HELPER = `export function buildSeed(){ return { messages: [] }; }`;

test('a bench runner (iterates tasks + calls the agent) is detected', () => {
  assert.equal(looksLikeRunner('bench/realworld/harness.mjs', RUNNER), true);
});

test('a helper module under bench/ is NOT a runner', () => {
  assert.equal(looksLikeRunner('bench/realworld/fixtures.mjs', HELPER), false);
});

test('a runner OUTSIDE a bench path is not guarded', () => {
  assert.equal(looksLikeRunner('src/lib/foo.mjs', RUNNER), false);
});

test('a test file is not a runner', () => {
  assert.equal(looksLikeRunner('bench/x/harness.test.mjs', RUNNER), false);
});

test('a serial runner is missing all three markers', () => {
  const missing = missingMarkers(RUNNER);
  assert.equal(missing.length, 3);
  assert.ok(missing.some((entry) => entry.startsWith('PARALLEL')));
  assert.ok(missing.some((entry) => entry.startsWith('PROGRESS')));
  assert.ok(missing.some((entry) => entry.startsWith('DURABLE')));
});

test('a runner with parallel + progress + durable passes', () => {
  assert.deepEqual(missingMarkers(GOOD_RUNNER), []);
});
