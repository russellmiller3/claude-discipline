#!/usr/bin/env node
// Stop hook — bakes in three behaviors that Russell shouldn't have to repeat:
//   1) Block asking-permission patterns ("want me to / should I / what's the call").
//   2) Block any work-progressing turn that doesn't tie back to the larger
//      workstream (must mention current epic, what's next, why for launch / Marcus).
//   3) Block freelancing — turns that moved work but didn't draw from the
//      session priority queue at .claude/state/priority-queue.md.
//
// Russell's CLAUDE.md (Ross Perot Rule, Self-Driving Rule, Critical-Path
// Navigator, Finish Epics Minimize WIP): lead, decide, ship; orient every
// substantive reply to the bigger picture; work off a prioritized queue
// derived from ROADMAP.md + RESEARCH.md + HANDOFF.md, not ad-hoc.
//
// Why this hook exists: those rules already live in CLAUDE.md and memory,
// but Claude keeps slipping. The hook is enforcement — Stop is blocked
// until the failure modes are absent from the last assistant message.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';

const ASKING_PATTERNS = [
  /\bwant me to\b/i,
  /\bshould i\b/i,
  /\bdo you want (me to)?\b/i,
  /\bwhat('s| is) the call\b/i,
  /\bwhat do you want\b/i,
  /\bor (would you|i could|if you'?d)\b/i,
  /\bif you'?d rather\b/i,
  /\bplease (let me know|confirm|approve)\b/i,
  /\b(let me know|tell me) (if|whether|what)\b/i,
  /\bwaiting (for|on) (your|you)\b/i,
  /\bblocked (on|until)\b[^\n]*\?/i,
];

// Phrases that count as big-picture / critical-path orientation. The turn
// must contain AT LEAST ONE of these if it had work-progressing tool calls.
const ORIENTATION_PATTERNS = [
  /\bwhere we are\b/i,
  /\bjust landed\b/i,
  /\bnext (critical[- ]path|move|step|up)\b/i,
  /\bwhy (for|it matters)\b/i,
  /\bcritical path\b/i,
  /\bworkstream\b/i,
  /\bepic\b/i,
  /\bqueue (item|#)\b/i,
  /\b(launch|ship|production)\b/i,
  /\b(in-flight|in flight)\b/i,
  /\b(handoff|roadmap)\b/i,
];

// Stop-tell patterns: language that signals the model is WINDING DOWN
// rather than checkpointing mid-flight. These are session-04-29 additions
// after Claude shipped two epics, wrote a clean "TL;DR — session wrap"
// summary, and stopped — even though the queue still had unblocked items.
// The existing asking-permission check missed it because the message
// didn't ASK anything; it just sounded like closing credits.
//
// Any of these in the last message → block on Stop. The model can rephrase
// the same content as a CHECKPOINT ("just landed X, starting Y now") with
// a tool call that proves Y is in flight.
const STOP_TELL_PATTERNS = [
  /\bnext session\b/i,
  /\bfuture session\b/i,
  /\bsession (wrap|summary|recap|ending|close)\b/i,
  /\b(stopping|ending)\s+(here|the session|the stretch|the phase)\b/i,
  /\bTL;?DR\b/i,
  /\bwrap (up|things up|the session|this up)\b/i,
  /\bend(ing)? (the )?(session|stretch|phase)\b/i,
  /\bcall (it|this) (a session|a day|done|complete)\b/i,
  /\bsave (it|this) for (next session|later|tomorrow)\b/i,
  /\bdefer (this|that|it) to (the next|a future)\b/i,
  /\bqueue (this|it|that) for (later|next session|follow[- ]up)\b/i,
  /\bbigger than (i thought|expected|the )/i,
  /\bnot a 30[- ]min\b/i,
  /\bsession[- ]sized (task|chunk)\b/i,
  /\b(let me|i'?ll) write a plan,?\s*(end|stop|next)/i,
];

// Next-move-described-but-not-started: when the message names a future
// move, the same turn must show evidence of starting it. Empty work-tool
// turns + "next move: X" framing is the satisfaction-stop pattern.
const NEXT_MOVE_DESCRIPTION_PATTERNS = [
  /\bnext (critical[- ]path )?move\b/i,
  /\bnext up\s*:/i,
  /\bnext priority\b/i,
  // Bare "Next: X" — any position, with or without bullet/bold markdown.
  // Matches "Next: foo", "**Next:** foo", "- Next: foo", ". Next: foo".
  /(?:^|[\s.,;\-*])\*{0,2}next\*{0,2}\s*:\s*\S/im,
];

// Tool-use signals — does the last turn look like it moved work?
function lastTurnMovedWork(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return false; }
  const lines = content.trim().split('\n');
  // Walk backwards to find the last assistant message and check tool_use blocks.
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.type !== 'assistant') continue;
    const blocks = entry.message?.content || [];
    const toolUses = blocks.filter(b => b && b.type === 'tool_use');
    if (toolUses.length === 0) return false;
    // Filter out pure-read tool uses (Read, Glob, Grep) — those don't count
    // as "moving work" by themselves. Bash, Write, Edit, Agent do.
    const workingTools = ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'Agent', 'NotebookEdit'];
    return toolUses.some(t => workingTools.includes(t.name));
  }
  return false;
}

