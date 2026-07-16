/**
 * agentSpawnGates — every PreToolUse(Agent) spawn-validation gate, one library.
 *
 * Consolidated 2026-07-15 (Russell, "one hook per idea"): SEVEN hooks each denied one property of an Agent
 * spawn on the SAME event with the SAME input (the brief). They're one idea — "is this Agent spawn valid?" —
 * so they're now one hook (agent-spawn-guard.mjs) running these gates in order, first-deny-wins. Retired:
 * agent-sidebar-only, background-on-agent-spawn, worktree-on-agent-spawn, cross-repo-worktree-on-agent-spawn,
 * agent-commit-cadence, agent-handoff-required, widget-ux-not-cli.
 *
 * Each gate is a pure function (input, context) -> reason string | null. `context` carries the resolved
 * environment + filesystem facts the hook computed once (env, sessionRepoRoot, widgetExists, isGitRepo). Order
 * matters: sidebar-only fires FIRST ("should this be an agent at all?" precedes durability gates); the rest
 * follow the historical chain. Every gate fails open (returns null) on doubt.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// A worktree (file-writing) agent is the one that must carry the durability instructions; read-only / non-isolated
// agents have nothing to commit or hand off. Extracted so the two brief-content gates share one definition.
function isWorktreeAgent(input) {
  return (input.isolation || '') === 'worktree';
}

// ---------------------------------------------------------------------------
// Gate 1 — SIDEBAR-ONLY: agents are for sidebar work; a read-only/research-shaped brief the orchestrator is
// waiting on must run INLINE, not as an agent. (was agent-sidebar-only.mjs)
// ---------------------------------------------------------------------------
const WRITE_CONTRACT_MARKERS = [
  /safe-merge-to-main\.sh/i,
  /\bMERGE:\s*land your branch\b/i,
  /\bAGENT-HANDOFF\.md\b[^\n]{0,120}\bcommit\b/i,
];
const RESEARCH_SHAPES = [
  /\bREAD[-\s]?ONLY\b/i,
  /\bwrites?\s+NOTHING\b/i,
  /\bweb[-\s]?research\b/i,
  /\bresearch\s+(agent|question|one[-\s]?shot)\b/i,
  /\bas your final message\b/i,
  /\bFOREGROUND_OK\b/,
];

export function researchShape(prompt) {
  if (!prompt) return null;
  if (/\bSIDEBAR_OK\b/.test(prompt)) return null;
  for (const marker of WRITE_CONTRACT_MARKERS) if (marker.test(prompt)) return null;
  for (const shape of RESEARCH_SHAPES) { const matched = prompt.match(shape); if (matched) return matched[0]; }
  return null;
}

export function gateSidebarOnly(input, context) {
  if (context.env.AGENT_SIDEBAR_ONLY_OK === '1') return null;
  const shape = researchShape(input.prompt || '');
  if (!shape) return null;
  return `"${input.description || '(unnamed)'}" looks like MAIN-TASK work (read-only/research-shaped brief, matched: "${shape}").

Russell's rule (2026-07-12): agents are for SIDEBAR work only — work that runs BESIDE a still-moving main thread. If your next step WAITS on this result (research feeding the plan, a lookup the next edit needs), do it INLINE with WebSearch/WebFetch/Grep/Read now.
Override (genuine sidebar work): add SIDEBAR_OK + one line stating what the main thread does meanwhile; env AGENT_SIDEBAR_ONLY_OK=1.`;
}

// ---------------------------------------------------------------------------
// Gate 2 — BACKGROUND: every agent must be run_in_background:true so it survives an interrupt.
// (was background-on-agent-spawn.mjs)
// ---------------------------------------------------------------------------
export function gateBackground(input) {
  if (input.run_in_background === true) return null;
  if (/\bFOREGROUND_RUSSELL_OK\b/.test(input.prompt || '')) return null;
  return `"${input.description || '(unnamed)'}" is not run_in_background: true.

Russell's rule (2026-06-29): EVERY agent — build OR research — must spawn with run_in_background: true so it survives an interrupt. A foreground agent dies the instant the turn is interrupted (it is owned by the turn, not the session), losing all in-flight work.
Fix: add run_in_background: true. Override (rare — Russell wants this ONE foreground): FOREGROUND_RUSSELL_OK. Never self-grant.`;
}

// ---------------------------------------------------------------------------
// Gate 3 — WORKTREE: every write-agent must be worktree-isolated. (was worktree-on-agent-spawn.mjs)
// ---------------------------------------------------------------------------
export function gateWorktree(input) {
  if (isWorktreeAgent(input)) return null;
  const prompt = input.prompt || '';
  if (/\bworktree\s+add\b/i.test(prompt)) return null;   // sets up its own (cross/sibling repo)
  if (/\bFOREGROUND_OK\b/.test(prompt)) return null;      // read-only one-shot, no tree to clobber
  if (/\bNO_WORKTREE_RUSSELL_OK\b/.test(prompt)) return null;
  return `"${input.description || '(unnamed)'}" is not worktree-isolated.

Russell's rule (2026-05-13, hardened 2026-06-27): EVERY write-agent must be isolated in its own git worktree so concurrent agents can't clobber each other's branch + files.
Pick one: (1) same-repo → add isolation: "worktree"; (2) cross/sibling repo → brief runs \`git worktree add <dir> -b <branch> <base>\` first and works there; (3) read-only one-shot → add FOREGROUND_OK; (4) Russell approved → NO_WORKTREE_RUSSELL_OK (never self-grant).`;
}

// ---------------------------------------------------------------------------
// Gate 4 — CROSS-REPO: a brief driving a SIBLING repo by absolute path must set up its OWN worktree there
// (isolation: param only isolates the session repo). (was cross-repo-worktree-on-agent-spawn.mjs)
// ---------------------------------------------------------------------------
function normalizePath(rawPath) {
  return rawPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function extractAbsolutePathMatches(prompt) {
  const matches = [];
  for (const found of [...prompt.matchAll(/[A-Za-z]:[\\/][^\s`'"<>|]+/g), ...prompt.matchAll(/\/[a-zA-Z]\/[Uu]sers\/[^\s`'"<>|]+/g)]) {
    matches.push({ normalized: normalizePath(found[0].replace(/[.,;:)\]]+$/, '')), index: found.index });
  }
  return matches;
}

const INTENT_WINDOW = 120;
const READ_CUE = /\b(read|references?|read-only|for reference|see|per)\b/i;
const WRITE_CUE = /\b(edit|write(?:s|ing)? to|modify|modifies|commit|checkout|create|build\b[^.]{0,40}\bin\b|git\s+(?!worktree\s+add))\b/i;
const CLAUSE_BOUNDARY = /[.;\n]|,\s+then\b/i;
const CONTEXT_DIR = 'c:/users/rmill/desktop/programming/context';

function clauseWindowAround(prompt, index) {
  const before = prompt.slice(Math.max(0, index - INTENT_WINDOW), index);
  const after = prompt.slice(index, Math.min(prompt.length, index + INTENT_WINDOW));
  const boundaryBefore = [...before.matchAll(new RegExp(CLAUSE_BOUNDARY, 'g'))].pop();
  const clauseStart = boundaryBefore ? boundaryBefore.index + boundaryBefore[0].length : 0;
  const boundaryAfter = after.match(CLAUSE_BOUNDARY);
  const clauseEnd = boundaryAfter ? boundaryAfter.index : after.length;
  return before.slice(clauseStart) + after.slice(0, clauseEnd);
}

function isReadOnlyMention(prompt, index, normalizedPath) {
  const clause = clauseWindowAround(prompt, index);
  if (WRITE_CUE.test(clause)) return false;
  if (normalizedPath === CONTEXT_DIR || normalizedPath.startsWith(CONTEXT_DIR + '/')) return true;
  return READ_CUE.test(clause);
}

export function gateCrossRepo(input, context) {
  const prompt = input.prompt || '';
  if (/\bworktree\s+add\b/i.test(prompt)) return null;
  if (/\bFOREGROUND_OK\b/.test(prompt)) return null;
  if (/\bCROSS_REPO_WORKTREE_RUSSELL_OK\b/.test(prompt)) return null;
  if (!context.sessionRepoRoot) return null;

  const sessionRoot = normalizePath(context.sessionRepoRoot);
  const parentDir = normalizePath(dirname(sessionRoot));
  const siblingMentions = [];
  for (const { normalized: targetPath, index } of extractAbsolutePathMatches(prompt)) {
    if (targetPath === sessionRoot || targetPath.startsWith(sessionRoot + '/')) continue;
    if (!targetPath.startsWith(parentDir + '/')) continue;
    const siblingName = targetPath.slice(parentDir.length + 1).split('/')[0];
    if (!siblingName || siblingName === basename(sessionRoot)) continue;
    if (!context.isGitRepo(join(parentDir, siblingName))) continue;
    siblingMentions.push({ targetPath, index, siblingName });
  }
  if (!siblingMentions.length) return null;
  if (siblingMentions.every(({ index, targetPath }) => isReadOnlyMention(prompt, index, targetPath))) return null;

  const siblingName = siblingMentions[0].siblingName;
  return `"${input.description || '(unnamed)'}" works in a SIBLING repo (${siblingName}) by absolute path but never sets up its own git worktree there.

Russell's rule (2026-06-29): isolation:"worktree" isolates the SESSION repo, NOT a sibling repo driven by absolute path — so every such agent shares the sibling's one working tree and their \`git checkout -b\` calls reset HEAD under each other.
Fix: brief runs \`git worktree add <dir> -b <branch> <base>\` inside ${siblingName} first. Escapes: FOREGROUND_OK (read-only) · CROSS_REPO_WORKTREE_RUSSELL_OK (never self-grant).`;
}

// ---------------------------------------------------------------------------
// Gate 5 — COMMIT-CADENCE: a worktree agent's brief must tell it to commit WIP often. (was agent-commit-cadence.mjs)
// ---------------------------------------------------------------------------
const HAS_CADENCE = /commit[\s\S]{0,80}\b(every|often|frequently|after each|after every|per (test|step)|each passing test|wip|work-in-progress|checkpoint|\d+\s*tool)/i;

export function gateCommitCadence(input) {
  if (!isWorktreeAgent(input)) return null;
  const prompt = input.prompt || '';
  if (/COMMIT_CADENCE_OK/i.test(prompt) || HAS_CADENCE.test(prompt)) return null;
  return `"${input.description || '(unnamed)'}" is a worktree agent with no COMMIT-CADENCE in its brief.

Russell's rule (2026-06-20): an agent that dies loses only UNCOMMITTED work — git is the only checkpoint that survives a silent death. Tell the brief: "Commit WIP to your worktree branch after every passing test and at least every 3 tool-uses (--no-verify for in-progress)."
Override (one-shot): COMMIT_CADENCE_OK.`;
}

// ---------------------------------------------------------------------------
// Gate 6 — HANDOFF: a worktree agent's brief must tell it to maintain AGENT-HANDOFF.md. (was agent-handoff-required.mjs)
// ---------------------------------------------------------------------------
const HAS_HANDOFF = /\bAGENT-HANDOFF\.md\b/i;
const HAS_STATE_FILE = /(maintain|keep|write|update)[\s\S]{0,60}\b(handoff|state|progress|status)\b[\s\S]{0,40}\b(file|\.md)\b/i;

export function gateHandoff(input) {
  if (!isWorktreeAgent(input)) return null;
  const prompt = input.prompt || '';
  if (/AGENT_HANDOFF_OK/i.test(prompt) || HAS_HANDOFF.test(prompt) || HAS_STATE_FILE.test(prompt)) return null;
  return `"${input.description || '(unnamed)'}" is a worktree agent with no HANDOFF-FILE instruction in its brief.

Russell's rule (2026-06-26): a write-agent must maintain AGENT-HANDOFF.md (GOAL/DONE/NEXT/BLOCKER, updated every 2-3 tool-uses, "STATUS: DONE" when finished) so a dead agent is RESUMED from real state, not restarted.
Override (one-shot): AGENT_HANDOFF_OK.`;
}

// ---------------------------------------------------------------------------
// Gate 7 — WIDGET-UX: a brief exposing UX via a CLI when the project has a widget.html. (was widget-ux-not-cli.mjs)
// ---------------------------------------------------------------------------
export function hasWidgetHtml(rootDir, maxDepth = 3) {
  if (!rootDir || !existsSync(rootDir)) return false;
  const stack = [[rootDir, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
      if (name.toLowerCase() === 'widget.html') return true;
      if (depth < maxDepth) {
        try { if (statSync(join(dir, name)).isDirectory()) stack.push([join(dir, name), depth + 1]); } catch { /* skip */ }
      }
    }
  }
  return false;
}

