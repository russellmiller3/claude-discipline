#!/usr/bin/env node
// Stop hook — blocks "easy-thing-first" pattern.
//
// Russell named the pattern explicitly on 2026-05-03 night: "there's a
// persistent pattern of you skipping harder work." Real and recurring.
// Tonight's example: 9 polish commits shipped (audit prose, deal-desk
// fixes, /enq skill, USER-GUIDE TOC, template comments, Studio errors,
// Marcus app tests) while concurrency Phase 2 — the regulated-tier
// CENTERPIECE — sat untouched in the queue tagged "multi-day work."
//
// The fix is structural: when the queue contains items tagged with
// launch-blocking keywords, this hook blocks Stop unless either
//   (a) the last commit advanced one of those high-impact items, OR
//   (b) the most-recent assistant message names that item as the next
//       move WITH a working tool call already in flight toward it.
//
// In other words: you can stop AFTER you've started the hard thing,
// not before.
//
// CLAUDE.md rule "The Hardest Thing Goes First" (2026-05-03) is the
// intent; this hook is the enforcement.

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join as pathJoin } from 'node:path';

// Generic load-bearing keywords. Anything project-specific lives in
// per-project config at <project>/.claude/hardest-first.json:
//   { "keywords": ["concurrency phase 2", "tenant isolation", ...],
//     "paths":    ["lib/prover/", "validator.js", ...] }
// Loaded by loadProjectConfig() below.
const DEFAULT_HIGH_IMPACT_KEYWORDS = [
  /\bload[- ]bearing\b/i,
  /\bnorth[- ]star[- ]blocking\b/i,
  /\bblocks?\s*(launch|ship|release)\b/i,
  /\bmulti[- ]day\s*(work|epic)\b/i,
  /\bcritical[- ]path\b/i,
];

