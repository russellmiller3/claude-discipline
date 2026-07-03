#!/usr/bin/env node
// delete-audit-guard.test.mjs — locks the "don't destroy the user's undocumented work" guard.
//
// THE INCIDENT this guard exists for: Russell manually renamed LEDGER-SOURCE-OF-TRUTH.md to
// Truth-ledger.md; the assistant found the "stray" old file, judged it a harmless duplicate
// (content was identical), and deleted it — destroying his intentional rename. These tests prove
// the guard blocks exactly that shape of command (delete/rename of a file the assistant never
// touched this session) while staying silent on the assistant's own scratch/created files.
//
// Run: node --test delete-audit-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const hookDirectory = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hookDirectory, 'delete-audit-guard.mjs');

// The guard treats anything under the OS temp dir as scratch (by design — that's where session
// scratchpads live). A sandbox rooted THERE would make every "real user file" test case look like
// scratch, so the main sandbox for "this is a real, non-scratch project file" tests lives NEXT TO
// this test file instead (inside the hooks directory, which is a real tracked project location).
// A separate temp-dir sandbox (see the "OS temp / scratchpad" test below) covers the scratch case.
const sandboxDirectory = join(hookDirectory, `.delete-audit-guard-test-sandbox-${process.pid}`);
mkdirSync(sandboxDirectory, { recursive: true });

function makeFile(relativeName, contents = 'hello') {
  const fullPath = join(sandboxDirectory, relativeName);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents, 'utf8');
  return fullPath;
}

// Writes a minimal fake session transcript (JSONL) recording a Write tool_use for `createdPath`
// (if given). Returns the transcript file path. Optionally stamps the transcript's first entry
// with an explicit `timestamp` (ISO string) so tests can control the session-start anchor the hook
// derives from the transcript.
function makeTranscript(createdPath, { timestamp } = {}) {
  const transcriptPath = join(sandboxDirectory, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  const transcriptLines = [];
  const firstEntry = { message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } };
  if (timestamp) firstEntry.timestamp = timestamp;
  transcriptLines.push(JSON.stringify(firstEntry));
  if (createdPath) {
    transcriptLines.push(JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: createdPath } }],
      },
    }));
  } else {
    // An assistant turn with no Write at all — still a valid transcript, just nothing created.
    transcriptLines.push(JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'whatever' } }] },
    }));
  }
  writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n', 'utf8');
  return transcriptPath;
}

function runHook(command, { tool = 'Bash', transcriptPath, workingDirectory, env } = {}) {
  const payload = {
    tool_name: tool,
    tool_input: { command },
    transcript_path: transcriptPath,
    cwd: workingDirectory || sandboxDirectory,
  };
  const childProcess = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
  return { combinedOutput: (childProcess.stdout || '') + (childProcess.stderr || ''), exitCode: childProcess.status };
}

const isBlocked = (combinedOutput) => /"permissionDecision"\s*:\s*"deny"/.test(combinedOutput);

// Pause long enough that a filesystem mtime taken after this resolves is unambiguously later than
// one taken before it started (mtime resolution can be coarse on some filesystems/CI runners).
// Shared by every test that needs to put a file's mtime on a specific side of a session-start line.
const sleepBriefly = () => new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

test('rm of a pre-session tracked .md file -> blocks', () => {
  const targetFile = makeFile('LEDGER-SOURCE-OF-TRUTH.md', 'the truth');
  // Transcript shows the assistant did NOT create/touch this file this session.
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`rm "${targetFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny for rm of a file the assistant never touched');
});

test('rm of a file the assistant created this session -> passes', () => {
  const targetFile = makeFile('assistant-created.md', 'fresh content');
  const transcriptPath = makeTranscript(targetFile);
  const { combinedOutput } = runHook(`rm "${targetFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow for rm of a file the assistant wrote this session');
});

