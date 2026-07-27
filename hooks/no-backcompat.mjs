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
//
// (Fixed 2026-07-02) The rule is about API/syntax backward-compat shims —
// but the pattern list fired on ANY prose use of "deprecated" etc, including
// a markdown doc describing an unrelated design decision ("the widget
// regressed to the deprecated color palette" — a CSS/UI choice, nothing to
// do with code compatibility). Mirrors live-ui-focus-guard.mjs's same-day
// fix: a match only counts as a real hit if there's CODE-ADJACENT evidence
// nearby — either a fenced code block in the text, or code/API vocabulary
// (function/API/endpoint/parser/compiler/syntax/interface/version/flag/
// schema/method/class/type/import/export) within a context window of the
// trigger word, or actual code-punctuation syntax around it (call parens,
// semicolons, `//` comments, etc). Plain prose with none of that — a design
// doc, a HANDOFF note about UI colors — no longer fires.
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

// (2026-07-02) Code-adjacency check — see header note. A trigger word only counts as a real
// backcompat violation if the surrounding text reads as code or an API/syntax discussion, not
// plain design/UI/product prose (e.g. a HANDOFF.md line about a "deprecated" color palette).
//
// (2026-07-13 false-fire) CODE_VOCAB was too loose: words like "function", "flag", "API",
// "version", "type", "class", "method", "argument"/"arg"/"param", "SDK"/"CLI"/"route" show up
// constantly in ORDINARY engineering prose that has nothing to do with an actual code decision
// — e.g. "confirmed live via an isolated function-level test" (test granularity, not a function
// in code) sat next to "temperature is flatly DEPRECATED" (a quote/paraphrase of Anthropic's own
// API error text in a HANDOFF.md status note) and the guard blocked it. Trimmed CODE_VOCAB down
// to words that are much harder to use outside a real code/API discussion (parser, compiler,
// syntax, endpoint, handler, shim, schema, module, import, export, interface, callers/caller).
// Also added a "quoted vendor text" exclusion: a trigger word sitting between a matching pair of
// quote marks — i.e. quoted verbatim, as in `("temperature is deprecated for this model")` — is
// almost always reported speech (someone ELSE's words: a vendor error string, a doc excerpt), not
// Claude's own backcompat decision, so it no longer counts weak CODE_VOCAB evidence; it still
// blocks if real code evidence (fenced block / code punctuation) is present.
const CODE_CONTEXT_WINDOW = 80;
const CODE_VOCAB =
  /\b(parser|parsers|parsing|compiler|compiles?|syntax|interface|schema|module|import|export|callers?|caller|handler|shim|endpoint)\b/i;
