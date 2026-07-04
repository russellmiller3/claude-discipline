#!/usr/bin/env node
/**
 * fix-false-positive-hooks — Stop hook. ENFORCES Russell's rule (2026-07-01, amended 2026-07-02):
 * "A hook that FALSE-POSITIVES gets fixed — never sentinel-comment, env-override, or route
 *  around a wrong block and keep working. But the fix itself is ALWAYS dispatched to a
 *  background Agent, never done inline on the main thread — hook-fixing must not interrupt
 *  whatever the main thread was actually doing when the false positive got in its way."
 *
 * The failure it targets (same session it was born): require-langdocs false-blocked a static
 * HTML edit; instead of fixing the regex I kept working via `api-docs-read:` sentinel comments.
 * A CLAUDE.md rule alone is advice; this hook has teeth (decision: block).
 *
 * MECHANICAL DEFINITION of "worked around a false positive", all three in ONE session:
 *   1. a hook BLOCKED a tool call (block event carries the hook's identity), then
 *   2. a LATER tool input / assistant message used that same hook's OVERRIDE token, and
 *   3. by Stop time that hook was neither (a) Edited/Written inline NOR (b) handed to a
 *      background Agent (a tool_use named `Agent` with `run_in_background: true` whose prompt
 *      names that hook's `.mjs` file) — i.e. no fix landed and none was even dispatched.
 * Escape: if the block was a TRUE positive and the override legitimate, SAY SO explicitly in
 * the final reply: `true-positive: <hook-name> — <why>`. An override used with NO preceding
 * block from that hook (e.g. a sanctioned COMMIT_MAIN_OVERRIDE doc-commit flow) never fires.
 *
 * Detection windows follow the invariant (session-wide trigger, current-state satisfaction):
 * the whole transcript is scanned for block→override pairs; the fix/declaration check reads
 * the same transcript, so publishing the fix clears the gate immediately.
 *
 * PERSISTED SATISFACTION (2026-07-03, Russell: worked-around-hook gate re-fired for HOURS after
 * the true-positive line was said once): `finalAssistantText` is only the LAST assistant text
 * block in the transcript — the declaration/dispatch/edit check re-derives "resolved?" from
 * scratch every Stop, so the moment a later reply doesn't repeat `true-positive: <hook> — <why>`,
 * an event resolved turns ago flags again, and keeps flagging every Stop for the rest of the
 * session even though the underlying block→override pair never recurred. Fix: once a specific
 * triggering event (hookName + the entry-index of ITS block) is found resolved, record it in a
 * per-session state file keyed by transcript path, so it stays resolved without needing the
 * declaration repeated. A NEW block of the SAME hook later (a fresh event, different block index)
 * is a distinct signature — it is not covered by a prior resolution and fires fresh.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const STATE_PATH = process.env.FIX_FALSE_POSITIVE_HOOKS_STATE_PATH
  || join(homedir(), '.claude', 'state', 'fix-false-positive-hooks-resolved.json');

function loadResolvedState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

function saveResolvedState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch { /* fail open — persistence is best-effort, never blocks on write failure */ }
}

// A stable signature for ONE triggering event: which transcript, which hook, which block. Keyed
// on the transcript path (a session-scoped file) + hookName + the block's own entry index, so a
// FRESH block of the same hook later in the same transcript (different index) is a new signature
// and is never silently covered by an earlier resolution.
function eventSignature(transcriptPath, hookName, blockIndex) {
  const key = `${transcriptPath}::${hookName}::${blockIndex}`;
  return createHash('sha1').update(key).digest('hex');
}

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

// A background Agent dispatch counts as "handling" a hook just like an inline edit does — the
// fix is delegated, not skipped. Only `run_in_background: true` qualifies (a foreground Agent
// call blocks the main thread exactly like doing the edit inline would, defeating the point of
// delegating); the prompt must name the hook's own `.mjs` file so a stray mention elsewhere
// can't accidentally clear an unrelated hook's gate.
function dispatchedFixesOf(entry) {
  const content = contentOf(entry);
  if (!Array.isArray(content)) return [];
  const dispatchedHookNames = [];
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    if (block.name !== 'Agent') continue;
    const input = block.input || {};
    if (input.run_in_background !== true) continue;
    const prompt = String(input.prompt || '');
    for (const match of prompt.matchAll(/([a-z0-9][a-z0-9-]*)\.mjs\b/gi)) {
      dispatchedHookNames.push(match[1].toLowerCase());
    }
  }
  return dispatchedHookNames;
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

