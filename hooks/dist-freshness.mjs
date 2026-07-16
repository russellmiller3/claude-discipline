#!/usr/bin/env node
/**
 * dist-freshness — ONE hook for the idea "the built bundle (dist/) stays in sync with source."
 *
 * Consolidated 2026-07-15 (Russell, "one hook per idea"): three thin event-wrappers over the shared
 * lib/buildFingerprint.mjs were three hooks. They're one idea — dist-freshness by CONTENT hash, not mtime —
 * enforced at three points. Now one event-routed hook. Retired: dist-staleness-check, stamp-build-fingerprint,
 * rebuild-after-commit.
 *
 *   SessionStart          → surface a genuinely STALE bundle (source-hash drift left by a PRIOR session) and
 *                           bootstrap a baseline for any built project that has none yet. Suggestion only.
 *   PostToolUse (Bash)    → after a SUCCESSFUL build command, record a content fingerprint of the just-built
 *                           source (the baseline the freshness checks compare against). Never blocks.
 *   Stop                  → BLOCK when this turn edited buildable source but dist/ is stale (content verdict
 *                           first, mtime fallback while a baseline bootstraps). Override: `rebuild-skip: <why>`.
 *
 * Fail-open on any error. Core provenance lives in lib/buildFingerprint.mjs.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { relative, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildProjectsUnder, freshnessOf, sourceFingerprint, recordBaseline, isBuildCommand, distExists,
} from './lib/buildFingerprint.mjs';
import { readTranscript, contentBlocks, currentTurnEntries } from './lib/transcript.mjs';

// ── SessionStart: surface stale bundles + bootstrap baselines (was dist-staleness-check.mjs) ──────────────────
export function staleBundleReport(root) {
  const staleProjects = [];
  for (const projectDirectory of buildProjectsUnder(root)) {
    const verdict = freshnessOf(projectDirectory);
    if (verdict.status === 'stale') staleProjects.push(projectDirectory);
    else if (verdict.status === 'unknown') recordBaseline(projectDirectory, sourceFingerprint(projectDirectory), ''); // bootstrap silently
  }
  if (!staleProjects.length) return null;
  const projectList = staleProjects.map((path) => `  • ${relative(root, path) || '.'} — run \`npm run build\``).join('\n');
  return (
    `=== STALE BUILD (dist out of date) ===\n` +
    `Source has changed since dist/ was last built — proven by content hash, not timestamps, so this is\n` +
    `a REAL staleness (an edit from a prior session that was never rebuilt), not a merge mtime artifact.\n` +
    `A reload of the app right now would run the OLD bundle.\n\n` +
    `Rebuild before trusting the running app:\n${projectList}`
  );
}

// ── PostToolUse(Bash): stamp a baseline after a successful build (was stamp-build-fingerprint.mjs) ────────────
const SUCCESS_MARKER = /built in|✓ built|build complete|compiled successfully|done in|gzip:|bundle(s)? generated|created .* in \d|transformed/i;
const FAILURE_MARKER = /\b(npm|pnpm|yarn) ERR!|error during build|build failed|ERR_|command not found|is not recognized|exit code [1-9]|Error:\s|SyntaxError|Cannot find module/i;

function buildOutputText(hookEvent) {
  const buildToolResponse = hookEvent.tool_response ?? hookEvent.toolResponse ?? '';
  if (typeof buildToolResponse === 'string') return buildToolResponse;
  return [buildToolResponse?.stdout, buildToolResponse?.stderr, buildToolResponse?.output, buildToolResponse?.content]
    .filter((part) => typeof part === 'string').join('\n');
}

export function stampBaselineAfterBuild(hookEvent) {
  if ((hookEvent.tool_name || hookEvent.toolName) !== 'Bash') return false;
  const command = hookEvent.tool_input?.command || hookEvent.toolInput?.command || '';
  if (!isBuildCommand(command)) return false;
  const buildOutput = buildOutputText(hookEvent);
  if (FAILURE_MARKER.test(buildOutput)) return false;                       // obvious failure → don't stamp
  if (!SUCCESS_MARKER.test(buildOutput) && buildOutput.length > 0) return false; // can't confirm success → stay 'unknown'
  const root = hookEvent.cwd || process.cwd();
  const nowIso = hookEvent.timestamp || hookEvent.time || '';
  let stampedAny = false;
  for (const projectDirectory of buildProjectsUnder(root)) {
    if (!distExists(projectDirectory)) continue; // a build that produced no dist isn't a bundle build
    if (recordBaseline(projectDirectory, sourceFingerprint(projectDirectory), nowIso)) stampedAny = true;
  }
  return stampedAny;
}

// ── Stop: block when source edited but dist/ is stale (was rebuild-after-commit.mjs) ─────────────────────────
const OVERRIDE_RE = /rebuild-skip\s*:/i;
const CODE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function isSource(filePath) {
  if (!filePath) return false;
  const path = String(filePath).replace(/\\/g, '/');
  if (/\.(test|spec)\./i.test(path)) return false;
  if (/\/(node_modules|dist)\//.test(path)) return false;
  return /\.(js|ts|svelte|mjs|cjs|jsx|tsx|vue|css|scss|html)$/i.test(path);
}

// Walk up from an edited file to the nearest package.json declaring a `build` script (the buildable project).
function buildRootFor(filePath) {
  let probeDirectory = dirname(String(filePath).replace(/\\/g, '/'));
  for (let depth = 0; depth < 12 && probeDirectory; depth++) {
    const packageJsonPath = join(probeDirectory, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const packageManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        if (packageManifest?.scripts?.build) return probeDirectory;
      } catch { /* unreadable — keep walking */ }
    }
    const parentDirectory = dirname(probeDirectory);
    if (parentDirectory === probeDirectory) break;
    probeDirectory = parentDirectory;
  }
  return null;
}

