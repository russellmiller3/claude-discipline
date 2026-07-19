#!/usr/bin/env node
// =============================================================================
// NO-CORE-DELEGATION-GUARD — PreToolUse(Agent): agents OFF by default, and NEVER
//   delegate the load-bearing CORE to one even when they're approved.
// =============================================================================
//
// new-hook-category: Agent-delegation authorization — nearest existing is agent-spawn-guard (same Agent tool boundary) but that ONLY checks brief FORMAT (worktree/pulse/handoff); it never checks WHETHER Russell approved agents this session, nor WHAT is being delegated. This is the authorization layer, not the format layer.
//
// TWICE-bitten (2026-07-16 executeTool extraction; 2026-07-19 exp147c/149 Qwen
// ports fanned to worktree agents on a misread "do it in parallel"). Russell:
// "no agents for core work, none without my signoff. do them yourself. hook
// should have blocked you." agent-spawn-guard happily allowed all of it — it
// only validates the brief shape, never the two things that actually matter.
//
// GATE A — per-session SIGNOFF (deny-by-default). Russell's standing rule
//   (~/.claude/CLAUDE.md, top): "NEVER spawn or work with background agents
//   without EXPLICIT in-session permission. Default = DO THE WORK YOURSELF."
//   So EVERY Agent spawn is DENIED unless a signoff is present:
//     - env AGENTS_APPROVED_THIS_SESSION=1, OR
//     - a sentinel file at ~/.claude/AGENTS_APPROVED_THIS_SESSION
//       (override path: AGENTS_APPROVAL_SENTINEL), OR
//     - the literal token AGENTS_APPROVED in the Agent prompt.
//   "in parallel" is NOT signoff — parallel means parallel TOOL CALLS or POD
//   runs, not spawning build-agents.
//
// GATE B — never delegate CORE, even WITH a signoff. A spawn whose brief targets
//   CORE / load-bearing code with an EDIT verb (extract/refactor/rewrite/
//   implement/move/split/modify/change/edit/build/port) is BLOCKED. Reading /
//   auditing core is fine; editing peripheral code is fine. Only delegating
//   EDITS to the core is blocked. A scientific experiment worker (the code that
//   produces a patent claim's result) IS core. Override: CORE_AGENT_OK in the
//   brief (Russell only — never self-grant).
//
// Core paths per repo: <repo>/.claude/core-paths.txt (one glob/path per line).
// If absent, a conservative built-in brain-ish list is used.
//
// Teeth: permissionDecision 'deny'. Fail-open on any error.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Verbs that EDIT code (delegating these to the core is the danger).
const EDIT_VERB_RE = /\b(extract|refactor|re-?architect|rewrite|re-?implement|implement|port|move|split|modify|change|edit|build|create|add|wire|patch|overhaul|migrat\w*|convert)\b/i;

// Built-in brain-ish signals used ONLY when a repo has no .claude/core-paths.txt.
const BUILTIN_CORE_SIGNALS = [
  /\bgateway\.ts\b/i,
  /\bexecuteTool\b/,
  /\bengine\b/i,
  /\bcompiler\b/i,
  /\binterpreter\b/i,
  /[\/\\]brain\b/i,
  /[\/\\]core[\/\\]/i,
];

const SIGNOFF_ENV = 'AGENTS_APPROVED_THIS_SESSION';
const SENTINEL_PATH_ENV = 'AGENTS_APPROVAL_SENTINEL';
const IN_PROMPT_SIGNOFF = /\bAGENTS_APPROVED\b/;
const CORE_OVERRIDE = /\bCORE_AGENT_OK\b/;

