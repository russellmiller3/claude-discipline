#!/usr/bin/env node
// Stop hook — block when the final message DEFERS A CHEAP, RUNNABLE job back to Russell instead of
// just running it. The repeat mistake (2026-06-25): Claude ended a turn with "that one's yours to run"
// / "it owes a paid live run" / "the hook blocks me from launching, so you run it" — for a $0.87 e2e
// gate that Claude could have launched itself. A CLAUDE.md rule alone ("<$5 = just run it") already
// failed once, so this is the teeth.
//
// The ross-perot-guard catches "want me to?" / "doing X next". This catches a NARROWER, sneakier shape:
// handing Russell a RUN ("you run it", "Russell runs it", "yours to run", "owes a run", "I can't launch")
// dressed up as if it were genuinely blocked — when it was a cheap command Claude should have executed.
//
// Blocks UNLESS the reply states a GENUINE blocker (a live browser the user must watch, hardware, a
// missing credential, something destructive, or a cost ≥ $5), or the override token is present.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The "hand a RUN to Russell" shapes. Each implies HE should run something CLAUDE could run.
const DEFER_RUN_PATTERNS = [
  /\b(for|to)\s+you\s+to\s+(run|launch|execute|verify)\b/i,                              // "for you to run"
  /\brun\s+it\s+yourself\b/i,
  /\byours\s+to\s+(run|launch|execute|verify)\b/i,                                       // "that one's yours to run"
  /\b(that|this|it)\s+one'?s?\s+(yours|for\s+you)\b/i,                                   // "that one's yours"
  /\bowes?\s+(a|one)\s+(paid\s+)?(live\s+)?run\b/i,                                       // "owes a run", "owes one paid live run"
  /\b(run|verification)\s+owed\b/i,
  /\bowed\s+(a\s+)?(live\s+)?run\b/i,
  /\b(i|claude)\s+can'?t\s+(launch|run|execute|trigger)\b/i,                             // "I can't launch"
  /\bblocked\s+from\s+(launching|running|executing|triggering)\b/i,
  /\bhook\s+blocks?\s+(me|claude)\b/i,                                                   // "the hook blocks me from..."
  /\bhand(?:ed|ing)?\s+(it|this|that)\s+back\b/i,                                        // "hand it back"
  /\bdefer(?:s|red|ring)?\s+(it\s+)?to\s+(russell|you)\b/i,                              // present OR past tense: "defer it to you" / "deferred to Russell"
  /\bleav(?:e|ing)\s+(it|that|the\s+run|the\s+\w+\s+run)\s+(to|for)\s+you\b/i,
  /\b(you|russell)\s+(kick|fire|trigger)s?\s+(it|the|that)\b/i,
  // 2026-07-16 gap: GATING a cheap run behind Russell's "go"/approval — the exact miss that let a
  // $0.75 GPU launch get deferred as "gated on your go" / "your one-word go" / "gate the launch" /
  // "awaiting your sign-off". None of the shapes above matched a launch parked behind approval.
  // (Note: this hook scans the final TEXT — a defer OFFERED via an AskUserQuestion option is still
  // NOT caught here; the behavior fix is "don't gate a <$5 run at all", but any follow-up gating
  // TEXT is now caught.)
  /\bgated?\s+(on|for)\s+your\b/i,                                                       // "gated on your go/approval"
  /\b(awaiting|await|pending|waiting\s+(?:on|for))\s+your\s+(go|go-?ahead|approval|sign-?off|green\s?light|ok|word|nod|yes)\b/i,
  /\bone-?word\s+(go|go-?ahead|yes|ok|nod)\b/i,                                          // "your one-word go"
  /\bgat(?:e|ing)\s+the\s+(launch|run|pod|paid|retrain|sweep|bench)\b/i,                 // "gate the launch"
  /\b(?:just\s+)?say\s+the\s+word\b/i,                                                   // "say the word"
  /\bon\s+your\s+go-?ahead\b/i,
];

