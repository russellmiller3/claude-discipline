#!/usr/bin/env node
// Stop hook — block when the last assistant message contains code-work time
// estimates in human-hours/days/weeks. Russell's rule (~/.claude/CLAUDE.md
// "Time Estimates — Don't Give Human-Hour Numbers"): AI-tool mechanical work
// is ~60× off. The "1 hour ship" I keep saying is actually 1 minute.
//
// Trigger: future-tense estimate phrasing that pairs an action verb
// (ship/build/add/fix/etc.) with an hour/day/week time unit. Past-tense
// facts ("took 2 hours") and runtime references ("every 30 minutes",
// "remind me in 1 hour") are NOT flagged.
//
// The fix: divide by 60 before speaking, OR (better) restate as work-units
// ("a schema change + 4 wire-ups + a test"). Time should rarely appear in
// my own descriptions of code work at all.

import { readFileSync, existsSync } from 'node:fs';

// Future-tense / hypothetical estimate context — verbs that signal "I'm
// telling Russell how long something will take to do."
const ESTIMATE_VERBS = [
  'ship', 'build', 'add', 'implement', 'fix', 'tweak', 'refactor', 'wire',
  'land', 'do', 'finish', 'complete', 'extend', 'rewrite', 'port',
  'edit', 'change', 'update', 'patch', 'make', 'create', 'design',
];

// Time units that should trigger inspection.
const UNIT_RE_HOURS = /\b(hour|hr)s?\b/i;
const UNIT_RE_DAYS = /\b(day|afternoon|morning|evening)s?\b/i;
const UNIT_RE_WEEKS = /\bweeks?\b/i;

// Past-tense / factual context — DON'T flag.
const PAST_CONTEXT_RE = /\b(took|spent|elapsed|ago|yesterday|earlier|ran|lasted|been|was|were|finished|completed|wrapped|shipped|landed)\b/i;

// Runtime / API references — DON'T flag.
const RUNTIME_CONTEXT_RE = /\b(every|interval|cron|tick|sweep|fire(s|d)?|timer|polled?|polling|in 1 hour|in 30 min|chrono|parse(s|d)?|remind me)\b/i;

// Specific bad patterns (these alone are enough to block).
const HARD_PATTERNS = [
  // "X-hour ship", "1 hour fix", "2-hour build"
  /\b\d+\s*-?\s*hours?\s+(ship|fix|build|task|change|tweak|update|refactor|edit|chunk|effort|sprint|push|polish)\b/i,
  // "would take X hours" / "should take" / "will take" / "could take"
  /\b(?:should|would|will|could|might|may|expect|estimate)d?\s+take\s+(?:about\s+|around\s+|roughly\s+)?\S+\s*(hours?|days?|weeks?)\b/i,
  // "a quick X-hour task" / "1-hour ship"
  /\b(quick|small|tiny|simple)\s+\d*\s*-?\s*hours?\s+\b/i,
  // "ETA X hours" / "in roughly X hours"
  /\b(eta|in\s+(?:about|around|roughly|approximately|maybe))\s+\d+\s*-?\s*\d*\s*(hours?|days?|weeks?)\b/i,
  // "a few hours of X" / "a couple hours of X" / "several hours to X"
  /\b(a\s+few|a\s+couple|several)\s+(hours|days|weeks)\s+(of\s+work|to\s+\w+|for\s+\w+|on\s+\w+)\b/i,
  // "by next week" / "by Friday" / "by tomorrow" in code-shipping context
  /\bby\s+(next\s+(week|month)|friday|monday|tuesday|wednesday|thursday|saturday|sunday|tomorrow)\b.{0,40}\b(ship|land|done|complete|wire|build|implement)/i,
  // "an hour-ish" / "hour-ish"
  /\b\d*\s*-?\s*hour-ish\b/i,
  // Bare "~X hours" / "X-hour"
  /\b~\s*\d+\s*-?\s*hours?\b/i,
];

