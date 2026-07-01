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

function targetPathOf(toolUseBlock) {
  return String(toolUseBlock.input?.file_path || '').replace(/\\/g, '/');
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

// Files where override tokens legitimately appear as CONTENT, not as escape hatches:
// hook sources (token lists like this file's own OVERRIDE_TOKENS), HOOKBOOK docs, the
// rules file, and settings. Without this, WRITING a hook that documents overrides read
// as USING them — the hook flagged itself on its first live stop (2026-07-01).
const HOOK_AUTHORING_TARGET = /(?:[\\/]hooks[\\/][a-z0-9-]+(?:\.test)?\.mjs|HOOKBOOK\.md|CLAUDE\.md|settings\.json)$/i;

// Reply-level override tokens take effect in plain MESSAGE TEXT (Stop-hook escapes).
// Everything else (env vars, sentinel comments) only works inside a tool INPUT.
const TEXT_LEVEL_TOKEN = /override:|true-positive:/i;

// The assistant-authored text of an entry, split by channel: tool INPUTS (minus hook-authoring
// targets) vs message TEXT. tool_results are excluded entirely — a block message advertising
// its own escape hatch must not read as using it.
function authoredChannelsOf(entry) {
  const role = entry?.message?.role || entry?.role;
  if (role !== 'assistant') return { inputText: '', messageText: '' };
  const content = contentOf(entry);
  if (!Array.isArray(content)) return { inputText: '', messageText: typeof content === 'string' ? content : '' };
  let inputText = '';
  let messageText = '';
  for (const block of content) {
    if (block?.type === 'text') messageText += `${block.text || ''}\n`;
    if (block?.type === 'tool_use') {
      if (HOOK_AUTHORING_TARGET.test(targetPathOf(block))) continue;   // writing ABOUT hooks ≠ dodging one
      inputText += `${JSON.stringify(block.input ?? {})}\n`;
    }
  }
  return { inputText, messageText };
}

function hookEditsOf(entry) {
  const content = contentOf(entry);
  if (!Array.isArray(content)) return [];
  const editedHookNames = [];
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    if (!['Edit', 'Write', 'MultiEdit'].includes(block.name)) continue;
    const match = targetPathOf(block).match(/\/hooks\/([a-z0-9-]+)(?:\.test)?\.mjs$/i);
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

    const { inputText, messageText } = authoredChannelsOf(entry);
    if (messageText.trim()) finalAssistantText = messageText;
    if (inputText || messageText) {
      for (const [hookName, blockIndex] of blockIndexByHook) {
        if (overrideIndexByHook.has(hookName) || entryIndex <= blockIndex) continue;
        const tokens = OVERRIDE_TOKENS[hookName] || [];
        const genericOverride = new RegExp(`\\b${hookName}[-_ ]?override`, 'i');
        // Input-level tokens (env vars, sentinels) only take effect inside a tool input; the
        // generic <hook>-override form is input-level too. Reply-level tokens (the `... override:`
        // family) also count in message text — but a prose MENTION of an input-level token doesn't.
        const usedInInput = tokens.some((token) => inputText.includes(token)) || genericOverride.test(inputText);
        const usedInText = tokens.some((token) => TEXT_LEVEL_TOKEN.test(token) && messageText.includes(token));
        if (usedInInput || usedInText) overrideIndexByHook.set(hookName, entryIndex);
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
