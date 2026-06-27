#!/usr/bin/env node
/**
 * Rebuild-after-source-edit guard — GLOBAL, Stop hook.
 *
 * The rule: a bundled app (Chrome extension, Vite app) runs from the
 * BUILT artifact (dist/), not the source. ANY time you do a fix or a feature — commit or not — you
 * must rebuild before the turn ends, or a reload shows the STALE bundle ("none of my changes are
 * there"). The earlier version only fired on a commit in the same turn; this one fires on any source
 * EDIT and proves the rebuild by FRESHNESS: dist/ must be newer than the files you edited. That also
 * catches a build that silently FAILED (dist stays old → still blocked).
 *
 * Fires when: this turn edited source in a project whose package.json declares a `build` script AND
 * that project's dist/ is older than the newest file edited this turn (or dist/ doesn't exist).
 *
 * Override: `rebuild-skip: <why>` in the final reply (e.g. a pure library consumed from source, or a
 * doc/test-only change with no bundle to refresh). Fail open on any error.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freshnessOf } from './lib/buildFingerprint.mjs';

const OVERRIDE_RE = /rebuild-skip\s*:/i;
const CODE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// A buildable source file (not a test): the kind of change that must end up in the bundle.
function isSource(filePath) {
  if (!filePath) return false;
  const path = String(filePath).replace(/\\/g, '/');
  if (/\.(test|spec)\./i.test(path)) return false;
  if (/\/(node_modules|dist)\//.test(path)) return false;
  return /\.(js|ts|svelte|mjs|cjs|jsx|tsx|vue|css|scss|html)$/i.test(path);
}

// Walk up from an edited file to the nearest package.json that declares a `build` script.
// Returns that directory, or null if none — i.e. the project is not a buildable bundle.
function buildRootFor(filePath) {
  let probeDirectory = dirname(String(filePath).replace(/\\/g, '/'));
  for (let depth = 0; depth < 12 && probeDirectory; depth++) {
    const packageJsonPath = join(probeDirectory, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const packageManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        if (packageManifest?.scripts?.build) return probeDirectory;
      } catch { /* unreadable package.json — keep walking */ }
    }
    const parentDirectory = dirname(probeDirectory);
    if (parentDirectory === probeDirectory) break;
    probeDirectory = parentDirectory;
  }
  return null;
}

// Newest mtime (ms) of any file under a directory tree. Bounded inputs only (dist/ is small); we
// NEVER call this on a whole project root (node_modules would make it crawl). 0 if dir is missing.
function newestMtimeUnder(directory) {
  if (!existsSync(directory)) return 0;
  let names;
  try { names = readdirSync(directory, { recursive: true }); } catch { return 0; }
  let newest = 0;
  for (const name of names) {
    const fullPath = join(directory, String(name));
    let fileStat;
    try { fileStat = statSync(fullPath); } catch { continue; }
    if (!fileStat.isFile()) continue;
    if (fileStat.mtimeMs > newest) newest = fileStat.mtimeMs;
  }
  return newest;
}

// Is the build root's dist/ stale relative to the files edited this turn? (missing dist = stale.)
function distIsStale(buildRoot, editedFiles) {
  const distDirectory = join(buildRoot, 'dist');
  if (!existsSync(distDirectory)) return true;
  const newestDist = newestMtimeUnder(distDirectory);
  let newestEdit = 0;
  for (const editedFile of editedFiles) {
    try { const editedMtime = statSync(editedFile).mtimeMs; if (editedMtime > newestEdit) newestEdit = editedMtime; }
    catch { /* file gone — ignore */ }
  }
  if (newestEdit === 0) return false;       // couldn't stat the edits — don't false-block
  return newestDist < newestEdit;            // dist older than your newest edit → not rebuilt
}

function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try {
    return readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function roleOf(entry) { return entry.message?.role || entry.role || entry.type || ''; }
function contentBlocks(entry) {
  const blocks = entry.message?.content ?? entry.content ?? [];
  if (typeof blocks === 'string') return [{ type: 'text', text: blocks }];
  return Array.isArray(blocks) ? blocks : [];
}
function currentTurnEntries(entries) {
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'assistant') { lastAssistant = i; break; } }
  if (lastAssistant < 0) return [];
  let turnStart = 0;
  for (let i = lastAssistant - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'user') { turnStart = i; break; } }
  return entries.slice(turnStart);
}

function onStop(hookEvent) {
  const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
  if (turnEntries.length === 0) return;

  let override = false;
  const editedByRoot = new Map(); // buildRoot -> [edited source file paths]
  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text' && OVERRIDE_RE.test(block.text || '')) override = true;
      if (block.type !== 'tool_use') continue;
      if (!CODE_EDIT_TOOLS.has(block.name || '')) continue;
      const filePath = block.input?.file_path || block.input?.path || '';
      if (!isSource(filePath)) continue;
      const buildRoot = buildRootFor(filePath);
      if (!buildRoot) continue;
      if (!editedByRoot.has(buildRoot)) editedByRoot.set(buildRoot, []);
      editedByRoot.get(buildRoot).push(String(filePath).replace(/\\/g, '/'));
    }
  }

  if (editedByRoot.size === 0) return; // no buildable source edited this turn
  if (override) return;

  const staleRoots = [];
  for (const [buildRoot, editedFiles] of editedByRoot) {
    // Prefer the CONTENT verdict (source-hash vs the hash dist was built from): immune to the git-merge
    // mtime artifact that made a fresh dist look stale. Only when there's no baseline yet ('unknown' /
    // 'no-dist') do we fall back to the mtime freshness check so the same-turn guarantee still holds.
    const verdict = freshnessOf(buildRoot);
    if (verdict.status === 'stale') staleRoots.push(buildRoot);
    else if (verdict.status === 'fresh') continue;
    else if (distIsStale(buildRoot, editedFiles)) staleRoots.push(buildRoot);
  }
  if (staleRoots.length === 0) return; // dist/ proven fresh (or rebuilt) → nothing to block

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      'REBUILD REQUIRED — you changed source in a buildable project but dist/ is stale.',
      '',
      "The rule: the app runs from the BUILT artifact (dist/), not source. ANY fix",
      'or feature must be rebuilt before you finish, or a reload shows the OLD bundle ("not there").',
      'This is a freshness check: dist/ is older than the files you edited this turn (or missing) — so',
      'either you never built, or the build failed.',
      '',
      `Run the build now (e.g. \`npm run build\`) in: ${staleRoots.join(', ')}`,
      '',
      'If this code genuinely has no bundle to refresh, say so with the literal token: rebuild-skip: <why>',
    ].join('\n'),
  }));
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); }
  const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
  if (eventName === 'Stop') onStop(hookEvent);
  process.exit(0);
}

main();