test('rm of a *.log file -> passes (scratch allowlist)', () => {
  const targetFile = makeFile('run-output.log', 'log lines');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`rm "${targetFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow for a .log scratch file');
});

test('rm of a file under the OS temp / scratchpad dir -> passes', () => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), 'session-scratchpad-'));
  const targetFile = join(scratchDirectory, 'whatever-intermediate.json');
  writeFileSync(targetFile, '{}', 'utf8');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`rm "${targetFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow for a file under the OS temp dir');
  rmSync(scratchDirectory, { recursive: true, force: true });
});

test('USER_DELETE_OK present in command -> passes even for a pre-session file', () => {
  const targetFile = makeFile('needs-confirmation.md', 'important doc');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`rm "${targetFile}" USER_DELETE_OK`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow once USER_DELETE_OK token is present');
});

test('mv rename of a pre-session file away from its name -> blocks', () => {
  const targetFile = makeFile('LEDGER-SOURCE-OF-TRUTH-2.md', 'the truth, again');
  const destinationFile = join(sandboxDirectory, 'Truth-ledger-2.md');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`mv "${targetFile}" "${destinationFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny for renaming away a file the assistant never touched');
});

test('malformed JSON on stdin -> silent pass (fail-open)', () => {
  const childProcess = spawnSync('node', [HOOK_PATH], { input: '{not valid json', encoding: 'utf8' });
  const combinedOutput = (childProcess.stdout || '') + (childProcess.stderr || '');
  assert.equal(isBlocked(combinedOutput), false, 'expected no block on malformed input');
  assert.equal(childProcess.status, 0, 'expected clean exit on malformed input');
});

// ── additional coverage beyond the required minimum ────────────────────────────────────────────

test('non-Bash/PowerShell tool_name -> passes untouched', () => {
  const targetFile = makeFile('irrelevant-for-other-tools.md');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`rm "${targetFile}"`, { tool: 'Read', transcriptPath });
  assert.equal(isBlocked(combinedOutput), false);
});

test('git branch -d never blocks (benign, not file-destroying)', () => {
  const { combinedOutput } = runHook('git branch -d feature/some-old-branch');
  assert.equal(isBlocked(combinedOutput), false);
});

test('rm of a nonexistent path -> passes (nothing to destroy)', () => {
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`rm "${join(sandboxDirectory, 'does-not-exist.md')}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), false);
});

test('git rm of a pre-session tracked file -> blocks', () => {
  const targetFile = makeFile('tracked-by-git.md', 'tracked content');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`git rm "${targetFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), true);
});

test('git checkout -- <path> discarding a pre-session file\'s edits -> blocks', () => {
  const targetFile = makeFile('working-tree-edit.md', 'in-progress edit');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`git checkout -- "${targetFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), true);
});

test('git restore <path> discarding a pre-session file\'s edits -> blocks', () => {
  const targetFile = makeFile('another-working-tree-edit.md', 'more in-progress edit');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`git restore "${targetFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), true);
});

test('Remove-Item (PowerShell) of a pre-session file -> blocks', () => {
  const targetFile = makeFile('powershell-target.md', 'doc content');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`Remove-Item "${targetFile}"`, { tool: 'PowerShell', transcriptPath });
  assert.equal(isBlocked(combinedOutput), true);
});

test('DELETE_AUDIT_OVERRIDE=1 env -> passes even for a pre-session file', () => {
  const targetFile = makeFile('override-env-target.md', 'doc content');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`rm "${targetFile}"`, { transcriptPath, env: { DELETE_AUDIT_OVERRIDE: '1' } });
  assert.equal(isBlocked(combinedOutput), false);
});

test('rm inside node_modules -> passes (derived artifact)', () => {
  makeFile('node_modules/some-pkg/index.js', 'module code');
  const transcriptPath = makeTranscript(null);
  const { combinedOutput } = runHook(`rm -rf "${join(sandboxDirectory, 'node_modules', 'some-pkg')}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), false);
});

