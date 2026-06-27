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
//     you failed"), OPEN a debug-gate state file (active, not-yet-instrumented).
//   - PreToolUse(Write|Edit): while the gate is open and instrumentation has NOT yet
//     been added, BLOCK any edit to SOURCE LOGIC that is not itself instrumentation.
//     An edit that ADDS logging clears the gate (you instrumented); a test/doc edit
//     is allowed; an explicit override clears it. Teeth: permissionDecision 'deny'.
//
// Override (escape hatches, both clear the gate for this episode):
//   - `instrumented: <where>`      — you already captured the cause; name where.
//   - `instrument-override: <why>` — instrumentation is genuinely impossible here.
//
// Fails OPEN on any error (a buggy guard must never block all work).
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE_PATH = join(homedir(), '.claude', 'state', 'instrument-gate.json');
const GATE_TTL_MS = 2 * 60 * 60 * 1000; // a debug episode goes stale after 2h — don't nag a new, unrelated task

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
const NOT_LOGIC = /(\.test\.|\.spec\.|\.d\.ts$|\.md$|\.json$|\.css$|\.html$)/i;

/** Does the message carry a debugging-an-in-app-failure signal? Pure. Returns the matched reason or null. */
export function debugSignal(messageText) {
  const haystack = String(messageText || '');
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

/** Pure decision for the PreToolUse path — exported so the test drives every branch without stdin/fs. */
export function decideEdit({ gateActive, instrumented, filePath, editText }) {
  if (!gateActive || instrumented) return { block: false, clears: false };
  if (OVERRIDE.test(String(editText || ''))) return { block: false, clears: true };   // explicitly handled
  if (!isSourceLogicFile(filePath)) return { block: false, clears: false };            // test/doc/etc — fine
  if (isInstrumentationEdit(editText)) return { block: false, clears: true };           // you're instrumenting
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
      writeGate({ active: true, instrumented: false, reason, ts: Date.now() });
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

  const verdict = decideEdit({ gateActive: true, instrumented: false, filePath, editText });
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