// Dodge phrases — language Claude reaches for when skipping the hard
// thing. If the most recent assistant message contains these AND the
// queue has high-impact items, that's a strong dodge signal.
const DODGE_PATTERNS = [
  /\bmulti[- ]day\s*work\b/i,
  /\bmulti[- ]day\s*epic\b/i,
  /\bbig\s*piece\b/i,
  /\bneeds\s*a\s*focused\s*session\b/i,
  /\bdesign\s*call\s*needed\b/i,
  /\bdecide\s*which\s*pattern\b/i,
  /\bneeds\s*russell['s]*\s*input\b/i,
  /\blet\s*me\s*wrap\s*this\s*phase\s*first\b/i,
  /\bship\s*the\s*small\s*wins\b/i,
  /\bfollow[- ]up\s*to\s*this\b/i,
  /\bsubstantively\s*done\b/i,
  /\bpolish\s*round\b/i,
  /\bsmaller\s*polish\s*stuff\b/i,
];

// Commit-shape patterns — what counts as "advancing the hard thing"
// vs "polish only." We classify the most recent N commits.
const POLISH_ONLY_COMMIT_RE = /^(?:[a-f0-9]+)\s+(?:style|docs|chore|test|fix\(([^)]*\))|refactor)\(/i;
// We don't try to identify "high-impact" commits by message — too noisy.
// Instead we check: did ANY of the last 3 commits touch files that look
// like load-bearing surfaces? (See HIGH_IMPACT_PATHS below.)
// Generic high-impact path patterns. Project-specific paths come from
// <project>/.claude/hardest-first.json:"paths".
const DEFAULT_HIGH_IMPACT_PATHS = [
  /^plans\/plan-/,
];

function loadProjectConfig(cwd) {
  const path = pathJoin(cwd, '.claude', 'hardest-first.json');
  if (!existsSync(path)) return { keywords: [], paths: [] };
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    return {
      keywords: Array.isArray(cfg.keywords) ? cfg.keywords.map(s => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i')) : [],
      paths: Array.isArray(cfg.paths) ? cfg.paths.map(s => new RegExp(s)) : [],
    };
  } catch { return { keywords: [], paths: [] }; }
}

function readPriorityQueue(cwd) {
  const path = pathJoin(cwd, '.claude', 'state', 'priority-queue.md');
  if (!existsSync(path)) return '';
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

import { lastAssistantTextOf } from './lib/transcript.mjs';

function lastNCommitMessages(cwd, n = 5) {
  try {
    const out = execSync(`git -C "${cwd}" log --oneline -${n}`, { encoding: 'utf8', timeout: 3000 });
    return out.trim().split('\n');
  } catch { return []; }
}

function lastNCommitFiles(cwd, n = 5) {
  try {
    const out = execSync(`git -C "${cwd}" log --name-only --pretty=format:--- -${n}`, { encoding: 'utf8', timeout: 3000 });
    const groups = out.split('---').map(g => g.trim()).filter(Boolean);
    return groups.map(g => g.split('\n').slice(1).filter(Boolean));
  } catch { return []; }
}

function highImpactItemsInQueue(queueText, keywords) {
  const lines = queueText.split('\n');
  const matches = [];
  for (const line of lines) {
    for (const pat of keywords) {
      if (pat.test(line)) {
        matches.push({ line: line.trim().slice(0, 200), pattern: pat.toString() });
        break;
      }
    }
  }
  return matches;
}

function recentCommitsAdvancedHardWork(cwd, paths) {
  const fileGroups = lastNCommitFiles(cwd, 5);
  for (const files of fileGroups) {
    for (const f of files) {
      for (const pat of paths) {
        if (pat.test(f)) return true;
      }
    }
  }
  return false;
}

function recentCommitsPolishOnly(cwd) {
  const messages = lastNCommitMessages(cwd, 3);
  if (messages.length === 0) return false;
  return messages.every(m => POLISH_ONLY_COMMIT_RE.test(m));
}

function dodgeSignalInLastMessage(text, queueHasHighImpact) {
  if (!queueHasHighImpact) return null;
  for (const pat of DODGE_PATTERNS) {
    if (pat.test(text)) {
      return pat.toString();
    }
  }
  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  const cwd = payload.cwd || process.cwd();
  const transcriptPath = payload.transcript_path;
  const reply = lastAssistantTextOf(transcriptPath);
  const queueText = readPriorityQueue(cwd);

  if (!queueText.trim()) { process.exit(0); return; }

  // Merge default generic patterns + per-project config.
  const projectCfg = loadProjectConfig(cwd);
  const allKeywords = [...DEFAULT_HIGH_IMPACT_KEYWORDS, ...projectCfg.keywords];
  const allPaths = [...DEFAULT_HIGH_IMPACT_PATHS, ...projectCfg.paths];

  const highImpactItems = highImpactItemsInQueue(queueText, allKeywords);
  if (highImpactItems.length === 0) {
    // No load-bearing items in queue — nothing to enforce.
    process.exit(0);
    return;
  }

  const advancedHardWork = recentCommitsAdvancedHardWork(cwd, allPaths);
  const polishOnly = recentCommitsPolishOnly(cwd);
  const dodgeSignal = dodgeSignalInLastMessage(reply, true);

  const violations = [];

  // Violation 1: queue has high-impact items, recent commits are polish-only,
  // and last message uses dodge language.
  if (polishOnly && dodgeSignal) {
    violations.push({
      kind: 'hardest-first-skipped',
      detail: `Queue has ${highImpactItems.length} load-bearing item(s) (e.g. "${highImpactItems[0].line}"), the last 3 commits look like polish-only, and the last assistant message uses dodge language: ${dodgeSignal}. The CLAUDE.md rule "The Hardest Thing Goes First" applies. Pick one of the high-impact items and start it now (read the relevant plan, write the first failing test, or cut the focused branch).`,
    });
  }

  // Violation 2: queue has high-impact items, no recent commit has advanced
  // any high-impact path, and last message names a "next move" without a tool
  // call advancing it. (This catches the satisfaction-stop pattern after a
  // batch of polish work.)
  // Simpler check: if queue has high-impact AND most recent 3 commits don't
  // touch any high-impact path AND last message doesn't mention any of the
  // high-impact keywords, that's a skip.
  if (!advancedHardWork && polishOnly) {
    const lastMessageMentionsHighImpact = allKeywords.some(p => p.test(reply));
    if (!lastMessageMentionsHighImpact) {
      violations.push({
        kind: 'hard-work-untouched',
        detail: `Queue has ${highImpactItems.length} load-bearing item(s) (e.g. "${highImpactItems[0].line}"). Recent commits (last 3) are polish-only and don't touch any high-impact code surface (per defaults or <project>/.claude/hardest-first.json). Last assistant message doesn't even mention the high-impact item. CLAUDE.md rule "The Hardest Thing Goes First": pick the highest-leverage queue item, not the easiest. Multi-day means starts with one commit, not skip.`,
      });
    }
  }

  if (violations.length === 0) { process.exit(0); return; }

  const message = [
    `STOP-BLOCKED — ${violations.length} hardest-first rule(s) violated:`,
    '',
    ...violations.map(v => `  • ${v.kind}: ${v.detail}`),
    '',
    `Russell's CLAUDE.md rule "The Hardest Thing Goes First" (2026-05-03):`,
    `  - When picking the next move, default to the HIGHEST-LEVERAGE item, not the easiest.`,
    `  - "Multi-day" means STARTS WITH ONE COMMIT, not skip-for-now.`,
    `  - Dodge phrases ("multi-day work", "design call needed", "needs Russell input", "let me wrap this phase first", "polish round") are STOP signals.`,
    `  - Hardest-first applies even at session-end. Better to make a 30-minute dent in the load-bearing thing than ship 4 polish commits and leave the centerpiece untouched.`,
    '',
    `What to do next:`,
    `  • Pick one high-impact item from the queue (e.g. "${highImpactItems[0].line}").`,
    `  • Read the relevant plan in plans/ if one exists.`,
    `  • Take the first concrete action — write a failing test, cut the focused branch, or start the first edit.`,
    `  • A working tool call (Bash/Write/Edit/Agent) on the high-impact code surface clears this hook.`,
  ].join('\n');

  console.error(message);
  process.exit(2);
}

main().catch(err => {
  console.error('hardest-first hook error:', err.message);
  process.exit(0); // Fail open — never block on hook bug.
});
