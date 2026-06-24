#!/usr/bin/env node
// name-by-use-override: faithful port of an existing hook; short transcript-helper locals
// (msg/text) are kept to match the upstream source and its companion test verbatim.
//
// ross-perot-guard — Stop hook with TEETH. Enforces a bias to action: lead with a
// decision, don't hand the operator a menu, and don't defer an obvious in-scope fix
// to "next". A reply that lists options without a pick, asks permission, or announces
// the next step instead of doing it is BLOCKED.
//
// Three blocks, checked in order:
//   1. ASKING PERMISSION — "want me to", "should I", "which do you want" with no
//      action taken. Defers a call the agent could make itself.
//   2. DEFERRED / ANNOUNCED FIX (builder mode only — the turn shipped edits) — the
//      reply describes an obvious fix as a "next"/"follow-up" ("I'd fix that next",
//      "doing X next", "next: wire Y") instead of doing it this turn.
//   3. ALTERNATIVES WITHOUT A RECOMMENDATION — lists Option A/B, "either X or Y",
//      "your call", "two approaches" but contains no recommendation verb.
//
// Suppressed when the user explicitly asked for survey/think mode ("just thinking",
// "what do you think", "research mode", "feedback only"). A genuinely irreversible
// action (real money / destructive / hardware) that truly needs the user is allowed
// when stated as such — not phrased as "want me to?".
//
// Override: the token "ross-perot-override: <why>" in the reply. Fail-open on error.

import { readFileSync, existsSync } from 'node:fs';

const ALTERNATIVE_PATTERNS = [
  // "Option A" / "Option B" framing
  /\boption\s+[a-d1-4]\b/i,
  // "either X or Y"
  /\beither\s+\S+.{0,40}\s+or\s+\S+/i,
  // "your call" / "your pick" / "you decide" / "up to you" — explicit abdication.
  /\b(your call|your pick|your choice|you decide|you choose|up to you|leave it to you|whichever you prefer|you pick)\b/i,
  // "Three options" / "Two approaches" / "A few paths" / "two ways forward"
  /\b(two|three|four|a few|several)\s+(option|approach|path|way|route|strateg|choice|step)s?\b/i,
  // offering to quit/wrap instead of taking the obvious next step
  /\bor\s+we\s+(wrap|stop|pause|call\s+it|leave\s+it)\b/i,
  // a menu of choices ending in a "where/which … you want to start?" hand-off
  /\b(where|which one|what)\s+(do|would)\s+you\s+want\s+to\s+(start|begin|do\s+first|tackle|prioriti[sz]e)\b/i,
];

const RECOMMENDATION_PATTERNS = [
  /\bi\s+recommend\b/i,
  /\bi'?d\s+(go|do|pick|choose|recommend|opt|lean)\b/i,
  // "my call: …" is a recommendation. Must NOT match the ABDICATION "your call:" / "your pick:" —
  // require an explicit "my " possessive, or a bare "call:/pick:" not preceded by "your".
  /(?<!your\s)\b(my\s+)?(call|pick|choice|recommendation|vote)\s*[:—-]/i,
  /\bgoing\s+with\s+\S/i,
  /\bdoing\s+\S+\s+unless/i,
  /\b\S+\s+wins\b/i,
  /\bthe\s+right\s+(call|move|answer|pick|choice)\s+is\b/i,
  /\bthe\s+winner\s+is\b/i,
  /\bshipping\s+\S+\s+(unless|now|next)/i,
  /\b\S+\s+is\s+the\s+way\s+to\s+go\b/i,
  /\bdefault\s+to\s+\S/i,
  /\bunless\s+you\s+(say|object|prefer|redirect|push back)/i,
  /\bi'?ll\s+(go|do|pick|choose|ship|use|take)\s+\S/i,
];