test('no transcript at all, file older than session start -> blocks (mtime fallback)', async () => {
  const targetFile = makeFile('no-transcript-target.md', 'doc content');
  // The hook computes session-start as (now - process.uptime()), which for a brand-new `node`
  // child process is ~now — so a file written a moment ago can read as "newer than session
  // start" by a hair. Sleep briefly so the file's mtime is unambiguously BEFORE the hook
  // process's own start time.
  await sleepBriefly();
  const { combinedOutput } = runHook(`rm "${targetFile}"`, { transcriptPath: undefined });
  assert.equal(isBlocked(combinedOutput), true, 'expected the mtime-based fallback to still audit a real file when no transcript exists');
});

test('command with no destructive verb (e.g. ls) -> passes', () => {
  const { combinedOutput } = runHook(`ls "${sandboxDirectory}"`);
  assert.equal(isBlocked(combinedOutput), false);
});

// ── 2026-07-03 false-positive regression: background-process run artifact ─────────────────────
// THE LIVE INCIDENT: the assistant launched a background python subprocess pool that wrote
// diag_*.jsonl run-output files directly to disk — never via the Write/Edit tools, so they never
// appear as a tool_use in the transcript. ~90 minutes later, in the SAME session, the assistant
// `mv`'d those files into a quarantine folder. The hook blocked, because the transcript (which DID
// exist) had no Write/Edit record for them. The fix: when a transcript exists but has no record for
// the exact target, a file mtime falling AFTER session start is independent proof of session
// origin — it must pass, not block.
test('mv of a background-process-written .jsonl run artifact (newer than session start, no transcript record) -> passes', async () => {
  // Session "starts" now; the transcript's first entry is timestamped to this moment.
  const sessionStartTimestamp = new Date().toISOString();
  const transcriptPath = makeTranscript(null, { timestamp: sessionStartTimestamp });
  // Simulate the background pool writing the run artifact a beat AFTER the session/transcript
  // started (it never shows up as a Write/Edit tool_use — the transcript has no record of it).
  await sleepBriefly();
  const targetFile = makeFile('diag_slowdict64_runs.jsonl', '{"run": 1}\n');
  const destinationDirectory = join(sandboxDirectory, 'quarantine_slowdict_race');
  mkdirSync(destinationDirectory, { recursive: true });
  const destinationFile = join(destinationDirectory, 'diag_slowdict64_runs.jsonl');
  const { combinedOutput } = runHook(`mv "${targetFile}" "${destinationFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow for a run artifact written mid-session by a background process, even with no transcript record of it');
});

test('rm of a pre-session tracked .md file whose mtime predates the session -> still blocks (canonical incident, unchanged)', async () => {
  // File exists BEFORE the transcript/session "starts" — mtime predates session start, and the
  // transcript has no record of it either. This is the exact shape of the original incident
  // (Russell's manually-renamed LEDGER-SOURCE-OF-TRUTH.md) and must still block after the fix.
  const targetFile = makeFile('LEDGER-SOURCE-OF-TRUTH-3.md', 'the truth, once again');
  await sleepBriefly();
  const sessionStartTimestamp = new Date().toISOString();
  const transcriptPath = makeTranscript(null, { timestamp: sessionStartTimestamp });
  const { combinedOutput } = runHook(`rm "${targetFile}"`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), true, 'expected deny: file predates session start and transcript has no record of it');
});

test('USER_DELETE_OK still overrides even for a background-process-written run artifact case', () => {
  const sessionStartTimestamp = new Date().toISOString();
  const transcriptPath = makeTranscript(null, { timestamp: sessionStartTimestamp });
  const targetFile = makeFile('diag_override_check.jsonl', '{"run": 2}\n');
  const { combinedOutput } = runHook(`rm "${targetFile}" USER_DELETE_OK`, { transcriptPath });
  assert.equal(isBlocked(combinedOutput), false, 'expected allow once USER_DELETE_OK token is present, regardless of provenance path');
});

test.after(() => {
  rmSync(sandboxDirectory, { recursive: true, force: true });
});