// PROSE-SHAPED defer patterns (2026-07-13). "you run" also appears in ordinary explanatory prose
// ("verification becomes ~free, so you run it everywhere") that hands Russell nothing runnable.
// These only count as a defer when a CONCRETE RUNNABLE ARTIFACT co-occurs nearby — a backticked
// command, a script/CLI name, a '$'-prompt line, or "the command"/"this script".
const PROSE_DEFER_PATTERNS = [
  /\b(you|russell)\s+(can|should|need\s+to|have\s+to|could|'ll|will|just)?\s*runs?\b/i, // "you run", "Russell runs", "you need to run"
];

// What counts as "something runnable was actually handed over". Checked against the RAW text
// (backticks intact) in a window around the prose match.
const RUNNABLE_ARTIFACT_PATTERNS = [
  // backticked span that looks like a command: known CLI token or a script filename inside
  /`[^`\n]*(?:\bnpm\b|\bnpx\b|\bpnpm\b|\byarn\b|\bnode\b|\bpytest\b|\bpython3?\b|\bpip\b|\bbash\b|\bpwsh\b|\bmodal\b|\bcargo\b|\bmake\b|\bdocker\b|\bcurl\b|\bgit\b|\.(?:py|sh|mjs|cjs|js|ts|ps1|bat)\b)[^`\n]*`/i,
  // bare script filename in prose: run.mjs, bench/sweep.py, scripts\gate.ps1 ...
  /\b[\w./\\-]+\.(?:py|sh|mjs|cjs|ps1|bat)\b/i,
  // CLI invocation in prose (command word + an argument)
  /\b(?:npm|npx|pnpm|pytest)\s+[\w.:\/-]/i,
  /\bmodal\s+(?:run|deploy|serve|launch)\b/i,
  /\bpy\s+-3\b/i,
  // a '$'-prompt line (not a dollar amount — next char must be non-digit)
  /(?:^|\n)\s*\$\s+[^\s\d]/,
  // an explicit pointer at a runnable thing
  /\b(?:the|this|that)\s+(?:command|script)\b/i,
];

// A prose defer only fires when a runnable artifact appears within this many chars of the match.
const ARTIFACT_WINDOW_CHARS = 250;

// stripCodeSpans is INDEX-PRESERVING (spans become same-length spaces), so a match position in the
// cleaned text maps 1:1 to the raw text — letting us inspect the raw window (backticks intact).
function proseDeferMatches(rawText, cleanedText) {
  const matched = [];
  for (const pattern of PROSE_DEFER_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    for (const match of cleanedText.matchAll(globalPattern)) {
      const windowStart = Math.max(0, match.index - ARTIFACT_WINDOW_CHARS);
      const windowEnd = Math.min(rawText.length, match.index + match[0].length + ARTIFACT_WINDOW_CHARS);
      const rawWindow = rawText.slice(windowStart, windowEnd);
      if (RUNNABLE_ARTIFACT_PATTERNS.some((artifact) => artifact.test(rawWindow))) {
        matched.push(pattern.toString());
        break;
      }
    }
  }
  return matched;
}

// A real reason a defer is correct, not a dodge. If any is stated, the hand-off is legitimate.
const GENUINE_BLOCKER_PATTERNS = [
  /\blive\s+(chrome|browser|headed)\b/i,
  /\byou\s+(need|have)\s+to\s+(watch|be\s+(present|there|here)|sit)\b/i,
  /\b(hardware|mic|microphone|physical\s+device|usb|webcam|speaker|headphones?)\b/i,
  /\bmissing\s+(key|token|credential|api\s*key|oauth|secret)\b/i,
  /\bno\s+(api\s*)?(key|token|credential)\b/i,
  /\b(destructive|irreversible|force-?push|wipe|production\s+(data|db|deploy)|send\s+real|real\s+(email|money|payment|trade))\b/i,
  /\brequires?\s+(your|a\s+human)\s+(sign-?off|approval|presence|decision)\b/i,
  /\bMFA\b/,
];

// The cost carve-out: a defer IS legitimate when the stated cost of the run is ≥ $5 (real-money gate).
// A $0.87 run does NOT escape.
//
// POISONING FIX (2026-07-16): the old version took the max of EVERY "$N", so a defer that merely
// CITED the rule ("under the <$5 rule", "I check in at ~$20 cumulative") registered a ≥$5 figure and
// silently exempted itself — the enforcement turned off exactly when cost was discussed. So we now
// count only a "$N" that reads as the actual COST OF THE RUN, skipping threshold/rule citations:
//   - a lower-bound comparison right before it ("under $5", "<$5", "below $5", "less than $5"), and
//   - a rule/checkpoint word right after it ("$5 rule", "$20 cumulative", "$5 threshold").
// A genuine cost ("costs about $40", "~$8/hr", "over $5") is NOT skipped and still exempts.
const THRESHOLD_BEFORE = /(?:<|≤|<=|under|below|beneath|less\s+than)\s*(?:the\s+|a\s+|~|≈|about\s+|around\s+)?$/i;
const RULE_AFTER = /^\s*(?:rule|cumulative|checkpoint|threshold|gate|cap|budget|carve|auto[-\s]?run|autonomy|median|mark|ceiling)\b/i;

function statedRunCostDollars(messageText) {
  let maxCost = 0;
  for (const match of messageText.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)) {
    const amount = parseFloat(match[1]);
    if (!Number.isFinite(amount)) continue;
    const start = match.index ?? 0;
    const before = messageText.slice(Math.max(0, start - 20), start);
    const after = messageText.slice(start + match[0].length, start + match[0].length + 20);
    if (THRESHOLD_BEFORE.test(before)) continue; // a threshold citation, not a run cost
    if (RULE_AFTER.test(after)) continue;         // "$N rule / cumulative / checkpoint"
    if (amount > maxCost) maxCost = amount;
  }
  return maxCost;
}

