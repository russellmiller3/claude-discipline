#!/usr/bin/env node
// =============================================================================
// CEREMONY-RABBITHOLE-GUARD — Stop: bite when the session becomes CEREMONY —
//   a streak of INFRA churn with no commit landing the CORE deliverable.
// =============================================================================
//
// new-hook-category: Ceremony / rabbit-hole detection — nearest existing is getty-no-repeat-mistakes (both enforce a Getty rule) but that arms ONLY on Russell's CORRECTION wording in a user message; it has NO detector for the ceremony pattern (many turns on the same infra layer with no core-value commit). This is that missing detector, session-scoped.
//
// The incident (2026-07-19, Russell "WHY DIDNT GETTY BITE?"): the core deliverable was a
// reduced-to-practice 1.5B claim; instead ~10 turns went to chasing a TRANSIENT pod crash and
// hand-patching pod-lifecycle plumbing — real bugs, but NOT the science, and the crash didn't even
// reproduce. That is the Getty "avoid ceremony that doesn't create value" rule + its "attempt #3+ at
// the same infra layer AFTER the core result is banked -> bank + hand off" signal. The rule lived only
// in CLAUDE.md (advisory), so it got ignored — the exact "advisory rules get ignored, use a hook".
//
// PROJECT-AGNOSTIC — no repo-specific paths. THE PATTERN (detectable, session-scoped):
//   (1) A trailing STREAK of INFRA-only commits (meta/tooling/config/docs — hooks, CI, *.md, *.json/
//       yaml, dotfiles, monitor dashboards) with NO commit touching the CORE deliverable (a real
//       SOURCE file that ships value — product code, a library, worker logic, a shipped surface, or a
//       test of it) since. Infra fixes IN SERVICE of a result are fine; a STREAK with no result is the
//       tell. A healthy loop (infra -> core -> infra -> core) never fires.
//   (2) ≥3 attempts at the SAME external op (an identical launch/deploy/remote-run/network command
//       retried 3+ times) — the Getty "attempt #3+ at the same layer" signal, verbatim.
//
// Override: `ceremony-ok: <why this infra IS the core deliverable right now>` in the reply (e.g. the
// task literally IS building the hook/launcher). Never self-grant to keep grinding. Fail-open.
//
// -----------------------------------------------------------------------------------------------
// DETECTOR 3 (2026-07-21) — DUPLICATE VERIFICATION: the same whole-project gate (npm test, pytest,
// go test ./..., a full lint/typecheck/build/e2e run, …) proving success TWICE against the SAME
// content snapshot. The incident: focused tests + diagnostics passed, then the identical 615-test
// full gate re-ran across multiple commits with no material code change between runs — one full
// gate was proof, every rerun after it was ceremony, not additional evidence.
//
// Honest boundary: this is a Stop hook. It cannot intercept or rewind a command already run — it
// can only look back at the transcript at the end of a turn, name the exact proof that got
// duplicated, and block a clean stop until the session either does something about it or states a
// real reason. It has no PreToolUse half; Russell chose Stop-only ownership for this detector.
//
// A "content epoch" is the span between real file-content mutations (a successful Write/Edit/
// MultiEdit/NotebookEdit, or an unambiguous patch-apply shell command). Two whole-project gate runs
// are only a duplicate if they both SUCCEEDED in the SAME epoch — `git add`/`git commit`/`git
// status`/`git diff`/rereading files never advance the epoch, so committing between two identical
// full-suite runs does not excuse the second one. A gate echoed inside a successful `git commit`
// (pre-commit/husky output) counts exactly like a direct run for this purpose.
//
// Override: `verification-rerun-ok: <why repeating the unchanged full gate was necessary>` (reason
// required — a bare token does not clear it). The pre-existing `ceremony-ok:` token also clears this
// detector, kept intentionally so both detectors share one override vocabulary.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_RE = /\bceremony-ok\s*:/i;
const INFRA_STREAK_THRESHOLD = 4; // ≥4 trailing infra-only commits, no core since
const SAME_OP_THRESHOLD = 3;      // ≥3 attempts at the SAME external op

