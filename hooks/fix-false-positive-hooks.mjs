#!/usr/bin/env node
/**
 * fix-false-positive-hooks — Stop hook. ENFORCES Russell's rule (2026-07-01):
 * "A hook that FALSE-POSITIVES gets fixed THIS TURN — never sentinel-comment, env-override,
 *  or route around a wrong block and keep working."
 *
 * The failure it targets (same session it was born): require-langdocs false-blocked a static
 * HTML edit; instead of fixing the regex I kept working via `api-docs-read:` sentinel comments.
 * A CLAUDE.md rule alone is advice; this hook has teeth (decision: block).
 *
 * MECHANICAL DEFINITION of "worked around a false positive", all three in ONE session:
 *   1. a hook BLOCKED a tool call (block event carries the hook's identity), then
 *   2. a LATER tool input / assistant message used that same hook's OVERRIDE token, and
 *   3. by Stop time that hook's file was never Edited/Written (no fix landed).
 * Escape: if the block was a TRUE positive and the override legitimate, SAY SO explicitly in
 * the final reply: `true-positive: <hook-name> — <why>`. An override used with NO preceding
 * block from that hook (e.g. a sanctioned COMMIT_MAIN_OVERRIDE doc-commit flow) never fires.
 *
 * Detection windows follow the invariant (session-wide trigger, current-state satisfaction):
 * the whole transcript is scanned for block→override pairs; the fix/declaration check reads
 * the same transcript, so publishing the fix clears the gate immediately.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

// Deny-style blocks that do NOT name their hook file in the message — map their stable
// signature phrase to the hook. Path-style blocks (`[node .../hooks/X.mjs]`) need no entry.
const SIGNATURE_TO_HOOK = [
  { signature: 'Commit to main blocked', hookName: 'no-commit-to-main' },
  { signature: "BLOCKED: you're on main", hookName: 'no-write-to-main' },
  { signature: 'Name-by-use violation', hookName: 'name-by-use' },
  { signature: 'Filename BLOCKED', hookName: 'filename-quality-guard' },
  { signature: 'jargon used without a gloss', hookName: 'jargon-gloss-guard' },
];

// Override tokens per hook (the escape hatches each hook advertises). A generic
// `<ANYTHING>_OVERRIDE=1` / `<word> override:` fallback catches hooks not listed.
const OVERRIDE_TOKENS = {
  'require-langdocs-read': ['api-docs-read:', 'API_DOCS_OVERRIDE=1', 'LANGDOCS_OVERRIDE=1'],
  'no-commit-to-main': ['COMMIT_MAIN_OVERRIDE=1'],
  'no-write-to-main': ['WRITE_MAIN_OVERRIDE=1'],
  'name-by-use': ['name-by-use-override', 'NAME_BY_USE_OVERRIDE=1'],
  'filename-quality-guard': ['FILENAME_GUARD_OVERRIDE=1'],
  'jargon-gloss-guard': ['jargon-gloss override:', 'JARGON_GLOSS_OVERRIDE=1'],
};

function contentOf(entry) {
  return entry?.message?.content ?? entry?.content ?? '';
}

function entryTextOf(entry) {
  const content = contentOf(entry);
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'tool_result') {
      const inner = block.content;
      if (typeof inner === 'string') return inner;
      if (Array.isArray(inner)) return inner.map((piece) => piece?.text || '').join('\n');
    }
    return '';
  }).join('\n');
}

// Text the ASSISTANT authored this entry: message text + tool INPUTS (command / new_string /
// content / file_path). Deliberately EXCLUDES tool_results — block messages advertise their own
// override tokens, and quoting a block must not read as using its escape hatch.
function authoredTextOf(entry) {
  const role = entry?.message?.role || entry?.role;
  if (role !== 'assistant') return '';
  const content = contentOf(entry);
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.map((block) => {
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'tool_use') return JSON.stringify(block.input ?? {});
    return '';
  }).join('\n');
}

function hookEditsOf(entry) {
  const content = contentOf(entry);
  if (!Array.isArray(content)) return [];
  const editedHookNames = [];
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    if (!['Edit', 'Write', 'MultiEdit'].includes(block.name)) continue;
    const filePath = String(block.input?.file_path || '').replace(/\\/g, '/');
    const match = filePath.match(/\/hooks\/([a-z0-9-]+)(?:\.test)?\.mjs$/i);
    if (match) editedHookNames.push(match[1].toLowerCase());
  }
  return editedHookNames;
}

function blocksOf(entryText) {
  const blockedHookNames = new Set();
  // Path-style: "PreToolUse:Edit hook error: [node ~/.claude/hooks/require-langdocs-read.mjs]: BLOCKED"
  for (const match of entryText.matchAll(/\[node [^\]]*[\\/]hooks[\\/]([a-z0-9-]+)\.mjs\]/gi)) {
    blockedHookNames.add(match[1].toLowerCase());
  }
  // Signature-style deny messages that don't carry their path.
  for (const { signature, hookName } of SIGNATURE_TO_HOOK) {
    if (entryText.includes(signature)) blockedHookNames.add(hookName);
  }
  return blockedHookNames;
}

export function findWorkedAroundHooks(transcriptText) {
  const lines = transcriptText.split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* non-JSON line */ }
  }

  const blockIndexByHook = new Map();     // hookName -> first entry index where it blocked
  const overrideIndexByHook = new Map();  // hookName -> first entry index (post-block) using its override
  const editedHooks = new Set();
  let finalAssistantText = '';

  entries.forEach((entry, entryIndex) => {
    const fullText = entryTextOf(entry);
    for (const hookName of blocksOf(fullText)) {
      if (!blockIndexByHook.has(hookName)) blockIndexByHook.set(hookName, entryIndex);
    }
    for (const editedHookName of hookEditsOf(entry)) editedHooks.add(editedHookName);

    const authored = authoredTextOf(entry);
    if (authored) {
      finalAssistantText = authored;
      for (const [hookName, blockIndex] of blockIndexByHook) {
        if (overrideIndexByHook.has(hookName) || entryIndex <= blockIndex) continue;
        const tokens = OVERRIDE_TOKENS[hookName] || [];
        const genericOverride = new RegExp(`\\b${hookName}[-_ ]?override`, 'i');
        if (tokens.some((token) => authored.includes(token)) || genericOverride.test(authored)) {
          overrideIndexByHook.set(hookName, entryIndex);
        }
      }
    }
  });

  const unresolved = [];
  for (const [hookName] of overrideIndexByHook) {
    if (editedHooks.has(hookName)) continue;                                   // fixed this session
    const declaration = new RegExp(`true-positive:\\s*\`?${hookName}`, 'i');
    if (declaration.test(finalAssistantText)) continue;                        // declared legit
    unresolved.push(hookName);
  }
  return unresolved;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if (event.stop_hook_active) process.exit(0);
  if (process.env.FIX_FALSE_POSITIVE_HOOKS_OFF === '1') process.exit(0);

  const transcriptPath = event.transcript_path || '';
  if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

  let transcriptText = '';
  try { transcriptText = readFileSync(transcriptPath, 'utf8'); } catch { process.exit(0); }
  if (!transcriptText) process.exit(0);

  let unresolvedHooks = [];
  try { unresolvedHooks = findWorkedAroundHooks(transcriptText); } catch { process.exit(0); }
  if (unresolvedHooks.length === 0) process.exit(0);

  const reason =
    `STOP — a hook blocked you, you used its override, and the hook was never fixed (Russell's rule, 2026-07-01: a false-positiving hook gets fixed THIS TURN, not worked around).\n\n` +
    `Worked-around hook(s): ${unresolvedHooks.map((name) => `${name}.mjs`).join(', ')}\n\n` +
    `Do ONE of these before stopping, per hook:\n` +
    `  1. FIX it: open ~/.claude/hooks/<name>.mjs, correct the trigger, add a regression test,\n` +
    `     rerun the tests, sync it to the claude-discipline kit. (The edit itself clears this gate.)\n` +
    `  2. If the block was CORRECT and the override was the sanctioned flow, say so explicitly in\n` +
    `     your final reply: true-positive: <hook-name> — <why the block was right>.\n\n` +
    `An override after a wrong block leaves the trap armed for next session — that's the whole point.`;

  console.log(JSON.stringify({ decision: 'block', reason }));
}

// Entry-guard by basename (Windows-safe): import from the test must not read stdin.
if (process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])) main();
