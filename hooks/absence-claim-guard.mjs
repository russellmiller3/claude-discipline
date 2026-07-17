#!/usr/bin/env node
/**
 * absence-claim-guard — Stop hook. Enforces the "never assert a capability is absent from a narrow
 * search" lesson (codeservo/learnings.md 2026-07-17): I grepped ONE file (codeservo_tools.py) for
 * `run_recipe`, found none, and implied CodeServo's replay/recipe capability was missing — it lives
 * in codeservo_recipes.py + codeservo_service_tools.py. An absence-claim is a factual claim; it earns
 * the fact-check bar (grep the WHOLE repo + read the capability doc) before it ships.
 *
 * new-hook-category: Test / verify / root-cause — nearest existing hook is coverage-claim-guard (guards
 * absolute test-COVERAGE claims like "tested every primitive") and self-verify-before-asking (verify
 * before asking Russell); NEITHER covers asserting a code CAPABILITY is absent from an insufficient
 * search — a different claim class (existence, not coverage) and this hook uniquely inspects THIS turn's
 * tool calls for a repo-wide search before allowing the claim.
 *
 * BLOCKS a Stop when the final reply asserts a code CAPABILITY is absent ("no <X> API/method", "net-new",
 * "not built", "<X> doesn't exist", "missing the <X> capability") AND no repo-wide search ran THIS turn
 * (a Grep with no single-file path, a Glob, or a Bash `grep -r`/`rg`/`git grep`). Every absence phrase is
 * tied to a capability noun so innocent "there's no need to" / "no problem" never trip it.
 *
 * Fail-open on any error. Escape: "absence-verified: <where I searched>" in the reply.
 *
 * Exports makesAbsenceClaim, ranRepoWideSearch, toolCallsOf, absenceClaimViolation for the test.
 */
import { readTranscript, currentTurnEntries, toolUsesOf, lastAssistantText } from './lib/transcript.mjs';

// A capability noun — the thing an absence-claim is ABOUT. Tying every phrase to one of these keeps the
// guard off innocent negations ("no need to", "no problem", "the file doesn't exist").
const CAP = '(?:api|method|function|func|tool|module|helper|endpoint|command|verb|capability|capabilities|implementation|support|class|feature|mechanism|primitive|handler|arch|architecture|engine|pipeline|abstraction|wrapper|interface)';
const NEAR = "[\\w\"'.@/`()-]{0,40}?"; // a symbol/name between "no" and the capability noun, no sentence crossing