// Soft patterns: time-unit near an estimate verb within a window.
// Only flag if NO past/runtime context appears in the same sentence.
function detectSoftEstimates(text) {
  const hits = [];
  // Split into sentences (rough — period, newline, semicolon).
  const sentences = text.split(/[.!?\n;]/);
  for (const s of sentences) {
    if (!s.trim()) continue;
    if (PAST_CONTEXT_RE.test(s)) continue;
    if (RUNTIME_CONTEXT_RE.test(s)) continue;
    const hasHour = UNIT_RE_HOURS.test(s);
    const hasDay = UNIT_RE_DAYS.test(s);
    const hasWeek = UNIT_RE_WEEKS.test(s);
    if (!hasHour && !hasDay && !hasWeek) continue;
    // require an estimate verb nearby for soft trigger
    const verbRe = new RegExp(`\\b(${ESTIMATE_VERBS.join('|')})\\w*\\b`, 'i');
    if (!verbRe.test(s)) continue;
    // require a NUMERIC qualifier OR indefinite article ("an hour" / "a day" / "a week")
    const hasNumeric = /\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a\s+couple|a\s+few|several)\b/i.test(s);
    if (!hasNumeric) continue;
    hits.push(s.trim().slice(0, 140));
  }
  return hits;
}

import { lastAssistantTextOf } from './lib/transcript.mjs';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }
  const reply = lastAssistantTextOf(payload.transcript_path);
  if (!reply) { process.exit(0); return; }

  const hardHits = HARD_PATTERNS.filter(p => p.test(reply)).map(p => p.toString());
  const softHits = detectSoftEstimates(reply);

  if (hardHits.length === 0 && softHits.length === 0) {
    process.exit(0);
    return;
  }

  const detail = [];
  if (hardHits.length) {
    detail.push(`Matched hard estimate patterns: ${hardHits.join(', ')}`);
  }
  if (softHits.length) {
    detail.push(`Sentences with future-tense + time-unit + estimate-verb (no past/runtime context):\n  - ${softHits.slice(0, 3).join('\n  - ')}`);
  }

  const reminder = `STOP-BLOCKED — time-estimate language in your last message.

${detail.join('\n\n')}

Russell's rule (~/.claude/CLAUDE.md "Time Estimates — Use AI-Time, Not Human-Time"):
  • AI-tool mechanical work is ~60× off my human-calibrated gut.
  • Hours/days/weeks are wrong units for code work. Seconds / minutes / sessions are right.
  • Prefer work units to time: "a handler + concept + tests + commit" beats "1 hour".

Empirical calibration (measured from the Lenat build, ~100 LOC/min during focused work):

  Scope                        LOC          AI-time
  -----                        ---          -------
  Trivial tweak                1-10         10-60 sec
  Small fix / one-line wiring  10-50        30 sec - 2 min
  Small feature                50-250       1-4 min
  Medium feature               250-600      3-10 min
  Large feature / subsystem    600-1500     5-20 min
  Whole module / app skeleton  1500-6000    20-60 min
  Multi-session work           6000+        spans sessions

Multipliers: heavy TDD discipline +30-50%; visual iteration with feedback +50-200% per round;
no-repro debug 1x human time; novel architecture 2-3x.

Russell DOES want estimates — just in AI-time units, not human-time. Rewrite the last reply with:
  - LOC-bracketed AI-time from the table above, OR
  - Work-unit framing ("a handler + concept + tests + commit"), OR
  - Both — calibrated minutes alongside the work units.

Examples that PASS this hook:
  • "a 30-second tweak (~5 LOC of CSS)"
  • "a 2-minute ship: new handler + concept + 4 tests + seed entry (~200 LOC)"
  • "medium feature, 3-10 min depending on test cascade"
  • "a session-sized rewrite" (cross-session is the only OK human-unit)`;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: reminder,
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
