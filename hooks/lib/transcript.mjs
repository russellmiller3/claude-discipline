// transcript.mjs — shared helpers for Claude Code hooks that read the hook event (on stdin) and the
// session transcript (the JSONL log of the conversation). Extracted because nearly every Stop / PostToolUse
// hook re-implemented these, and the copies had DRIFTED: three incompatible `lastAssistantText` signatures,
// and a `currentTurnEntries` that started mid-turn and silently dropped early tool_results (so a `git merge`
// printed early in a turn was invisible to the gate). One canonical, bug-fixed copy lives here.
//
// Dependency-free. Import from a hook in hooks/ with:  import { ... } from './lib/transcript.mjs';

import { readFileSync, existsSync } from 'node:fs';

// Read the hook event JSON from stdin (fd 0). Fail-open to {} so a parse error never breaks a hook —
// each caller decides whether an empty event means "no-op".
export function readHookEvent() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// Parse a transcript JSONL file into an array of entries (skips blank/garbled lines). [] on any error.
export function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try {
    return readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// The role/type of an entry, tolerant of the two transcript shapes (message-wrapped or flat).
export function roleOf(entry) { return entry?.message?.role || entry?.role || entry?.type || ''; }

// An entry's content blocks, normalized to an array. A bare string becomes one text block.
export function contentBlocks(entry) {
  const blocks = entry?.message?.content ?? entry?.content ?? [];
  if (typeof blocks === 'string') return [{ type: 'text', text: blocks }];
  return Array.isArray(blocks) ? blocks : [];
}

// The tool_use blocks in an entry (what the assistant called this step).
export function toolUsesOf(entry) { return contentBlocks(entry).filter((b) => b?.type === 'tool_use'); }

// Flatten a tool_result block to plain text (its content may be a string or an array of {text}/string parts).
export function toolResultText(block) {
  if (block?.type !== 'tool_result') return '';
  const inner = block.content;
  if (typeof inner === 'string') return inner;
  if (Array.isArray(inner)) return inner.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
  return '';
}

// A real human prompt (not a tool-result carrier): a user-role message that has actual text. Tool results
// come back as user-role messages whose blocks are all tool_result — those are NOT turn starts.
export function isHumanPrompt(entry) {
  if (roleOf(entry) !== 'user') return false;
  return contentBlocks(entry).some((b) => b.type === 'text' && (b.text || '').trim().length > 0);
}

// The current turn: from the last HUMAN prompt through the end. (The naive version started at the last user
// message before the last assistant — on a multi-step tool turn that began mid-turn and dropped earlier
// tool_results. Starting at the human prompt captures the whole turn, including early tool output.)
export function currentTurnEntries(entries) {
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'assistant') { lastAssistant = i; break; } }
  if (lastAssistant < 0) return [];
  let turnStart = 0;
  for (let i = lastAssistant; i >= 0; i--) { if (isHumanPrompt(entries[i])) { turnStart = i; break; } }
  return entries.slice(turnStart);
}

// The text of the last assistant message. Accepts EITHER a transcript path (string) or a pre-parsed entries
// array — unifying the three drifted signatures that existed across hooks, so a caller can't pass the wrong type.
export function lastAssistantText(pathOrEntries) {
  const entries = typeof pathOrEntries === 'string' ? readTranscript(pathOrEntries) : (pathOrEntries || []);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (roleOf(entries[i]) !== 'assistant') continue;
    const textBlocks = contentBlocks(entries[i]).filter((b) => b && b.type === 'text');
    if (textBlocks.length > 0) return textBlocks.map((b) => b.text).join('\n');
  }
  return '';
}