// Newest mtime under a directory tree (bounded — only ever called on dist/, never a project root).
function newestMtimeUnder(directory) {
  if (!existsSync(directory)) return 0;
  let names;
  try { names = readdirSync(directory, { recursive: true }); } catch { return 0; }
  let newest = 0;
  for (const name of names) {
    let fileStat;
    try { fileStat = statSync(join(directory, String(name))); } catch { continue; }
    if (fileStat.isFile() && fileStat.mtimeMs > newest) newest = fileStat.mtimeMs;
  }
  return newest;
}

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

/** The stale build roots this turn's source edits left unbuilt, or [] (with an `overridden` flag). */
export function staleRootsThisTurn(turnEntries) {
  let overridden = false;
  const editedByRoot = new Map();
  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text' && OVERRIDE_RE.test(block.text || '')) overridden = true;
      if (block.type !== 'tool_use' || !CODE_EDIT_TOOLS.has(block.name || '')) continue;
      const filePath = block.input?.file_path || block.input?.path || '';
      if (!isSource(filePath)) continue;
      const buildRoot = buildRootFor(filePath);
      if (!buildRoot) continue;
      if (!editedByRoot.has(buildRoot)) editedByRoot.set(buildRoot, []);
      editedByRoot.get(buildRoot).push(String(filePath).replace(/\\/g, '/'));
    }
  }
  if (overridden || editedByRoot.size === 0) return { overridden, staleRoots: [] };
  const staleRoots = [];
  for (const [buildRoot, editedFiles] of editedByRoot) {
    // Content verdict first (source-hash vs the hash dist was built from — immune to git-merge mtime scramble);
    // only when there's no baseline yet ('unknown'/'no-dist') fall back to the mtime freshness check.
    const verdict = freshnessOf(buildRoot);
    if (verdict.status === 'stale') staleRoots.push(buildRoot);
    else if (verdict.status === 'fresh') continue;
    else if (distIsStale(buildRoot, editedFiles)) staleRoots.push(buildRoot);
  }
  return { overridden, staleRoots };
}

function rebuildBlockReason(staleRoots) {
  return [
    'REBUILD REQUIRED — you changed source in a buildable project but dist/ is stale.',
    '',
    "Russell's rule (2026-06-20): the app runs from the BUILT artifact (dist/), not source. ANY fix",
    'or feature must be rebuilt before you finish, or a reload shows the OLD bundle ("not there").',
    'This is a freshness check: dist/ is older than the files you edited this turn (or missing) — so',
    'either you never built, or the build failed.',
    '',
    `Run the build now (e.g. \`npm run build\`) in: ${staleRoots.join(', ')}`,
    '',
    'If this code genuinely has no bundle to refresh, say so with the literal token: rebuild-skip: <why>',
  ].join('\n');
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); return; }
  const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';

  try {
    if (eventName === 'SessionStart') {
      const report = staleBundleReport(hookEvent.cwd || process.cwd());
      if (report) process.stdout.write(report);
    } else if (eventName === 'PostToolUse') {
      if (stampBaselineAfterBuild(hookEvent)) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Recorded a content fingerprint of the just-built source (dist freshness is now tracked by hash, not mtime).' },
        }));
      }
    } else if (eventName === 'Stop') {
      if (hookEvent.stop_hook_active) { process.exit(0); return; }
      const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
      if (turnEntries.length) {
        const { staleRoots } = staleRootsThisTurn(turnEntries);
        if (staleRoots.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: rebuildBlockReason(staleRoots) }));
      }
    }
  } catch { /* fail open */ }
  process.exit(0);
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) main();
