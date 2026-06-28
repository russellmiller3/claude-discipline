#!/usr/bin/env node
// Stop hook — "the self-echo / realtime acoustic voice loop is NOT 'fixed' on unit-green."
//
// Russell reported the Jarvis self-echo bug (the realtime voice model hears its own TTS, transcribes
// it, and fires a fake user turn) as "still broken" MULTIPLE times after I declared it fixed. A
// learnings entry was written and STILL failed to stop the next "it's fixed" claim. J. Paul Getty rule:
// a repeated mistake must become an ENFORCED gate, not another learning.
//
// The core truth: an ACOUSTIC feedback loop is an audio-setup-dependent bug. Passing unit tests proves
// NOTHING about it — the only valid proof is a LIVE check on Russell's actual Chrome with his mic/
// speakers. So a turn may NEVER claim the echo loop is fixed/resolved/gone unless it ALSO flags the
// claim as needing (or having had) a live verification on Russell's machine.
//
// Blocks Stop when the last assistant message says the echo/acoustic/voice loop is fixed/solved/gone
// AND does NOT carry a live-verify acknowledgment (or the explicit override token). Conservative:
// only fires when a SUCCESS verb sits near an ECHO subject, so ordinary mentions ("echo is the GO
// item", "I'll work on the echo next") never trip it.
//
// Escape hatches:
//   • say it needs / hasn't had live verification ("LIVE-VERIFY", "needs live verify on your Chrome",
//     "not live-verified", "can't prove acoustic loops headless", "unit-green only", …), OR
//   • include the literal token  echo-live-verify-override: <reason>

import { readFileSync, existsSync } from 'node:fs';

// ECHO subject × FIXED verb, combined in BOTH orders with a bounded proximity window so paraphrases
// still trip it (authoring rule: match a CLASS of phrasings, not one sentence).
const ECHO_SUBJECT = String.raw`(self[-\s]?echo|echo[-\s]?(loop|issue|bug|problem)|acoustic[-\s]?(loop|echo|feedback)|voice[-\s]?(loop|feedback)|feedback[-\s]?loop|hear(s|ing|d)?[-\s]?(its|it)[-\s]?self|the\s+echo)`;
const FIXED_VERB = String.raw`(fixed|resolved|solved|squashed|eliminated|killed|gone|done|addressed|patched|handled|sorted|taken[-\s]care[-\s]of|no[-\s]longer\s+(loops?|echoes|happens|fires)|is\s+working\s+now|works\s+now|stopped\s+(looping|echoing))`;

const ECHO_FIXED_PATTERNS = [
  new RegExp(`${ECHO_SUBJECT}[^.\\n]{0,55}\\b${FIXED_VERB}\\b`, 'i'),
  new RegExp(`\\b${FIXED_VERB}\\b[^.\\n]{0,55}${ECHO_SUBJECT}`, 'i'),
];

// Any of these present = the claim is honestly hedged as needing/having a LIVE check → allowed.
const LIVE_VERIFY_PATTERNS = [
  /live[-\s]?verif/i,
  /\bneeds?\s+(a\s+)?live\b/i,
  /verify\s+(it|this)?\s*(live|on\s+(your|his|russell'?s)?\s*chrome)/i,
  /on\s+(your|his|russell'?s)\s+(real\s+)?chrome/i,
  /not\s+(yet\s+)?(live[-\s]?)?verified/i,
  /haven'?t\s+(been\s+)?(live[-\s]?)?(verif|confirm|test)/i,
  /can'?t\s+(verify|confirm|prove|test)[^.\n]{0,40}(live|acoustic|chrome|asleep|headless|mic|speaker)/i,
  /unit[-\s]?(green|tests?|only)[^.\n]{0,25}(only|not\s+(live|proof|enough))/i,
  /(flag|flagged|flagging)[^.\n]{0,20}live/i,
  /\bLIVE[-\s]?VERIFY\b/,
];

const OVERRIDE = /echo-live-verify-override:\s*\S+/i;

import { lastAssistantTextOf } from './lib/transcript.mjs';

export function evaluateEchoClaim(assistantText) {
  if (!assistantText) return { violation: false };
  const claimsFixed = ECHO_FIXED_PATTERNS.some((re) => re.test(assistantText));
  if (!claimsFixed) return { violation: false };
  if (OVERRIDE.test(assistantText)) return { violation: false };
  if (LIVE_VERIFY_PATTERNS.some((re) => re.test(assistantText))) return { violation: false };
  return { violation: true };
}

function main() {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { payload = {}; }
  const assistantText = lastAssistantTextOf(payload.transcript_path);

  const { violation } = evaluateEchoClaim(assistantText);
  if (!violation) { process.exit(0); return; }

  const reason = [
    'STOP-BLOCKED — the self-echo / realtime acoustic voice loop is NOT "fixed" on unit-green.',
    '',
    'Your message claims the echo / acoustic / voice feedback loop is fixed/solved/gone, but does NOT',
    'flag it as live-verified (or needing live verification). Russell reported this bug "still broken"',
    'MULTIPLE times after I declared it fixed. It is an ACOUSTIC loop — it depends on his mic/speakers,',
    'so passing tests proves NOTHING. The ONLY valid proof is a LIVE check on Russell\'s actual Chrome.',
    '',
    'To proceed, do ONE of:',
    '  • State the structural fix is built but UNVERIFIED: "needs LIVE-VERIFY on your Chrome" /',
    '    "not live-verified" / "unit-green only, can\'t prove an acoustic loop headless".',
    '  • If Russell just confirmed it live this session, say so explicitly (live-verified).',
    '  • If this is a genuine false positive, add:  echo-live-verify-override: <reason>',
    '',
    'Never imply the echo loop is resolved on unit tests alone.',
  ].join('\n');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

// Only run main() when invoked directly (not when imported by the test).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main();
}

export { main };
