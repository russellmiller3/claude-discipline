// buildFingerprint.mjs — CONTENT-based build provenance (shared by the dist-freshness hooks).
//
// The problem this kills: "is dist/ stale?" answered by FILE TIMESTAMPS is wrong both ways. A git
// merge/checkout rewrites working-tree files with fresh mtimes in arbitrary order, so a perfectly
// fresh dist can look stale (false alarm) — and an edit in a PRIOR session leaves a genuinely stale
// dist that a same-turn mtime check never sees (missed drift).
//
// The fix: a project's dist is "fresh" iff the SOURCE it was built from is byte-identical to the
// source right now — proven by HASH, not time. When a build runs we record a fingerprint of the
// source at that moment (the "baseline"); staleness is simply `sourceFingerprint(now) !== baseline`.
// Immune to mtime noise; catches drift from ANY session.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

// One canonical key per project dir, so a baseline RECORDED with a Windows backslash path is FOUND
// when looked up with a forward-slash path (the Stop hook normalizes slashes; the stamp hook doesn't).
// Mismatched keys = silent misses = the exact false-block this whole system exists to kill.
function canonicalKey(projectDir) {
  return resolve(String(projectDir)).replace(/\\/g, '/');
}

const SOURCE_EXTENSIONS = /\.(js|ts|svelte|mjs|cjs|jsx|tsx|vue|css|scss|sass|less|html|json)$/i;
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.vite', '.next', 'out', '.cache']);
const SKIP_FILE = /\.(test|spec)\.[a-z]+$|(^|[\\/])(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const BUILD_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\b(vite|tsc|webpack|rollup|esbuild|parcel|next)\s+build\b|\bnpx\s+vite\s+build\b/i;

// Where baselines live — resolved LAZILY (per call, not at import) so a test can set
// BUILD_FINGERPRINT_STORE before calling and stay hermetic without fighting ESM import hoisting.
function storePath() {
  return process.env.BUILD_FINGERPRINT_STORE || join(homedir(), '.claude', 'state', 'build-fingerprints.json');
}

// A buildable source file (the kind whose change must end up in the bundle) — not a test, not a lockfile.
function isSourceFile(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  if (SKIP_FILE.test(normalized)) return false;
  return SOURCE_EXTENSIONS.test(normalized);
}

// Deterministic content hash of every build-input source file under projectDir (path + content, sorted).
// Bounded walk (skips vendored/built dirs, caps file count) so it stays fast even in a big repo.
export function sourceFingerprint(projectDir) {
  if (!existsSync(projectDir)) return '';
  const entries = [];
  const queue = [projectDir];
  let budget = 6000; // file cap — provenance, not a full crawl
  while (queue.length && budget > 0) {
    const currentDirectory = queue.shift();
    let directoryEntries = [];
    try { directoryEntries = readdirSync(currentDirectory, { withFileTypes: true }); } catch { continue; }
    for (const entry of directoryEntries) {
      if (budget-- <= 0) break;
      const fullPath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) queue.push(fullPath); continue; }
      if (!isSourceFile(fullPath)) continue;
      try {
        const contentHash = createHash('sha1').update(readFileSync(fullPath)).digest('hex');
        entries.push(`${relative(projectDir, fullPath).replace(/\\/g, '/')}:${contentHash}`);
      } catch { /* unreadable file — skip */ }
    }
  }
  entries.sort();
  return createHash('sha1').update(entries.join('\n')).digest('hex');
}

export function isBuildCommand(command) {
  return BUILD_COMMAND.test(String(command || ''));
}

export function distExists(projectDir) {
  return existsSync(join(projectDir, 'dist'));
}

// projectDir is a buildable bundle iff its package.json declares a `build` script.
export function isBuildableProject(projectDir) {
  const packageJsonPath = join(projectDir, 'package.json');
  if (!existsSync(packageJsonPath)) return false;
  try { return !!JSON.parse(readFileSync(packageJsonPath, 'utf8'))?.scripts?.build; }
  catch { return false; }
}

// Find buildable projects at root + one level of common app subdirs (extension/, app/, web/, …).
export function buildProjectsUnder(root) {
  const candidates = [root, ...['extension', 'app', 'web', 'client', 'frontend', 'packages', 'src-tauri']
    .map((sub) => join(root, sub)).filter(existsSync)];
  return candidates.filter(isBuildableProject);
}

export function loadBaselines() {
  if (!existsSync(storePath())) return {};
  try { return JSON.parse(readFileSync(storePath(), 'utf8')) || {}; } catch { return {}; }
}

export function baselineFor(projectDir) {
  return loadBaselines()[canonicalKey(projectDir)] || null;
}

// Record "dist was just built from THIS source" — called when a build command is observed succeeding.
export function recordBaseline(projectDir, fingerprint, nowIso) {
  const baselines = loadBaselines();
  baselines[canonicalKey(projectDir)] = { sourceFingerprint: fingerprint, recordedAt: nowIso || '' };
  try {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(baselines, null, 2));
    return true;
  } catch { return false; }
}

// The verdict. fresh: dist matches the source it was built from. stale: source changed since the
// last recorded build. unknown: no baseline yet (fresh clone / never built under this system) — the
// caller decides whether to bootstrap or stay quiet, and we never cry "stale" without evidence.
export function freshnessOf(projectDir) {
  if (!distExists(projectDir)) return { status: 'no-dist' };
  const baseline = baselineFor(projectDir);
  if (!baseline) return { status: 'unknown' };
  const current = sourceFingerprint(projectDir);
  return { status: current === baseline.sourceFingerprint ? 'fresh' : 'stale', current, baseline: baseline.sourceFingerprint };
}