// Asking-permission phrases — deferring the call to the user instead of leading. Checked
// INDEPENDENTLY of the alternatives check (a bare "Want me to?" closer has no option list but is
// still the failure). Survey-mode + a genuine high-cost-permission ask are the only legit exits —
// and those should be phrased "I'm doing X unless you object", not "want me to?".
const ASKING_PERMISSION_PATTERNS = [
  /\bwant me to\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\b(do|would) you (want|like) (me )?to\b/i,
  /\bwhat('s| is) the call\b/i,
  // handing the user a "pick one of these" question instead of just doing the obvious one
  /\bwhich\s+(one|do\s+you\s+(want|prefer)|would\s+you\s+(want|prefer|like))\b/i,
  /\bwhich\s+(?:way|approach|path|option|route)\b[^.?!]{0,40}\?/i,
  /\bwhere\s+(do|would)\s+you\s+want\s+to\s+(start|begin)\b/i,
];

// Deferred-fix check — in a turn that ALREADY shipped code edits, the reply DESCRIBES an obvious
// fix but hands it back as a "next"/"follow-up" instead of just doing it. Built from phrase PARTS
// (commitment × fix-verb × deferral) so it catches MANY phrasings, not one fixed sentence.
// Apostrophes may be straight (') or curly (’).
const APOS = `['’]?`;
const COMMIT = `(?:i${APOS}d|i\\s+would|i${APOS}ll|i\\s+will|i\\s+can|i\\s+could|we\\s+(?:should|could|can)|let${APOS}s|going\\s+to|gonna|plan(?:ning)?\\s+to|next\\s+step)`;
const FIX_VERB = `(?:fix|add|exempt|change|update|remove|implement|wire|patch|adjust|refactor|apply|handle|extend|tweak|harden|migrate|rename|delete|guard|cover|clean\\s+up|do\\s+(?:that|this|it))`;
const DEFER = `(?:next|later|after\\s+(?:this|that)|afterwards?|in\\s+a\\s+follow-?up|as\\s+a\\s+follow-?up|down\\s+the\\s+line|soon|eventually|in\\s+a\\s+(?:bit|sec|moment))`;

const DEFERRED_FIX_PATTERNS = [
  // "I'd … fix … next"  (commitment, up to 4 words, a fix-verb, then a deferral within the sentence)
  new RegExp(`\\b${COMMIT}\\s+(?:\\w+\\s+){0,4}?${FIX_VERB}\\b[^.]{0,60}?\\b${DEFER}\\b`, 'i'),
  // "next, I'd fix …"  (deferral first, then the commitment + fix-verb)
  new RegExp(`\\b${DEFER}\\b[^.]{0,15}?\\b${COMMIT}\\s+(?:\\w+\\s+){0,4}?${FIX_VERB}\\b`, 'i'),
  // "the fix I'd make" / "the change I'd make" — inherently a deferral
  new RegExp(`\\bthe\\s+(?:fix|change|cleanup|refactor|tweak)\\s+(?:i${APOS}d|i\\s+would)\\s+make\\b`, 'i'),
  // "leaving that as a follow-up" / "leave it for later"
  /\bleav(?:e|ing)\s+(?:that|this|it|the\s+\w+)\s+(?:as\s+)?(?:a\s+)?(?:follow-?up|for\s+(?:later|next))\b/i,
  // "that fix can wait / come next"
  /\b(?:that|this)\s+(?:fix|change|cleanup|refactor)\s+can\s+(?:come|wait|happen|go|land)\s+(?:next|later|after)\b/i,
];

// ANNOUNCE-NEXT patterns catch the broad CLASS: naming a concrete DEV action as the next/future
// thing instead of doing it. The deferred-fix patterns above require a COMMIT word next to the verb,
// so a bare gerund close like "Doing the wiring next" (no commit word) slips through without these.
const BUILD_VERB = `(?:build|wir|add|implement|writ|creat|fix|updat|refactor|hook\\s+up|finish|continu|start|run|do|tackl|knock\\s+out|patch|handl|ship|land|set\\s+up)(?:e|es|ed|ing)?`;
const ANNOUNCE_NEXT_PATTERNS = [
  // "Doing X next" / "doing the wiring next" — a gerund close with no commit word.
  /\bdoing\b[^.!?]{0,60}?\bnext\b/i,
  // "next: build…", "next up — wire…", "next, I'll add…", "next I'll implement…"
  new RegExp(`\\bnext\\b\\s*(?:up|:|,|—|-)?\\s*(?:i['’]?ll\\s+|i\\s+will\\s+|let['’]?s\\s+)?${BUILD_VERB}\\b`, 'i'),
  // "<build-verb> … next" — "wire the audio next", "run the suite next"
  new RegExp(`\\b${BUILD_VERB}\\b[^.!?]{0,45}?\\bnext\\b`, 'i'),
  // "the next step/thing/move/chunk/piece is …"
  /\bthe\s+next\s+(?:step|thing|move|chunk|piece|bit|task)\b/i,
  // "next session/turn I'll …", "in the next session …"
  new RegExp(`\\bnext\\s+(?:session|turn)\\b[^.!?]{0,40}?(?:i['’]?ll|${BUILD_VERB})`, 'i'),
];

// Legit reasons to defer — if the reply states one of these, deferring is the right call, not a dodge.
const SCOPE_REASON_PATTERNS = [
  /\bout of scope\b/i,
  /\bneeds?\s+(?:your|a)\s+(?:call|decision|sign-?off|permission|approval)\b/i,
  /\barchitecture\s+(?:change|call|decision)\b/i,
  /\b(?:too\s+)?(?:risky|destructive|dangerous|sweeping)\b/i,
  /\bseparate\s+(?:pr|branch|session|change|ticket|repo)\b/i,
  /\brequires?\s+(?:permission|approval|a\s+decision)\b/i,
  /\b(?:bigger|larger|broader)\s+(?:refactor|change|lift|rework)\b/i,
];

const ROSS_PEROT_OVERRIDE = /ross-perot-override:/i;

// Mutating tools that mark a turn as "builder mode" — the deferred-fix check only applies then.
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Did the CURRENT turn (since the last user message) ship any code edits?
function turnShippedEdits(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return false; }
  const entries = content.trim().split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  let turnStart = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user') { turnStart = i; break; }
  }
  for (let i = turnStart; i < entries.length; i++) {
    if (entries[i].type !== 'assistant') continue;
    const blocks = entries[i].message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'tool_use' && MUTATING_TOOLS.has(block.name)) return true;
    }
  }
  return false;
}

