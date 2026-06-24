#!/usr/bin/env node
/**
 * coverage-claim-guard — Stop hook. Enforces the "say the REAL scope" lesson: it's easy to round
 * "tested most primitives" up to "tested EVERY primitive" in a chat summary while the written report
 * was honest. This blocks an absolute coverage claim UNLESS the same reply also states the true scope
 * (a count, or what's uncovered).
 *
 * Detection is combinatorial: (coverage verb) × (every/all quantifier) × (testable noun) within a
 * proximity window, PLUS "full/100% coverage" and "tested/covered everything". The escape is any
 * scope-honest signal in the SAME message: "N of M", "uncovered", "didn't test", "except", "gated", etc.
 *
 * Fail-open on any error. Override: "coverage-override: <why>" in the reply.
 *
 * Exports `makesAbsoluteClaim`, `statesRealScope`, `coverageClaimViolation` for the test.
 */
import { readFileSync, existsSync } from 'node:fs';

// ── PARTS (combined combinatorially so paraphrases still trip it) ──
const VERB = '(?:tested|test|testing|covers?|covered|covering|exercises?|exercised|exercising|uses?|used|using|hits?|hit|ran|run|validates?|validated|validating)';
const QUANT = '(?:every|all|each)';
const NOUN = '(?:primitives?|tools?|cases?|branches|branch|paths?|scenarios?|inputs?|endpoints?|methods?|functions?|features?|ops?|operations?|components?|modules?|fields?|states?|combinations?|edge ?cases?|code ?paths?)';
const GAP = '[^.!?\\n]{0,40}?'; // bounded proximity, never crossing a sentence end

// VERB → QUANT → NOUN ("tested every primitive", "exercises all the tools")
const CLAIM_VERB_FIRST = new RegExp(`\\b${VERB}\\b${GAP}\\b${QUANT}\\b(?: single| of the| of)?${GAP}\\b${NOUN}\\b`, 'i');
// QUANT → NOUN → VERB ("every primitive is tested", "all tools covered")
const CLAIM_NOUN_FIRST = new RegExp(`\\b${QUANT}\\b(?: single)?${GAP}\\b${NOUN}\\b${GAP}\\b(?:are |is |were |was |get |got |now )?${VERB}\\b`, 'i');
// "full / complete / total / 100% / every coverage"
const CLAIM_COVERAGE = /\b(?:full|complete|total|100%|comprehensive|every|entire)\s+coverage\b/i;
// "tested everything" / "everything is covered"
const CLAIM_EVERYTHING = /\b(?:tested|covered|exercised|validated)\s+everything\b|\beverything\s+(?:is |was |gets |has been )?(?:tested|covered|exercised|validated)\b/i;

const CLAIM_PATTERNS = [CLAIM_VERB_FIRST, CLAIM_NOUN_FIRST, CLAIM_COVERAGE, CLAIM_EVERYTHING];

// ── ESCAPE: a scope-honest signal in the SAME message means the claim is already qualified ──
const SCOPE_HONEST = [
  /\b\d+\s*(?:of|\/|out of)\s*\d+\b/i,             // "30 of 43", "30/43", "30 out of 43"
  /\buncovered\b/i,
  /\bnot (?:yet )?(?:tested|covered|exercised|run|wired)\b/i,
  /\b(?:did|does|do|could|can|would)(?:n['’]?t| not) (?:test|cover|exercise|run|hit)\b/i,
  /\b(?:can['’]?t|cannot|couldn['’]?t) (?:test|cover|exercise|run|headless)\b/i,
  /\bexcept(?:ing|ed|s)?\b/i,
  /\bexclud(?:e|es|ing|ed)\b/i,
  /\bgated?\b/i,
  /\blive-?gate/i,
  /\bheadless-?testable\b/i,
  /\bcoverage matrix\b/i,
  /\bremaining\b/i,
  /\bstill (?:need|needs|untested|missing)\b/i,
  /\bthe rest\b/i,
];

const OVERRIDE = /coverage-override:/i;

export function makesAbsoluteClaim(reply) {
  const replyBody = String(reply || '');
  return CLAIM_PATTERNS.some((pattern) => pattern.test(replyBody));
}

export function statesRealScope(reply) {
  const replyBody = String(reply || '');
  return SCOPE_HONEST.some((pattern) => pattern.test(replyBody));
}

/** True when the reply makes an absolute coverage claim with NO honest scope and NO override. */
export function coverageClaimViolation(reply) {
  const replyBody = String(reply || '');
  if (OVERRIDE.test(replyBody)) return false;
  return makesAbsoluteClaim(replyBody) && !statesRealScope(replyBody);
}

function readEntries(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try {
    return readFileSync(transcriptPath, 'utf8').trim().split('\n')
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function lastAssistantText(transcriptPath) {
  const entries = readEntries(transcriptPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== 'assistant') continue;
    const blocks = entries[i].message?.content;
    if (!Array.isArray(blocks)) continue;
    const reply = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    if (reply) return reply;
  }
  return '';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }
  const event = payload.hook_event_name || payload.hookEventName || '';
  if (event && event !== 'Stop' && event !== 'SubagentStop') return;

  const reply = lastAssistantText(payload.transcript_path);
  if (!coverageClaimViolation(reply)) return;

  const reason = `STOP-BLOCKED — absolute coverage claim without the real scope.
Your reply claims you tested/covered EVERYTHING (or "every <X>") but doesn't state the true scope.
Don't round "most" up to "every". Before stopping, rewrite the claim to state the REAL coverage:
  • a count — "N of M <X> covered", and
  • what's uncovered — "uncovered: …", distinguishing "can't headless-test" from "didn't build the harness yet".
Override only if the claim is genuinely exhaustive AND you said so honestly: "coverage-override: <why>".`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

main().catch(() => process.exit(0));
