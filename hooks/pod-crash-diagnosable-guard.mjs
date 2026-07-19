#!/usr/bin/env node
// =============================================================================
// POD-CRASH-DIAGNOSABLE-GUARD — a paid-pod crash must be DIAGNOSED from a REAL
//   traceback, never guessed. Two teeth:
//     Stop            — block a worker "fix" after a pod crash with no traceback read.
//     PreToolUse(Edit)— block a crash-branch pod-delete that has no copyback first.
// =============================================================================
//
// new-hook-category: Paid-pod crash diagnosability — nearest existing are pod-teardown-rescue-guard (rescue-before-a-Bash-delete) and destructive-on-loose-error-guard (delete on an exact token); neither forces READING the real traceback before a blind fix, nor guards a copyback-before-delete INSIDE finalize CODE. This is the diagnosability layer.
//
// The incident (2026-07-19, Getty, the $13 lesson): the exp147c worker crashed on an A40 (exit 1)
// with NO recoverable traceback TWICE, and I was pushed to GUESS (OOM? device?) instead of reading the
// real error — because `finalize_training_pod` raised on the non-zero exit BEFORE its copyback, so the
// worker's `write_error_record` traceback died with the pod; and a CPU pass is a LOSSY PROXY for CUDA
// ("the proxy lies"). Getty class: a crash that can't be diagnosed → guess-and-retry burns pod cycles.
//
// Override (Stop): `pod-blind-fix-ok: <why the fix is provably right without the traceback>`.
// Override (Edit): `pod-blind-fix-ok:` in the edit content. Fail-open on any error.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_RE = /\bpod-blind-fix-ok\s*:/i;

// A paid-pod crash signal in a tool result this session.
const CRASH_SIGNAL_RE = /\bpod\b[^\n]{0,40}\bexited\b[^\n]{0,12}[1-9]|RunPodRequestError|\bexit(?:\s*code)?\s*[1-9]\b|non[-\s]?zero exit/i;
// A worker/launcher CODE file — the thing edited to "fix" the crash.
const WORKER_FILE_RE = /(?:^|[\/\\])(?:exp\w*|runpod_\w*|modal_\w*|train_\w*)\.py$/i;
// A Read that plausibly surfaced the real traceback: a crash-artifact path, or content with a traceback.
const TRACEBACK_PATH_RE = /results[^\/\\]*\.jsonl$|crash|traceback|error[^\/\\]*\.log$|nohup|stdout/i;
const TRACEBACK_CONTENT_RE = /traceback|write_error_record|"error"\s*:/i;

