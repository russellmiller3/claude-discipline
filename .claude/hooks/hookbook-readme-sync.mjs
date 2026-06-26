#!/usr/bin/env node
/**
 * hookbook-readme-sync — REPO-LOCAL Stop gate with TEETH for the claude-discipline kit itself. The kit's
 * value is that its docs are TRUE: the README and docs/HOOKBOOK.md must describe every hook it actually
 * ships. This hook blocks `stop` whenever a hook file in `hooks/` is NOT documented in BOTH the README and
 * the HOOKBOOK — so a hook can never be added/renamed without its docs catching up, and neither doc can go
 * stale relative to what's on disk. (Russell 2026-06-26: "repo should always be in sync with hookbook" +
 * "readme should never be stale" — one guard, both surfaces.)
 *
 * Forward direction only (every shipped hook is documented). Pure-logic core is exported for tests; the
 * Stop wrapper reads the repo off the hook event's cwd and fails OPEN on any error (a doc guard must never
 * wedge the session on a filesystem hiccup).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The hook stems a docs check must cover: every `*.mjs` in hooks/ that is a real hook — NOT a `*.test.mjs`
// and NOT a `lib/` helper module (those aren't user-facing hooks, so they need no README/HOOKBOOK row).
export function shippedHookStems(hooksDir, readDir = readdirSync) {
  let entries = [];
  try { entries = readDir(hooksDir); } catch { return []; }
  return entries
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => name.replace(/\.mjs$/, ''))
    .sort();
}

// Which stems are missing from a given doc's text? A stem counts as documented if it appears anywhere in the
// doc (backticked or bare) — low-false-positive: the kit always writes the literal hook name in its tables.
export function undocumentedStems(stems, docText) {
  const haystack = String(docText || '');
  return stems.filter((stem) => !haystack.includes(stem));
}

// The verdict for the whole repo: per-doc lists of stems that aren't documented. Empty arrays = all in sync.
export function coverageVerdict({ stems, readmeText, hookbookText }) {
  return {
    missingFromReadme: undocumentedStems(stems, readmeText),
    missingFromHookbook: undocumentedStems(stems, hookbookText),
  };
}

function readFileSafe(path) { try { return readFileSync(path, 'utf8'); } catch { return ''; } }

function onStop(hookEvent) {
  const repoRoot = hookEvent.cwd || process.cwd();
  const hooksDir = join(repoRoot, 'hooks');
  // Only act in a repo that actually looks like this kit (a hooks/ dir + a README) — never in an unrelated project.
  if (!existsSync(hooksDir) || !existsSync(join(repoRoot, 'README.md'))) return;

  const stems = shippedHookStems(hooksDir);
  if (stems.length === 0) return;

  const verdict = coverageVerdict({
    stems,
    readmeText: readFileSafe(join(repoRoot, 'README.md')),
    hookbookText: readFileSafe(join(repoRoot, 'docs', 'HOOKBOOK.md')),
  });

  if (verdict.missingFromReadme.length === 0 && verdict.missingFromHookbook.length === 0) return;

  const lines = [];
  if (verdict.missingFromReadme.length) lines.push(`  README.md is missing: ${verdict.missingFromReadme.join(', ')}`);
  if (verdict.missingFromHookbook.length) lines.push(`  docs/HOOKBOOK.md is missing: ${verdict.missingFromHookbook.join(', ')}`);

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      'DOCS OUT OF SYNC — a shipped hook is not documented. The kit only earns trust if its docs are TRUE.',
      '',
      ...lines,
      '',
      'Add each missing hook to the doc(s) above (README hook table + docs/HOOKBOOK.md row), then stop again.',
      'Renamed a hook? Update both docs to the new name. Deleted one? Remove its rows. The repo and its',
      'hookbook/README must always describe exactly what hooks/ ships.',
    ].join('\n'),
  }));
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
  if (eventName === 'Stop') onStop(hookEvent);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
