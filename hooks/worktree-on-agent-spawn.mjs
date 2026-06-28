#!/usr/bin/env node
/**
 * worktree-on-agent-spawn — gate hook that blocks any Agent spawn missing
 * isolation: "worktree". Forces every background-agent dispatch to use a
 * separate git worktree so concurrent agents physically cannot clobber
 * each other's parser.js / compiler.js / shared-file edits.
 *
 * Why this rule exists:
 * 2026-05-13 — three agents (Phase 3 / 5 / 6) ran in parallel without
 * worktree isolation. They share the same filesystem on the same branch.
 * Phase 3's compiler.js edits got eaten by a stash/pop; Phase 6's
 * parser.js edits were clobbered by Phase 5; Phase 5 was forced into
 * "batch all 4 cycles into one atomic patch" survival mode. The pulse
 * log captured the whole autopsy. Worktree isolation prevents this
 * class of collision entirely.
 *
 * Opt-out: add NO_WORKTREE to the prompt for genuinely-doesn't-write
 * agents (pure research, read-only exploration, planning).
 *
 * Fail-open on unexpected errors.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Scan a directory for child git repos. Returns the set of repo paths.
 * Skips dot-directories and node_modules. One level deep — that's enough
 * for the ~/Desktop/programming/ shape (Clear, Lenat, Lenat-clear all
 * sit as sibling directories at depth 1).
 */
function findChildGitRepos(parentDir) {
  const repos = new Set();
  if (!existsSync(parentDir)) return repos;
  let entries = [];
  try { entries = readdirSync(parentDir); } catch { return repos; }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const childPath = join(parentDir, name);
    try {
      if (!statSync(childPath).isDirectory()) continue;
      if (existsSync(join(childPath, '.git'))) repos.add(childPath);
    } catch {}
  }
  return repos;
}

/**
 * Detect whether the prompt indicates the agent will WRITE files in a
 * specific repo. We look for "work in <path>" or "work exclusively in
 * <path>" patterns. If the path resolves to a git repo, this agent is
 * a same-repo write-agent and must NOT use NO_WORKTREE — the agent's
 * `git checkout -b` will switch the parent's working tree.
 */
function detectTargetRepo(prompt, parentCwd) {
  // Match patterns: "work in `<path>`", "work exclusively in `<path>`",
  // "in `<path>`", "branch off `<branch>` on <repoName>", and explicit
  // path mentions. We try the most specific patterns first.
  const patterns = [
    /work(?:\s+exclusively)?\s+in\s+`?([^`\s]+)`?/i,
    /in\s+`(C:\/Users\/[^`]+)`/i,
  ];
  for (const re of patterns) {
    const m = prompt.match(re);
    if (m) {
      const p = m[1].replace(/^['"]|['"]$/g, '');
      // Resolve against parent cwd or as absolute
      const resolved = p.startsWith('C:') || p.startsWith('/') ? p : resolve(parentCwd, p);
      try {
        if (existsSync(join(resolved, '.git'))) return resolved;
      } catch {}
    }
  }
  return null;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }

  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') {
    process.exit(0);
    return;
  }
  if ((event.tool_name || '') !== 'Agent') {
    process.exit(0);
    return;
  }

  const input = event.tool_input || {};
  const isolation = input.isolation || '';
  const description = input.description || '(unnamed)';
  const prompt = input.prompt || '';

  // Already worktree-isolated — allow.
  if (isolation === 'worktree') {
    process.exit(0);
    return;
  }

  // Worktree isolation is MANDATORY for any write-agent (Russell, 2026-06-27: "always enforce worktrees +
  // background"). The bare NO_WORKTREE marker is RETIRED — it let SIBLING-repo agents (e.g. baryo from a
  // skaffen session) share one working tree and clobber each other's branch (the 2026-06-27 collision).
  // Allowed escapes, in order:
  //   - the brief sets up its OWN worktree (`git worktree add ...`) — the cross/sibling-repo pattern the
  //     isolation: param can't reach (parent cwd isn't that repo).
  //   - FOREGROUND_OK — a read-only one-shot that writes nothing, so there is no tree to clobber.
  //   - NO_WORKTREE_RUSSELL_OK — Russell's explicit approval (ASK first; never self-grant).
  const setsUpOwnWorktree = /git\s+worktree\s+add/i.test(prompt);
  const readOnlyOneShot = /\bFOREGROUND_OK\b/.test(prompt);
  const russellApproved = /\bNO_WORKTREE_RUSSELL_OK\b/.test(prompt);
  if (setsUpOwnWorktree || readOnlyOneShot || russellApproved) {
    process.exit(0);
    return;
  }

  const reason = `Agent spawn BLOCKED — "${description}" is not worktree-isolated.

Russell's rule (2026-05-13, hardened 2026-06-27 after the baryo sibling-tree collision): EVERY write-agent must be isolated in its own git worktree so concurrent agents can't clobber each other's branch + files. The bare NO_WORKTREE marker is RETIRED (it let sibling-repo agents share one tree).

Pick one:
1. (same repo as the session) Add isolation: "worktree" to the Agent call.
2. (cross / sibling repo — e.g. baryo from a skaffen session) Put the worktree setup IN the brief: tell the agent to FIRST run \`git worktree add <dir> -b <branch> <base>\`, junction node_modules + copy .env, and do ALL work there. This is what actually isolates a sibling repo the isolation: param can't reach.
3. (read-only one-shot that writes nothing) add FOREGROUND_OK.
4. (you asked Russell and he approved) add NO_WORKTREE_RUSSELL_OK — never self-grant.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

main();