// Duplicate-verification override: requires an actual reason, not just the bare token.
const VERIFICATION_RERUN_OVERRIDE_RE = /\bverification-rerun-ok\s*:\s*(\S.*)/i;

// A normalized-identity table of whole-project gate families. Each `trigger` matches the command
// (or, for a commit-hook run, the echoed output) that invokes the WHOLE suite/check; `requireAll`
// (when present) are additional markers that must ALSO be present (e.g. go test needs `./...`).
// Data-driven and project-agnostic — no repo names, paths, or test counts.
const GATE_FAMILIES = [
  { id: 'js-test', trigger: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::all)?\b/i },
  { id: 'vitest', trigger: /\bvitest\s+run\b/i },
  { id: 'jest', trigger: /\bjest\b/i },
  { id: 'pytest', trigger: /\bpytest\b/i },
  { id: 'go-test', trigger: /\bgo\s+test\b/i, requireAll: [/\.\/\.\.\.(?:\s|$)/] },
  { id: 'cargo-test', trigger: /\bcargo\s+test\b/i },
  { id: 'dotnet-test', trigger: /\bdotnet\s+test\b/i },
  { id: 'lint', trigger: /\b(?:npm|pnpm|yarn|bun)\s+run\s+lint\b|\beslint\s+\.(?:\s|$)/i },
  { id: 'typecheck', trigger: /\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:typecheck|type-check|check)\b|\btsc\s+--noEmit\b/i },
  { id: 'build', trigger: /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b/i },
  { id: 'e2e', trigger: /\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:e2e|test:e2e)\b|\bplaywright\s+test\b|\bcypress\s+run\b/i },
];

// A file/test/pattern selector anywhere in the command downgrades a would-be whole-project gate to
// FOCUSED — it is scoped to less than the whole project, so it never counts as a whole-project gate.
const SELECTOR_FLAG_RE = /(^|\s)(-t|--testNamePattern|--grep|-k|--filter|--testPathPattern|-run)(=|\s|$)/i;
const SELECTOR_NODE_ID_RE = /::[\w./-]+/;
const SELECTOR_JS_TEST_FILE_RE = /[\w./-]*\.(?:test|spec)\.[cm]?[jt]sx?\b/i;
const SELECTOR_PY_FILE_ARG_RE = /(^|[\s"'])[\w./-]+\.py(?=[\s"']|$)/;

// A content-mutating shell idiom that isn't a Write/Edit/MultiEdit/NotebookEdit tool call but still
// changes file content — advances the content epoch just like those tool calls do.
const PATCH_COMMAND_RE = /\bgit\s+apply\b|\bpatch\s+-p\d?\b|\bsed\s+-i\b/i;
const CONTENT_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// PROJECT-AGNOSTIC classification. INFRA = meta/tooling/config/docs churn (the scaffolding around a
// product); CORE = a real source file that ships value (product code, a library, worker logic, a
// shipped surface) or a test of it. No project-specific paths — works for any repo.
const META_DIR = /(?:^|\/)(?:hooks|\.github|\.claude|\.husky|\.circleci|\.gitlab|ci|deploy|infra|scripts\/deploy)\//i;
const DASHBOARD = /-live\.html$/i;                    // a monitor/telemetry dashboard, not product UI
const DOC_EXT = /\.(?:md|markdown|rst|txt|adoc)$/i;   // docs (README/CHANGELOG/HANDOFF/notes/briefs)
const CONFIG_EXT = /\.(?:json|ya?ml|toml|ini|cfg|conf|lock|env)$/i; // config / lockfiles
const DOTFILE = /(?:^|\/)\.[^/]+$/;                   // .gitignore / .editorconfig / etc.

// True when a changed path is INFRA (not the CORE deliverable). Anything else — a real source file with
// a code extension outside a meta dir — is CORE.
export function isInfraPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return false;
  if (META_DIR.test(normalized)) return true;
  if (DASHBOARD.test(normalized)) return true;
  if (DOC_EXT.test(normalized) || CONFIG_EXT.test(normalized)) return true;
  if (DOTFILE.test(normalized)) return true;
  return false;
}

// Classify one commit by its changed files: 'infra' (all files infra), 'core' (≥1 non-infra file), or
// 'empty' (no known files — neither counts nor breaks a streak).
export function classifyCommit(files) {
  const changedFiles = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!changedFiles.length) return 'empty';
  return changedFiles.every((filePath) => isInfraPath(filePath)) ? 'infra' : 'core';
}