// A destructive pod delete inside worker/finalize CODE, and an artifact copyback that must precede it.
const POD_DELETE_CALL_RE = /\b(?:delete_resource|delete_when_safe|delete_pod|force[_-]?delete|terminate_pod|remove_pod)\s*\(/i;
const COPYBACK_CALL_RE = /\b(?:copy_?back|copyback|download\w*|scp|receive|fetch_?results|copy_?results|rescue_?results|pull_?results|get_?artifacts)\b/i;
// A crash context near the delete — so a plain successful-path finalize delete isn't flagged.
const CRASH_CONTEXT_RE = /crash|exited|exit\s*code|returncode|non[-\s]?zero|\bfail\w*|error/i;

// ---------- Stop half: blind-fix block (pure) ----------
export function evaluateBlindFix({ crashSignalSeen = false, workerFileEdited = false, tracebackRead = false, replyText = '' } = {}) {
  if (OVERRIDE_RE.test(replyText)) return { block: false };
  if (crashSignalSeen && workerFileEdited && !tracebackRead) {
    return {
      block: true,
      reason: `POD-CRASH BLIND-FIX BLOCKED — you're editing the worker after a paid pod crash without reading the REAL traceback.

Get it first: the finalize must COPY the crash artifacts home BEFORE deleting the pod (the worker's \`write_error_record\` traceback / results JSONL), then READ it. Don't guess the cause (OOM? device? — the $13 lesson); a CPU pass is a LOSSY PROXY for the CUDA pod ("the proxy lies").

Do this before stopping:
  1. Ensure finalize copied the failing run's artifact dir home (results*.jsonl / crash log / stdout).
  2. READ that traceback — fix the cause it actually names.
Override (rare — the crash string itself names the exact cause): put pod-blind-fix-ok: <why> in your reply.`,
    };
  }
  return { block: false };
}

// ---------- PreToolUse(Edit) half: copyback-before-delete invariant (pure) ----------
export function flagsDeleteWithoutCopyback(content) {
  const contentText = String(content || '');
  if (OVERRIDE_RE.test(contentText)) return false;
  const deleteMatch = POD_DELETE_CALL_RE.exec(contentText);
  if (!deleteMatch) return false;
  const beforeDelete = contentText.slice(0, deleteMatch.index);
  // Only a delete in a CRASH branch is the hazard (a success-path finalize delete is fine). Require a
  // crash-context word near the delete AND no artifact copyback anywhere before the delete in this edit.
  const nearDelete = contentText.slice(Math.max(0, deleteMatch.index - 240), deleteMatch.index + 80);
  if (!CRASH_CONTEXT_RE.test(nearDelete)) return false;
  return !COPYBACK_CALL_RE.test(beforeDelete);
}

// ---------- transcript parsing for the Stop half ----------
function parseSession(transcriptPath) {
  const facts = { crashSignalSeen: false, workerFileEdited: false, tracebackRead: false };
  if (!transcriptPath || !existsSync(transcriptPath)) return facts;
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return facts; }
  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        const filePath = block.input?.file_path || block.input?.path || '';
        if ((block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit') && WORKER_FILE_RE.test(String(filePath))) {
          facts.workerFileEdited = true;
        }
        if (block.name === 'Read' && TRACEBACK_PATH_RE.test(String(filePath))) facts.tracebackRead = true;
      }
      if (block?.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((part) => part?.text || '').join('\n') : '';
        if (CRASH_SIGNAL_RE.test(resultText)) facts.crashSignalSeen = true;
        if (TRACEBACK_CONTENT_RE.test(resultText)) facts.tracebackRead = true;
      }
    }
  }
  return facts;
}

function lastAssistantReply(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').trim().split('\n'); } catch { return ''; }
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry; try { entry = JSON.parse(lines[index]); } catch { continue; }
    if ((entry?.message?.role || entry?.role) !== 'assistant') continue;
    const blocks = entry?.message?.content ?? [];
    return Array.isArray(blocks) ? blocks.map((block) => block?.text || '').join(' ') : String(blocks || '');
  }
  return '';
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const eventName = event.hook_event_name || event.hookEventName || '';

  if (eventName === 'PreToolUse') {
    const toolName = event.tool_name || '';
    if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') process.exit(0);
    const filePath = event.tool_input?.file_path || event.tool_input?.path || '';
    if (filePath && !WORKER_FILE_RE.test(String(filePath))) process.exit(0); // only worker/launcher code
    const added = event.tool_input?.content ?? event.tool_input?.new_string ?? '';
    let flagged;
    try { flagged = flagsDeleteWithoutCopyback(added); } catch { process.exit(0); }
    if (!flagged) process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `POD CRASH-BRANCH DELETE WITHOUT COPYBACK — a branch that force-deletes a crashed pod must COPY its artifacts home FIRST.

The delete is IRREVERSIBLE and takes the worker's traceback (write_error_record / results JSONL) with it — the exact reason the exp147c crash was undiagnosable ($13 lost). Add the artifact copyback (scp/download the results dir) BEFORE the delete in this branch.

Deeper fix (recommended): copyback-before-delete-on-crash belongs in Runner's finalize_training_pod (a teardown_on_failure= option), not hand-patched per project — this is the 3rd hand-rolled pod-teardown bug in marcus.
Override: pod-blind-fix-ok: <why> in the content.`,
      },
    }));
    process.exit(0);
  }

  if (eventName === 'Stop') {
    const transcriptPath = event.transcript_path || event.transcriptPath || '';
    const facts = parseSession(transcriptPath);
    const verdict = evaluateBlindFix({ ...facts, replyText: lastAssistantReply(transcriptPath) });
    if (!verdict.block) process.exit(0);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
    process.exit(0);
  }

  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