// User-explicit survey/think mode: suppress this hook entirely
const USER_PAUSE_PATTERNS = [
  /\bjust\s+(think|thinking|describe|describing|exploring|brainstorm)/i,
  /\b(research|survey|brainstorm|explore)\s+mode\b/i,
  /\b(don'?t|do not)\s+(take|do)\s+action\b/i,
  /\bfeedback\s+only\b/i,
  /\bjust\s+laying\s+out\b/i,
  /\bwhat\s+(do you think|are the options)\b/i,  // user asked for options on purpose
];

function lastAssistantText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
  const lines = content.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.type !== 'assistant') continue;
    const assistantMessage = entry.message;
    if (!assistantMessage || !Array.isArray(assistantMessage.content)) continue;
    const replyText = assistantMessage.content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
    if (replyText) return replyText;
  }
  return '';
}

function lastUserText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
  const lines = content.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.type !== 'user') continue;
    const userMessage = entry.message;
    if (!userMessage) continue;
    if (typeof userMessage.content === 'string') return userMessage.content;
    if (Array.isArray(userMessage.content)) {
      const promptText = userMessage.content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n');
      if (promptText) return promptText;
    }
  }
  return '';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  const replyText = lastAssistantText(payload.transcript_path);
  if (!replyText) { process.exit(0); return; }

  // Suppress on explicit user-pause / survey-mode messages
  const promptText = lastUserText(payload.transcript_path);
  const userInSurveyMode = USER_PAUSE_PATTERNS.some(p => p.test(promptText));
  if (userInSurveyMode) { process.exit(0); return; }

  // Asking-permission check — fires on its own (no option-list required).
  const askingMatches = ASKING_PERMISSION_PATTERNS.filter(p => p.test(replyText)).map(p => p.toString());
  if (askingMatches.length > 0) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `STOP-BLOCKED — asking permission instead of leading (bias to action).

Your last message asked the user for the go-ahead. Matched: ${askingMatches.join(', ')}

The rule: never wait for permission on a call you can make. Determine what the user is trying to
accomplish and just do the most complete version. "Want me to?" / "should I?" hands them a decision
they shouldn't have to make.

Rewrite as a DECISION, then act in the same turn:
  - "Doing X now." / "I'd do X unless you object — going with it."
  - For an obvious next step: just do it, don't ask.
  - Only genuinely-needs-permission case (real money / destructive / hardware): state it as
    "This is the one call I can't make for you: <the specific irreversible thing>." — not "want me to?".`,
    }));
    process.exit(0);
    return;
  }

  // Deferred-fix check — fires only in BUILDER mode (edits shipped this turn). Scans prose only.
  // Escapes: a stated scope reason or the override token.
  const proseOnly = replyText.split(/\*\*Files touched:\*\*/i)[0];
  if (turnShippedEdits(payload.transcript_path)
      && !ROSS_PEROT_OVERRIDE.test(replyText)
      && !SCOPE_REASON_PATTERNS.some(p => p.test(proseOnly))) {
    const deferralMatches = DEFERRED_FIX_PATTERNS.filter(p => p.test(proseOnly)).map(p => p.toString());
    if (deferralMatches.length > 0) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `STOP-BLOCKED — you DEFERRED an obvious fix instead of doing it (bias to action).

This turn already shipped code edits, and your reply hands back a fix to "do next" rather than doing it now. Matched: ${deferralMatches.join(', ')}

The rule: if a fix is obvious, in-scope, and you're already in the code — DO IT THIS TURN. Handing the user a follow-up to approve is a decision tax.

Do it now, or justify the deferral honestly:
  - Just make the fix and re-run the tests in THIS turn (the default).
  - If it's genuinely out of scope / risky / large / needs a decision, SAY that reason in the reply ("out of scope", "needs your call", "bigger refactor").
  - Real override: write "ross-perot-override: <why deferring is the correct call>".`,
      }));
      process.exit(0);
      return;
    }
  }

  // ANNOUNCE-NEXT check — block when the reply NAMES a concrete next dev action instead of doing it
  // ("Doing X next", "next: wire Y", "the next step is Z"), UNLESS a real scope/blocked reason is
  // stated or the override is set. Prose only (a debt footer may list real follow-ups).
  const announceProse = replyText.split(/\*\*Files touched:\*\*/i)[0];
  if (turnShippedEdits(payload.transcript_path)
      && !ROSS_PEROT_OVERRIDE.test(replyText)
      && !SCOPE_REASON_PATTERNS.some(p => p.test(announceProse))) {
    const announceMatches = ANNOUNCE_NEXT_PATTERNS.filter(p => p.test(announceProse)).map(p => p.toString());
    if (announceMatches.length > 0) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `STOP-BLOCKED — you ANNOUNCED the next step instead of DOING it (bias to action).

Your reply names a concrete next action and ends the turn. Matched: ${announceMatches.join(', ')}

Announcing "Doing X next" / "next: wire Y" is the SAME violation as asking permission — it defers a
doable action to a future turn. If you can name it and it's in scope and unblocked, DO IT THIS TURN.

Either do it now (the default — keep working in this turn), or justify honestly:
  - It genuinely needs the user (hardware / a decision / money / destructive) → state that reason explicitly.
  - It's genuinely out of scope / a separate change → say "out of scope" / "separate PR".
  - Real override: write "ross-perot-override: <why this can't be done now>".`,
      }));
      process.exit(0);
      return;
    }
  }

  const alternativeMatches = ALTERNATIVE_PATTERNS.filter(p => p.test(replyText)).map(p => p.toString());
  if (alternativeMatches.length === 0) { process.exit(0); return; }

  const hasRecommendation = RECOMMENDATION_PATTERNS.some(p => p.test(replyText));
  if (hasRecommendation) { process.exit(0); return; }

  // Block — alternatives present, no recommendation
  const reminder = `STOP-BLOCKED — alternatives listed without a recommendation.

Your last message:
  - Listed multiple options (matched: ${alternativeMatches.join(', ')})
  - Did not contain a recommendation verb (no "I recommend", "I'd go with", "going with X", "doing X unless", "shipping X unless", "the right call is", etc.)

The rule "strong opinion + minimize cognitive load":
  - Present alternatives so the user can OVERRIDE, not so they can PICK.
  - Always tell them which option is right and WHY.
  - The cost of asking "want me to do A or B?" with no opinion is a decision tax on the user per choice.

Rewrite shapes that PASS this hook:
  - "Options: A / B / C. Going with B because [reason]. Override by saying X."
  - "Three paths. I recommend the middle one — A and C have these costs."
  - "I'd default to B unless you object, because [reason]."

The user explicitly opting OUT of recommendations (suppression triggers):
  - "just thinking", "research mode", "don't take action", "feedback only", "what do you think"
  - If the user said any of those, this hook stays quiet.`;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: reminder,
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