// Count the trailing run of infra-only commits (newest-last order), stopping at the first CORE commit.
// 'empty' commits are skipped (no evidence either way). A CORE commit anywhere in the trailing run
// resets the streak to what came after it — so a healthy infra->core->infra loop never accumulates.
export function trailingInfraOnlyStreak(classifications) {
  let streak = 0;
  for (let index = (classifications || []).length - 1; index >= 0; index--) {
    const kind = classifications[index];
    if (kind === 'core') break;
    if (kind === 'infra') streak += 1;
  }
  return streak;
}

// An EXTERNAL / expensive op — a launch, deploy, remote run, or network retry. Project-agnostic verb
// list; a repeated IDENTICAL such command across the session is the "attempt #3+ at the same op" signal.
// Read-only/local commands (git status, ls, cat, node --test) are never external ops.
const EXTERNAL_OP_RE = /\b(?:launch|deploy|publish|terminate|provision|runpod\w*|modal|kubectl|terraform|helm|ansible|docker\s+(?:run|build|push)|curl|wget|ssh|scp|rsync|npm\s+publish|gh\s+(?:release|workflow)|sbatch|srun|aws\s+\w+|gcloud\s+\w+)\b/i;

// The op signature: the command with volatile-only noise (surrounding whitespace) normalized, but its
// DISTINGUISHING args intact — so the SAME op retried collapses to one key while genuinely different
// targets (different seeds, different endpoints) stay distinct. Null when it's not an external op.
export function externalOpSignature(command) {
  const commandText = String(command || '');
  if (!EXTERNAL_OP_RE.test(commandText)) return null;
  return commandText.replace(/\s+/g, ' ').trim().toLowerCase();
}

// The largest count of any single external op repeated across the session. ≥ SAME_OP_THRESHOLD is the
// "same failing op attempted 3+ times" rabbit-hole (a launch that won't take, an endpoint retried).
export function repeatedSameOpCount(commands) {
  const counts = new Map();
  for (const command of commands || []) {
    const signature = externalOpSignature(command);
    if (!signature) continue;
    counts.set(signature, (counts.get(signature) || 0) + 1);
  }
  let maxCount = 0;
  for (const count of counts.values()) if (count > maxCount) maxCount = count;
  return maxCount;
}

// Pure decision.
export function detectCeremony({ commitFileLists = [], commands = [], replyText = '', infraStreakThreshold = INFRA_STREAK_THRESHOLD, sameOpThreshold = SAME_OP_THRESHOLD } = {}) {
  if (OVERRIDE_RE.test(replyText)) return { block: false };
  const streak = trailingInfraOnlyStreak(commitFileLists.map(classifyCommit));
  if (streak >= infraStreakThreshold) {
    return { block: true, reason: ceremonyReason(`${streak} straight INFRA-only commits with no commit landing the CORE deliverable`) };
  }
  const sameOp = repeatedSameOpCount(commands);
  if (sameOp >= sameOpThreshold) {
    return { block: true, reason: ceremonyReason(`the SAME external op attempted ${sameOp}× (attempt #3+ at the same layer)`) };
  }
  return { block: false };
}

function ceremonyReason(what) {
  return `CEREMONY CHECK — ${what}. This is the rabbit-hole the Getty "avoid ceremony that doesn't create value" rule names.

BANK what works, state the CORE result's status in ONE line, then either:
  (a) take the ONE action that advances the core deliverable (the science / the shipped surface / the verdict), or
  (b) if it's genuinely blocked, say the blocker in one line and HAND OFF — do NOT keep patching the infra.

Infra fixes in service of a result are fine; a STREAK of them with no result landing is the tell (attempt #3+ at the same layer after the core is banked = bank + hand off, not push).
Override (only when the infra IS the deliverable right now — e.g. the task literally is building this hook/launcher): put ceremony-ok: <why> in your reply.`;
}

