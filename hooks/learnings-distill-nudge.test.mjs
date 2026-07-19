import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, 'learnings-distill-nudge.mjs');
const libPath = path.join(here, 'lib', 'learningsWatermark.mjs');
const {
  countLessons, distillVerdict, markDistilled, readWatermark, learningsPaths,
} = await import(pathToFileURL(libPath).href);

const DAY = 86_400_000;

function makeLearnings(lessonCount) {
  const bullets = Array.from({ length: lessonCount }, (index) => `- **Lesson number ${index}** something happened and here is the gotcha.`);
  return `# Learnings\n\n## Table of Contents\n\n## Body\n\n${bullets.join('\n')}\n`;
}

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'distill-'));
  return {
    dir,
    learnings: path.join(dir, 'learnings.md'),
    watermark: path.join(dir, 'watermark.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runHook({ learnings, watermark }) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    env: { ...process.env, LEARNINGS_FILES: learnings, LEARNINGS_WATERMARK_PATH: watermark },
  });
}

// ---- pure lesson-counting ----
test('countLessons counts bolded-lead bullets, ignores plain lines', () => {
  assert.equal(countLessons(makeLearnings(5)), 5);
  assert.equal(countLessons('# just a heading\n- a plain bullet\nno bold here'), 0);
});

// ---- scope dedupe (global and project resolving to the same file) ----
test('learningsPaths dedupes identical paths so a file is never counted twice', () => {
  const same = path.join(here, 'learnings.md');
  process.env.LEARNINGS_FILES = `${same}${path.delimiter}${same}`;
  try {
    assert.deepEqual(learningsPaths(here), [path.resolve(same)]);
  } finally {
    delete process.env.LEARNINGS_FILES;
  }
});

// ---- pure trigger decision ----
test('distillVerdict fires when NEW lessons cross the threshold', () => {
  const verdict = distillVerdict({ current: 20, watermarkCount: 10, distilledAt: new Date(Date.now()).toISOString(), now: Date.now(), threshold: 8 });
  assert.equal(verdict.nudge, true);
  assert.equal(verdict.reason, 'threshold');
  assert.equal(verdict.newCount, 10);
});

test('distillVerdict fires on a small STALE backlog (the weekly backstop)', () => {
  const now = Date.now();
  const verdict = distillVerdict({ current: 12, watermarkCount: 10, distilledAt: new Date(now - 30 * DAY).toISOString(), now, threshold: 8, staleDays: 7 });
  assert.equal(verdict.nudge, true);
  assert.equal(verdict.reason, 'stale');
});

test('distillVerdict stays quiet when a small backlog is fresh (does not over-fire)', () => {
  const now = Date.now();
  const verdict = distillVerdict({ current: 12, watermarkCount: 10, distilledAt: new Date(now - 1 * DAY).toISOString(), now, threshold: 8, staleDays: 7 });
  assert.equal(verdict.nudge, false);
});

test('distillVerdict stays quiet when nothing new since the last mark', () => {
  const verdict = distillVerdict({ current: 10, watermarkCount: 10, distilledAt: new Date(Date.now()).toISOString(), now: Date.now() });
  assert.equal(verdict.nudge, false);
  assert.equal(verdict.newCount, 0);
});

// ---- mark roundtrip ----
test('markDistilled records the current lesson count so the backlog resets to zero', () => {
  const box = sandbox();
  try {
    writeFileSync(box.learnings, makeLearnings(14));
    markDistilled([box.learnings], { path: box.watermark, now: Date.now() });
    const stored = readWatermark(box.watermark);
    assert.equal(stored[box.learnings].lessonCount, 14);
    assert.ok(stored[box.learnings].distilledAt);
  } finally {
    box.cleanup();
  }
});

// ---- hook end-to-end: POSITIVE ----
test('hook nudges when an undistilled backlog crosses the threshold', () => {
  const box = sandbox();
  try {
    writeFileSync(box.learnings, makeLearnings(10)); // no watermark yet → 10 new > 8
    writeFileSync(box.watermark, '{}');
    const hookRun = runHook(box);
    assert.equal(hookRun.status, 0);
    assert.match(hookRun.stdout, /LEARNINGS DISTILL DUE/);
    assert.match(hookRun.stdout, /distill-learnings/);
    assert.match(hookRun.stdout, /10 undistilled/);
  } finally {
    box.cleanup();
  }
});

test('hook nudges on a small STALE backlog even under the threshold', () => {
  const box = sandbox();
  try {
    writeFileSync(box.learnings, makeLearnings(12));
    writeFileSync(box.watermark, JSON.stringify({ [box.learnings]: { lessonCount: 10, distilledAt: new Date(Date.now() - 30 * DAY).toISOString() } }));
    const hookRun = runHook(box);
    assert.equal(hookRun.status, 0);
    assert.match(hookRun.stdout, /LEARNINGS DISTILL DUE/);
    assert.match(hookRun.stdout, /stale/);
  } finally {
    box.cleanup();
  }
});

// ---- hook end-to-end: NEGATIVE (must-allow / must-not-fire) ----
test('hook stays silent when everything is already distilled', () => {
  const box = sandbox();
  try {
    writeFileSync(box.learnings, makeLearnings(14));
    writeFileSync(box.watermark, JSON.stringify({ [box.learnings]: { lessonCount: 14, distilledAt: new Date(Date.now()).toISOString() } }));
    const hookRun = runHook(box);
    assert.equal(hookRun.status, 0);
    assert.equal(hookRun.stdout, '');
  } finally {
    box.cleanup();
  }
});

test('hook stays silent on a small FRESH backlog under the threshold (no false positive)', () => {
  const box = sandbox();
  try {
    writeFileSync(box.learnings, makeLearnings(3)); // 3 new, no watermark, below threshold, not stale
    writeFileSync(box.watermark, '{}');
    const hookRun = runHook(box);
    assert.equal(hookRun.status, 0);
    assert.equal(hookRun.stdout, '');
  } finally {
    box.cleanup();
  }
});
