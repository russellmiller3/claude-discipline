#!/usr/bin/env node
/**
 * learningsWatermark — the single owner of the "how many learnings have piled up since the last
 * first-principles distillation?" math. Used by:
 *   - learnings-distill-nudge.mjs (SessionStart) — reads the watermark, nudges when a backlog builds.
 *   - the /distill-learnings skill — calls the CLI (`--mark`) to stamp the new watermark after a pass.
 *
 * Why a shared lib (2026-07-18): the counting rule ("what is one learning?") and the trigger rule
 * ("when is a distill due?") must be IDENTICAL on the read side (the nudge) and the write side (the
 * mark). One owner = they can't drift. Lesson-counting reuses the SAME bolded-bullet definition as
 * learnings-to-hooks-nudge.mjs so the whole learnings system agrees on what an "entry" is.
 *
 * A "lesson" = a top-or-nested bullet whose lead is bold: `- **Title** ...`. A distill is DUE for a
 * file when the number of NEW lessons since the last mark crosses a threshold, OR a smaller backlog
 * has sat un-distilled past a staleness window (the weekly backstop, computed here — no cron needed).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_THRESHOLD = 8;   // this many NEW lessons → distill is due
export const DEFAULT_STALE_DAYS = 7;  // any backlog older than this since last distill → due (weekly backstop)
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];

/** Count lessons: bullets whose lead phrase is bold (`- **Title** ...`). Same definition as learnings-to-hooks-nudge. */
export function countLessons(learningsText) {
  return [...String(learningsText || '').matchAll(/^\s*[-*]\s*\*\*(.+?)\*\*/gm)].length;
}

/**
 * Pure trigger decision so the rule is unit-testable. Given the current lesson count, the last-marked
 * count + timestamp, and "now", decide whether a distill is due and why.
 */
export function distillVerdict({ current, watermarkCount, distilledAt, now, threshold = DEFAULT_THRESHOLD, staleDays = DEFAULT_STALE_DAYS }) {
  const newCount = Math.max(0, current - (watermarkCount ?? 0));
  if (newCount <= 0) return { nudge: false, newCount };
  if (newCount >= threshold) return { nudge: true, newCount, reason: 'threshold' };
  if (distilledAt) {
    const ageDays = (now - Date.parse(distilledAt)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays >= staleDays) return { nudge: true, newCount, reason: 'stale' };
  }
  return { nudge: false, newCount };
}

function findProjectRoot(startDirectory) {
  let probeDirectory = startDirectory;
  for (let steps = 0; steps < 12; steps++) {
    for (const marker of ROOT_MARKERS) if (existsSync(join(probeDirectory, marker))) return probeDirectory;
    const parentDirectory = dirname(probeDirectory);
    if (parentDirectory === probeDirectory) return null;
    probeDirectory = parentDirectory;
  }
  return null;
}

/**
 * The learnings files in scope: global + this project's. Overridable via LEARNINGS_FILES for tests.
 * Deduped by absolute path: when the working dir sits inside ~/.claude, the "project" learnings.md
 * resolves to the same file as global — without the dedupe it would be counted (and nudged) twice.
 */
export function learningsPaths(workingDirectory = process.cwd()) {
  if (process.env.LEARNINGS_FILES) return [...new Set(process.env.LEARNINGS_FILES.split(delimiter).filter(Boolean).map((path) => resolve(path)))];
  const globalPath = resolve(homedir(), '.claude', 'learnings.md');
  const projectRoot = findProjectRoot(workingDirectory);
  const projectPath = projectRoot ? resolve(join(projectRoot, 'learnings.md')) : null;
  return [...new Set([globalPath, projectPath].filter(Boolean))];
}

export function watermarkPath() {
  return process.env.LEARNINGS_WATERMARK_PATH || resolve(homedir(), '.claude', 'state', 'learnings-watermark.json');
}

export function readWatermark(path = watermarkPath()) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function writeWatermark(watermarkMap, path = watermarkPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(watermarkMap, null, 2)}\n`);
}

/** Stamp the given files (default: all in scope) as distilled NOW — resets their backlog to zero. */
export function markDistilled(files, { path = watermarkPath(), now = Date.now() } = {}) {
  const watermarkMap = readWatermark(path);
  const stampedAt = new Date(now).toISOString();
  for (const file of files) {
    if (!existsSync(file)) continue;
    watermarkMap[file] = { lessonCount: countLessons(readFileSync(file, 'utf8')), distilledAt: stampedAt };
  }
  writeWatermark(watermarkMap, path);
  return watermarkMap;
}

/** The list of files with a distill due, with counts — the data the nudge and --status both render. */
export function dueFiles(workingDirectory = process.cwd(), { now = Date.now(), threshold = DEFAULT_THRESHOLD, staleDays = DEFAULT_STALE_DAYS } = {}) {
  const watermarkMap = readWatermark();
  const due = [];
  for (const file of learningsPaths(workingDirectory)) {
    if (!existsSync(file)) continue;
    let learningsText = '';
    try { learningsText = readFileSync(file, 'utf8'); } catch { continue; }
    const entry = watermarkMap[file] || {};
    const verdict = distillVerdict({ current: countLessons(learningsText), watermarkCount: entry.lessonCount, distilledAt: entry.distilledAt, now, threshold, staleDays });
    if (verdict.nudge) due.push({ file, ...verdict });
  }
  return due;
}

// ---- CLI: `--mark [file...]` stamps distilled watermark; `--status` prints the due list as JSON ----
function cli(argv) {
  const args = argv.slice(2);
  if (args.includes('--mark')) {
    const files = args.filter((arg) => !arg.startsWith('--'));
    const stamped = markDistilled(files.length ? files : learningsPaths(process.cwd()));
    process.stdout.write(`${JSON.stringify(stamped, null, 2)}\n`);
    return;
  }
  if (args.includes('--status')) {
    process.stdout.write(`${JSON.stringify(dueFiles(process.cwd()), null, 2)}\n`);
    return;
  }
  process.stdout.write('usage: learningsWatermark.mjs [--status | --mark [file...]]\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) cli(process.argv);