// ---------- duplicate-verification detection (session-scoped) ----------

// True when `command` carries a selector that scopes it to LESS than the whole project — a
// specific file/spec, a test-name pattern, a pytest/dotnet node id, or a package filter. Any match
// means the command is FOCUSED, never a whole-project gate, regardless of which family it belongs to.
export function hasSelectorMarker(command) {
  const normalizedCommand = String(command || '');
  if (SELECTOR_FLAG_RE.test(normalizedCommand)) return true;
  if (SELECTOR_NODE_ID_RE.test(normalizedCommand)) return true;
  if (SELECTOR_JS_TEST_FILE_RE.test(normalizedCommand)) return true;
  if (SELECTOR_PY_FILE_ARG_RE.test(normalizedCommand) && /\bpytest\b/i.test(normalizedCommand)) return true;
  return false;
}

// The normalized whole-project gate family `command` invokes, or null when it doesn't match any
// known family, or matches one but is scoped down by a selector (focused, not whole-project).
export function matchGateFamily(command) {
  const normalizedCommand = String(command || '');
  for (const family of GATE_FAMILIES) {
    if (!family.trigger.test(normalizedCommand)) continue;
    if (family.requireAll && !family.requireAll.every((marker) => marker.test(normalizedCommand))) continue;
    if (hasSelectorMarker(normalizedCommand)) return null;
    return family.id;
  }
  return null;
}

// Every whole-project family whose trigger appears in `commitOutput` with no selector — used to find
// a gate that ran NESTED inside a `git commit`'s own output (a pre-commit/husky hook echoing the
// underlying test/lint/build command it ran). Each hit is paired with its outcome from that same output.
export function nestedGateRunsInOutput(commitOutput) {
  const normalizedOutput = String(commitOutput || '');
  const found = [];
  for (const family of GATE_FAMILIES) {
    if (!family.trigger.test(normalizedOutput)) continue;
    if (family.requireAll && !family.requireAll.every((marker) => marker.test(normalizedOutput))) continue;
    if (hasSelectorMarker(normalizedOutput)) continue;
    found.push({ familyId: family.id, outcome: classifyGateOutcome(family.id, normalizedOutput, false) });
  }
  return found;
}

// 'pass' | 'fail' | 'unknown' — read from OUTPUT TEXT, never from the shell exit code: a command
// chained through `| tail` or `2>&1 | grep` reports the pipeline's exit, not the test runner's, so
// `is_error` on the tool result is unreliable and only used as a last-resort signal for generic gates.
export function classifyGateOutcome(familyId, gateOutput, isError) {
  const normalizedGateOutput = String(gateOutput || '');
  switch (familyId) {
    case 'pytest': {
      const failed = normalizedGateOutput.match(/(\d+)\s+failed\b/i);
      const errored = normalizedGateOutput.match(/(\d+)\s+error(?:s)?\b/i);
      const passed = normalizedGateOutput.match(/(\d+)\s+passed\b/i);
      if ((failed && Number(failed[1]) > 0) || (errored && Number(errored[1]) > 0)) return 'fail';
      if (passed && Number(passed[1]) > 0) return 'pass';
      return 'unknown';
    }
    case 'js-test':
    case 'vitest':
    case 'jest':
    case 'e2e': {
      const failed = normalizedGateOutput.match(/(\d+)\s+(?:failed|failing)\b/i);
      if (failed && Number(failed[1]) > 0) return 'fail';
      if (/npm ERR!/i.test(normalizedGateOutput)) return 'fail';
      const passed = normalizedGateOutput.match(/(\d+)\s+passing\b/i) || normalizedGateOutput.match(/(\d+)\s+passed\b/i);
      if (passed && Number(passed[1]) > 0) return 'pass';
      return 'unknown';
    }
    case 'go-test':
      if (/\bFAIL\b/.test(normalizedGateOutput)) return 'fail';
      if (/\bok\s+\S+/.test(normalizedGateOutput)) return 'pass';
      return 'unknown';
    case 'cargo-test':
      if (/test result:\s*FAILED/i.test(normalizedGateOutput)) return 'fail';
      if (/test result:\s*ok/i.test(normalizedGateOutput)) return 'pass';
      return 'unknown';
    case 'dotnet-test': {
      const failed = normalizedGateOutput.match(/Failed:\s*(\d+)/i);
      const passed = normalizedGateOutput.match(/Passed:\s*(\d+)/i);
      if (failed && Number(failed[1]) > 0) return 'fail';
      if (/Passed!/i.test(normalizedGateOutput) || (passed && Number(passed[1]) > 0)) return 'pass';
      return 'unknown';
    }
    default: { // lint / typecheck / build — formats vary too much per project to pattern-match precisely
      if (/\berror(?:s)?\b/i.test(normalizedGateOutput) && !/\b0\s+errors?\b/i.test(normalizedGateOutput)) return 'fail';
      if (isError) return 'fail';
      return normalizedGateOutput.trim() ? 'pass' : 'unknown';
    }
  }
}

