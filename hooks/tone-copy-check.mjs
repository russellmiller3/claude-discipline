#!/usr/bin/env node
// =============================================================================
// tone-copy-check — external-facing copy (outreach emails, proposals, pitch
//                   decks) must be confident and direct, never condescending.
// =============================================================================
//
// Russell's rule (~/.claude/CLAUDE.md, "External Copy Tone — Confident, Never
// Condescending", 2026-07-03): stay terse and direct — that's still right for
// a technical buyer — but never diminish what the recipient already built,
// and never explain something they obviously already know. Triggered when
// Russell flagged the Inngest proposal's "You just raised $21M. That buys
// runway, not attention... It's good. You've built exactly one." as
// condescending toward a founder who'd clearly earned what he built.
//
// Fires on PreToolUse(Write|Edit|MultiEdit) for a file that LOOKS like
// external-facing copy (filename signals: email/proposal/pitch/outreach/
// cover-letter). Scans the new text for known condescension SHAPES — not a
// general tone classifier, a curated list of the specific patterns that have
// actually bitten. Blocks with a quote of the offending line + a rewrite
// direction, mirroring bench-pattern-guard's denial style.
//
// Bypass (rare — you've reviewed the line and it's not actually condescending
// in context): put `tone-check-override` in the file, or set
// TONE_CHECK_OVERRIDE=1. The teeth: PreToolUse permissionDecision 'deny'.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Not \b — an underscore/hyphen (common in script filenames like build_proposal.py)
// counts as a word character in regex, so \b would miss "proposal" in "build_proposal".
const EXTERNAL_COPY_FILE_RE = /(?:^|[^a-zA-Z])(email|proposal|pitch|outreach|cover.?letter)(?:[^a-zA-Z]|$)/i;

const CONDESCENSION_PATTERNS = [
  {
    label: 'EXACTLY-ONE DIMINISHMENT',
    regex: /\byou'?ve (built|done|made|shipped|got)\s+exactly\s+(one|1)\b/i,
    why: 'flattens a real accomplishment into a scoreboard number — reads as a setup for the pitch, not a compliment',
  },
  {
    label: 'ONLY-DIMINISHMENT',
    regex: /\byou'?ve only (built|done|made|shipped)\b/i,
    why: 'minimizes what they built instead of crediting it',
  },
  {
    label: 'OBVIOUS-ECONOMICS EXPLAINER',
    regex: /\b(that|this)\s+(buys|means)\b[^.]{0,40},\s*not\b/i,
    why: 'explains something a funded/experienced recipient obviously already knows',
  },
  {
    label: 'WELL-ACTUALLY',
    regex: /\bwell,?\s+actually\b/i,
    why: 'classic condescension opener',
  },
  {
    label: 'AS-YOU-KNOW PRESUMPTION',
    regex: /\bas you (probably|surely|already) know\b/i,
    why: 'patronizing presumption about what they know',
  },
];

const OVERRIDE = /tone-check-override/i;

/** Does this file look like external-facing copy (email/proposal/pitch/outreach)? */
export function looksLikeExternalCopy(filePath) {
  return EXTERNAL_COPY_FILE_RE.test(filePath || '');
}

/** Which condescension patterns match the given copy, with the offending snippet. */
export function findCondescension(copyText) {
  const findings = [];
  for (const pattern of CONDESCENSION_PATTERNS) {
    const match = pattern.regex.exec(copyText || '');
    if (match) {
      findings.push({ label: pattern.label, why: pattern.why, snippet: match[0] });
    }
  }
  return findings;
}

function denial(filePath, findings) {
  const findingLines = findings
    .map((finding) => `  - ${finding.label}: "${finding.snippet}" — ${finding.why}`)
    .join('\n');
  return `BLOCKED — this reads as condescending, not confident.

${filePath} looks like external-facing copy (email/proposal/pitch/outreach), and it matches:

${findingLines}

Russell's rule (~/.claude/CLAUDE.md, "External Copy Tone"): stay terse and direct — that's
still right for a technical buyer — but credit what the recipient genuinely built, in full
sentences, without a "but" doing the work of minimizing it. Never explain something they
obviously already know.

Rewrite direction: keep the same length and punch, lose the diminishment. Test: would a peer
say this to someone they respect?

Bypass only if you've reviewed the line and it's genuinely not condescending in context: put
tone-check-override in the file, or set TONE_CHECK_OVERRIDE=1.`;
}

function readEvent() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  const hookEvent = readEvent();
  if (!['Write', 'Edit', 'MultiEdit'].includes(hookEvent.tool_name)) { process.exit(0); return; }

  const input = hookEvent.tool_input || {};
  const filePath = input.file_path || input.path || '';
  const newCopyText = input.content
    || input.new_string
    || (Array.isArray(input.edits) ? input.edits.map((edit) => edit.new_string || '').join('\n') : '')
    || '';

  if (!newCopyText) { process.exit(0); return; }
  if (process.env.TONE_CHECK_OVERRIDE === '1' || OVERRIDE.test(newCopyText)) { process.exit(0); return; }
  if (!looksLikeExternalCopy(filePath)) { process.exit(0); return; }

  const findings = findCondescension(newCopyText);
  if (findings.length === 0) { process.exit(0); return; }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial(filePath, findings),
    },
  }));
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
