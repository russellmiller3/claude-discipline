#!/usr/bin/env node
// =============================================================================
// instrument-before-debug — when you're DEBUGGING an in-app/unobservable failure,
//   you may NOT edit logic until you've INSTRUMENTED the failing path to capture
//   the cause. Forces "measure first," blocks "guess first."
// =============================================================================
//
// Russell's rule (2026-06-27, after I burned ~6 reload rounds shipping blind fixes
// to a tier-escalation bug whose debug log never recorded WHY it escalated): "build
// a hook that forces you to make sure debugging is properly instrumented before you
// try to debug. if it catches you debugging it asks if you've set up instrumentation
// and if you answer no it forces you to. and then flay yourself for your fuckup."
//
// DUAL-EVENT, GLOBAL (all projects):
//   - UserPromptSubmit: if the user's message shows a debugging-an-in-app-failure
//     signal (a pasted debug artifact, "still broken / doesn't work / still routes /
//     you failed"), OPEN a debug-gate state file (active, not-yet-instrumented), along
//     with the human-turn count so far and any file paths/basenames named in the message.
//   - PreToolUse(Write|Edit): while the gate is open, NOT stale, and instrumentation has
//     NOT yet been added, BLOCK an edit to SOURCE LOGIC that is not itself instrumentation
//     AND targets a file plausibly involved in the reported failure. An edit that ADDS
//     logging clears the gate (you instrumented); a test/doc edit is allowed; an explicit
//     override clears it. Teeth: permissionDecision 'deny'.
//
// SIGNAL DECAY (2026-07-03, after a live false positive: Russell's "hook enforced why is
// hook not working" — a conversation about reply-narration prefs, resolved in two turns by
// widening a DIFFERENT hook — left this gate armed HOURS later and blocked ordinary feature
// edits to an unrelated training harness. The orchestrator had to sentinel-comment override
// tokens into production code to get past it, exactly the pollution the escape hatch
// shouldn't force.). A debug episode is stale — gate treated as inactive — once ANY of:
//   (a) TURN decay: STALE_TURN_COUNT human turns have passed since the gate opened. A real
//       debugging episode gets addressed within a couple of turns; if the conversation has
//       moved on that far without instrumentation, the signal is almost certainly cold.
//   (b) TARGET decay: the gate recorded file paths/basenames mentioned in the triggering
//       message, and the CURRENT edit's file matches none of them (by basename) — the
//       failure being debugged plausibly lives elsewhere. When the message named no files
//       at all, this decay does not apply (nothing to scope to) and TURN/TTL decay carry it.
//   (c) TTL decay: GATE_TTL_MS wall-clock time has passed (unchanged, coarse backstop).
//
// Override (escape hatches, both clear the gate for this episode):
//   - `instrumented: <where>`      — you already captured the cause; name where.
//   - `instrument-override: <why>` — instrumentation is genuinely impossible here.
//
// Fails OPEN on any error (a buggy guard must never block all work).
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, isHumanPrompt } from './lib/transcript.mjs';

const GATE_PATH = join(homedir(), '.claude', 'state', 'instrument-gate.json');
const GATE_TTL_MS = 2 * 60 * 60 * 1000; // a debug episode goes stale after 2h — don't nag a new, unrelated task
const STALE_TURN_COUNT = 3; // this many human turns with no instrumentation/override → treat the episode as cold