// One session-scoped, chronologically-ordered pass over `events` (see parseSession's `events`
// output) that returns every PROVEN (successful) whole-project gate run, each tagged with the
// content epoch it ran in. Epoch advances only on a real content mutation — see CONTENT_EDIT_TOOLS /
// PATCH_COMMAND_RE above; `git add`/`git commit`/reads/reruns never advance it.
export function buildVerificationLedger(events) {
  let epoch = 0;
  const provenRuns = [];
  for (const event of events || []) {
    if (!event) continue;
    if (event.kind === 'edit') {
      if (event.isError !== true) epoch += 1;
      continue;
    }
    if (event.kind !== 'shell') continue;
    const command = event.command || '';
    if (/\bgit\s+commit\b/.test(command)) {
      for (const { familyId, outcome } of nestedGateRunsInOutput(event.outputText)) {
        if (outcome === 'pass') provenRuns.push({ familyId, epoch, viaCommitHook: true });
      }
    } else {
      const familyId = matchGateFamily(command);
      if (familyId) {
        const outcome = classifyGateOutcome(familyId, event.outputText, event.isError);
        if (outcome === 'pass') provenRuns.push({ familyId, epoch, viaCommitHook: false });
      }
    }
    if (PATCH_COMMAND_RE.test(command) && event.isError !== true) epoch += 1;
  }
  return provenRuns;
}

function hasDuplicateVerificationOverride(replyText) {
  const reply = String(replyText || '');
  const match = reply.match(VERIFICATION_RERUN_OVERRIDE_RE);
  if (match && match[1] && match[1].trim()) return true;
  return OVERRIDE_RE.test(reply); // the pre-existing ceremony-ok token, kept working for both detectors
}

// Pure decision. Groups every PROVEN whole-project run by `${epoch}:${familyId}`; ≥2 in the same
// group is the same gate proving success twice against unchanged code.
export function detectDuplicateVerification({ events = [], replyText = '' } = {}) {
  if (hasDuplicateVerificationOverride(replyText)) return { block: false };
  const groups = new Map();
  for (const run of buildVerificationLedger(events)) {
    const key = `${run.epoch}:${run.familyId}`;
    const group = groups.get(key) || { familyId: run.familyId, epoch: run.epoch, count: 0, viaCommitHook: false };
    group.count += 1;
    if (run.viaCommitHook) group.viaCommitHook = true;
    groups.set(key, group);
  }
  const duplicates = [...groups.values()].filter((group) => group.count >= 2);
  if (!duplicates.length) return { block: false };
  return { block: true, reason: duplicateVerificationReason(duplicates) };
}

const GATE_LABELS = {
  'js-test': 'the JS/TS test suite (npm/pnpm/yarn/bun test)',
  vitest: 'vitest run',
  jest: 'jest',
  pytest: 'pytest',
  'go-test': 'go test ./...',
  'cargo-test': 'cargo test',
  'dotnet-test': 'dotnet test',
  lint: 'the full lint gate',
  typecheck: 'the full typecheck/check gate',
  build: 'the full build',
  e2e: 'the end-to-end suite',
};

