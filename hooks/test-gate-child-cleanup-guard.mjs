#!/usr/bin/env node
/**
 * test-gate-child-cleanup-guard — Stop guard for test/verification scripts that launch child processes.
 *
 * new-hook-category: Test/verify/root-cause — nearest existing hook is tests-must-pass.mjs; it tracks
 * failed results, not whether a test gate can orphan child processes after its parent is cancelled.
 *
 * A changed test or verification gate that launches another process must visibly own a deadline, kill
 * descendants, and ship a changed forced-cancel test. Outer tool timeouts do not clean up children.
 * The rule is session-scoped so it still applies after the work has been committed and git diff is empty.
 * Fail-open on unreadable files or malformed transcript data.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTranscript, toolUsesOf } from './lib/transcript.mjs';

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'apply_patch']);

// (2026-07-27 false-fire) Two independent over-matches fired this guard on `gateway.ts`, ordinary
// Cloudflare Worker request-handling code that cannot spawn a process at all:
//   1. the bare word `exec` matched `/regex/.exec(signature)` — RegExp.prototype.exec is BY FAR the
//      most common use of that word in JavaScript, and `str.replace`-style method calls make bare
//      `spawn` similarly ambiguous;
//   2. the filename pattern matched "gate" as a SUBSTRING of "gateway".
// The durable fix is to identify the process API by its MODULE rather than by lookalike words:
// unambiguous symbols (execSync, spawnSync, Bun.spawn, subprocess.run, …) count on their own, while
// the ambiguous bare verbs `exec`/`spawn` only count when the file actually imports a process
// module. That keeps every real gate detected — a script cannot launch a child without one of these
// — without flagging any code that merely runs a regex.
const UNAMBIGUOUS_PROCESS_LAUNCH =
  /\b(?:spawnSync|execFileSync|execFile|execSync|execa|subprocess\.(?:run|Popen|call)|Bun\.spawn|child_process\.(?:exec|spawn)\w*)\b/;
const PROCESS_MODULE_IMPORT =
  /(?:require\(\s*['"](?:node:)?child_process['"]|from\s+['"](?:node:)?child_process['"]|import\s+.*['"](?:node:)?child_process['"]|^\s*import\s+subprocess\b|from\s+subprocess\s+import)/m;
// Bare `exec(`/`spawn(` — only meaningful alongside a real process-module import (see above).
const AMBIGUOUS_PROCESS_VERB = /\b(?:exec|spawn)\s*\(/;

export function launchesChildProcess(gateSource) {
  const source = String(gateSource || '');
  if (UNAMBIGUOUS_PROCESS_LAUNCH.test(source)) return true;
  return PROCESS_MODULE_IMPORT.test(source) && AMBIGUOUS_PROCESS_VERB.test(source);
}
const DEADLINE = /\b(?:setTimeout|deadline|timeout(?:Ms|Seconds)?|AbortSignal\.timeout|runWithDeadline)\b/i;
const TREE_CLEANUP = /\b(?:taskkill|terminate(?:Process|Child|Tree)|kill(?:Process|Tree)|process\.kill|\.kill\(|SIG(?:INT|TERM|BREAK)|pkill|killpg)\b/i;
const CANCELLATION_PROOF = /\b(?:timeout|cancel(?:lation|led)?|abort(?:ed)?|interrupt(?:ed)?|signal)\b/i;
const CLEANUP_PROOF = /\b(?:terminate(?:d|s)?|kill(?:ed|s)?|cleanup|child\s+(?:process|tree)|process\s+tree)\b/i;

function normalizedPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function isTestFile(filePath) {
  const normalizedFilePath = normalizedPath(filePath);
  return /(?:^|\/)(?:test|tests|__tests__)\/|(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]s$|(?:^|\/)test_[^/]+\.py$/i.test(normalizedFilePath);
}

// The gate-name keywords must be whole words inside the filename, not bare substrings: "gate"
// inside "gateway.ts" (a Worker request handler), "ci" inside "reconcile.ts", or "check" inside
// "checkout.ts" are ordinary application files, not verification gates. Segments are split on the
// usual filename separators plus camelCase boundaries, so `verify-deploy.mjs`, `run_checks.py`,
// and `ciPipeline.ts` still match while `gateway.ts` no longer does. (2026-07-27 false-fire.)
const GATE_NAME_KEYWORD = /^(?:tests?|verify|verification|check|checks|gate|gates|ci|build)$/i;

function isTestGateScript(filePath) {
  const normalizedFilePath = normalizedPath(filePath);
  if (isTestFile(normalizedFilePath)) return false;
  const fileName = normalizedFilePath.split('/').pop() || '';
  const extensionMatch = /\.(?:[cm]?[jt]s|py|sh|ps1)$/i.test(fileName);
  if (!extensionMatch) return false;
  const baseName = fileName.replace(/\.(?:[cm]?[jt]s|py|sh|ps1)$/i, '');
  const nameSegments = baseName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return nameSegments.some((segment) => GATE_NAME_KEYWORD.test(segment));
}

function patchPaths(patchContent) {
  const discoveredPaths = [];
  const patchHeader = /\*\*\*\s+(?:Add|Update)\s+File:\s+(.+)/g;
  let headerMatch;
  while ((headerMatch = patchHeader.exec(String(patchContent || ''))) !== null) {
    discoveredPaths.push(headerMatch[1].trim());
  }
  return discoveredPaths;
}

/** Changed file paths across this session, including Codex apply_patch payloads. */
export function changedPathsInSession(sessionEntries) {
  const changedPaths = new Set();
  for (const sessionEntry of sessionEntries) {
    for (const toolUse of toolUsesOf(sessionEntry)) {
      if (!MUTATING_TOOLS.has(toolUse.name || '')) continue;
      const toolInput = toolUse.input || {};
      const directPath = toolInput.file_path || toolInput.path;
      if (directPath) changedPaths.add(String(directPath));
      const patchContent = typeof toolInput === 'string' ? toolInput : toolInput.patch || toolInput.content || '';
      for (const patchPath of patchPaths(patchContent)) changedPaths.add(patchPath);
    }
  }
  return [...changedPaths];
}

