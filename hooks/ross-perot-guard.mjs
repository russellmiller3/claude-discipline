#!/usr/bin/env node
// Stop hook — enforce Russell's Ross Perot Rule: LEAD, don't ask; do the obvious next thing instead of
// handing it back. The OLD design was a growing museum of asking-permission PHRASES ("want me to",
// "should i", "which next", "your call", "say the word", …) — a lexical net that ALWAYS leaks, so every
// miss spawned another pattern (the whack-a-mole Russell called out 2026-06-26). This version enforces the
// OUTCOME structurally instead of chasing wording:
//
//   SOLICITS-INPUT (the big one) — block when the final message SOLICITS Russell's input. Two structural
//     forms, no phrase zoo: (a) the prose ENDS WITH A QUESTION MARK — catches every "…?" closer, present
//     and future ("want me to fix that next?", "proceed?", "good to merge?", "cool, wire it in?"); or
//     (b) it ends on a SMALL, stable set of no-"?" hand-off closers ("say the word", "your move", "up to
//     you", "let me know", "ball's in your court"). A genuine question goes through the AskUserQuestion
//     TOOL (a tool call, not a prose "?"), so it continues the turn and never reaches a Stop with a "?".
//
//   The other checks stay — they catch a DIFFERENT class (announcing/deferring a doable ACTION, or listing
//   options with no recommendation): ALTERNATIVES-without-recommendation, ANNOUNCE-NEXT / DEFERRED-FIX
//   (builder mode), LIST-AND-DEFER, and QUEUE-AWARE keep-executing.
//
// Escapes (all checks): survey/think mode (user opted out), the ross-perot-override: token, and — for the
// action-deferral checks — a stated scope/blocker reason. Code spans/fences are stripped first so QUOTING a
// trigger (or this hook's own examples) never false-fires.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALTERNATIVE_PATTERNS = [
  // "Option A" / "Option B" framing
  /\boption\s+[a-d1-4]\b/i,
  // "either X or Y" — ONLY when framed as a CHOICE OFFERED to Russell, not outcome narration.
  // (2026-07-04 FP: "the clone run will either catch it red-handed or eliminate it." — two possible
  // RESULTS of an experiment, nobody was handed a pick — blocked because the old matcher fired on ANY
  // bare either..or.) A choice-OFFER carries a frame the narration lacks; require one of:
  //   (a) a you/we choice verb right before the either — "you could either A or B", "we can either…";
  /\b(?:you|we)(?:['’]d|\s+(?:could|can|should|might|may|want(?:\s+to)?|prefer(?:\s+to)?|need\s+to|get\s+to))\b[^.!?]{0,40}?\beither\s+\S+[^.!?]{0,40}\bor\s+\S+/i,
  //   (b) an imperative pick/choose — "pick either the fix or the rewrite";
  /\b(?:pick|choose)\s+(?:between\s+)?either\b/i,
  //   (c) an explicit choice NOUN — "either option/approach/path works";
  /\beither\s+(?:option|choice|approach|path|way|route|direction|one)s?\b/i,
  //   (d) the either..or inside a question (same-sentence "?").
  /\beither\s+\S+[^.!?]{0,40}\bor\s+[^.!?]{0,40}\?/i,
  // "your call" / "your pick" / "you decide" / "up to you" — explicit abdication.
  // "your pick"/"your choice" added 2026-06-23: Russell got "Two ways forward, your pick: ...".
  /\b(your call|your pick|your choice|you decide|you choose|up to you|leave it to you|whichever you prefer|you pick)\b/i,
  // "Three options" / "Two approaches" / "A few paths" / "two ways forward"
  /\b(two|three|four|a few|several)\s+(option|approach|path|way|route|strateg|choice|step)s?\b/i,
  // 2026-06-23: offering to quit/wrap instead of taking the obvious next step — "..., or we wrap
  // here", "or we stop here", "or we wrap and finish next session". Hands Russell the call to quit.
  /\bor\s+we\s+(wrap|stop|pause|call\s+it|leave\s+it)\b/i,
  // 2026-06-23: a menu of choices ending in a "where/which … you want to start?" hand-off.
  /\b(where|which one|what)\s+(do|would)\s+you\s+want\s+to\s+(start|begin|do\s+first|tackle|prioriti[sz]e)\b/i,
];

const RECOMMENDATION_PATTERNS = [
  /\bi\s+recommend\b/i,
  /\bi'?d\s+(go|do|pick|choose|recommend|opt|lean)\b/i,
  // "my call: …" is a recommendation. Must NOT match the ABDICATION "your call:" / "your pick:" —
  // 2026-06-23: that false match was silently treating Russell's hand-offs as recommendations. Require
  // an explicit "my " possessive, or a bare "call:/pick:" not preceded by "your".
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

// SOLICITS-INPUT — the Ross Perot violation: ending a turn by handing Russell the next decision instead
// of leading. Detected STRUCTURALLY (see solicitsInput below), not by a phrase museum. The dominant signal
// is a trailing "?" — every asking-permission closer ("want me to?", "proceed?", "which next?") ends that
// way, present and future. The ONLY solicitations that DON'T end in "?" are these few hand-off closers, so
// they're the entire residual list (matched only near the END of the message, so a mid-reply mention is
// fine). A genuine question belongs in the AskUserQuestion TOOL, not a prose "?".
const HANDOFF_CLOSERS = [
  /\bsay the word\b/i,
  /\blet me know\b/i,
  /\byour (call|move|pick|choice|shout)\b/i,
  /\bup to you\b/i,
  /\byou (decide|choose)\b/i,
  /\bwhichever you (prefer|want|like)\b/i,
  /\bleave it to you\b/i,
  /\b(?:the )?ball['’]?s?(?:\s+is)?\s+in your court\b/i,
  /\btell me (which|what|how|when|whether)\b/i,
  /\b(which|what)['’]?s?\s+next\b/i,
];

// Deferred-fix check — the Ross Perot violation Russell flagged 2026-06-16: in a turn that ALREADY
// shipped code edits, the reply DESCRIBES an obvious fix but hands it back as a "next"/"follow-up"
// instead of just doing it. Built from phrase PARTS (commitment × fix-verb × deferral) so it catches
// MANY phrasings, not one fixed sentence. Apostrophes may be straight (') or curly (’).
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

// 2026-06-23 (Russell: "stop the whack-a-mole — I don't want to keep guessing every variant"). The
// deferred-fix patterns above require a COMMIT word ("I'd"/"I'll"/"going to") next to the verb — so a bare
// gerund close like "Doing the native-audio wiring next" slipped through (no commit word). These ANNOUNCE-NEXT
// patterns catch the broad CLASS: naming a concrete DEV action as the next/future thing instead of doing it.
// Verb set is gerund-tolerant on purpose (wire/wiring, build/building). Fires regardless of builder-mode (a
// status turn that ends "next I'll build X" is the same violation), but the scope-reason + override carve-outs
// below still apply, so a genuinely-blocked next step ("needs your call", hardware) is allowed.
const BUILD_VERB = `(?:build|wir|add|implement|writ|creat|fix|updat|refactor|hook\\s+up|finish|continu|start|run|do|tackl|knock\\s+out|patch|handl|ship|land|set\\s+up)(?:e|es|ed|ing)?`;
const ANNOUNCE_NEXT_PATTERNS = [
  // "Doing X next" / "doing the wiring next" — the exact crack that slipped (gerund, no commit word).
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

// 2026-06-25: LIST-AND-DEFER — the Ross Perot miss Russell flagged ("do all of them in parallel. why did you
// not immediately go onto them?"). The reply ENUMERATES ≥2 divergences/gaps, then DISMISSES them ("intentional
// teaching simplification", "cosmetic", "not a break", "leaving as-is") instead of fixing them this turn. A
// confident dismissal is a deferral the question-phrase matchers above can't see. Block unless a scope reason
// or the override says the listed items are genuinely correct to leave.
const DIVERGENCE_TERM = /\b(diverg\w*|differ\w*|mismatch\w*|doesn'?t match|don'?t match|not shown|omit\w*|inconsisten\w*|out of sync|stale|drift\w*|vs\.?|versus)\b/i;
const DISMISSAL_PATTERNS = [
  /\bteaching simplification/i,
  /\bsimplification(?:s)?\b/i,
  /\b(?:deliberate|intentional|on purpose)\b/i,
  /\bcosmetic\b/i,
  /\bnot\s+(?:a\s+|really\s+a\s+)?(?:break|bug|problem|issue)\b/i,
  /\b(?:labeling|labelling|naming)\s+(?:nuance|difference|drift)\b/i,
  /\bnuance,?\s+not\b/i,
  /\bleav(?:e|ing)\s+(?:it|that|them|these|the\s+\w+)\s+(?:as-?is|alone|for now)\b/i,
  /\b(?:acceptable|fine|ok|okay)\s+(?:for now|as-?is|to leave|as teaching)\b/i,
  /\bnot worth\s+(?:churning|fixing|the churn|it)\b/i,
];
// >=2 markdown list items (bulleted or numbered, at line start) = an enumeration.
function looksEnumerated(messageText) {
  return (messageText.match(/^\s*(?:[-*]|\d+[.)])\s+\S/gm) || []).length >= 2;
}

// Strip inline-code spans and fenced code blocks so QUOTING a trigger phrase (e.g. explaining this very hook
// with `want me to` in backticks) doesn't false-fire the phrase matchers. (2026-06-25 — meta-discussion of the
// hook's own example phrases was blocking legit turns.)
function stripCodeSpans(messageText) {
  return messageText.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

// Does this prose END on a question? Strip trailing markdown wrappers / quotes / brackets / whitespace
// (so "…want?**", "…proceed?)", '…merge?"' all count) then test for a final "?". This one structural
// check replaces the whole asking-permission phrase list — any "…?" closer, present or future, is caught.
function endsWithQuestion(prose) {
  const trimmed = String(prose || '').replace(/[\s*_>"'`)\]]+$/g, '');
  return /\?$/.test(trimmed);
}

// SOLICITS-INPUT: the message ends by handing Russell the next decision. Either it ends with a question,
// or its tail (last ~200 chars, where a closer lives) matches one of the few no-"?" hand-off closers.
// Returns a short reason string when it solicits, else null. Language-agnostic by construction.
function solicitsInput(prose) {
  if (endsWithQuestion(prose)) return 'your last message ends with a question to Russell';
  const tail = String(prose || '').slice(-200);
  const closer = HANDOFF_CLOSERS.find((re) => re.test(tail));
  return closer ? `your last message hands Russell the next move (matched ${closer})` : null;
}

// 2026-06-25 (Russell): HANDOFF.md IS the priority queue — keep executing it, don't stop to ask "what next".
// Only an explicit stop from Russell (or, for a genuinely blocked queue, the override token) ends the run.
// 2026-07-12: RELEASE signals TIGHTENED (the third leak of the overnight failure): bare "call it" matched
// ANY "call it …" sentence (the day/night group was optional), and bare "handoff" matched Russell saying
// "update the handoff and keep going" — both falsely released the queue gate. Releases must be NARROW;
// the catching side (wind-down closers below) is where broad belongs.
const STOP_SIGNAL_PATTERNS = [
  /\bstop\b/i, /\bhalt\b/i, /\bpause\b/i, /\bhold (on|up)\b/i,
  /\bwrap (it |things )?up\b/i, /\bthat'?s enough\b/i, /\benough for now\b/i,
  /\bdone for now\b/i, /\bwe'?re done\b/i, /\bstand down\b/i, /\bcall it( a)? (day|night|here|quits)\b/i,
  /\btake a break\b/i, /\bsave context\b/i, /\bthat'?s all\b/i,
  /\b(do|write|prep(?:are)?)\s+(a\s+|the\s+)?handoff\b/i, /\bhandoff\s+(and|then)\s+(pause|stop|sleep)\b/i,
];

// 2026-07-12 — AFK GRANT (the overnight failure, Russell: "any idea why you did so little work"). When
// Russell's LAST real message grants autonomous time ("going to bed", "work on other stuff", "keep going",
// "afk"), the run is UNRELEASABLE except by an explicit stop signal: his question-mark release is void
// (he's gone — a pre-bed question is not engagement), and wind-down language has no override. His NEXT
// real message naturally ends the grant (it becomes the new last message), so presence == normal rules.
const AFK_GRANT_PATTERNS = [
  /\bgoing to (bed|sleep)\b/i, /\bgood\s*night\b/i, /\bafk\b/i,
  // "overnight" only as an ACTION grant ("run/work overnight"), not a topic ("what did you get done overnight?")
  /\b(?:run|work|going|keep (?:going|working))\b[^.!?]{0,20}\bovernight\b/i,
  /\bwhile i['’]?m (out|away|asleep|gone|afk)\b/i, /\bback (in a (bit|few|while)|later|tomorrow|in the morning)\b/i,
  /\bkeep (going|working|at it|grinding)\b/i, /\bwork on other (stuff|things)\b/i,
  /\bdon['’]?t stop\b/i, /\bautonomy grant\b/i, /\brun autonomous(ly)?\b/i,
];
function afkGrantActive(userText, userSaidStop) {
  if (userSaidStop) return false;                       // an explicit stop beats a grant in the same message
  return AFK_GRANT_PATTERNS.some((re) => re.test(userText || ''));
}

// 2026-07-12 — WIND-DOWN closers (the FIRST leak): the overnight run ended with "standing by", "the rest
// needs you", "nothing else mid-flight", "sleep well" — none in HANDOFF_CLOSERS, so the solicits-input
// check waved them through. This class catches DISENGAGEMENT language in the message TAIL while the board
// still has work (or an AFK grant is live). Ending a run is Russell's move, not a sign-off phrase.
const WIND_DOWN_CLOSERS = [
  /\bstand(?:ing)?\s+by\b/i,
  /\bawait(?:ing)?\s+(?:your|further|instructions)\b/i,
  /\bi['’]?ll\s+(?:hold|wait)\b/i, /\bholding\s+(?:here|off|there|for now)\b/i,
  /\bnothing\s+(?:else\s+|more\s+)?(?:left|remaining|mid-?flight|in[- ]flight|to\s+(?:do|start|launch))\b/i,
  /\b(?:rest|sleep)\s+well\b/i, /\bgood\s*night\b/i, /\bsigning\s+off\b/i,
  /\bwhen\s+you(?:['’]re| are| get)?\s*(?:back|ready|up|wake)\b/i,
  /\b(?:over|back)\s+to\s+you\b/i, /\ball\s+yours\b/i,
  /\bthat['’]?s\s+(?:it|all)\s+(?:for\s+now|from\s+me)\b/i,
  /\bstopping\s+(?:here|the\s+autonomous)\b/i, /\bclean\s+stopping\s+point\b/i,
  /\bneeds?\s+(?:you\b|your\s+(?:eyes|steering|input|call|decision|framing|go|sign-?off))/i,
  /\b(?:queue|board|backlog)\s+is\s+(?:genuinely\s+)?(?:empty|clear|worked\s+out|done)\b/i,
  /\bpick\s+(?:it|this|that)\s+up\s+(?:next\s+session|tomorrow|when\b)/i,
];
// A closer that ECHOES Russell's own last message is him deferring that item, not the assistant dodging
// (e.g. HE says "pick this up next session" → the reply may confirm it without tripping the guard).
function windDownReason(prose, userText) {
  const tail = String(prose || '').slice(-250);
  const closer = WIND_DOWN_CLOSERS.find((re) => re.test(tail) && !re.test(userText || ''));
  return closer ? `your closing lines disengage (matched ${closer})` : null;
}

// Queue markers Russell uses in HANDOFF.md — deliberate ALL-CAPS section tags (not prose), plus unchecked
// markdown checkboxes. Their presence means the priority queue still has open work to execute.
// 2026-07-12 BROADENED (the SECOND leak): the assistant WRITES the queue file it is judged against, and the
// overnight failure reworded open work into "TOP OPEN ITEMS (need YOU)" / "REMAINING OPEN" — headings the old
// marker set didn't know. Open-work vocabulary now counts however it's phrased; the ONLY sanctioned release
// is genuinely pruning finished items out of HANDOFF.md (auditable in git), never re-labeling them.
const HANDOFF_QUEUE_MARKERS = /\b(OWED|QUEUED|STILL QUEUED|NOT STARTED|NOT DONE|TODO|OPEN ITEMS?|REMAINING OPEN|PICK UP NEXT|NEEDS? YOU)\b/;
const HANDOFF_QUEUE_MARKERS_PROSE = /\bopen (items?|follow-?ups?|questions?|work)\b|\bnext session\b|\bneed(?:s)? (?:you|russell)\b/i;
const HANDOFF_UNCHECKED_BOX = /^\s*[-*]\s*\[ \]\s+\S/m;
// Active work is often encoded by the handoff's structure, not status words.
const HANDOFF_ACTIVE_HEADING = /^\s*#{1,6}\s+(?:next|up next|resume)\b/im;

function handoffHasOpenQueue(projectDir) {
  if (!projectDir) return false;
  const handoffPath = join(projectDir, 'HANDOFF.md');
  if (!existsSync(handoffPath)) return false;
  let handoffContent;
  try { handoffContent = readFileSync(handoffPath, 'utf8'); } catch { return false; }
  // Struck-through lines (~~…~~) and ✅-DONE lines are finished work legitimately left as history —
  // don't let a completed item's leftover "OWED" keep the gate armed forever.
  const liveContent = handoffContent.split('\n')
    .filter((line) => !/~~.*~~/.test(line) && !/✅/.test(line)).join('\n');
  return HANDOFF_UNCHECKED_BOX.test(liveContent)
    || HANDOFF_ACTIVE_HEADING.test(liveContent)
    || HANDOFF_QUEUE_MARKERS.test(liveContent)
    || HANDOFF_QUEUE_MARKERS_PROSE.test(liveContent);
}

// Count background agents STILL IN FLIGHT: run_in_background:true Agent spawns whose tool-use id has not been
// cleared by a completed/killed task-notification. (Same detection the agent-monitor hook uses.) Russell's intent
// (2026-06-28, after he watched the orchestrator say "holding here while it runs"): agents in flight is NOT a
// reason to idle/wait — it's the cue to REVIEW HANDOFF.md + the roadmap and LAUNCH whatever other independent work
// can run in PARALLEL. So this count does not RELEASE the keep-executing gate; it TAILORS the nag — when agents are
// running, the directive becomes "fan out more parallel work", and "holding/waiting" is itself the violation.
function activeBackgroundAgentCount(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return 0; }
  const liveSpawnIds = new Set();
  const agentRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,200}?"name"\s*:\s*"Agent"[\s\S]{0,3000}?"run_in_background"\s*:\s*true/g;
  for (const spawnMatch of content.matchAll(agentRe)) liveSpawnIds.add(spawnMatch[1]);
  if (liveSpawnIds.size === 0) return 0;
  // A spawn the harness DENIED (a PreToolUse hook blocked it) never started an agent — its paired
  // tool_result is an error. Drop those ids: a blocked spawn is not in flight. (2026-07-16, after
  // agent-sidebar-only blocked 3 read-only spawns and the Stop gate reported "3 in flight" with zero
  // real agents.) Parse JSONL so is_error is bound to the RIGHT tool_use_id, not a nearby one.
  for (const line of content.split('\n')) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      if (block.is_error === true || /spawn\s+BLOCKED|denied/i.test(resultText)) liveSpawnIds.delete(block.tool_use_id);
    }
  }
  if (liveSpawnIds.size === 0) return 0;
  const notificationRe = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const notification of content.matchAll(notificationRe)) {
    const body = notification[1];
    if (!/<status>\s*(completed|killed)\s*<\/status>/i.test(body)) continue;
    const idMatch = body.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
    if (idMatch) liveSpawnIds.delete(idMatch[1]);
  }
  return liveSpawnIds.size;
}

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

import { lastAssistantTextOf, lastUserTextOf } from './lib/transcript.mjs';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  // name-by-use-override: `text` is the existing variable name used throughout this hook.
  let text = lastAssistantTextOf(payload.transcript_path);
  if (!text) { process.exit(0); return; }
  // Phrase matchers run on the code-span-stripped text so quoting a trigger (e.g. `want me to` in backticks
  // while explaining this hook) doesn't false-fire. Edit-detection still reads the raw transcript.
  text = stripCodeSpans(text);

  // Suppress on explicit user-pause / survey-mode messages
  const userText = lastUserTextOf(payload.transcript_path);
  const userInSurveyMode = USER_PAUSE_PATTERNS.some(p => p.test(userText));
  if (userInSurveyMode) { process.exit(0); return; }

  // Shared release/grant state (2026-07-12): computed once, used by wind-down + the queue gate.
  const userSaidStop = STOP_SIGNAL_PATTERNS.some(p => p.test(userText));
  const afkActive = afkGrantActive(userText, userSaidStop);

  // LIST-AND-DEFER check (2026-06-25) — enumerated divergences DISMISSED instead of fixed. Fires regardless of
  // builder mode: even after fixing one item, waving off the rest as "intentional / cosmetic / not a break" is
  // the violation Russell flagged. Escapes: a stated scope reason or the override.
  if (!ROSS_PEROT_OVERRIDE.test(text)
      && !SCOPE_REASON_PATTERNS.some(p => p.test(text))
      && looksEnumerated(text)
      && DIVERGENCE_TERM.test(text)) {
    const dismissalMatches = DISMISSAL_PATTERNS.filter(p => p.test(text)).map(p => p.toString());
    if (dismissalMatches.length > 0) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `STOP-BLOCKED — you LISTED divergences and dismissed them instead of fixing them (Ross Perot Rule).

Your reply enumerates multiple gaps/mismatches, then waves them off as acceptable rather than fixing them. Matched dismissal: ${dismissalMatches.join(', ')}

Russell (2026-06-25): "if you can enumerate the fixes, you must DO the fixes — this turn, in parallel." Surfacing a list of divergences is a COMMITMENT to close them, not a menu to leave on the table.

Fix them now (batch all the edits in ONE message), or justify honestly:
  - genuinely out of scope / a separate change → say "out of scope" / "separate PR".
  - they are truly CORRECT to leave (not a dodge) → ross-perot-override: <why each listed item is right to leave as-is>.`,
      }));
      process.exit(0);
      return;
    }
  }

  // Deferred-fix check — fires only in BUILDER mode (edits shipped this turn). Scans prose only (the
  // decay footer is the sanctioned place to note real follow-ups). Escapes: a stated scope reason or
  // the override token. This is the Ross Perot "if it's obvious and you're in the code, DO IT NOW" guard.
  const proseOnly = text.split(/\*\*Files touched:\*\*/i)[0];
  if (turnShippedEdits(payload.transcript_path)
      && !ROSS_PEROT_OVERRIDE.test(text)
      && !SCOPE_REASON_PATTERNS.some(p => p.test(proseOnly))) {
    const deferralMatches = DEFERRED_FIX_PATTERNS.filter(p => p.test(proseOnly)).map(p => p.toString());
    if (deferralMatches.length > 0) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `STOP-BLOCKED — you DEFERRED an obvious fix instead of doing it (Ross Perot Rule).

This turn already shipped code edits, and your reply hands back a fix to "do next" rather than doing it now. Matched: ${deferralMatches.join(', ')}

Russell's Ross Perot Rule: if a fix is obvious, in-scope, and you're already in the code — DO IT THIS TURN. Handing him a follow-up to approve is a decision tax he can't afford (Mito + ADHD).

Do it now, or justify the deferral honestly:
  - Just make the fix and re-run the tests in THIS turn (the default).
  - If it's genuinely out of scope / risky / large / needs a decision, SAY that reason in the reply ("out of scope", "needs your call", "bigger refactor").
  - Real override: write "ross-perot-override: <why deferring is the correct call>".`,
      }));
      process.exit(0);
      return;
    }
  }

  // ANNOUNCE-NEXT check — the broad anti-whack-a-mole guard (2026-06-23). Block when the reply NAMES a concrete
  // next dev action instead of doing it ("Doing X next", "next: wire Y", "the next step is Z"), UNLESS a real
  // scope/blocked reason is stated or the override is set. Prose only (the decay footer may list real follow-ups).
  const announceProse = text.split(/\*\*Files touched:\*\*/i)[0];
  if (turnShippedEdits(payload.transcript_path)
      && !ROSS_PEROT_OVERRIDE.test(text)
      && !SCOPE_REASON_PATTERNS.some(p => p.test(announceProse))) {
    const announceMatches = ANNOUNCE_NEXT_PATTERNS.filter(p => p.test(announceProse)).map(p => p.toString());
    if (announceMatches.length > 0) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `STOP-BLOCKED — you ANNOUNCED the next step instead of DOING it (Ross Perot Rule).

Your reply names a concrete next action and ends the turn. Matched: ${announceMatches.join(', ')}

Russell (2026-06-23): "I don't want to keep playing whack-a-mole." Announcing "Doing X next" / "next: wire Y"
is the SAME violation as asking permission — it defers a doable action to a future turn. If you can name it
and it's in scope and unblocked, DO IT THIS TURN.

Either do it now (the default — keep working in this turn), or justify honestly:
  - It genuinely needs Russell (hardware / a decision / money / destructive) → state that reason explicitly.
  - It's genuinely out of scope / a separate change → say "out of scope" / "separate PR".
  - Real override: write "ross-perot-override: <why this can't be done now>".`,
      }));
      process.exit(0);
      return;
    }
  }

  // QUEUE-AWARE keep-executing (Russell 2026-06-25; HARDENED 2026-06-28 — "FIX THE HOOK SO YOU CANT SATISFY IT
  // UNLESS I TELL YOU"). HANDOFF.md IS the priority queue: while it lists open work, the run ends ONLY when RUSSELL
  // releases it — his stop signal, or his asking a question (he's engaging, expecting an answer). The assistant can
  // NO LONGER self-satisfy this gate: the `ross-perot-override:` token is DELIBERATELY NOT an escape here (it was
  // being abused to self-declare "blocked" and stop early). A genuinely all-blocked queue is not the assistant's
  // call to make — keep finding doable work (prep, docs, the next phase, reviewing in-flight output) until Russell
  // says stop or the queue is empty. (The override still works on the phrasing checks above, where a real fork
  // legitimately needs Russell — it just can't end the QUEUE run.)
  // userSaidStop/afkActive hoisted above (shared with the wind-down check). 2026-07-12: a trailing "?"
  // from Russell releases this gate ONLY when no AFK grant is live — overnight, a pre-bed question is
  // not engagement, and "answer it, then quit" was the exact leak.
  const userAskedQuestion = /\?\s*$/.test((userText || '').trim()) && !afkActive;
  const liveAgents = activeBackgroundAgentCount(payload.transcript_path);
  if (!userSaidStop && !userAskedQuestion && handoffHasOpenQueue(payload.cwd)) {
    // Tailor the directive to whether work is already in flight. Russell's intent (2026-06-28): agents running is
    // NOT permission to idle — it's the cue to REVIEW HANDOFF.md + the roadmap and LAUNCH more parallel work.
    const directive = liveAgents > 0
      ? `${liveAgents} background agent(s) are IN FLIGHT — that is NOT permission to idle, "hold", or "wait while it runs". Russell's intent: while agents run, REVIEW HANDOFF.md AND the roadmap (ROADMAP.md / plans/ / any roadmap doc) and LAUNCH every OTHER independent unit of work you can IN PARALLEL right now. Maximize parallelism. Only stop launching once you have honestly fanned out ALL parallelizable work — then integrating finished branches is fine, but don't sit idle while there's independent work left to start.`
      : `No background agents are running. Take the next open queue item and DO it this turn — yourself, or by launching parallel agents for each independent unit (review HANDOFF.md + the roadmap and fan out everything that can run concurrently).`;
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `STOP-BLOCKED — keep executing the queue (Ross Perot Rule). Only Russell can end this run.

HANDOFF.md IS the priority queue and still lists open work (OWED / QUEUED / NOT DONE / unchecked items). Russell (Mito + ADHD) should never have to re-issue queued work, and should never see you sitting idle while the board has work.

${directive}

This run ends ONLY when:
  - RUSSELL says stop / wrap up / pause / that's enough (or asks a question), OR
  - the queue is genuinely EMPTY (no OWED / QUEUED / NOT DONE / unchecked items left in HANDOFF.md).

There is NO self-override on this gate. "Holding", "waiting for it to land", "monitoring", or "I'll integrate when it finishes" are NOT acceptable turn-enders while independent work remains — review HANDOFF + the roadmap and launch it.`,
    }));
    process.exit(0);
    return;
  }

  // WIND-DOWN check (2026-07-12 — the overnight failure): the reply DISENGAGES ("standing by",
  // "needs your eyes", "nothing else mid-flight", "sleep well") while the board still has work or an
  // AFK grant is live. Fires REGARDLESS of a trailing "?" in Russell's message — answering a pre-bed
  // question is not a release. Escapes: Russell's explicit stop; the override token ONLY when no AFK
  // grant is active (overnight, self-certified "blocked/done" is exactly the abuse this closes).
  if (!userSaidStop && (afkActive || handoffHasOpenQueue(payload.cwd))) {
    const windDown = windDownReason(text, userText);
    const overrideAllowed = !afkActive && ROSS_PEROT_OVERRIDE.test(text);
    if (windDown && !overrideAllowed) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `STOP-BLOCKED — winding down while the board still has work (Ross Perot Rule).

${windDown[0].toUpperCase() + windDown.slice(1)}.

This is the 2026-07-12 overnight failure: "standing by" / "the rest needs you" / "nothing left" ended an
AFK run while HANDOFF.md still listed open work — Russell woke up to a short shift. Ending the run is
RUSSELL's move, never a sign-off phrase. ${afkActive ? 'An AFK grant is ACTIVE — there is NO self-override overnight.' : ''}

Instead of disengaging:
  - Take the next open HANDOFF item and DO it (or fan out agents for every independent unit).
  - Out of listed work? GENERATE more: a Kintsugi round, a bench retrofit, doc backfill — the generator
    role never runs dry.
  - If an item truly needs Russell live, leave it on the board and work a DIFFERENT one — "needs you"
    is a property of one item, never a reason to end the run.
  - If the queue is GENUINELY empty, prune the finished items OUT of HANDOFF.md (auditable in git) so
    the gate reads empty — do not re-label open work as "needs you" / "next session".${afkActive ? '' : '\n  - Real fork with Russell PRESENT: ross-perot-override: <why stopping is right>.'}`,
      }));
      process.exit(0);
      return;
    }
  }

  // SOLICITS-INPUT check — the structural replacement for the old asking-permission phrase museum. Fires on
  // its own (no option-list required): block if the final message ends by handing Russell the next decision
  // (a trailing "?" OR a no-"?" hand-off closer). Survey mode already early-exited above; the override token
  // is the only extra escape — a genuine question belongs in the AskUserQuestion tool, not a prose "?".
  const askProse = text.split(/\*\*Files touched:\*\*/i)[0];
  const solicitation = solicitsInput(askProse);
  if (solicitation && !ROSS_PEROT_OVERRIDE.test(text)) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `STOP-BLOCKED — soliciting Russell's input instead of leading (Ross Perot Rule).

${solicitation[0].toUpperCase() + solicitation.slice(1)}.

Russell's Ross Perot Rule: never wait for permission. Work out what he's trying to accomplish and just do
the most complete version. Ending on a question / "your call" / "say the word" hands him a decision he
shouldn't have to make — it costs him energy (Mito + ADHD), and a trailing question is an OCD trigger.

End on a DECISION and act in the same turn:
  - "Doing X now." / "I'd do X unless you object — going with it."
  - Obvious next step → just do it; don't ask, don't announce.
  - A genuine fork or a real blocker (money / destructive / hardware / missing info you truly can't get):
    use the AskUserQuestion TOOL (not a prose "?"), or STATE it — "the one call I can't make for you is X" —
    then add  ross-perot-override: <why this genuinely needs Russell>.`,
    }));
    process.exit(0);
    return;
  }

  const alternativeMatches = ALTERNATIVE_PATTERNS.filter(p => p.test(text)).map(p => p.toString());
  if (alternativeMatches.length === 0) { process.exit(0); return; }

  const hasRecommendation = RECOMMENDATION_PATTERNS.some(p => p.test(text));
  if (hasRecommendation) { process.exit(0); return; }

  // Block — alternatives present, no recommendation
  const reminder = `STOP-BLOCKED — alternatives listed without a recommendation.

Your last message:
  - Listed multiple options (matched: ${alternativeMatches.join(', ')})
  - Did not contain a recommendation verb (no "I recommend", "I'd go with", "going with X", "doing X unless", "shipping X unless", "the right call is", etc.)

Russell's rule "Strong Opinion + Minimize Cognitive Load":
  - Present alternatives so Russell can OVERRIDE, not so he can PICK.
  - Always tell him which option is right and WHY.
  - The cost of asking "want me to do A or B?" with no opinion: Russell loses 15-30 sec of cognitive energy per choice.

Rewrite shapes that PASS this hook:
  - "Options: A / B / C. Going with B because [reason]. Override by saying X."
  - "Three paths. I recommend the middle one — A and C have these costs."
  - "I'd default to B unless you object, because [reason]."

Russell explicitly opting OUT of recommendations (suppression triggers):
  - "just thinking", "research mode", "don't take action", "feedback only", "what do you think"
  - If the user said any of those, this hook stays quiet.`;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: reminder,
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
