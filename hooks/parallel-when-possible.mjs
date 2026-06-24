#!/usr/bin/env node
// name-by-use-override: faithful port of an existing hook; a short `text` local for file contents
// is kept to match the upstream source and its companion test verbatim.
//
// parallel-when-possible — Stop + SessionStart hook that catches under-parallelization.
//
// The rule "work in parallel by default": batch independent tool calls + spawn multiple agents
// concurrently when the plan allows. The rule is easy to state and easy to forget mid-session;
// this hook is the enforcement.
//
// SessionStart: injects a "decompose → fan out" prompt up front (the primary win — deciding to
// parallelize BEFORE grinding).
//
// Stop: blocks when the CURRENT turn shows a serial grind that should have been delegated:
//   - MODE A — exactly 1 background agent alive while 2+ "parallel-safe" phases sit unstarted in a
//     project queue/plan. (Optional; only fires if a queue/plan with parallel-safe markers exists.)
//   - MODE B — many edits across many distinct files with ZERO subagents spawned (independent work
//     ground through one-at-a-time in the main thread).
//   - MODE C — a read/explore grind: many Read/Grep/Glob calls across many distinct targets with ZERO
//     subagents (should have been an Explore/general-purpose agent).
//
// Queue/plan discovery (Mode A) is generic and OPT-IN:
//   - per-repo `<cwd>/.claude/state/priority-queue.md`
//   - any paths in PARALLEL_QUEUE_PATHS (comma-separated)
//   - any `plans/plan-*.md` under the repo (most recent wins)
// If none exist, Mode A simply never fires — Modes B/C (transcript-based) work anywhere with no config.
//
// Suppression (scoped to the CURRENT turn): "serial only" / "do not parallelize" / "no parallel".
// Fail-open on unexpected errors.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Queue/plan discovery is rooted at the repo the hook runs in (event.cwd), plus any explicit paths
// from PARALLEL_QUEUE_PATHS. No hardcoded project layout — works in any repo or none.
function findProjectQueues(repoRoot) {
  const queues = [];
  const perRepoQueue = resolve(repoRoot, '.claude', 'state', 'priority-queue.md');
  if (existsSync(perRepoQueue)) queues.push(perRepoQueue);
  const explicit = String(process.env.PARALLEL_QUEUE_PATHS || '')
    .split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const queuePath of explicit) {
    if (existsSync(queuePath)) queues.push(queuePath);
  }
  return queues;
}

// Plan-file discovery: the most recently modified `plan-*.md` under `<repoRoot>/plans/`, if that
// directory exists. Generic — any repo that uses a plans/ convention is picked up; others are skipped.
function findPlanDirs(repoRoot) {
  const dirs = [];
  const planDir = join(repoRoot, 'plans');
  if (existsSync(planDir)) dirs.push(planDir);
  return dirs;
}

function safeRead(filePath) {
  if (!existsSync(filePath)) return '';
  try { return readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function activeAgentCount(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return 0; }
  const spawnIds = new Set();

  const agentRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,200}?"name"\s*:\s*"Agent"[\s\S]{0,3000}?"run_in_background"\s*:\s*true/g;
  for (const m of raw.matchAll(agentRe)) spawnIds.add(m[1]);
  if (spawnIds.size === 0) return 0;

  const notificationRe = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const nMatch of raw.matchAll(notificationRe)) {
    const block = nMatch[1];
    if (!/<status>\s*(completed|killed)\s*<\/status>/i.test(block)) continue;
    const idMatch = block.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
    if (idMatch) spawnIds.delete(idMatch[1]);
  }
  return spawnIds.size;
}

function latestPlanFile(repoRoot) {
  const candidates = [];
  for (const planDir of findPlanDirs(repoRoot)) {
    try {
      const files = readdirSync(planDir).filter((f) => /^plan-.*\.md$/.test(f));
      for (const f of files) {
        const full = join(planDir, f);
        try { candidates.push({ full, mtime: statSync(full).mtimeMs }); } catch {}
      }
    } catch {}
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].full;
}

/**
 * Look for unstarted parallel-safe phases in the queue/plan. Returns a list of human-readable phase
 * titles, or [] if none. A phase is "unstarted" if it carries a "parallel-safe" tag and is NOT marked
 * done (✅, done, shipped, complete).
 */
