// transcript.mjs — shared transcript-parsing helpers for Stop / UserPromptSubmit hooks.
//
// Before 2026-06-28 these were copy-pasted into ~15 hooks (readTranscript) and ~12 (the
// roleOf/contentBlocks/toolUsesOf trio), each with tiny drift. This is the single canonical home;
// `hook-dry-review.mjs` blocks any new hook that hand-rolls one of these instead of importing it.
//
// Claude Code and Codex transcripts are JSONL. These helpers normalize Claude message/tool blocks
// and Codex response_item payloads into one canonical view so policy never trusts a tool-authored
// substitute for the human's actual message.

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
  const codexPayload = entry?.type === 'response_item' ? entry.payload : null;
  if (codexPayload?.type === 'message') return codexPayload.role || '';
  if (codexPayload?.type === 'custom_tool_call') return 'assistant';
  if (codexPayload?.type === 'custom_tool_call_output') return 'tool';
  return entry?.message?.role || entry?.role || entry?.type || '';
}

/** Normalize an entry's content to an array of blocks. A bare string becomes one text block. */
export function contentBlocks(entry) {
  const codexPayload = entry?.type === 'response_item' ? entry.payload : null;
  if (codexPayload?.type === 'message') {
    const content = Array.isArray(codexPayload.content) ? codexPayload.content : [];
    return content.map((block) => {
      if (block?.type === 'input_text' || block?.type === 'output_text') {
        return { ...block, type: 'text', text: block.text || '' };
      }
      return block;
    });
  }
  if (codexPayload?.type === 'custom_tool_call') {
    return [{
      type: 'tool_use',
      id: codexPayload.id || '',
      call_id: codexPayload.call_id || '',
      name: codexPayload.name || '',
      input: codexPayload.input,
    }];
  }
  if (codexPayload?.type === 'custom_tool_call_output') {
    return [{
      type: 'tool_result',
      tool_use_id: codexPayload.call_id || '',
      content: codexPayload.output,
    }];
  }
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

/**
 * An entry's wall-clock timestamp in epoch ms, or null if missing/unparseable. Claude Code
 * transcript lines carry a top-level ISO `timestamp` field (sibling of `message`, not nested
 * inside it — confirmed against a live transcript, 2026-08-05); Codex response_item payloads
 * carry no equivalent field yet, so this returns null for those and callers must treat null as
 * "skip this entry," never as epoch 0 (which would look like a multi-decade gap).
 */
export function timestampOf(entry) {
  const raw = entry?.timestamp;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
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
 * A REAL human prompt — a user message carrying actual text Russell typed. Tool results come back as
 * user-role messages whose blocks are all `tool_result`; those are NOT turn starts. Neither is a
 * synthetic `isMeta:true` injection (Stop hook feedback, a skill's launch instructions) — it has
 * `role:'user'` and real text, but it is not something Russell typed, and currentTurnEntries() must
 * not treat it as a new turn boundary or a blocked draft gets severed from the retry that follows it.
 */
export function isHumanPrompt(entry) {
  if (roleOf(entry) !== 'user') return false;
  if (entry?.isMeta === true) return false;
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
      const textBlocks = contentBlocks(entries[i])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string');
      if (textBlocks.length > 0) return textBlocks.map((block) => block.text).join('\n');
    }
  }
  return '';
}

const SHORT_CONTINUATION_RE = /^\s*(?:g|go|continue|focus|t|y|yes(?:,?\s*(?:proceed|go\s+ahead|do\s+it))?|ok(?:ay)?|approved|go\s+ahead|proceed|do\s+it)[.!\s]*$/i;
const SAFETY_CONCERN_RE = /\b(?:safety concern|security risk|data loss|destructive|irreversible|credential leak|privacy breach|corrupt(?:ion)?|unsafe)\b/i;
const SAFETY_APPROVAL_RE = /\b(?:approve|approved|authorize|authorized|go\s+ahead|proceed|do\s+it|yes)\b/i;

/** Keep the substantive human goal across terse continuation or approval turns. */
export function effectiveHumanTask(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const prompts = rows.filter(isHumanPrompt).map((entry) => textOf(entry).trim()).filter(Boolean);
  if (!prompts.length) return '';
  const latest = prompts[prompts.length - 1];
  if (!SHORT_CONTINUATION_RE.test(latest) && !(SAFETY_APPROVAL_RE.test(latest) && latest.length < 100)) return latest;
  for (let index = prompts.length - 2; index >= 0; index--) {
    if (!SHORT_CONTINUATION_RE.test(prompts[index])) return prompts[index];
  }
  return latest;
}

/** True only when a real human approves a concrete safety concern raised immediately before. */
export function humanSafetyApproval(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  let humanIndex = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (isHumanPrompt(rows[index])) { humanIndex = index; break; }
  }
  if (humanIndex < 0) return false;
  const humanText = textOf(rows[humanIndex]).trim();
  if (!SAFETY_APPROVAL_RE.test(humanText)) return false;
  for (let index = humanIndex - 1; index >= 0; index--) {
    if (isHumanPrompt(rows[index])) break;
    if (roleOf(rows[index]) === 'assistant' && SAFETY_CONCERN_RE.test(textOf(rows[index]))) return true;
  }
  return false;
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