const ABSENCE_PATTERNS = [
  // "no run_recipe method", "no such replay API", "no existing X tool"
  new RegExp(`\\bno\\s+(?:such\\s+|existing\\s+)?${NEAR}\\s*${CAP}\\b`, 'i'),
  // "there's no X capability", "there is no Y function"
  new RegExp(`\\bthere(?:['’]s| is)\\s+no\\s+${NEAR}\\s*${CAP}\\b`, 'i'),
  // "X method doesn't exist", "the replay API does not exist"
  new RegExp(`${CAP}\\s+(?:does(?:n['’]t| not)|do(?:n['’]t| not))\\s+exist\\b`, 'i'),
  // "doesn't have a rollback method", "don't have any recipe engine"
  new RegExp(`\\bdoes(?:n['’]t| not)\\s+have\\s+(?:a\\s+|an\\s+|any\\s+)?${NEAR}\\s*${CAP}\\b`, 'i'),
  // "missing the X capability", "lacks a Y module"
  new RegExp(`\\b(?:missing|lacks?)\\s+(?:the\\s+|a\\s+|an\\s+|any\\s+)?${NEAR}\\s*${CAP}\\b`, 'i'),
  // strong standalone "we don't have this built" signals
  /\bnet[-\s]new\b/i,
  /\b(?:not\s+(?:yet\s+)?built|never\s+built|not\s+(?:implemented|wired|exposed))\b/i,
  /\b(?:is|are)n['’]?t\s+(?:built|implemented|wired|exposed)\b/i,
  /\bno\s+prior\s+art\b/i,
];

const OVERRIDE = /absence-verified:/i;

export function makesAbsenceClaim(reply) {
  const body = String(reply || '');
  return ABSENCE_PATTERNS.some((pattern) => pattern.test(body));
}

/** Does a single Grep `path` point at ONE specific file (the narrow case that misled me)? */
function isSingleFilePath(path) {
  if (!path || typeof path !== 'string') return false;
  if (/[*?]/.test(path)) return false;             // a glob is not a single file
  const base = path.replace(/\\/g, '/').split('/').pop() || '';
  return /\.\w+$/.test(base);                       // basename has an extension → a specific file
}

/**
 * Did a repo-WIDE search run this turn? Grep without a single-file path, a Glob, or a shell
 * `grep -r`/`grep -R`/`rg`/`git grep`/`findstr /s`/`find -name`. A single-file grep (my original mistake)
 * does NOT count.
 */
export function ranRepoWideSearch(toolCalls) {
  for (const call of toolCalls || []) {
    const name = call?.name || '';
    const input = call?.input || {};
    if (name === 'Grep') {
      if (!isSingleFilePath(input.path)) return true; // no path / dir / glob → repo-wide
    }
    if (name === 'Glob') return true;
    if (name === 'Bash' || name === 'PowerShell') {
      const command = String(input.command || '');
      if (/\bgrep\b[^|&;\n]*\s-[A-Za-z]*[rR]/.test(command)) return true; // grep -r / -R
      if (/\brg\b/.test(command)) return true;                            // ripgrep (recursive default)
      if (/\bgit\s+grep\b/.test(command)) return true;
      if (/\bfindstr\b[^|&;\n]*\/[sS]\b/.test(command)) return true;      // Windows findstr /s
      if (/\bfind\b[^|&;\n]*-name\b/.test(command)) return true;
    }
  }
  return false;
}

/** Normalize this turn's entries into a flat [{name, input}] tool-call list. */
export function toolCallsOf(turnEntries) {
  const calls = [];
  for (const entry of turnEntries || []) {
    for (const block of toolUsesOf(entry)) {
      calls.push({ name: block?.name || '', input: block?.input || {} });
    }
  }
  return calls;
}

/** True when the reply asserts a capability is absent, no repo-wide search ran, and no override. */
export function absenceClaimViolation(reply, toolCalls) {
  const body = String(reply || '');
  if (OVERRIDE.test(body)) return false;
  if (!makesAbsenceClaim(body)) return false;
  return !ranRepoWideSearch(toolCalls);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }
  const event = payload.hook_event_name || payload.hookEventName || '';
  if (event && event !== 'Stop' && event !== 'SubagentStop') return;

  const entries = readTranscript(payload.transcript_path);
  const turn = currentTurnEntries(entries);
  const reply = lastAssistantText(turn);
  const toolCalls = toolCallsOf(turn);
  if (!absenceClaimViolation(reply, toolCalls)) return;

  const reason = `STOP-BLOCKED — you asserted a code capability is ABSENT without a repo-wide search (codeservo/learnings.md 2026-07-17, cost a false alarm).
Your reply claims something like "no <X> API / not built / net-new / <X> doesn't exist", but this turn ran no repo-wide search — only a narrow one (or none). A single-file grep is exactly what misled me into "CodeServo has no replay API" when it lived in another module.
Before stopping, VERIFY the absence:
  • grep the WHOLE repo (Grep with no single-file path, or \`grep -r\`/\`rg\`/\`git grep\`), not one file, and
  • read the project's capability doc (AGENTS.md glossary / TRUTH.md / an intent.md if present).
Then correct the claim, or if it's genuinely absent, say so with: "absence-verified: <what I searched>".`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  main().catch(() => process.exit(0));
}