// Fenced code block anywhere in the candidate text (```...```), or code-punctuation syntax
// immediately around the match itself (dotted call, statement semicolon, `//` comment, arrow fn,
// `if (`) — catches cases like `console.warn("deprecated: ...")` that carry no API vocabulary.
const FENCED_CODE_BLOCK = /```/;
const CODE_SYNTAX_NEAR =
  /(\/\/|[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*\s*\(|\([^()]*\)\s*;|;\s*$|=>|\bif\s*\(|\bconsole\.\w+\()/;
// Quote-mark pairs used to detect "this trigger word is quoted verbatim" (reported speech).
// Deliberately excludes the plain apostrophe (') — contractions like "doesn't" would otherwise
// misread as an open quote.
const QUOTE_PAIRS = [
  ['"', '"'],
  ['`', '`'],
  ['“', '”'], // “ ”
];

function isInsideQuotedSpan(windowText, matchIndex, matchLength, windowStart) {
  const relStart = matchIndex - windowStart;
  const before = windowText.slice(0, relStart);
  const after = windowText.slice(relStart + matchLength);
  for (const [open, close] of QUOTE_PAIRS) {
    if (before.lastIndexOf(open) !== -1 && after.indexOf(close) !== -1) return true;
  }
  return false;
}

// (2026-07-27 false-fire) THIRD instance of the same class as the 2026-07-02 and 2026-07-13 fixes:
// the trigger word appeared in text that is not a backcompat decision at all. Here a CHANGELOG
// entry described MIGRATING OFF a third-party vendor's deprecated endpoint (Retell removing
// `GET /list-agents`) — i.e. ripping the old call shape out entirely, which is exactly what this
// rule DEMANDS ("RIP OUT the old syntax / API"). The guard blocked the write for containing the
// word "deprecated", which would have made it impossible to document compliance with the rule.
//
// The distinguishing signal is DIRECTION, not vocabulary:
//   - PRESERVING the old path (the real violation): "still works", "keep the old", "fall back",
//     "legacy path", "for compatibility", "shim".
//   - REMOVING / migrating off it (compliance): "migrate off", "removes", "no longer", "replaced
//     by", "rip out", "switched to".
// Preservation ALWAYS wins: text that says "migrated off, but the old form still works" is still a
// violation, so a preservation phrase anywhere in the window vetoes the removal exemption.
const REMOVAL_CONTEXT =
  /\b(?:migrat(?:e|ed|es|ing)\s+(?:off|away|from|to)|remov(?:e|ed|es|al|ing)|rip(?:ped)?\s+out|no\s+longer|replac(?:e|ed|es|ement)\s*(?:by|with)?|switch(?:ed|ing)?\s+to|drop(?:s|ped|ping)?\b)/i;
const PRESERVATION_CONTEXT =
  /\b(?:still\s+(?:works?|compiles?|parses?|accepted|supported)|keep(?:s|ing)?\s+(?:the\s+)?(?:old|legacy|previous)|fall(?:s|ing)?\s+back|legacy\s+path|for\s+(?:backwards?\s+)?compat|shim|both\s+forms?|continues?\s+to\s+(?:work|compile|parse))/i;

function isMigrationAwayFromDeprecation(candidateText, matchIndex, matchLength) {
  const windowStart = Math.max(0, matchIndex - CODE_CONTEXT_WINDOW * 2);
  const windowEnd = Math.min(candidateText.length, matchIndex + matchLength + CODE_CONTEXT_WINDOW * 2);
  const window = candidateText.slice(windowStart, windowEnd);
  if (PRESERVATION_CONTEXT.test(window)) return false; // keeping the old path — a real violation
  return REMOVAL_CONTEXT.test(window);
}

function hasCodeAdjacentEvidence(candidateText, matchIndex, matchLength) {
  if (FENCED_CODE_BLOCK.test(candidateText)) return true;
  const windowStart = Math.max(0, matchIndex - CODE_CONTEXT_WINDOW);
  const windowEnd = Math.min(candidateText.length, matchIndex + matchLength + CODE_CONTEXT_WINDOW);
  const window = candidateText.slice(windowStart, windowEnd);
  if (CODE_SYNTAX_NEAR.test(window)) return true;
  // A trigger word quoted verbatim is reported speech, not a code decision — don't let a merely
  // generic CODE_VOCAB word nearby count as evidence in that case; real code syntax (above) still
  // wins if present.
  if (isInsideQuotedSpan(window, matchIndex, matchLength, windowStart)) return false;
  if (CODE_VOCAB.test(window)) return true;
  return false;
}

function findHits(candidateText) {
  if (!candidateText || typeof candidateText !== 'string') return [];
  if (isOverride(candidateText)) return [];
  const scannable = withoutSelfReferences(candidateText);
  const hits = [];
  for (const re of PATTERNS) {
    const m = scannable.match(re);
    if (!m) continue;
    // (2026-07-02) The word alone isn't enough — require code-adjacent evidence nearby, so plain
    // prose (a markdown doc's "deprecated color palette") doesn't read as a real backcompat shim.
    if (!hasCodeAdjacentEvidence(scannable, m.index, m[0].length)) continue;
    // (2026-07-27) Removing/migrating off a deprecated path is COMPLIANCE with the rule, not a
    // violation of it — only preserving one is. See isMigrationAwayFromDeprecation above.
    if (isMigrationAwayFromDeprecation(scannable, m.index, m[0].length)) continue;
    hits.push({ pattern: re.source, sample: m[0] });
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