function duplicateVerificationReason(duplicates) {
  const lines = duplicates.map((duplicate) => `  - ${GATE_LABELS[duplicate.familyId] || duplicate.familyId}: succeeded ${duplicate.count}× in the same content epoch${duplicate.viaCommitHook ? ' (includes a commit-hook copy)' : ''}`);
  return `DUPLICATE VERIFICATION — the same whole-project gate proved success more than once against unchanged code:
${lines.join('\n')}

One successful full gate is proof. Running it again with no content change is ceremony, not additional evidence.
  1. Keep focused tests during development.
  2. Choose ONE owner for the final whole-project proof.
  3. If pre-commit already owns the full gate, do not manually run that same full gate immediately before committing — let the commit hook provide the single canonical proof.
  4. Never bypass a required hook with --no-verify merely to silence this guard.
  5. After a real content edit, one new full gate is valid because it proves a new snapshot.
Override only for a genuine exception: verification-rerun-ok: <why repeating the unchanged full gate was necessary>`;
}

// ---------- transcript parsing (session-scoped) ----------

// Files a `git commit` command committed: `-o a b c` args, plus any `git add a b c` in the same command.
function commitFilesFrom(command) {
  const commandText = String(command || '');
  if (!/\bgit\s+commit\b/.test(commandText)) return null;
  const files = [];
  const dashOMatch = commandText.match(/\bgit\s+commit\b[\s\S]*?\s-o\s+([\s\S]*?)(?=\s-m\b|\s--message\b|$)/);
  if (dashOMatch) files.push(...dashOMatch[1].split(/\s+/).filter((token) => token && !token.startsWith('-')));
  for (const addMatch of commandText.matchAll(/\bgit\s+add\s+([\s\S]*?)(?=&&|;|\bgit\b|$)/g)) {
    files.push(...addMatch[1].split(/\s+/).filter((token) => token && !token.startsWith('-') && token !== '.' && token !== '-A'));
  }
  return files;
}

// Every tool_result in the transcript, keyed by the tool_use_id it answers — built in one pass so the
// second pass (below) can pair each tool_use with its outcome without a nested scan.
function toolResultsByCallId(lines) {
  const resultsByCallId = new Map();
  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      const outputText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      resultsByCallId.set(block.tool_use_id, { outputText, isError: block.is_error === true });
    }
  }
  return resultsByCallId;
}

// Parses the transcript ONCE into everything the ceremony + duplicate-verification detectors need:
// `commitFileLists`/`commands` (ceremony detector, unchanged) and `events` (duplicate-verification
// detector) — a chronologically-ordered list of shell calls and content-editing tool calls, each
// paired with its outcome via `toolResultsByCallId`.
function parseSession(transcriptPath) {
  const commitFileLists = [];
  const commands = [];
  const events = [];
  if (!transcriptPath || !existsSync(transcriptPath)) return { commitFileLists, commands, events };
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return { commitFileLists, commands, events }; }

  const resultsByCallId = toolResultsByCallId(lines);

  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue;
      if (block.name === 'Bash' || block.name === 'PowerShell') {
        const command = String(block.input?.command || '');
        if (!command) continue;
        commands.push(command);
        const committed = commitFilesFrom(command);
        if (committed) commitFileLists.push(committed);
        const outcome = resultsByCallId.get(block.id) || { outputText: '', isError: null };
        events.push({ kind: 'shell', command, outputText: outcome.outputText, isError: outcome.isError });
      } else if (CONTENT_EDIT_TOOLS.has(block.name)) {
        const outcome = resultsByCallId.get(block.id) || { outputText: '', isError: null };
        events.push({ kind: 'edit', tool: block.name, isError: outcome.isError });
      }
    }
  }
  return { commitFileLists, commands, events };
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
  if ((event.hook_event_name || event.hookEventName) !== 'Stop') process.exit(0);
  if (event.stop_hook_active) process.exit(0); // never loop

  const transcriptPath = event.transcript_path || event.transcriptPath || '';
  const { commitFileLists, commands, events } = parseSession(transcriptPath);
  const replyText = lastAssistantReply(transcriptPath);
  let verdict;
  try {
    verdict = detectCeremony({ commitFileLists, commands, replyText });
    if (!verdict.block) verdict = detectDuplicateVerification({ events, replyText });
  } catch { process.exit(0); } // fail-open
  if (!verdict.block) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
