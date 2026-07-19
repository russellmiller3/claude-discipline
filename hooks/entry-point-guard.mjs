#!/usr/bin/env node
/**
 * entry-point-guard — PreToolUse(Write|Edit|MultiEdit) guard. Blocks writing a `.mjs` whose
 * "am I being run directly?" check uses an ALWAYS-FALSE-on-Windows comparison, so the file silently
 * does nothing when executed (looks installed, never runs). Recommends the robust basename compare.
 *
 * new-hook-category: Code structure / quality — nearest existing hooks are filename-quality-guard and
 * no-backcompat; neither covers the self-execution (entry-point) guard pattern. This is a distinct idea:
 * a dual-mode module (importable AND runnable) that guards its main() with a raw `import.meta.url` vs
 * `process.argv[1]` comparison. On Windows `import.meta.url` is a `file:///C:/...` URL with forward
 * slashes and `process.argv[1]` is a `C:\...` path — the compare is ALWAYS false, so `node file.mjs`
 * imports the module and exits without running main(). Bit 3x (watchtower daemon + two hooks that
 * silently never ran, per ~/.claude/learnings.md). The robust fix, already used across the hook tree:
 * compare BASENAMES — `basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])`.
 *
 * Teeth: denies the write with the fix. Override: put `ENTRY_POINT_GUARD_OK` in the file (rare — e.g.
 * you deliberately want a URL/path compare). `.test.mjs` files are exempt (fixtures legitimately hold
 * the bad pattern). Fail-open on any error. ENTRY_POINT_GUARD_OK (self-exempt: this file documents the
 * bad pattern in its deny message; it is a guard, not an entry point using it).
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_TOKEN = 'ENTRY_POINT_GUARD_OK';

// The three ALWAYS-FALSE forms. All compare a raw URL to a native path (never equal on Windows).
const BROKEN_FORMS = [
  // `file://${process.argv[1]}` — manually building a file URL from a native path (the watchtower bug).
  /[`'"]file:\/\/\$\{\s*process\.argv\[1\]\s*\}/,
  // import.meta.url === process.argv[1]  (raw url vs path; import.meta.url NOT wrapped in fileURLToPath).
  /import\.meta\.url\s*[!=]==?\s*[`'"]?(?:file:\/\/)?\$?\{?\s*process\.argv\[1\]/,
  // reversed:  process.argv[1] === import.meta.url
  /process\.argv\[1\]\s*[!=]==?\s*import\.meta\.url\b/,
];

/** Pure detector: returns the offending snippet, or null if no always-false entry guard is present. */
export function findBrokenEntryGuard(fileContent) {
  const source = String(fileContent || '');
  for (const form of BROKEN_FORMS) {
    const match = source.match(form);
    if (match) return match[0];
  }
  return null;
}

function shouldScan(filePath) {
  const path = String(filePath || '').replace(/\\/g, '/');
  return /\.mjs$/.test(path) && !/\.test\.mjs$/.test(path);
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  if (!['Write', 'Edit', 'MultiEdit'].includes(event.tool_name || '')) process.exit(0);

  const input = event.tool_input || {};
  if (!shouldScan(input.file_path)) process.exit(0);

  // The text this write introduces: Write gives the whole file; Edit/MultiEdit give the replacement(s).
  const writtenText = input.content
    || input.new_string
    || (Array.isArray(input.edits) ? input.edits.map((edit) => edit.new_string || '').join('\n') : '')
    || '';
  if (writtenText.includes(OVERRIDE_TOKEN)) process.exit(0);

  const offender = findBrokenEntryGuard(writtenText);
  if (!offender) process.exit(0);

  const reason = `Entry-point guard BLOCKED — "${String(input.file_path).split(/[\\/]/).pop()}" uses an ALWAYS-FALSE self-execution check.

  ${offender}

On Windows \`import.meta.url\` is a \`file:///C:/...\` URL (forward slashes) and \`process.argv[1]\` is a
\`C:\\...\` path (backslashes) — this comparison is ALWAYS false, so \`node file.mjs\` imports the module
and exits WITHOUT running main(). The file looks installed but silently never runs (bit 3x: a daemon +
two hooks). Compare BASENAMES instead:

  import { basename } from 'node:path';
  import { fileURLToPath } from 'node:url';
  if (process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])) main();

Override (rare — you genuinely want a URL/path compare): put ${OVERRIDE_TOKEN} in the file.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

if (process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])) main();
