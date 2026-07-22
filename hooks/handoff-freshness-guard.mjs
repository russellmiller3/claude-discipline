#!/usr/bin/env node
// Stop guard: HANDOFF.md is a parachute, so its checkable claims must match live state.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkHandoffState } from './handoff-state-check.mjs';

const ACTIVE_RE = /\b(?:running|in[- ]flight|in progress|active)\b/i;
const TERMINAL_RE = /\b(?:done|completed?|finished|killed|deleted|landed|shipped|passed|torn down)\b/i;
const NEGATED_ACTIVE_RE = /(?:\b(?:no|not|none|zero|without)\b[^\n]{0,24}\b(?:running|in[- ]flight|in progress|active)\b)|(?:\b(?:running|in[- ]flight|in progress|active)\b\s*[:=]\s*(?:no|none|zero)\b)/i;
const POD_ID_RE = /\bpod(?:\s+id|_id)?\s*(?:[:=#-]\s*)?`?([a-z0-9][a-z0-9-]{7,})`?/gi;
const UNCHECKABLE_RE = /\bHANDOFF_FRESHNESS_UNCHECKABLE\s*:\s*\S.+/i;

const SUBJECT_STOP_WORDS = new Set([
  'active', 'build', 'completed', 'deleted', 'done', 'finished', 'handoff', 'flight',
  'killed', 'landed', 'progress', 'running', 'shipped', 'state', 'status', 'task',
  'tested', 'torn', 'work', 'working', 'required', 'redesign', 'first', 'attempt',
]);

export function extractBuildTargets(content) {
  const targets = [];
  for (const match of content.matchAll(/\bBUILD\b[\s\S]{0,180}?`([^`\r\n]+)`/gi)) {
    const target = match[1].trim();
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

function buildTargetCandidates(target, repoDir) {
  if (/\s/.test(target)) return [];
  const expanded = target.replace(/^~(?=[\\/])/, homedir());
  if (isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)) return [expanded];
  const candidates = [join(repoDir, expanded)];
  if (!/\.[A-Za-z0-9]+$/.test(expanded)) {
    candidates.push(
      join(repoDir, `${expanded}.mjs`),
      join(repoDir, 'hooks', `${expanded}.mjs`),
      join(homedir(), '.claude', 'hooks', `${expanded}.mjs`),
      join(homedir(), '.codex', 'hooks', `${expanded}.mjs`),
    );
  }
  return [...new Set(candidates)];
}

function meaningfulTokens(line) {
  const cleaned = line
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`*_#|()[\]{}:;,.!?$=+<>/\\—-]/g, ' ')
    .toLowerCase();
  return new Set(
    (cleaned.match(/[a-z][a-z0-9]+/g) || [])
      .filter((word) => word.length >= 4 && !SUBJECT_STOP_WORDS.has(word)),
  );
}

function claimsSameSubject(left, right) {
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  if (shared >= 2) return true;
  const leftExperiment = left.match(/\b(?:exp(?:eriment)?\s*)?#?(\d{2,4}[a-z]?)\b/i)?.[1];
  const rightExperiment = right.match(/\b(?:exp(?:eriment)?\s*)?#?(\d{2,4}[a-z]?)\b/i)?.[1];
  return Boolean(leftExperiment && rightExperiment && leftExperiment.toLowerCase() === rightExperiment.toLowerCase());
}

function isPositiveActiveLine(rawLines, index) {
  const line = rawLines[index];
  if (!ACTIVE_RE.test(line)) return false;
  const nextLine = rawLines[index + 1] || '';
  const wrappedContinuation = /^\s{2,}\S/.test(nextLine) && !/^\s*(?:[-*#|]|\d+\.)\s/.test(nextLine);
  const claimText = wrappedContinuation ? `${line} ${nextLine.trim()}` : line;
  return !NEGATED_ACTIVE_RE.test(claimText);
}

export function findContradictoryStatusClaims(content) {
  const rawLines = content.split(/\r?\n/);
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);
  const activeLines = rawLines
    .filter((line, index) => isPositiveActiveLine(rawLines, index))
    .map((line) => line.trim())
    .filter(Boolean);
  const terminalLines = lines.filter((line) => TERMINAL_RE.test(line));
  const contradictions = [];
  for (const activeLine of activeLines) {
    const terminalLine = terminalLines.find((candidate) => candidate !== activeLine && claimsSameSubject(activeLine, candidate));
    if (terminalLine) contradictions.push(`${activeLine}  <->  ${terminalLine}`);
  }
  return contradictions;
}

export function extractActivePodIds(content) {
  const podIds = [];
  const rawLines = content.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    if (!isPositiveActiveLine(rawLines, index)) continue;
    for (const match of line.matchAll(POD_ID_RE)) {
      if (!podIds.includes(match[1])) podIds.push(match[1]);
    }
  }
  return podIds;
}

function realGit(args, repoDir) {
  return execFileSync('git', args.trim().split(/\s+/), {
    cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
  }).trim();
}

function readRunPodKey(repoDir) {
  if (process.env.RUNPOD_API_KEY || process.env.RUNPOD_KEY) return process.env.RUNPOD_API_KEY || process.env.RUNPOD_KEY;
  let searchDir = repoDir;
  for (let depth = 0; depth < 5; depth += 1) {
    const envPath = join(searchDir, '.env');
    if (existsSync(envPath)) {
      const match = readFileSync(envPath, 'utf8').match(/^RUNPOD_(?:API_)?KEY=(.+)$/m);
      if (match?.[1]?.trim()) return match[1].trim().replace(/^['"]|['"]$/g, '');
    }
    const parent = dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }
  throw new Error('RUNPOD_API_KEY/RUNPOD_KEY unavailable');
}

function listRunPodPods(repoDir) {
  const apiKey = readRunPodKey(repoDir);
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const raw = execFileSync(curl, [
    '-sS', '--fail', '--max-time', '5',
    '-H', `Authorization: Bearer ${apiKey}`,
    'https://rest.runpod.io/v1/pods',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 7000 });
  const pods = JSON.parse(raw);
  if (!Array.isArray(pods)) throw new Error('provider response was not a pod list');
  return pods;
}

export function evaluateFreshness({
  content,
  repoDir,
  assistantText = '',
  pathExists = existsSync,
  git = realGit,
  listProviderPods = () => listRunPodPods(repoDir),
}) {
  const staleReasons = [];
  const branchVerdict = checkHandoffState({ content, repoDir, git });
  if (!branchVerdict.ok) staleReasons.push(branchVerdict.reason);

  for (const target of extractBuildTargets(content)) {
    const existingPath = buildTargetCandidates(target, repoDir).find((candidate) => pathExists(candidate));
    if (existingPath) staleReasons.push(`BUILD target \`${target}\` already exists at \`${existingPath}\`.`);
  }

  for (const contradiction of findContradictoryStatusClaims(content)) {
    staleReasons.push(`Active and terminal claims contradict each other: ${contradiction}`);
  }

  const claimedPodIds = extractActivePodIds(content);
  if (claimedPodIds.length) {
    try {
      const livePodIds = new Set(listProviderPods().map((pod) => String(pod.id || pod.podId || '')));
      for (const podId of claimedPodIds) {
        if (!livePodIds.has(podId)) staleReasons.push(`Pod \`${podId}\` is claimed active but is absent from the provider list.`);
      }
    } catch (error) {
      if (!UNCHECKABLE_RE.test(assistantText)) {
        staleReasons.push(`Active pod state could not be checked (${error.message}). Restore provider access or reply with HANDOFF_FRESHNESS_UNCHECKABLE: <specific reason>.`);
      }
    }
  }

  if (!staleReasons.length) return { block: false };
  return {
    block: true,
    reason: `HANDOFF STALE — ${staleReasons.length} checkable contradiction(s). Fix all before stopping:\n- ${staleReasons.join('\n- ')}`,
  };
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((input.hook_event_name || input.hookEventName) !== 'Stop') process.exit(0);
  const repoDir = input.cwd || process.cwd();
  const handoffPath = join(repoDir, 'HANDOFF.md');
  if (!existsSync(handoffPath)) process.exit(0);
  const verdict = evaluateFreshness({
    content: readFileSync(handoffPath, 'utf8'),
    repoDir,
    assistantText: input.last_assistant_message || input.lastAssistantMessage || '',
  });
  if (verdict.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  try { main(); } catch { process.exit(0); }
}
