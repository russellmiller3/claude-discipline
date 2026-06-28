// transcript.mjs — shared transcript-parsing helpers for Stop / UserPromptSubmit hooks.
//
// Before 2026-06-28 these were copy-pasted into ~15 hooks (readTranscript) and ~12 (the
// roleOf/contentBlocks/toolUsesOf trio), each with tiny drift. This is the single canonical home;
// `hook-dry-review.mjs` blocks any new hook that hand-rolls one of these instead of importing it.
//
// A Claude Code transcript is JSONL: one JSON object per line. Each entry is a user/assistant/tool
// message. These helpers normalize the two shapes seen in the wild (`entry.message.{role,content}`
// and the flatter `entry.{role,content,type}`) so callers never branch on it.

import { existsSync, readFileSync } from 'node:fs';

/** Parse a JSONL transcript file into an array of entries. Missing file / bad lines → []. Never throws. */
export function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try {
    return readFileSync(transcriptPath, 'utf8')
      .split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** The role of an entry: 'user' | 'assistant' | tool/type fallback | ''. */
export function roleOf(entry) {
  return entry?.message?.role || entry?.role || entry?.type || '';
}

/** Normalize an entry's content to an array of blocks. A bare string becomes one text block. */
export function contentBlocks(entry) {
  const content = entry?.message?.content ?? entry?.content ?? [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/** All text in an entry, blocks joined by newline (handles string blocks and {text}/{content} blocks). */
export function textOf(entry) {
  return contentBlocks(entry)
    .map((block) => (typeof block === 'string' ? block : block?.text || block?.content || ''))
    .join('\n');
}

/** Just the tool_use blocks in an entry. */
export function toolUsesOf(entry) {
  return contentBlocks(entry).filter((block) => block?.type === 'tool_use');
}

/** Flatten a tool_result block's content to plain text (it may be a string or an array of {text}/string parts). */
export function toolResultText(block) {
  if (block?.type !== 'tool_result') return '';
  const inner = block.content;
  if (typeof inner === 'string') return inner;
  if (Array.isArray(inner)) return inner.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n');
  return '';
}

/**
 * A REAL human prompt — a user message carrying actual text. Tool results come back as user-role messages
 * whose blocks are all `tool_result`; those are NOT turn starts.
 */
export function isHumanPrompt(entry) {
  if (roleOf(entry) !== 'user') return false;
  return contentBlocks(entry).some((block) => block.type === 'text' && (block.text || '').trim().length > 0);
}

/**
 * Entries belonging to the CURRENT turn: from the last HUMAN prompt through the end of the transcript.
 * Empty when there's no assistant entry yet. Anchoring on the human prompt (not just any user message)
 * keeps early tool_results in-turn — the simpler "last user before last assistant" version started mid-turn
 * on a multi-step tool turn and dropped an early `git merge` result. Empty when there's no assistant yet.
 */
export function currentTurnEntries(entries) {
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (roleOf(entries[i]) === 'assistant') { lastAssistant = i; break; }
  }
  if (lastAssistant < 0) return [];
  let turnStart = 0;
  for (let i = lastAssistant; i >= 0; i--) {
    if (isHumanPrompt(entries[i])) { turnStart = i; break; }
  }
  return entries.slice(turnStart);
}

/**
 * Text of the most recent assistant REPLY — the last assistant entry that actually carries text.
 * Trailing assistant messages may be tool_use-only (no prose); those are skipped so callers scanning
 * "the reply" for phrases get the real words, not ''.
 */
export function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (roleOf(entries[i]) !== 'assistant') continue;
    const reply = contentBlocks(entries[i])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text).join('\n');
    if (reply) return reply;
  }
  return '';
}

/** Text of the most recent user entry — only its text blocks, never tool results (''). */
export function lastUserText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (roleOf(entries[i]) === 'user') {
      const blocks = entries[i]?.message?.content ?? entries[i]?.content;
      if (typeof blocks === 'string') return blocks;
      if (Array.isArray(blocks)) {
        const textBlocks = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string');
        if (textBlocks.length > 0) return textBlocks.map((block) => block.text).join('\n');
      }
    }
  }
  return '';
}

// ── path-taking convenience wrappers ─────────────────────────────────────────
// Many Stop hooks only want "the last reply text" / "the last user text" straight from a transcript path.
// These fold readTranscript + the entries-based getter into one call (was ~8 hand-rolled copies each).

/** Last assistant reply text, read straight from a transcript file path (''). */
export function lastAssistantTextOf(transcriptPath) {
  return lastAssistantText(readTranscript(transcriptPath));
}

/** Last genuine user text, read straight from a transcript file path (''). */
export function lastUserTextOf(transcriptPath) {
  return lastUserText(readTranscript(transcriptPath));
}