/** Pure verdict for a changed session. Tests inject file access; production reads final file content. */
export function evaluateProcessGateOwnership({ changedPaths, fileExists, readSource }) {
  const changedTestFiles = changedPaths.filter(isTestFile);
  const cancellationProofExists = changedTestFiles.some((testPath) => {
    if (!fileExists(testPath)) return false;
    const testSource = readSource(testPath);
    return CANCELLATION_PROOF.test(testSource) && CLEANUP_PROOF.test(testSource);
  });

  const offendingGates = [];
  for (const gatePath of changedPaths.filter(isTestGateScript)) {
    if (!fileExists(gatePath)) continue;
    const gateSource = readSource(gatePath);
    if (!launchesChildProcess(gateSource)) continue;
    const missing = [];
    if (!DEADLINE.test(gateSource)) missing.push('deadline');
    if (!TREE_CLEANUP.test(gateSource)) missing.push('tree cleanup');
    if (!cancellationProofExists) missing.push('forced-cancel test');
    if (missing.length > 0) offendingGates.push({ path: normalizedPath(gatePath), missing });
  }
  return { block: offendingGates.length > 0, offendingGates };
}

function blockReason(offendingGates) {
  const offenderLines = offendingGates
    .map((offender) => `  - ${offender.path}: missing ${offender.missing.join(', ')}`)
    .join('\n');
  return `STOP-BLOCKED — a changed test or verification gate can launch child processes without proven ownership.\n\n${offenderLines}\n\nOuter tool timeouts kill the parent, not necessarily its children. A child process can keep running after the\nagent thinks the gate stopped, burning CPU and blocking later work. Before stopping:\n  1. Give the gate its own bounded deadline.\n  2. Terminate the whole descendant tree on timeout and cancellation.\n  3. Add a forced-timeout or forced-cancel test proving the child tree is gone.\n\nThis guard is intentionally narrow: ordinary application code and test files are ignored. It fires only when\nthis session changed a test/verification-style script that visibly launches another process.`;
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { hookEvent = {}; }
  if ((hookEvent.hook_event_name || hookEvent.hookEventName) !== 'Stop' || hookEvent.stop_hook_active) return;
  const sessionEntries = readTranscript(hookEvent.transcript_path);
  if (sessionEntries.length === 0) return;

  const verdict = evaluateProcessGateOwnership({
    changedPaths: changedPathsInSession(sessionEntries),
    fileExists: existsSync,
    readSource: (filePath) => readFileSync(filePath, 'utf8'),
  });
  if (verdict.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(verdict.offendingGates) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