// transcriptKey identifies the session for persisted-satisfaction lookups (omit to skip persistence,
// e.g. from unit tests exercising the pure transcript-scan logic in isolation).
export function findWorkedAroundHooks(transcriptText, transcriptKey) {
  const lines = transcriptText.split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* non-JSON line */ }
  }

  const pendingBlockIndexByHook = new Map();  // hookName -> the most recent UN-overridden block's entry index
  const overrideIndicesByHook = new Map();    // hookName -> [entry index, ...] of EACH override event (one per
                                               // block→override pair, in order) — not just the first ever, so a
                                               // fresh block+override pair later in the same transcript is its
                                               // own distinct event with its own signature (2026-07-03 fix).
  const editIndicesByHook = new Map();        // hookName -> [entry index, ...] where it was edited inline
  const dispatchIndicesByHook = new Map();    // hookName -> [entry index, ...] where a fix was dispatched
  const declarationIndicesByHook = new Map(); // hookName -> [entry index, ...] where declared true-positive

  entries.forEach((entry, entryIndex) => {
    const fullText = entryTextOf(entry);
    for (const hookName of blocksOf(fullText)) {
      // A hook can block, get overridden, and later block AGAIN — each block starts a new pending
      // pair. Only arm a new pending block if the previous one (if any) was already paired off.
      if (!pendingBlockIndexByHook.has(hookName)) pendingBlockIndexByHook.set(hookName, entryIndex);
    }
    for (const editedHookName of hookEditsOf(entry)) {
      if (!editIndicesByHook.has(editedHookName)) editIndicesByHook.set(editedHookName, []);
      editIndicesByHook.get(editedHookName).push(entryIndex);
    }
    for (const dispatchedHookName of dispatchedFixesOf(entry)) {
      if (!dispatchIndicesByHook.has(dispatchedHookName)) dispatchIndicesByHook.set(dispatchedHookName, []);
      dispatchIndicesByHook.get(dispatchedHookName).push(entryIndex);
    }

    const { inputText, messageText } = authoredChannelsOf(entry);
    if (messageText.trim()) {
      for (const hookName of new Set([...pendingBlockIndexByHook.keys(), ...overrideIndicesByHook.keys()])) {
        if (new RegExp(`true-positive:\\s*\`?${hookName}`, 'i').test(messageText)) {
          if (!declarationIndicesByHook.has(hookName)) declarationIndicesByHook.set(hookName, []);
          declarationIndicesByHook.get(hookName).push(entryIndex);
        }
      }
    }
    if (inputText || messageText) {
      for (const [hookName, blockIndex] of pendingBlockIndexByHook) {
        if (entryIndex <= blockIndex) continue;
        const tokens = OVERRIDE_TOKENS[hookName] || [];
        const genericOverride = new RegExp(`\\b${hookName}[-_ ]?override`, 'i');
        // Input-level tokens (env vars, sentinels) only take effect inside a tool input; the
        // generic <hook>-override form is input-level too. Reply-level tokens (the `... override:`
        // family) also count in message text — but a prose MENTION of an input-level token doesn't.
        const usedInInput = tokens.some((token) => inputText.includes(token)) || genericOverride.test(inputText);
        const usedInText = tokens.some((token) => TEXT_LEVEL_TOKEN.test(token) && messageText.includes(token));
        if (usedInInput || usedInText) {
          if (!overrideIndicesByHook.has(hookName)) overrideIndicesByHook.set(hookName, []);
          overrideIndicesByHook.get(hookName).push(entryIndex);
          pendingBlockIndexByHook.delete(hookName);  // this block is paired off; a LATER block re-arms fresh
        }
      }
    }
  });

  // Does any resolution-signal index (edit/dispatch/declaration) for this hook fall strictly after
  // the given override's own entry index? Scoping this way means an OLD declaration/fix from a prior,
  // already-resolved event does not blanket-cover a FRESH block→override pair later in the transcript.
  function resolvedAfter(hookName, overrideIndex) {
    const signalIndices = [
      ...(editIndicesByHook.get(hookName) || []),
      ...(dispatchIndicesByHook.get(hookName) || []),
      ...(declarationIndicesByHook.get(hookName) || []),
    ];
    return signalIndices.some((signalIndex) => signalIndex > overrideIndex);
  }

  const resolvedState = transcriptKey ? loadResolvedState() : {};
  let stateChanged = false;
  const unresolvedSet = new Set();
  for (const [hookName, overrideIndices] of overrideIndicesByHook) {
    for (const overrideIndex of overrideIndices) {
      const signature = transcriptKey ? eventSignature(transcriptKey, hookName, overrideIndex) : null;
      if (signature && resolvedState[signature]) continue;                     // already resolved — stays silent
      if (resolvedAfter(hookName, overrideIndex)) {
        if (signature) { resolvedState[signature] = { hookName, resolvedAt: new Date().toISOString() }; stateChanged = true; }
        continue;
      }
      unresolvedSet.add(hookName);
    }
  }
  if (transcriptKey && stateChanged) saveResolvedState(resolvedState);
  return [...unresolvedSet];
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
  try { unresolvedHooks = findWorkedAroundHooks(transcriptText, transcriptPath); } catch { process.exit(0); }
  if (unresolvedHooks.length === 0) process.exit(0);

  const reason =
    `STOP — a hook blocked you, you used its override, and the hook was neither fixed nor handed off (Russell's rule, 2026-07-01, amended 2026-07-02: a false-positiving hook gets fixed, not worked around — and the fix is ALWAYS dispatched to a background Agent, never done inline).\n\n` +
    `Worked-around hook(s): ${unresolvedHooks.map((name) => `${name}.mjs`).join(', ')}\n\n` +
    `Do ONE of these before stopping, per hook:\n` +
    `  1. DISPATCH it (preferred): call Agent with run_in_background: true and a prompt that names\n` +
    `     ~/.claude/hooks/<name>.mjs — open it, correct the trigger, add a regression test, rerun the\n` +
    `     tests, sync it to the claude-discipline kit. Then keep going on whatever you were doing; the\n` +
    `     dispatch itself clears this gate, you don't have to wait for it to finish.\n` +
    `  2. FIX it inline yourself only if you're already deep in that hook's own code for another\n` +
    `     reason — editing ~/.claude/hooks/<name>.mjs directly also clears the gate.\n` +
    `  3. If the block was CORRECT and the override was the sanctioned flow, say so explicitly in\n` +
    `     your final reply: true-positive: <hook-name> — <why the block was right>.\n\n` +
    `An override after a wrong block with no fix and no dispatch leaves the trap armed for next session.`;

  console.log(JSON.stringify({ decision: 'block', reason }));
}

// Entry-guard by basename (Windows-safe): import from the test must not read stdin.
if (process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])) main();
