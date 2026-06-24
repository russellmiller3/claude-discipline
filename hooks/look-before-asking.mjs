#!/usr/bin/env node
/**
 * look-before-asking — Stop hook with TEETH (decision:block).
 *
 * The rule: search before you ask. When the agent asks the user where a key/file/value lives WITHOUT
 * first searching the filesystem (.env, settings, the repo), it's handing back a discoverable fact as a
 * question — a decision/energy tax when the answer was sitting on disk. This hook is the enforcement.
 *
 * FIRES on Stop when, IN THE CURRENT TURN (since the last genuine user prompt):
 *   1. The assistant's final text ASKS THE USER FOR A DISCOVERABLE FACT — where a file/key/value is, to
 *      paste/provide a path/key/env var, "is X in <file>", "do you have", "where is", "what's the path",
 *      "can you tell me the", etc. (locate-a-fact asks), AND
 *   2. The turn made ZERO look-first tool calls (no Read / Grep / Glob, and no Bash command that searches
 *      or reads: grep/rg/find/ls/cat/dir/Get-Content/Select-String/Test-Path/type/findstr...).
 *
 * BLOCKS with: "LOOK BEFORE ASKING — you asked for <thing> but ran 0 searches/reads this turn. Search the
 * filesystem (.env, settings, the repo) FIRST; only ask if you genuinely can't find it."
 *
 * CONSERVATIVE — does NOT fire on a genuine DESIGN-FORK question ("should we use X or Y approach", "which
 * approach do you prefer") — that's a judgment call, not a locate-a-fact ask. The asks are matched as a
 * CLASS via combinatorial PARTS (ask-shape × discoverable-target), not one fixed sentence.
 *
 * Override: put "asked-after-looking" in the reply (the genuine "I searched and truly can't get it —
 * hardware MFA, a value only the user knows" case). Re-entrancy-safe (stop_hook_active short-circuits).
 * Fail-open on any error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APOS = `['’]?`;

// --- DISCOVERABLE-FACT ASK detection -------------------------------------------------------------------
// Built from interchangeable PARTS so paraphrases still trip it: an ASK SHAPE pointed at a DISCOVERABLE
// TARGET (a file / path / key / token / credential / env var / config / setting / value / id / url).
const TARGET = `(?:\\.?env(?:\\s*(?:file|var(?:iable)?s?))?|environment\\s+variable|file|files|path|filepath|directory|folder|repo|api[\\s_-]?key|secret|token|credential|password|config(?:uration)?|setting|value|variable|var|url|endpoint|id|location)`;

const DISCOVERABLE_ASK_PATTERNS = [
  // "where is/are the X" / "where's the X" / "where do you keep the X"
  new RegExp(`\\bwhere${APOS}s?\\b(?:\\s+(?:is|are|do\\s+you\\s+(?:keep|store|put|have)|can\\s+i\\s+find))?[^.?!]{0,40}?\\b${TARGET}\\b`, 'i'),
  // "what's the path/value/key ..." / "what is the X"
  new RegExp(`\\bwhat${APOS}s?\\b(?:\\s+is)?\\s+the\\s+[^.?!]{0,30}?\\b${TARGET}\\b`, 'i'),
  // "can/could you (please) paste/provide/share/send/give (me) the X" / "tell me the X"
  new RegExp(`\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?(?:paste|provide|share|send|give|tell)\\b[^.?!]{0,40}?\\b${TARGET}\\b`, 'i'),
  // "(please) paste/provide/share the X" (imperative, no "can you")
  new RegExp(`\\b(?:please\\s+)?(?:paste|provide|share|send\\s+me)\\b[^.?!]{0,30}?\\b${TARGET}\\b[^.?!]{0,30}?(?:\\?|$|\\bso\\s+i\\b|\\band\\s+i${APOS}ll\\b)`, 'im'),
  // "do you have a/an/the X (set/configured/anywhere)?"
  new RegExp(`\\bdo\\s+you\\s+have\\s+(?:a|an|the|any)?\\s*[^.?!]{0,30}?\\b${TARGET}\\b`, 'i'),
  // "is the X in <file>?" / "is it in .env?" — locating a known fact in a known place
  new RegExp(`\\bis\\s+(?:the\\s+|your\\s+|it\\s+|that\\s+)?[^.?!]{0,30}?\\b${TARGET}\\b[^.?!]{0,20}?\\bin\\b`, 'i'),
  new RegExp(`\\bis\\s+(?:it|that|the\\s+\\w+)\\s+in\\s+(?:the\\s+|your\\s+)?[^.?!]{0,20}?\\b${TARGET}\\b`, 'i'),
  // "can you tell me the X" / "let me know the X / where the X is"
  new RegExp(`\\b(?:tell\\s+me|let\\s+me\\s+know)\\b[^.?!]{0,40}?\\b${TARGET}\\b`, 'i'),
  // "what(') s your X" / "where's your X" — possessive "your" tightly bound to a discoverable target
  new RegExp(`\\b(?:what${APOS}s?|where${APOS}s?)\\b[^.?!]{0,15}?\\byour\\s+[^.?!]{0,20}?\\b${TARGET}\\b`, 'i'),
];

// --- DESIGN-FORK guard ---------------------------------------------------------------------------------
// A genuine "X or Y approach?" judgment question is NOT a locate-a-fact ask. If the reply reads as a
// design fork AND none of the asks above name a hard file/credential target, stay quiet. Used as a
// TIE-BREAKER: design-fork wording without an on-disk target → suppress.
const DESIGN_FORK_PATTERNS = [
  /\b(approach|approaches|option|options|strateg(?:y|ies)|design|architect|pattern|way)\b[^.?!]{0,40}?\bor\b/i,
  /\b(which|what)\b[^.?!]{0,40}?\b(approach|option|way|route|path\s+forward|direction|design|do\s+you\s+(?:prefer|want))\b/i,
  /\b(should|shall)\s+(?:we|i)\b[^.?!]{0,40}?\bor\b/i,
  /\b(do\s+you\s+want)\b[^.?!]{0,40}?\bor\b/i,
];

// HARD discoverable targets — a credential/file-ish thing that genuinely lives on disk. If the ask names
// one of these, it's a locate-a-fact ask even if it superficially looks fork-shaped, so design-fork
// suppression does NOT apply.
const HARD_TARGET = /\b(\.?env(?:\s*(?:file|var))?|api[\s_-]?key|secret|token|credential|password|filepath|file\s+path|the\s+path\b|directory|config(?:uration)?\s+file)\b/i;

const OVERRIDE = /asked-after-looking/i;

// --- LOOK-FIRST tool detection -------------------------------------------------------------------------
// These tool_use names ARE a look (read/search the filesystem before asking).
const READ_SEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
// A Bash/PowerShell command counts as a look only if it actually searches or reads files.
const BASH_TOOLS = new Set(['Bash', 'PowerShell']);
const BASH_LOOK_RE = /\b(grep|rg|ripgrep|find|fd|ls|dir|cat|type|head|tail|less|more|sed|awk|Get-Content|Select-String|Get-ChildItem|Test-Path|gci|gc|sls|findstr|locate|tree|env|printenv)\b/i;

function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records.length ? records : null;
}

// Turn start = the last GENUINE user prompt (a user message with real text, not a pure tool_result echo).
function turnStartIndex(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const message = records[i]?.message;
    if (!message || message.role !== 'user') continue;
    const content = message.content;
    const hasText = typeof content === 'string'
      ? content.trim().length > 0
      : Array.isArray(content) && content.some((block) => block?.type === 'text' && String(block.text || '').trim());
    const toolResultOnly = Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === 'tool_result');
    if (hasText && !toolResultOnly) return i;
  }
  return 0;
}

// Did the current turn run any look-first tool call?
function lookedThisTurn(records, fromIndex) {
  for (let i = fromIndex; i < records.length; i++) {
    const message = records[i]?.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== 'tool_use') continue;
      if (READ_SEARCH_TOOLS.has(block.name)) return true;
      if (BASH_TOOLS.has(block.name)) {
        const shellCommand = String(block.input?.command || '');
        if (BASH_LOOK_RE.test(shellCommand)) return true;
      }
    }
  }
  return false;
}

// The assistant's final text in the current turn.
function lastAssistantReply(records, fromIndex) {
  for (let i = records.length - 1; i >= fromIndex; i--) {
    const message = records[i]?.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const replyText = message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (replyText) return replyText;
  }
  return '';
}

// Pure verdict so the rule is unit-testable in isolation.
export function evaluateLookBeforeAsking({ reply, looked }) {
  const replyText = String(reply || '');
  if (!replyText) return { block: false, reason: 'no assistant text' };
  if (OVERRIDE.test(replyText)) return { block: false, reason: 'override: asked-after-looking' };

  const askMatches = DISCOVERABLE_ASK_PATTERNS.filter((pattern) => pattern.test(replyText));
  if (askMatches.length === 0) return { block: false, reason: 'no discoverable-fact ask' };

  // Design-fork tie-breaker: if the reply reads as an X-or-Y judgment question AND does not name a hard
  // on-disk target (env/key/path/file/credential), treat it as a legitimate design question → no block.
  const looksLikeFork = DESIGN_FORK_PATTERNS.some((pattern) => pattern.test(replyText));
  const namesHardTarget = HARD_TARGET.test(replyText);
  if (looksLikeFork && !namesHardTarget) return { block: false, reason: 'design-fork question, no on-disk target' };

  if (looked) return { block: false, reason: 'looked this turn' };

  return {
    block: true,
    matched: askMatches.map((pattern) => pattern.toString()),
    reason: 'asked-for-discoverable + did-not-look',
  };
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); return; }

  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'Stop') { process.exit(0); return; }
  if (event.stop_hook_active) { process.exit(0); return; }   // never re-block — no infinite stop loop

  const records = readTranscript(event.transcript_path);
  if (!records) { process.exit(0); return; }

  const fromIndex = turnStartIndex(records);
  const reply = lastAssistantReply(records, fromIndex);
  const looked = lookedThisTurn(records, fromIndex);

  const verdict = evaluateLookBeforeAsking({ reply, looked });
  if (!verdict.block) { process.exit(0); return; }

  const blockReason = `LOOK BEFORE ASKING — you asked the user for something discoverable but ran 0 searches/reads this turn.

Matched ask pattern(s): ${verdict.matched.join(', ')}

The thing you asked for — a file / path / key / token / env var / config value — almost certainly lives
on disk. Handing it back as a question costs the user energy when the answer is sitting in the repo.

The rule: before claiming blocked, search the filesystem, env vars, shell profiles, binaries, alternate
auth. Document the search. Genuine blocks are rare.

What to do NOW (this turn, before stopping):
  - Search the obvious places: .env / .env.local, settings files, the repo (Grep/Glob), shell profiles, and the environment (printenv / Get-ChildItem Env:).
  - If you find it, use it and don't ask.
  - Only ask AFTER a real search comes up empty — and then say what you searched.

Override (you genuinely searched and truly can't get it — hardware MFA, a value only the user knows):
  add "asked-after-looking" to your reply with the one specific thing you couldn't find and where you looked.`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason }));
  process.exit(0);
}

// Only run when executed directly as a hook — importing (e.g. from the test) must NOT block on stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
