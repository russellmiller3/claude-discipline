#!/usr/bin/env node
/**
 * hook-dry-review — PreToolUse(Write|Edit|MultiEdit) META-GUARD: writing or editing a hook FORCES a DRY review.
 *
 * Russell's rule (2026-06-28): "any hook creation or editing forces a review of hooks to DRY hooks."
 * The hook ecosystem grew to ~90 files that each re-implemented the same boilerplate (15 copies of
 * readTranscript, 12 of the roleOf/contentBlocks/toolUsesOf trio, etc.). Every new hook copy-pasted the
 * last one. This guard makes the DRY review MECHANICAL: the moment you write a hook that hand-rolls a
 * helper which already lives in the shared lib, it BLOCKS and points you at the canonical home — so the
 * duplication can't grow back, and you're forced to look at what already exists before adding another.
 *
 * TEETH (permissionDecision: 'deny'): a hook Write/Edit is blocked when the content DEFINES a local copy
 * of a SHARED-LIB helper (readTranscript / roleOf / contentBlocks / toolUsesOf / currentTurnEntries /
 * lastAssistantText / lastUserText / textOf) instead of importing it from ./lib/transcript.mjs.
 *
 * Scope: only `.mjs` under a `hooks/` dir, not `*.test.mjs`, and NOT the canonical lib itself
 * (`hooks/lib/…` is where these helpers are SUPPOSED to live). Fail-open on any error.
 * Override (a genuinely distinct helper that only shares a name): `dry-reviewed: <why>` in the edit, or
 * HOOK_DRY_OVERRIDE=1.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OVERRIDE = /\bdry-reviewed\s*:/i;
// The declaration a NEW hook must carry, proving its author swept the category index first (2026-07-15).
const NEW_HOOK_CATEGORY = /new-hook-category\s*:/i;

// Helpers that now live in lib/transcript.mjs. A hand-rolled `function <name>(` defining any of these,
// in a hook that does NOT import the shared lib, is a DRY violation we block.
const SHARED_HELPERS = [
  'readTranscript',
  'roleOf',
  'contentBlocks',
  'toolUsesOf',
  'currentTurnEntries',
  'lastAssistantText',
  'lastUserText',
  'textOf',
];

const norm = (anyPath) => String(anyPath || '').replace(/\\/g, '/');

// A hook source file we police: a .mjs under a hooks/ dir, not a test, not the shared lib dir.
export function isPolicedHookFile(filePath) {
  const path = norm(filePath);
  if (!/\/hooks\/[^/]+\.mjs$/.test(path)) return false; // also excludes hooks/lib/<x>.mjs (has an extra segment)
  if (/\.test\.mjs$/.test(path)) return false;
  return true;
}

// Pure verdict so the rule is unit-testable. Blocks iff the content locally DEFINES a shared helper but
// does NOT import it from the transcript lib (and hasn't opted out).
export function evaluateDry(content) {
  const source = String(content || '');
  if (OVERRIDE.test(source)) return { block: false, reason: 'opted out: dry-reviewed' };

  const importsLib = /from\s+['"][^'"]*lib\/transcript\.mjs['"]/.test(source);
  if (importsLib) return { block: false, reason: 'imports the shared transcript lib' };

  const reimplemented = SHARED_HELPERS.filter((name) =>
    new RegExp(`function\\s+${name}\\s*\\(`).test(source)
    || new RegExp(`(const|let)\\s+${name}\\s*=\\s*(\\([^)]*\\)|[A-Za-z0-9_$]+)\\s*=>`).test(source)
  );
  if (reimplemented.length === 0) return { block: false, reason: 'no shared helper re-implemented' };

  return { block: true, reimplemented };
}

function denial(filePath, reimplemented) {
  const name = norm(filePath).split('/').pop();
  return `HOOK DRY REVIEW — "${name}" re-implements helper(s) that already live in the shared lib: ${reimplemented.join(', ')}.

Russell's rule (2026-06-28): editing or creating a hook forces a DRY review. These transcript/parsing helpers
were copy-pasted across ~15 hooks before they were consolidated — don't grow that back.

Do this instead:
  import { ${reimplemented.join(', ')} } from './lib/transcript.mjs';

Before adding ANY new hook, also skim HOOKBOOK.md + the existing hooks for one that already does this job —
extend it rather than shipping a near-duplicate.

Override (a genuinely DISTINCT helper that only shares a name): add  dry-reviewed: <why it's not the shared one>
to the edit, or set HOOK_DRY_OVERRIDE=1.`;
}

// NEW-HOOK CATEGORY SWEEP (2026-07-15, Russell — after 20 overlapping hooks had to be consolidated 20->5).
// A Write that CREATES a new hooks/*.mjs (the file doesn't exist yet) must declare which HOOKBOOK category it
// belongs to — the mechanical "sweep before you add a sibling" that turns the create-hook skill's advisory Rule 0
// into a hard step. Editing an EXISTING hook is exempt (an Edit, or a Write that overwrites): extending is the
// path we WANT. Pure + exported for the test.
export function evaluateNewHook({ toolName, fileExists, content }) {
  if (toolName !== 'Write') return { block: false };   // only a Write can create a file; Edit/MultiEdit = extend
  if (fileExists) return { block: false };             // overwriting an existing hook is not a NEW hook
  const source = String(content || '');
  if (OVERRIDE.test(source) || NEW_HOOK_CATEGORY.test(source)) return { block: false };
  return { block: true };
}

function newHookDenial(filePath) {
  const name = norm(filePath).split('/').pop() || 'this hook';
  return `NEW HOOK — SWEEP THE EXISTING HOOKS FIRST (one hook per idea): "${name}".

Russell's rule (2026-07-15, after 20 overlapping hooks had to be consolidated to 5): before ADDING a hook, scan
the CATEGORY INDEX at the top of ~/.claude/hooks/HOOKBOOK.md — 16 categories covering all 113 hooks — and find the
one this belongs to. If an existing hook in that category ALMOST covers it, EXTEND that hook; don't ship a sibling.

Categories: Git safety · Git worktree/branch hygiene · Agent lifecycle · Bench/long-run · Code structure/quality ·
Test/verify/root-cause · Build/dist freshness · Docs/explainer/spec sync · Learnings system · Meta (hook discipline) ·
Session continuity · Output style/voice · Keep-executing · Process-discipline meta · Project-scoped · Control tower.

Then prove you looked by putting this in the new hook's header comment:
  new-hook-category: <category> — nearest existing hook is <X>; it does NOT cover this because <why>

(A genuinely brand-new idea no category holds: same token with "new category: <name>".)
Override: HOOK_DRY_OVERRIDE=1, or  dry-reviewed: <why>  in the content.`;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  if (!['Write', 'Edit', 'MultiEdit'].includes(event.tool_name || '')) process.exit(0);
  if (process.env.HOOK_DRY_OVERRIDE === '1') process.exit(0);

  const input = event.tool_input || {};
  if (!isPolicedHookFile(input.file_path || input.path)) process.exit(0);

  const content = input.content
    || input.new_string
    || (Array.isArray(input.edits) ? input.edits.map((edit) => edit.new_string || '').join('\n') : '')
    || '';

  const emitDeny = (permissionDecisionReason) => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason },
  }));

  // Check 1 — DRY: no re-implementing a shared-lib helper.
  const verdict = evaluateDry(content);
  if (verdict.block) { emitDeny(denial(input.file_path || input.path, verdict.reimplemented)); process.exit(0); }

  // Check 2 — NEW-HOOK category sweep: a brand-new hook must declare its category.
  let fileExists = false;
  try { fileExists = existsSync(input.file_path || input.path); } catch { fileExists = false; }
  if (evaluateNewHook({ toolName: event.tool_name, fileExists, content }).block) {
    emitDeny(newHookDenial(input.file_path || input.path));
    process.exit(0);
  }

  process.exit(0);
}

// Only run when executed directly as a hook — importing (e.g. from the test) must NOT block on stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
