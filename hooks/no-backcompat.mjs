#!/usr/bin/env node
// =============================================================================
// no-backcompat — STOP CLAUDE FROM PRESERVING BACKWARDS COMPATIBILITY
// =============================================================================
//
// Russell's rule, repeated three times across sessions and EXPLICITLY in Clear's
// CLAUDE.md ("No Backward Compatibility"):
//
//   There are no users yet. Do not preserve backward compatibility.
//   Always do things the right way. If the right design breaks existing
//   tests, update the tests. If it changes syntax, change it.
//   Speed of iteration > stability of APIs.
//
// And yet Claude keeps adding deprecation warnings, soft-deprecation paths,
// "the old form still compiles" branches, "existing apps don't break"
// disclaimers. Every one of those is a violation. Russell asked, verbatim,
// for a hook that fires when this pattern appears so future-Claude reads
// the excoriation and stops doing it.
//
// Fires on TWO events:
//   1. PreToolUse(Edit|Write) — scans the new_string / content for
//      backcompat-friendly language and BLOCKS the write with an
//      excoriation block.
//   2. Stop — scans the last assistant message for the same patterns
//      and BLOCKS the stop with the same excoriation. Forces Claude to
//      rewrite the reply and (importantly) rip out the backcompat path
//      that probably accompanied it.
//
// The detection pattern list is deliberately broad. False positives are
// rare because legitimate code rarely mentions "back-compat" / "deprecation
// warning" / "existing apps don't break" / "the old form still compiles".
// When they DO appear, they nearly always belong to a Claude-introduced
// soft-deprecation that violates the rule.
//
// Override: include `BACKCOMPAT_OVERRIDE=1` in the env or the literal
// string `intentional backcompat` in the offending text. Use only when
// Russell EXPLICITLY says so — never just to dodge the hook.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';

const PATTERNS = [
  // Direct violations — language Claude uses to justify keeping the old path
  /\bback[\s-]?compat(?:ibility|ible)?\b/i,
  /\bbackwards?\s*compat/i,
  /\bdeprecat(?:e|es|ed|ion|ing)\b/i,
  /\bsoft[\s-]?deprecat/i,
  /\bexisting\s+(?:apps?|code|tests?|callers?)\s+(?:don'?t|do\s+not)\s+break/i,
  /\b(?:old|legacy|previous|prior)\s+(?:form|shape|syntax|API|interface)\s+still\s+(?:compiles?|works?|parses?)/i,
  /\bstill\s+(?:compiles?|works?|parses?)\s+(?:cleanly|fine)/i,
  /\bback[\s-]?compat\s+path\b/i,
  /\bkeep\s+(?:parsing|emitting|the\s+old)\b/i,
  /\bmigration\s+(?:hint|warning)\b/i,
  /\bdeprecation\s+(?:hint|warning|notice|marker)\b/i,
];

const OVERRIDE_PATTERNS = [
  /\bintentional\s+backcompat\b/i,
  /BACKCOMPAT_OVERRIDE\s*=\s*1/i,
];

function isOverride(text) {
  if (process.env.BACKCOMPAT_OVERRIDE === '1') return true;
  for (const re of OVERRIDE_PATTERNS) if (re.test(text)) return true;
  return false;
}

// intentional backcompat: this guard's own source + tests necessarily contain the trigger words
// (they define the patterns). main() exempts edits to this file's family; this token keeps the guard
// from blocking edits to ITSELF.
//
// Blank the guard's OWN identifiers so DOCUMENTING this hook — a README row / HOOKBOOK entry naming
// the guard, or a "*_OVERRIDE" token — isn't read as a violation. The concept-word standing alone
// (a real Claude-introduced soft-deprecation path) still fires. (2026-07-01 false-fire.)
function withoutSelfReferences(candidateText) {
  return candidateText
    .replace(/\bno-?backcompat(?:\.test)?(?:\.mjs)?\b/gi, ' ')
    .replace(/BACKCOMPAT_OVERRIDE/gi, ' ');
}

function findHits(candidateText) {
  if (!candidateText || typeof candidateText !== 'string') return [];
  if (isOverride(candidateText)) return [];
  const scannable = withoutSelfReferences(candidateText);
  const hits = [];
  for (const re of PATTERNS) {
    const m = scannable.match(re);
    if (m) hits.push({ pattern: re.source, sample: m[0] });
  }
  return hits;
}

function excoriation(hits, where) {
  const list = hits.slice(0, 5).map((h) => `  - matched ${h.pattern}: "${h.sample}"`).join('\n');
  return `STOP. You are about to violate "No Backward Compatibility".

Detected backcompat-friendly language in ${where}:

${list}

Russell's rule (Clear CLAUDE.md, restated three times across sessions):

  There are no users yet. Do not preserve backward compatibility.
  Always do things the right way. If the right design breaks existing
  tests, update the tests. If it changes syntax, change it.
  Speed of iteration > stability of APIs. We'll freeze interfaces when
  we have users, not before.

What you almost did wrong: keep an old form working "for back-compat",
add a deprecation warning, leave the legacy path as a soft-deprecation.
That is a violation. Every time you do it Russell has to come back and
say "rewrite the tests, rip out the deprecation."

What to do instead:
  1. RIP OUT the old syntax / API / behavior. Don't leave it.
  2. Update the parser/compiler to ONLY accept the new form.
  3. Rewrite every test that uses the old form.
  4. Update docs to show only the new form.
  5. Skip the deprecation warning entirely.

Override (rare, ONLY when Russell explicitly told you to keep the old
form): include the literal string "intentional backcompat" in the text,
or set BACKCOMPAT_OVERRIDE=1 in the environment. Never use this to dodge.

Now rewrite without the backcompat path.`;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }
  const eventName = event.hook_event_name || event.hookEventName || '';

  if (eventName === 'PreToolUse') {
    const toolName = event.tool_name || '';
    if (toolName !== 'Edit' && toolName !== 'Write') {
      process.exit(0);
      return;
    }
    const input = event.tool_input || {};
    // The guard's own source + test define the trigger words — editing them must never self-block.
    const editedPath = String(input.file_path || '').replace(/\\/g, '/');
    if (/\/no-backcompat(?:\.test)?\.mjs$/i.test(editedPath)) { process.exit(0); return; }
    const editedContent = input.new_string || input.content || '';
    const hits = findHits(editedContent);
    if (hits.length === 0) {
      process.exit(0);
      return;
    }
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: excoriation(hits, 'your file edit'),
        },
      })
    );
    process.exit(0);
    return;
  }

  if (eventName === 'Stop') {
    if (event.stop_hook_active) {
      process.exit(0);
      return;
    }
    const transcriptPath = event.transcript_path;
    if (!transcriptPath || !existsSync(transcriptPath)) {
      process.exit(0);
      return;
    }
    let content;
    try {
      content = readFileSync(transcriptPath, 'utf8');
    } catch {
      process.exit(0);
      return;
    }
    const lines = content.trim().split('\n');
    let lastAssistantText = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== 'assistant') continue;
        const blocks = entry.message?.content || [];
        const textBlocks = blocks.filter((b) => b && b.type === 'text');
        if (textBlocks.length > 0) {
          lastAssistantText = textBlocks.map((b) => b.text).join('\n');
          break;
        }
      } catch {
        continue;
      }
    }
    const hits = findHits(lastAssistantText);
    if (hits.length === 0) {
      process.exit(0);
      return;
    }
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: excoriation(hits, "your last reply"),
      })
    );
    process.exit(0);
    return;
  }

  process.exit(0);
}

main();