// A debugging-an-in-app-failure signal in the user's message. TIGHT on purpose (the word "fail" alone is
// everywhere) — match a pasted debug artifact OR an explicit complaint that the running app misbehaved.
const DEBUG_SIGNAL = [
  /\b(skaffen|jarvis)?-?debug-session\b/i,          // a pasted debug dump
  /"kind"\s*:\s*"[\w-]*debug/i,                       // ...same, by its kind field
  /"tier"\s*:\s*"(reserve|pilot|stepup)"/i,           // a routing/tier field pasted in
  /\b(still|again)\b[^.\n]{0,40}\b(broken|fail|wrong|calls?|routes?|routed|navigat|search|messed)/i,
  /\b(did\s?n'?t|does\s?n'?t|do\s?n'?t|not)\s+work(ing)?\b/i,
  /\byou\s+(failed|fucked|messed|broke)\b/i,
  /\b(routing|routes?|routed)\s+to\b/i,                // "routed to sonnet" / "keeps routing to the wrong tier"
  /\bwrong\s+(tier|model|route|branch|one|thing)\b/i,
  /\bstill\s+(calls?|routes?|searches|fails?|broken|messed)/i,
];

// An edit that ADDS instrumentation (logging that captures the cause) — these CLEAR the gate.
const INSTRUMENTATION = [
  /console\.(log|debug|error|warn|info)\s*\(/,
  /appendFileSync\s*\(/,                              // writing to a log/JSONL
  /\b(debugLog|onDebug|emitPulse|pulse|logger|addLog|recordEvent|trace)\b/i,
  /\.push\(\s*\{[^}]*\b(message|tier|error|stage|step|reason)\b/i, // pushing a structured log line
  /\b(log|logTier|logEscalation|logDebug)\s*\(/,
];

const OVERRIDE = /\b(instrumented|instrument-override)\s*:/i;

const SOURCE_LOGIC = /\.(js|mjs|cjs|jsx|ts|tsx|svelte|py|go|rs|rb|java)$/i;
// A test file is not source logic. Covers JS/TS `.test.`/`.spec.`, pytest `test_*.py` (prefix, not a
// `.test.` infix), and Go `*_test.go` — writing/editing a test in a red phase must never trip the gate.
const NOT_LOGIC = /(\.test\.|\.spec\.|\.d\.ts$|\.md$|\.json$|\.css$|\.html$|(?:^|[\\/])test_[^\\/]*\.py$|_test\.(?:py|go)$)/i;

// A red→green (test-driven) cycle is NOT in-app debugging: a freshly-written FAILING test is the
// designed RED state the next edit turns green, not a running-app failure to instrument. Anchor on
// test-driven NARRATION or TEST-RUNNER output — never on a bare error token (an ImportError can appear
// in a real runtime trace that MUST still open the gate). (2026-07-16)
const RED_GREEN_MARKERS = [
  /\bexpect(?:ing)?\s+(?:a\s+)?red\b/i,
  /\bred[\s-]*(?:→|->|to)[\s-]*green\b/i,
  /\bred\s+(?:state|phase)\b/i,
  /\bfailing\s+test\s+first\b/i,
  /\bTDD\b/,
  /\bcollected\s+\d+\s+items?\b/i,   // pytest session header
];

// A path-or-basename-looking token in the triggering message, e.g. "chatRouter.js" or
// "extension/lib/chatRouter.js" or "the tierRouter module". Loose on purpose — this only
// narrows a BLOCK to plausible targets, it never widens one; a miss just falls back to
// "no files named" (unscoped, existing behavior), never a false allow on a real episode.
const FILE_MENTION = /[\w.-]+\.(?:js|mjs|cjs|jsx|ts|tsx|svelte|py|go|rs|rb|java)\b/gi;

/** Basenames of files named in the debug-signal message, lowercased, deduped. Pure. */
export function mentionedFileBasenames(messageText) {
  const haystack = String(messageText || '');
  const matches = haystack.match(FILE_MENTION) || [];
  const basenames = matches.map((m) => m.replace(/\\/g, '/').split('/').pop().toLowerCase());
  return [...new Set(basenames)];
}

/** Basename of a file path, lowercased. Pure. */
function basenameOf(filePath) {
  return String(filePath || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

/**
 * Is this edit's file plausibly part of the failure being debugged? Pure.
 * No files named in the original signal → can't scope by target, so everything is "in scope"
 * (existing behavior; turn/TTL decay still apply). Files WERE named → only a basename match
 * (or the file itself being one of the named ones) counts as in scope.
 */
export function isTargetInScope(filePath, mentionedBasenames) {
  if (!mentionedBasenames || mentionedBasenames.length === 0) return true;
  return mentionedBasenames.includes(basenameOf(filePath));
}

/**
 * Has the debug signal gone cold by TURN count? Pure. Counts human prompts strictly AFTER
 * the gate-opening prompt; STALE_TURN_COUNT or more such turns with no resolution means the
 * conversation has moved on and this is very unlikely to still be the live failure.
 */
export function isTurnStale(turnsSinceOpen) {
  return typeof turnsSinceOpen === 'number' && turnsSinceOpen >= STALE_TURN_COUNT;
}

/**
 * Count human-prompt turns in a transcript that occur AFTER the gate was opened (i.e. after
 * the human prompt that carried the debug signal). Pure over a plain entries array so tests
 * don't need real transcript files. `entries` is the full session transcript; `openedAtIndex`
 * is the index of the human-prompt entry that opened the gate (-1/unknown → 0, conservative).
 */
export function humanTurnsSince(entries, openedAtIndex) {
  const start = typeof openedAtIndex === 'number' && openedAtIndex >= 0 ? openedAtIndex + 1 : 0;
  let count = 0;
  for (let i = start; i < entries.length; i++) {
    if (isHumanPrompt(entries[i])) count++;
  }
  return count;
}

/** Index of the LAST human-prompt entry in a transcript (the one presumed to carry the debug signal). Pure. */
export function lastHumanPromptIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isHumanPrompt(entries[i])) return i;
  }
  return -1;
}

/** Is the message a red→green (test-driven) cycle rather than in-app debugging? Pure. Exported as
 *  isTddContext for the test suite's naming; anchored on narration/test-runner output, not error tokens. */
export function isRedGreenCycle(messageText) {
  const haystack = String(messageText || '');
  return RED_GREEN_MARKERS.some((pattern) => pattern.test(haystack));
}
export { isRedGreenCycle as isTddContext };

/** Does the message carry a debugging-an-in-app-failure signal? Pure. Returns the matched reason or null. */
export function debugSignal(messageText) {
  const haystack = String(messageText || '');
  // A red→green cycle (a freshly-written failing test) is not an in-app failure — never open the gate.
  if (isRedGreenCycle(haystack)) return null;
  for (const pattern of DEBUG_SIGNAL) {
    const match = haystack.match(pattern);
    if (match) return match[0].slice(0, 60);
  }
  return null;
}

/** Is this edit ADDING instrumentation (logging) rather than changing logic? Pure. */
export function isInstrumentationEdit(editText) {
  const haystack = String(editText || '');
  return INSTRUMENTATION.some((pattern) => pattern.test(haystack));
}

/** Is this a source-logic file (the kind a "fix" lands in), not a test/doc/config? Pure. */
export function isSourceLogicFile(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!SOURCE_LOGIC.test(normalized)) return false;
  if (NOT_LOGIC.test(normalized)) return false;
  if (/[\\/]hooks[\\/]/i.test(normalized)) return false; // editing the hooks themselves is not app-debugging
  return true;
}

/**
 * Pure decision for the PreToolUse path — exported so the test drives every branch without stdin/fs.
 * `turnsSinceOpen` / `mentionedBasenames` are optional: omitted (undefined) means "unknown, don't decay
 * on that axis" so callers that don't track them (or old gate files written before this fix) keep the
 * prior behavior instead of silently disarming.
 */
export function decideEdit({ gateActive, instrumented, filePath, editText, turnsSinceOpen, mentionedBasenames, fileExists }) {
  if (!gateActive || instrumented) return { block: false, clears: false };
  if (isTurnStale(turnsSinceOpen)) return { block: false, clears: false };             // signal went cold — let it lapse
  if (OVERRIDE.test(String(editText || ''))) return { block: false, clears: true };   // explicitly handled
  if (fileExists === false) return { block: false, clears: false };                    // brand-new file — no failing path to instrument
  if (!isSourceLogicFile(filePath)) return { block: false, clears: false };            // test/doc/etc — fine
  if (isInstrumentationEdit(editText)) return { block: false, clears: true };           // you're instrumenting
  if (!isTargetInScope(filePath, mentionedBasenames)) return { block: false, clears: false }; // unrelated file — fine
  return { block: true, clears: false };                                                // a blind logic fix — STOP
}

function readGate() {
  try {
    const gate = JSON.parse(readFileSync(GATE_PATH, 'utf8'));
    if (!gate || typeof gate !== 'object') return null;
    if (typeof gate.ts === 'number' && Date.now() - gate.ts > GATE_TTL_MS) return null; // stale episode
    return gate;
  } catch { return null; }
}

function writeGate(gate) {
  try {
    mkdirSync(dirname(GATE_PATH), { recursive: true });
    writeFileSync(GATE_PATH, JSON.stringify(gate));
  } catch { /* state is best-effort; never block on a write failure */ }
}

function denial(reason) {
  return `INSTRUMENT-FIRST GATE — you are debugging an in-app failure and about to edit LOGIC, not add instrumentation.

Debug signal that opened this gate: "${reason}"

Did you set up logging on the FAILING PATH to capture the CAUSE? If the honest answer is no, the answer is no —
do that FIRST. Add a log line where the behavior diverges (the router/tier, the branch, the handler), get ONE
real post-reload/debug artifact that shows WHY, THEN fix the proven cause.

FLAY THYSELF: last time you skipped this you treated a plain "tier: reserve" signal as a known instead of
measuring it — and shipped a whole feature + two blind fixes across ~6 of Russell's reload rounds and a session
of his fury, when ONE logging line would have shown the cause on round one. A node probe / e2e that can't
reproduce the in-app symptom is not a diagnosis. Do not do that to him again.

To proceed:
  - Add the instrumentation now (a console.log / debug-log push on the failing path) — that edit is allowed and
    clears this gate; or
  - if you HAVE already captured the cause, put  instrumented: <where you logged + what it showed>  in this edit; or
  - if instrumentation is genuinely impossible here, put  instrument-override: <why>  in this edit.`;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); return; }

  const eventName = event.hook_event_name || event.hookEventName || '';

  // --- UserPromptSubmit: open the gate when the user reports an in-app failure ---
  if (eventName === 'UserPromptSubmit') {
    const reason = debugSignal(event.prompt);
    if (reason) {
      const entries = readTranscript(event.transcript_path);
      // The prompt that just fired hasn't been appended to the transcript file yet on most
      // setups, so "the last human prompt currently on disk" is the one BEFORE this one; turn
      // decay counts forward from here. If it's already on disk (order varies by harness), that's
      // fine too — worst case decay starts one turn early, which only makes the gate MORE eager
      // to lapse, never less (never a missed true-positive).
      const openedAtIndex = lastHumanPromptIndex(entries);
      const mentionedBasenames = mentionedFileBasenames(event.prompt);
      writeGate({ active: true, instrumented: false, reason, ts: Date.now(), openedAtIndex, mentionedBasenames });
      // A nudge the model sees this turn (the gate's teeth land on the next edit).
      process.stdout.write(`Debug mode detected ("${reason}"). INSTRUMENT the failing path FIRST — add logging that captures WHY it misbehaves, get a real debug artifact, THEN edit logic. Blind fixes are blocked until you do.`);
    }
    process.exit(0);
    return;
  }

  // --- PreToolUse(Write|Edit): block blind logic fixes while the gate is open ---
  if (eventName !== 'PreToolUse') { process.exit(0); return; }
  if (event.tool_name !== 'Write' && event.tool_name !== 'Edit') { process.exit(0); return; }

  const gate = readGate();
  if (!gate || !gate.active || gate.instrumented) { process.exit(0); return; }

  const input = event.tool_input || {};
  const filePath = input.file_path || input.path || '';
  const editText = input.content ?? input.new_string ?? '';

  const entries = readTranscript(event.transcript_path);
  const turnsSinceOpen = humanTurnsSince(entries, gate.openedAtIndex);
  // A file that doesn't exist yet has no failing path to instrument — creating it is never a blind fix.
  const fileExists = (() => { try { return existsSync(filePath); } catch { return true; } })();

  const verdict = decideEdit({
    gateActive: true,
    instrumented: false,
    filePath,
    editText,
    turnsSinceOpen,
    mentionedBasenames: gate.mentionedBasenames,
    fileExists,
  });
  if (verdict.clears) { writeGate({ ...gate, instrumented: true }); process.exit(0); return; } // instrumented/overridden
  if (!verdict.block) { process.exit(0); return; }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial(gate.reason || 'in-app failure'),
    },
  }));
  process.exit(0);
}

// Entry-point guard so importing this for tests does not execute main() (which reads stdin and hangs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