const OVERRIDE = /(defer-run-override:|ross-perot-override:)/i;

// User explicitly opted into hands-off / survey mode → stay quiet.
const USER_PAUSE_PATTERNS = [
  /\bjust\s+(think|thinking|describe|describing|exploring|brainstorm)/i,
  /\b(research|survey|brainstorm|explore)\s+mode\b/i,
  /\b(don'?t|do not)\s+(take|do)\s+action\b/i,
  /\bfeedback\s+only\b/i,
];

// Strip code spans/blocks so quoting a trigger phrase (e.g. documenting this hook) doesn't false-fire.
// Index-preserving: spans become same-length whitespace so cleaned-text match positions map 1:1 onto
// the raw text (proseDeferMatches needs that to inspect the raw window around a match).
function stripCodeSpans(messageText) {
  return messageText
    .replace(/```[\s\S]*?```/g, (span) => span.replace(/[^\n]/g, ' '))
    .replace(/`[^`]*`/g, (span) => span.replace(/[^\n]/g, ' '));
}

function lastTextOfType(transcriptPath, wantedType) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
  const lines = content.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.type !== wantedType) continue;
    const message = entry.message;
    if (!message) continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const joined = message.content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
      if (joined) return joined;
    }
  }
  return '';
}

// The core decision, exported for the test. Returns the matched defer phrases when this is a
// cheap-run-deferred-to-Russell violation, or [] when it's fine to stop.
export function defersCheapRunToRussell(assistantText) {
  if (!assistantText) return [];
  const cleaned = stripCodeSpans(assistantText);
  if (OVERRIDE.test(cleaned)) return [];
  if (GENUINE_BLOCKER_PATTERNS.some((pattern) => pattern.test(cleaned))) return [];
  if (statedRunCostDollars(cleaned) >= 5) return []; // real-money gate — a legitimate hand-off
  const strongMatches = DEFER_RUN_PATTERNS.filter((pattern) => pattern.test(cleaned)).map((pattern) => pattern.toString());
  return [...strongMatches, ...proseDeferMatches(assistantText, cleaned)];
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  const assistantText = lastTextOfType(payload.transcript_path, 'assistant');
  if (!assistantText) { process.exit(0); return; }

  const userText = lastTextOfType(payload.transcript_path, 'user');
  if (USER_PAUSE_PATTERNS.some((pattern) => pattern.test(userText))) { process.exit(0); return; }

  const matched = defersCheapRunToRussell(assistantText);
  if (matched.length === 0) { process.exit(0); return; }

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `STOP-BLOCKED — you DEFERRED a cheap, runnable job back to Russell instead of running it (Cost-Autonomy Rule).

Your reply hands Russell a RUN to do. Matched: ${matched.join(', ')}

Russell's rule (2026-06-25): anything under $5 = JUST RUN IT, this turn. Never hand a runnable command back,
never claim "blocked" on a gate you only assumed — TEST the command first (a glob/flag workaround is 5 seconds).
This is the exact failure that wasted a session: deferring a $0.87 e2e gate Claude could have launched.

Do it now:
  - Run the command yourself (background it if long; post the one-line cost estimate first).
  - If it's a script/bench, a glob or --flag almost always satisfies any guard — try it, don't assume.

Only legitimately hand it back when:
  - It needs a LIVE browser Russell must watch, real hardware, a missing credential, or is destructive — STATE which.
  - The run costs >= $5 (real-money gate) — state the cost.
  - Real override: write "defer-run-override: <why Russell must be the one to run it>".`,
  }));
  process.exit(0);
}

// Entry-point guard so importing this for tests does not execute main() (which reads stdin and hangs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