export function gateWidgetUx(input, context) {
  const prompt = input.prompt || '';
  if (/\bUX_CLI_OK\b/.test(prompt) || /\bWIDGET_UX_RUSSELL_OK\b/.test(prompt)) return null;
  const uxIntent =
    /\b(expos\w*|surfac\w*)\b[^.\n]{0,40}\bux\b/i.test(prompt) ||
    /\bux\b[^.\n]{0,40}\b(expos\w*|surfac\w*)\b/i.test(prompt) ||
    /\buser[- ]facing\b[^.\n]{0,20}\bux\b/i.test(prompt);
  if (!uxIntent) return null;
  const buildsCli = /\bpy(thon)?\s+-m\b/i.test(prompt) || /\b__main__\b/.test(prompt) || /\bargparse\b/i.test(prompt) || /\bcommand[- ]line\b/i.test(prompt) || /\bCLI\b/.test(prompt);
  if (!buildsCli) return null;
  if (/widget\.html|widget\.py|pywebview|js_api|window\.pywebview/i.test(prompt)) return null;
  if (!context.widgetExists) return null;
  return `"${input.description || '(unnamed)'}" claims to EXPOSE UX via a CLI, but this project has a widget.

Russell's rule (2026-06-29): a desktop product's UX is the WIDGET (widget.html + widget.py via pywebview js_api), NOT a py -m/CLI. A CLI is a dev convenience.
Fix: build the UX as a widget panel wired through pywebview js_api, with a screenshot as proof. Override: UX_CLI_OK (dev-only tool) · WIDGET_UX_RUSSELL_OK.`;
}

// ---------------------------------------------------------------------------
// Orchestration — run gates in order, first-deny-wins.
// ---------------------------------------------------------------------------
export const GATES = [gateSidebarOnly, gateBackground, gateWorktree, gateCrossRepo, gateCommitCadence, gateHandoff, gateWidgetUx];

/** Returns the first gate's reason string (deny), or null (allow). */
export function evaluateAgentSpawn(input, context) {
  for (const gate of GATES) {
    const reason = gate(input || {}, context);
    if (reason) return reason;
  }
  return null;
}

/** Walk up to the nearest ancestor containing a `.git`. */
export function findRepoRoot(startDir) {
  let current = startDir;
  while (current) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** Compute the filesystem/env context the gates need, once per event. */
export function buildContext(event, env = process.env) {
  const workingDirectory = event.cwd || process.cwd();
  const sessionRepoRoot = findRepoRoot(workingDirectory);
  return {
    env,
    sessionRepoRoot,
    widgetExists: hasWidgetHtml(sessionRepoRoot || workingDirectory),
    isGitRepo: (candidate) => existsSync(join(candidate, '.git')),
  };
}