function escapeForRegExp(rawText) {
  return String(rawText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sentinelPath() {
  return process.env[SENTINEL_PATH_ENV] || join(homedir(), '.claude', SIGNOFF_ENV);
}

// A core-paths glob -> matchers. The prompt rarely names the FULL path, so we also derive a distinctive
// STEM (the last non-glob path segment, extension + `*` stripped) and match it as a word. Short stems
// (< 5 chars, e.g. "exp") require a trailing digit so a bare "exp" in "explain/export" doesn't false-fire.
export function globToCoreSignals(glob) {
  const normalized = String(glob || '').replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('#')) return [];
  const signals = [];
  const literalBase = normalized.split('/').filter((segment) => segment && segment !== '**' && segment !== '*').pop() || '';
  if (literalBase && !/[*]/.test(literalBase)) {
    signals.push(new RegExp(escapeForRegExp(literalBase), 'i')); // literal path/basename mention
  }
  const stem = literalBase.replace(/\.[a-z0-9]+$/i, '').replace(/\*+/g, '');
  if (stem.length >= 2) {
    const needsDigit = stem.length < 5;
    signals.push(new RegExp(`\\b${escapeForRegExp(stem)}${needsDigit ? '\\d' : ''}\\w*`, 'i'));
  }
  return signals;
}

// Does the prompt name a CORE path? Returns the matched signal's source, or null. Pure.
export function matchesCore(prompt, coreGlobs) {
  const haystack = String(prompt || '');
  const globs = Array.isArray(coreGlobs) ? coreGlobs.filter(Boolean) : [];
  const signalSets = globs.length ? globs.flatMap((glob) => globToCoreSignals(glob)) : BUILTIN_CORE_SIGNALS;
  for (const signal of signalSets) {
    if (signal.test(haystack)) return signal.source;
  }
  return null;
}

const GATE_A_REASON = `Agent spawn BLOCKED — agents are OFF by default (Russell's standing rule).

"NEVER spawn or work with background agents without EXPLICIT in-session permission. Default = DO THE WORK YOURSELF." Do this work in the main thread yourself, OR ask Russell to approve agents for THIS task.

"Do it in parallel" is NOT approval — that means parallel TOOL CALLS or parallel POD runs, not spawning build-agents.

To approve for this session: set ${SIGNOFF_ENV}=1, create the sentinel file (${SIGNOFF_ENV} under ~/.claude), or put the literal token AGENTS_APPROVED in the brief once Russell has said yes.`;

// Pure core: returns { block, gate?, reason? }. `approved` = env/sentinel signoff already resolved.
export function evaluateAgentDelegation({ prompt = '', approved = false, coreGlobs = [] } = {}) {
  const promptText = String(prompt || '');

  // Gate A — signoff (deny-by-default).
  if (!approved && !IN_PROMPT_SIGNOFF.test(promptText)) {
    return { block: true, gate: 'A', reason: GATE_A_REASON };
  }

  // Gate B — never delegate CORE edits (even with a signoff), unless CORE_AGENT_OK.
  if (CORE_OVERRIDE.test(promptText)) return { block: false };
  const coreHit = matchesCore(promptText, coreGlobs);
  if (coreHit && EDIT_VERB_RE.test(promptText)) {
    return {
      block: true,
      gate: 'B',
      reason: `Agent spawn BLOCKED — CORE work must be done by the MAIN THREAD, not an agent.

The brief targets load-bearing code (matched: ${coreHit}) with an edit verb. Agents are for peripheral, parallel, bounded units; the load-bearing center of a product (or the code that produces a scientific/patent claim's result) must be built by the main thread, which has to understand it line-by-line and vouch for it.

Do it yourself. Reading/auditing the core with an agent is fine (read-only); only delegating EDITS to it is blocked. If Russell knowingly approves this specific core delegation, put CORE_AGENT_OK in the brief (never self-grant).`,
    };
  }
  return { block: false };
}

// Read <startDir>/.claude/core-paths.txt, walking up to the repo root. Returns an array of globs (or []).
export function readCoreGlobs(startDir, readFn = readFileSync, existsFn = existsSync) {
  let probeDir = resolve(startDir || process.cwd());
  for (let depth = 0; depth < 14; depth++) {
    const candidate = join(probeDir, '.claude', 'core-paths.txt');
    if (existsFn(candidate)) {
      try {
        return readFn(candidate, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
      } catch { return []; }
    }
    const parent = dirname(probeDir);
    if (parent === probeDir) break;
    probeDir = parent;
  }
  return [];
}

function hasSessionSignoff() {
  if (process.env[SIGNOFF_ENV] === '1') return true;
  try { if (existsSync(sentinelPath())) return true; } catch { /* ignore */ }
  return false;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  if ((event.tool_name || '') !== 'Agent') process.exit(0);

  const prompt = event.tool_input?.prompt || '';
  const sessionDir = event.cwd || process.cwd();
  let coreGlobs = [];
  try { coreGlobs = readCoreGlobs(sessionDir); } catch { /* fail-open to built-in signals */ }

  let verdict;
  try { verdict = evaluateAgentDelegation({ prompt, approved: hasSessionSignoff(), coreGlobs }); }
  catch { process.exit(0); } // fail-open — a buggy guard must never block all agent work permanently
  if (!verdict.block) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason,
    },
  }));
  process.exit(0);
}

// Entry-point guard by BASENAME (the Windows import.meta gotcha) so tests import the pure core.
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