function unstartedParallelSafePhases(repoRoot) {
  const sources = [...findProjectQueues(repoRoot), latestPlanFile(repoRoot)].filter(Boolean);
  const phases = new Set();
  for (const source of sources) {
    const sourceText = safeRead(source);
    if (!sourceText) continue;
    const lines = sourceText.split('\n');
    for (const line of lines) {
      if (!/parallel[- ]safe|\(parallel\)/i.test(line)) continue;
      if (/^[\s|]*✅|complete|completed|shipped|done|🔥/i.test(line)) continue;
      const idMatch = line.match(/Phase\s+(\d+(?:\.\d+)?)/i);
      const titleMatch = line.match(/Phase\s+\d+(?:\.\d+)?\s*[—–\-:|]\s*([^|]+?)(?:\s*\||\s*$)/i);
      const title = titleMatch ? `Phase ${idMatch ? idMatch[1] : '?'} — ${titleMatch[1].trim().slice(0, 60)}` : line.replace(/[|*_`]/g, '').trim().slice(0, 80);
      if (title) phases.add(title);
    }
  }
  return [...phases];
}

const SUPPRESS_RE = /serial only|do not parallelize|no parallel/i;

function suppressed(turnText) {
  if (!turnText) return false;
  return SUPPRESS_RE.test(turnText);
}

// Parse a transcript file into JSONL records + the index of the current turn's start (last GENUINE user
// prompt). Shared by currentTurnToolStats and currentTurnText so suppression and grind-detection agree on
// where "this turn" begins. Returns null if the transcript can't be read/parsed.
function parseTurn(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  if (!records.length) return null;

  // Turn start = the last GENUINE user prompt (a user message with text, not a pure tool_result echo).
  let turnStart = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const message = records[i]?.message;
    if (!message || message.role !== 'user') continue;
    const content = message.content;
    const hasText = typeof content === 'string'
      ? content.trim().length > 0
      : Array.isArray(content) && content.some((block) => block?.type === 'text' && String(block.text || '').trim());
    const toolResultOnly = Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === 'tool_result');
    if (hasText && !toolResultOnly) { turnStart = i; break; }
  }
  return { records, turnStart };
}

/**
 * Concatenated text (user + assistant) of the CURRENT turn only. Suppression is scoped to this so a
 * single "serial only" anywhere earlier in the session does not permanently disable the hook.
 */
function currentTurnText(transcriptPath) {
  const parsed = parseTurn(transcriptPath);
  if (!parsed) return '';
  const { records, turnStart } = parsed;
  const turnParts = [];
  for (let i = turnStart; i < records.length; i++) {
    const message = records[i]?.message;
    if (!message) continue;
    const content = message.content;
    if (typeof content === 'string') { turnParts.push(content); continue; }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && block.text) turnParts.push(String(block.text));
    }
  }
  return turnParts.join('\n');
}

// --- MODE A: 1 background agent alive while parallel-safe phases wait. Returns a block reason or null. ---
function modeA(event) {
  const activeCount = activeAgentCount(event.transcript_path);
  // Only nudge when exactly 1 agent is in flight — 0 means idle/done (Mode B handles that), 2+ already parallel.
  if (activeCount !== 1) return null;

  const repoRoot = event.cwd || process.cwd();
  const parallelSafe = unstartedParallelSafePhases(repoRoot);
  if (parallelSafe.length < 1) return null;

  const phaseLines = parallelSafe.slice(0, 6).map((phase) => `  - ${phase}`).join('\n');
  return `PARALLELIZE — only 1 background agent is in flight, but ${parallelSafe.length} parallel-safe phase(s) are still unstarted in the priority queue / latest plan:

${phaseLines}

The rule "work in parallel by default": batch independent agents + tool calls. Subagent throughput compounds. Right now you have parallel headroom and are using one slot.

Action: spawn the remaining parallel-safe agent(s) in your next message. The plan explicitly marks them as collision-safe with the in-flight work. If you have a real reason this run must be serial, include "serial only" or "do not parallelize" in your reply and the hook will quiet down.`;
}

// --- MODE B: catch a SERIAL GRIND in the main thread — heavy editing spread across many files with no
//     delegation. Detection is transcript-based and scoped to the CURRENT TURN. ---
const FILE_THRESHOLD = 6;   // independent work tends to fan across many files...
const EDIT_THRESHOLD = 15;  // ...and a serial grind is a LOT of edits. Both must clear to fire.
// Mode C (read/explore grind): a pile of reads/searches across many distinct targets with zero delegation.
const READ_THRESHOLD = 12;          // a real exploration grind reads/searches a LOT...
const READ_TARGET_THRESHOLD = 8;    // ...across many distinct files/patterns. Both must clear to fire.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const DELEGATE_TOOLS = new Set(['Agent', 'Task']);

function currentTurnToolStats(transcriptPath) {
  const parsed = parseTurn(transcriptPath);
  if (!parsed) return null;
  const { records, turnStart } = parsed;

  let editCalls = 0;
  let readCalls = 0;
  let agentSpawns = 0;
  const filesTouched = new Set();
  const readTargets = new Set();
  for (let i = turnStart; i < records.length; i++) {
    const message = records[i]?.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== 'tool_use') continue;
      if (DELEGATE_TOOLS.has(block.name)) agentSpawns++;
      if (EDIT_TOOLS.has(block.name)) {
        editCalls++;
        const editedFile = block.input?.file_path || block.input?.notebook_path;
        if (editedFile) filesTouched.add(String(editedFile));
      }
      if (READ_TOOLS.has(block.name)) {
        readCalls++;
        // Distinct target = the file path (Read/Glob) or the search pattern (Grep).
        const readTarget = block.input?.file_path || block.input?.pattern || block.input?.path;
        if (readTarget) readTargets.add(String(readTarget));
      }
    }
  }
  return { editCalls, readCalls, agentSpawns, distinctFiles: filesTouched.size, distinctReadTargets: readTargets.size };
}

function modeB(event) {
  const stats = currentTurnToolStats(event.transcript_path);
  if (!stats) return null;
  if (stats.agentSpawns > 0) return null;                  // already delegated — not a serial grind
  if (stats.distinctFiles < FILE_THRESHOLD) return null;   // few files → likely one coupled unit
  if (stats.editCalls < EDIT_THRESHOLD) return null;        // not enough volume to bother

  return `PARALLELIZE — this turn made ${stats.editCalls} edits across ${stats.distinctFiles} files with ZERO subagents spawned.

The rule "work in parallel by default": independent work items should be DISPATCHED to concurrent subagents (the Agent tool, multiple in one message), not ground through one-at-a-time in the main thread. That's what just happened — a long serial grind across many files.

Ask: were those files independent work units (separate modules, separate features, separate fixes)? If yes, the next batch should fan out — spawn one Agent per unit in a single message and let them run concurrently. If the files are genuinely coupled (must be edited in lockstep) and serial was correct, say "serial only" or "do not parallelize" in your reply and this hook will quiet down.`;
}

// --- MODE C: the read/explore grind — many Read/Grep/Glob calls across many files in the MAIN thread,
//     answering one question one file at a time, with ZERO subagents. ---
function modeC(event) {
  const stats = currentTurnToolStats(event.transcript_path);
  if (!stats) return null;
  if (stats.agentSpawns > 0) return null;                            // already delegated — not a solo grind
  if (stats.readCalls < READ_THRESHOLD) return null;                 // not enough volume to bother
  if (stats.distinctReadTargets < READ_TARGET_THRESHOLD) return null; // narrow — likely one focused dig

  return `PARALLELIZE — this turn made ${stats.readCalls} read/search calls across ${stats.distinctReadTargets} targets with ZERO subagents spawned.

The rule "work in parallel by default": reading across many files to answer one question should be DISPATCHED to an Explore/general-purpose agent, not ground through one file at a time in the main thread. An Explore agent reads excerpts across many locations and returns just the conclusion — keeping your context clean and the search concurrent.

Action: when the next chunk of work involves broad searching/reading across many files, send an Explore agent (or fan several out in one message for independent search threads) instead of hand-walking each file. If this exploration genuinely had to be sequential (each read depended on the last), say "serial only" or "do not parallelize" in your reply and this hook will quiet down.`;
}

// --- PROACTIVE (SessionStart): the PRIMARY enforcement. The cheap win is deciding to fan out BEFORE
//     grinding, not getting flagged after. ---
const PROACTIVE_PROMPT = `=== WORK IN PARALLEL BY DEFAULT — assess BEFORE you start ===
Before substantive work this session, decompose the task into independent units (separate modules / files / features / fixes / searches). If 2+ units don't depend on each other, DISPATCH them to concurrent subagents — multiple Agent tool calls in ONE message run in parallel — instead of doing them one-at-a-time in the main thread. Reading across many files to answer one question? Send an Explore/general-purpose agent and keep just the conclusion.
Go serial only when the units are genuinely coupled (must change in lockstep) or trivial. State your parallel-vs-serial call in your first plan. The Stop hook backstops this (it flags a serial grind — many edits across many files with 0 subagents — after the fact), but fanning out up front is the real win.`;

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }

  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName === 'SessionStart') {
    process.stdout.write(PROACTIVE_PROMPT);
    process.exit(0);
    return;
  }
  if (eventName !== 'Stop') {
    process.exit(0);
    return;
  }
  if (event.stop_hook_active) {
    process.exit(0);
    return;
  }

  // Suppression is scoped to the CURRENT TURN only.
  if (suppressed(currentTurnText(event.transcript_path))) {
    process.exit(0);
    return;
  }

  const reason = modeA(event) || modeB(event) || modeC(event);
  if (!reason) {
    process.exit(0);
    return;
  }

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

main();
