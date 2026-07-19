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
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_RE = /\bceremony-ok\s*:/i;
const INFRA_STREAK_THRESHOLD = 4; // ≥4 trailing infra-only commits, no core since
const SAME_OP_THRESHOLD = 3;      // ≥3 attempts at the SAME external op

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

function parseSession(transcriptPath) {
  const commitFileLists = [];
  const commands = [];
  if (!transcriptPath || !existsSync(transcriptPath)) return { commitFileLists, commands };
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return { commitFileLists, commands }; }
  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue;
      if (block.name !== 'Bash' && block.name !== 'PowerShell') continue;
      const command = String(block.input?.command || '');
      if (!command) continue;
      commands.push(command);
      const committed = commitFilesFrom(command);
      if (committed) commitFileLists.push(committed);
    }
  }
  return { commitFileLists, commands };
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
  const { commitFileLists, commands } = parseSession(transcriptPath);
  let verdict;
  try { verdict = detectCeremony({ commitFileLists, commands, replyText: lastAssistantReply(transcriptPath) }); }
  catch { process.exit(0); } // fail-open
  if (!verdict.block) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
