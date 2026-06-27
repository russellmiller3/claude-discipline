#!/usr/bin/env node
/**
 * Stop hook — block stop if background tasks are still running.
 *
 * The rule: "main Claude should never stay idle. Always find something
 * to work on AND start work while agents/background tasks are running."
 *
 * v2 (2026-04-27 evening): scan the FULL transcript text (not per-entry, not
 * windowed) and use string-level regex to find spawn -> completion pairs.
 * The previous per-entry parser missed completions older than the 100-line
 * window AND missed notifications that lived in non-assistant content
 * blocks. Result: false positives blocking every stop. v2 keeps it simple.
 *
 * Detection:
 *   1. Read full transcript.
 *   2. Find all spawn IDs from tool_use blocks where:
 *        - input.run_in_background === true (background bash), OR
 *        - name === "Agent" (subagent dispatch), OR
 *        - name starts with "mcp__ccd_session__spawn_task"
 *   3. Find all completion IDs from <task-notification> blocks where
 *      <status>completed</status> appears.
 *   4. Set difference: still-running = spawned minus completed.
 *
 * Fail-open on any unexpected error — never permanently block CC.
 */

import { readFileSync } from 'node:fs';

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'Stop') process.exit(0);
  if (event.stop_hook_active) process.exit(0); // subagent stops aren't blocked

  const transcriptPath = event.transcript_path || '';
  if (!transcriptPath) process.exit(0);

  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    process.exit(0);
  }

  // 1) Find all spawn IDs. The tool_use blocks are JSON objects embedded in
  // the transcript JSONL. We scan for the literal patterns rather than
  // parsing every line — much cheaper and survives format drift.

  const spawnIds = new Map(); // tool_use_id -> {kind, descriptor}

  // Background bash: tool_use with input.run_in_background: true
  // Pattern: "id":"toolu_xxx", ... "input":{ ... "run_in_background":true ... ,"description":"..."
  const bgBashRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,2000}?"run_in_background"\s*:\s*true[\s\S]{0,500}?(?:"description"\s*:\s*"([^"]{0,60})"|"command"\s*:\s*"([^"]{0,60}))/g;
  for (const m of raw.matchAll(bgBashRe)) {
    spawnIds.set(m[1], {
      kind: 'background-bash',
      descriptor: (m[2] || m[3] || '').slice(0, 60),
    });
  }

  // Agent dispatch: tool_use name="Agent". Both sync AND async (run_in_background:true)
  // count, but ONLY async ones are "still running" after dispatch returns.
  // Heuristic: only count Agent dispatches that have run_in_background:true.
  // (Sync agents complete before stop fires.)
  const agentRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,200}?"name"\s*:\s*"Agent"[\s\S]{0,3000}?"run_in_background"\s*:\s*true[\s\S]{0,1000}?"description"\s*:\s*"([^"]{0,60})"/g;
  for (const m of raw.matchAll(agentRe)) {
    spawnIds.set(m[1], {
      kind: 'agent',
      descriptor: (m[2] || '').slice(0, 60),
    });
  }

  // mcp__ccd_session__spawn_task: always async by design
  const spawnTaskRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,200}?"name"\s*:\s*"mcp__ccd_session__spawn_task"[\s\S]{0,2000}?"title"\s*:\s*"([^"]{0,60})"/g;
  for (const m of raw.matchAll(spawnTaskRe)) {
    spawnIds.set(m[1], {
      kind: 'spawn-task',
      descriptor: (m[2] || '').slice(0, 60),
    });
  }

  if (spawnIds.size === 0) process.exit(0);

  // 2) Find completion IDs. The <task-notification> blocks contain both
  // <tool-use-id>X</tool-use-id> AND <status>completed</status>. We pair
  // them by proximity within a single notification block.
  // Pattern: <task-notification>...<tool-use-id>X</tool-use-id>...<status>completed</status>...
  // OR:      <task-notification>...<status>completed</status>...<tool-use-id>X</tool-use-id>...
  // We accept either ordering by matching them inside a single
  // <task-notification>...</task-notification> block.

  const notificationRe = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const nMatch of raw.matchAll(notificationRe)) {
    const block = nMatch[1];
    if (!/<status>\s*completed\s*<\/status>/i.test(block)) continue;
    const idMatch = block.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
    if (idMatch) {
      spawnIds.delete(idMatch[1]);
    }
  }

  // 3) Also clear Agent dispatches whose result text is present (Agent
  // results land inline as a tool_result; the result text being present
  // means the agent finished and parent has the data).
  for (const [id, meta] of spawnIds) {
    if (meta.kind !== 'agent') continue;
    // Look for tool_result block referencing this id
    const resultRe = new RegExp(`"tool_use_id"\\s*:\\s*"${id}"`, 'g');
    if (resultRe.test(raw)) {
      spawnIds.delete(id);
    }
  }

  if (spawnIds.size === 0) process.exit(0);

  // Build the reminder. Cap at 5 items.
  const items = [...spawnIds.values()].slice(0, 5);
  const lines = items.map(m => `  - [${m.kind}] ${m.descriptor || '(no description)'}`).join('\n');
  const more = spawnIds.size > 5 ? `\n  ...(+${spawnIds.size - 5} more)` : '';

  const reason =
    `Never-idle rule (${spawnIds.size} background task${spawnIds.size === 1 ? '' : 's'} still running):\n` +
    lines + more + '\n\n' +
    `Don't stop yet. Use the wait time productively — pick up the next chunk of work in the parent context. ` +
    `Good candidates: independent file edits, doc updates, related research, follow-up commits, exploring ` +
    `a question that came up earlier, sharpening the current plan. ` +
    `If there is genuinely nothing left to do, write that explicitly in your next reply ` +
    `(then the next stop event will be allowed because the task list will show empty).`;

  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

try { main(); } catch { process.exit(0); }