import { lastAssistantTextOf, lastUserTextOf } from './lib/transcript.mjs';

// User-explicit pause directives. When the most recent user message clearly
// asks to end or save the session, the stop-tell / missing-big-picture /
// no-priority-queue checks are suppressed. A passing mention like "add this
// to the handoff queue" is bookkeeping, not a pause directive.
const USER_PAUSE_PATTERNS = [
  /(^|\n|[.!?]\s*)(please\s+)?(do|write|save|create|make|prepare)\s+(the\s+)?handoff\b/i,
  /(^|\n|[.!?]\s*)\s*handoff\s*$/i,
  /\bsave (the )?handoff\b/i,
  /\bdo (the )?handoff\b/i,
  /\bsave context\b/i,
  /\bwrap (up|things up|the session|this up)\b/i,
  /\bend (the )?(session|stretch|phase)\b/i,
  /\bcall (it|this) (a session|a day|done|complete)\b/i,
  /\bi'?m done (for now|here)\b/i,
  /\bstop (working|here|for now)\b/i,
  /\bwrite a resume prompt\b/i,
];

// Read the repo's HANDOFF.md "Up next" section as the priority queue.
// Russell's rule (2026-06-21): the handoff IS the priority queue — no separate file.
// If HANDOFF.md doesn't exist or has no "Up next" items, the queue is empty
// and this check is a no-op (other checks still fire).
function handoffUpNextItems(cwd) {
  const handoffPath = pathJoin(cwd, 'HANDOFF.md');
  if (!existsSync(handoffPath)) return [];

  let markdown;
  try { markdown = readFileSync(handoffPath, 'utf8'); } catch { return []; }

  // Scan for a numbered list under "## Up next" — same shape as HANDOFF uses.
  // Items are: "1. **Title** — description" or "1. Title — description".
  // Skip items that say "blocked" / "waiting on Russell" / "needs Russell".
  const items = [];
  let inUpNext = false;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      inUpNext = /up next/i.test(heading[1]);
      continue;
    }
    if (!inUpNext) continue;

    // Stop scanning when we hit the next section (## Just landed, ## Gotchas, etc.)
    // — but that's already handled by the heading check above.

    const numberedMatch = line.match(/^\s*\d+\.\s+\*\*(.+?)\*\*(.*)$/) || line.match(/^\s*\d+\.\s+(.+)$/);
    if (!numberedMatch) continue;
    const title = numberedMatch[1].replace(/\s+—.*$/, '').trim();
    if (/\b(blocked|waiting on russell|needs russell|live-verify on russell)\b/i.test(line)) continue;
    items.push({ section: 'Up next', title, line: line.trim() });
  }
  return items;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  const transcriptPath = payload.transcript_path;
  const cwd = payload.cwd || process.cwd();
  // name-by-use-override: `text` is the existing variable name used throughout this hook's main().
  const text = lastAssistantTextOf(transcriptPath);
  if (!text) { process.exit(0); return; }

  // Detect user-explicit pause: when the most recent user message contains
  // a handoff / wrap / stop directive, suppress the checks that would push
  // the model to keep working. Asking-permission stays — even on handoff,
  // asking permission is the wrong shape.
  const userText = lastUserTextOf(transcriptPath);
  const userSaidPause = USER_PAUSE_PATTERNS.some(p => p.test(userText));

  const askingMatches = ASKING_PATTERNS.filter(p => p.test(text));
  const stopTellMatches = STOP_TELL_PATTERNS.filter(p => p.test(text));
  const nextMoveDescribed = NEXT_MOVE_DESCRIPTION_PATTERNS.some(p => p.test(text));
  const movedWork = lastTurnMovedWork(transcriptPath);
  const hasOrientation = ORIENTATION_PATTERNS.some(p => p.test(text));
  const nextQueueItems = handoffUpNextItems(cwd);

  const violations = [];

  if (askingMatches.length > 0) {
    violations.push({
      kind: 'asking-permission',
      detail: `Last message asked Russell permission instead of leading. Matched: ${askingMatches.map(p => p.toString()).join(', ')}`,
    });
  }

  // Stop-tell — the message reads like closing credits, not a mid-flight
  // checkpoint. Doesn't matter whether work moved this turn; if the
  // language signals winding down, block. SUPPRESSED when the user has
  // explicitly said handoff/wrap/stop — their words override the default.
  if (stopTellMatches.length > 0 && !userSaidPause) {
    violations.push({
      kind: 'stop-tell-language',
      detail: `Last message used winding-down language that reads like a session close, not a mid-flight checkpoint. Matched: ${stopTellMatches.map(p => p.toString()).join(', ')}. Rewrite as "just landed X, starting Y now" + actually start Y in the same turn (tool call). Stop tells defer work to a future session that may never come; checkpoints keep the work moving.`,
    });
  }

  // Next-move described but not started — the message names a future move
  // but the turn made zero working tool calls toward it. That's the
  // satisfaction-stop: model describes forward motion without producing it.
  // SUPPRESSED on user-explicit pause — naming the next move IS the handoff.
  if (nextMoveDescribed && !movedWork && !userSaidPause) {
    violations.push({
      kind: 'next-move-described-not-started',
      detail: `Last message named a "next move" but the turn made no working tool calls toward it (Bash/Write/Edit/Agent). Either start the next move now (cut the branch, read the relevant code, write the first edit) or drop the "next:" framing. Describing forward motion without producing it is the satisfaction-stop pattern from session 04-29.`,
    });
  }

  // DISABLED 2026-06-02 per Russell's "Output Budget" rule — the mandatory
  // 4-line critical-path beat was bloating every reply. The beat is now
  // optional (use only when code ships), so this check no longer fires.
  // (hasOrientation is still computed above; intentionally unused now.)

  // Queue still has work in HANDOFF.md "Up next". Stopping after a tidy summary
  // is the exact failure Russell called out on 2026-06-06. A queue item
  // finishing should pull the next item automatically, unless Russell
  // explicitly paused.
  if (nextQueueItems.length > 0 && !userSaidPause) {
    const nextItem = nextQueueItems[0];
    violations.push({
      kind: 'queue-has-next-item',
      detail: `HANDOFF.md "Up next" still has actionable work: "${nextItem.title}". Do not stop after summarizing the finished item. Start the next item now. If that item needs Russell (live-verify, his hands), mark it blocked and start the next unblocked item.`,
    });
  }

  if (violations.length === 0) { process.exit(0); return; }

  const reasons = violations.map(v => `  • ${v.kind}: ${v.detail}`).join('\n');
  const reminder = `STOP-BLOCKED — ${violations.length} workflow rule(s) violated by your last message:

${reasons}

Russell's rules (CLAUDE.md, Ross Perot Rule + Critical-Path Navigator + Finish Epics):
  1. Never wait for permission. Lead, decide, ship. "Doing X unless you object."
  2. Keep replies SHORT (≤2 short paragraphs unless asked). No mandatory 4-line beat — add a one-line "next" only when useful, and show the full beat only when code ships.
  3. The HANDOFF.md "Up next" section IS the priority queue. Read it, work off it.
     No ad-hoc work, no separate priority-queue file.
  4. When one queue item finishes, immediately pull the next item. A tidy
     summary is not a stop point unless Russell explicitly said stop/wrap.
  5. If the next item needs Russell (real money / hardware key / destructive /
     live-verify on his Chrome), SKIP it and pick the next unblocked item. Don't stop.

What to do next:
  • Re-write the last reply as a decision + critical-path beat, not a question.
  • If HANDOFF.md is missing or has no "Up next" section, you're done — stop freely.
  • Otherwise: pull the next item from HANDOFF.md "Up next" and start it now.
  • If the next item needs Russell (real money / hardware key / destructive / live-verify),
    mark it blocked in HANDOFF and pull the next unblocked item. Don't stop.`;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: reminder,
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
