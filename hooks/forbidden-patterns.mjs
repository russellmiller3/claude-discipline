#!/usr/bin/env node
/**
 * PreToolUse hook — block Write/Edit containing forbidden structural patterns.
 *
 * Russell's rules (2026-05-10):
 *   - Rule 3: No positional/stringly-typed data
 *   - Rule 1: No god objects
 *
 * Forbidden patterns (language-agnostic heuristics):
 *   1. Positional row access: row[0], cols[1], cells[2], fields[3], record[0], item[1]
 *      (the variable name + integer index on a collection used like a row)
 *   2. Direct stringly-typed row construction: []string{, Vec::new() with string pushes
 *      used in a domain context (not tests, not render layer)
 *   3. String type-discriminators: `currentResource == "pods"`, `viewMode == "list"`,
 *      `type == "foo"` used as a control-flow branch
 *   4. Root struct field additions: recognizes `App {` / `Model {` growing with `state:`
 *      fields that look view-specific (heuristic, noisy — warn not block)
 *
 * Fail-open on any unexpected error — never permanently brick CC.
 */

import { readFileSync } from 'node:fs';

// Patterns that produce a DENY (hard stop before write).
const DENY_PATTERNS = [
  {
    re: /\b(row|col|cols|cell|cells|record|item|entry|fields?)\s*\[\s*\d+\s*\]/gi,
    label: 'Positional row access',
    detail: 'e.g. row[0], cols[1], fields[3] — use named struct fields instead.',
    rule: 'Rule 3: No Positional/Stringly-Typed Data',
  },
  {
    re: /\b(currentResource|viewMode|currentView|activeTab|activePane|currentPage|resourceType|viewType)\s*==\s*["'`][^"'`]+["'`]/gi,
    label: 'String type-discriminator',
    detail: 'e.g. currentResource == "pods" — use typed variants/enums instead.',
    rule: 'Rule 5: Resist Shortest Path / Rule 3: No stringly-typed control flow',
  },
];

/**
 * A memo whose key is produced by the expensive call it is meant to skip.
 *
 * Made this mistake TWICE on 2026-08-15, in one session, in the same file:
 *
 *   snapshot_version, statuses = self._file_first_inventory()   <- the cost
 *   if self._catalog_version == snapshot_version:               <- the memo
 *       return self._catalog_memo
 *
 * The guard reads correctly, passes every correctness test, and saves nothing:
 * the expensive derivation runs, then its result is thrown away in favour of
 * the cached copy. The first instance measured 1,141 -> 1,463 ms (noise, no
 * gain) and was reverted; the second cost another full build-measure-revert
 * cycle before the shape was recognised.
 *
 * The signal is precise: an early-return cache check whose key was UNPACKED
 * from a method call on `self` in the preceding lines. Unpacking is what makes
 * it unambiguous — the call returned other values too, and the early return
 * discards them, which is only possible if the call already did its work.
 *
 * The fix is always the same: move the memo BELOW the cost, or key it on
 * something cheap (a stat fingerprint) that does not require the derivation.
 */
export function memoAboveItsOwnCost(source) {
  const findings = [];
  const lines = String(source || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    // A tuple unpack whose right-hand side is a method call on self.
    const unpack = lines[index].match(
      /^\s*([A-Za-z_]\w*\s*,[\w\s,_]*?)=\s*self\.(_?\w+)\s*\(/,
    );
    if (!unpack) continue;
    const producedNames = unpack[1]
      .split(',')
      .map((produced) => produced.trim())
      .filter((produced) => produced && produced !== '_');
    // A cache early-return within the next few lines, keyed on one of them.
    for (let ahead = index + 1; ahead <= index + 6 && ahead < lines.length; ahead += 1) {
      const guard = lines[ahead].match(
        /^\s*if\s+self\.(_\w*(?:memo|cache|snapshot|version|fingerprint)\w*)\s*[=!]=\s*(\w+)/,
      );
      if (!guard) continue;
      if (!producedNames.includes(guard[2])) continue;
      const returnsCache = lines
        .slice(ahead + 1, ahead + 3)
        .some((following) => /^\s*return\s+self\._\w*(memo|cache)\w*/.test(following));
      if (!returnsCache) continue;
      findings.push(
        `${lines[index].trim().slice(0, 70)} ... ${lines[ahead].trim().slice(0, 60)}`,
      );
      break;
    }
  }
  return findings;
}

// Patterns that produce a WARN (message injected, not blocked).
// These are noisier heuristics where context matters more.
const WARN_PATTERNS = [
  {
    re: /\[\]\s*string\s*\{[^}]{0,200}\}/gi,
    label: '[]string literal with multiple values',
    detail: 'If this is a domain record (not a string slice for display), use a named struct.',
    rule: 'Rule 3: No Positional/Stringly-Typed Data',
  },
  {
    re: /Vec\s*::\s*new\s*\(\s*\)[\s\S]{0,300}\.push\s*\(\s*["']/gi,
    label: 'Vec<String> built by pushing string literals',
    detail: 'If these are field values of a domain record, use a named struct.',
    rule: 'Rule 3: No Positional/Stringly-Typed Data',
  },
];

function extractMatches(text, re) {
  const hits = [];
  let m;
  const localRe = new RegExp(re.source, re.flags);
  while ((m = localRe.exec(text)) !== null) {
    hits.push(m[0].slice(0, 80));
    if (hits.length >= 3) break;
  }
  return hits;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  const tool = event.tool_name || '';
  if (tool !== 'Write' && tool !== 'Edit') process.exit(0);

  const input = event.tool_input || {};
  const path = (input.file_path || '').replace(/\\/g, '/');

  // Skip test files, render/view files, and non-code files.
  // Render/view is the one place positional output strings are OK.
  if (/\.(md|txt|json|toml|yaml|yml|html?|css)$/i.test(path)) process.exit(0);
  if (/[/\\](test|spec|__tests__|_test|\.test\.|\.spec\.)/.test(path)) process.exit(0);
  if (/[/\\](render|view|display|format|template)[^/\\]*\.(go|rs|js|ts|py|rb)$/i.test(path)) process.exit(0);

  const text =
    tool === 'Write' ? (input.content || '')
    : tool === 'Edit' ? (input.new_string || '')
    : '';

  if (!text) process.exit(0);

  const denyHits = [];
  for (const p of DENY_PATTERNS) {
    const matches = extractMatches(text, p.re);
    if (matches.length > 0) {
      denyHits.push({ ...p, matches });
    }
  }

  // A guard's own test file must be able to hold the shape it blocks. The
  // path-based test skip above misses `<name>.test.mjs` beside the hook.
  const isTestFile = /\.(test|spec)\.[cm]?[jt]s$/i.test(path);
  const memoHits = isTestFile ? [] : memoAboveItsOwnCost(text);
  if (memoHits.length > 0) {
    denyHits.push({
      label: 'Memo placed ABOVE the cost it is meant to skip',
      rule: 'A cache must not be keyed on what the expensive call produces',
      detail:
        'The key is unpacked from the very call the memo exists to avoid, so ' +
        'that call still runs and its result is discarded. Correct, tested, ' +
        'and saves nothing. Move the memo BELOW the cost, or key it on ' +
        'something cheap (a stat fingerprint) that needs no derivation.',
      matches: memoHits.slice(0, 3),
    });
  }

  if (denyHits.length > 0) {
    const lines = denyHits.map(h =>
      `  ❌ ${h.label} (${h.rule})\n     ${h.detail}\n     Seen: ${h.matches.map(m => `"${m}"`).join(', ')}`
    ).join('\n');
    const reason =
      `Forbidden structural pattern — STOP before writing.\n\n` +
      `${lines}\n\n` +
      `These patterns are banned by CLAUDE.md structural rules. ` +
      `Fix the design before writing the code:\n` +
      `  • Use named structs/classes with typed fields instead of positional collections.\n` +
      `  • Use typed variants/enums instead of string comparisons as type gates.\n` +
      `If this is a false positive (e.g. legitimate array index, not a row field), ` +
      `say "forbidden-patterns override: [reason]" and retry.`;

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      }
    }));
    process.exit(0);
  }

  // Warn-only patterns: inject into context but allow the write.
  const warnHits = [];
  for (const p of WARN_PATTERNS) {
    const matches = extractMatches(text, p.re);
    if (matches.length > 0) {
      warnHits.push({ ...p, matches });
    }
  }

  if (warnHits.length > 0) {
    const lines = warnHits.map(h =>
      `  ⚠️  ${h.label} (${h.rule}): ${h.detail}`
    ).join('\n');
    // Output a user-facing warning but allow the write.
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          `Structural warning (write allowed but check needed):\n${lines}\n` +
          `If these are domain records, use named structs. If they are display-layer string slices, that is fine.`,
      }
    }));
  }

  process.exit(0);
}

// Entry-point guard: importing this for tests must not run main(), which reads
// stdin and would hang the test process. Added 2026-08-15 after exactly that.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (invokedDirectly) {
  try { main(); } catch { process.exit(0); }
}
