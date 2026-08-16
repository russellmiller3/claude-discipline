#!/usr/bin/env node
/**
 * Pick the smallest test command set that can actually catch what a commit changed.
 *
 * WHY THIS EXISTS
 * On 2026-08-16 a one-line Cloudflare Worker fix in Macher took 24 minutes end to end. Six
 * commits, each running the full release gate: a node suite (~30s), a jsdom browser suite (~115s),
 * and a type check over 784 files. A Cloudflare Worker ships no line to a browser, so two thirds
 * of every commit proved something the change could not break. Russell: "This is madness."
 *
 * The mistake was not any single rule. Each was added after a real incident and each was correct
 * alone. Nobody checked the SUM: together they made every commit cost a full release. Per-commit
 * and per-release are different questions and deserve different answers -- the full gate belongs
 * at the merge boundary, where paying it once is obviously worth it.
 *
 * THE SAFETY DIRECTION THAT MATTERS
 * A wrong "skip" ships a broken release. A wrong "run everything" costs time. Those are not
 * symmetric, so every ambiguity here resolves toward running more:
 *   - nothing staged (amend, hook re-entry, unknown state) -> full gate
 *   - no config file -> full gate
 *   - ONE changed path outside a tier -> full gate for the whole commit
 *   - a malformed config -> full gate, and say so on stderr rather than failing the commit
 * A tier applies only when EVERY changed path matches it. That is the whole trick, and it is why
 * a frontend file mixed into a Worker commit correctly drags the commit back to the full suite.
 *
 * ADOPTING IT (one line per repo)
 *   .husky/pre-commit:  node ~/.claude/scripts/scoped-gate.mjs
 *   .claude/gate-tiers.json:
 *     {
 *       "full": ["npm test", "npm run check"],
 *       "tiers": [
 *         { "name": "server-only",
 *           "paths": ["^cloudflare/", "^scripts/", "^supabase/", "\\.md$"],
 *           "commands": ["npm run test:node"] }
 *       ]
 *     }
 * Tiers are tried in order; the first whose patterns cover every changed path wins.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const configRelativePath = join('.claude', 'gate-tiers.json');

/** A gate that hangs is worse than one that fails: it blocks the commit with no verdict. */
export const defaultGateTimeoutMs = 10 * 60 * 1_000;

/**
 * Read the tier config. Returns null for "no opinion", which always means the full gate.
 * A broken config must never fail a commit -- it degrades to running everything and complains.
 */
export function readGateTiers(projectRoot, { warn = console.error } = {}) {
  const configPath = join(projectRoot, configRelativePath);
  if (!existsSync(configPath)) return null;
  let configured;
  try {
    configured = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (failure) {
    warn(`[scoped-gate] ${configRelativePath} is not valid JSON, running the full gate: ${failure.message}`);
    return null;
  }
  if (!Array.isArray(configured?.full) || configured.full.length === 0) {
    warn(`[scoped-gate] ${configRelativePath} has no "full" command list, running the full gate.`);
    return null;
  }
  return { full: configured.full.map(String), tiers: Array.isArray(configured.tiers) ? configured.tiers : [] };
}

/**
 * Which commands should this commit run?
 *
 * `changedPaths` are repo-relative and may arrive with Windows separators; they are normalised to
 * forward slashes so one config works on every platform.
 */
export function selectGateCommands(changedPaths, gateTiers, { warn = console.error } = {}) {
  if (!gateTiers) return null;
  const normalisedPaths = (changedPaths ?? []).map((path) => String(path).replace(/\\/gu, '/')).filter(Boolean);
  if (normalisedPaths.length === 0) return { name: 'full', commands: gateTiers.full };

  for (const tier of gateTiers.tiers) {
    if (!Array.isArray(tier?.paths) || !Array.isArray(tier?.commands) || tier.commands.length === 0) {
      warn(`[scoped-gate] tier "${tier?.name ?? '(unnamed)'}" is missing paths or commands, skipping it.`);
      continue;
    }
    let tierPatterns;
    try {
      tierPatterns = tier.paths.map((pattern) => new RegExp(pattern, 'u'));
    } catch (failure) {
      warn(`[scoped-gate] tier "${tier.name}" has an invalid pattern, skipping it: ${failure.message}`);
      continue;
    }
    // EVERY path must match, not merely some. One unmatched file means this tier cannot speak for
    // the commit, and the search falls through -- ultimately to the full gate.
    if (normalisedPaths.every((path) => tierPatterns.some((pattern) => pattern.test(path)))) {
      return { name: String(tier.name ?? 'tier'), commands: tier.commands.map(String) };
    }
  }
  return { name: 'full', commands: gateTiers.full };
}

/** Staged paths. Deletions are included on purpose: removing a file can break its importers. */
export function stagedPaths(projectRoot, { run = spawnSync } = {}) {
  const staged = run('git', ['diff', '--cached', '--name-only', '-z'], { cwd: projectRoot, encoding: 'utf8' });
  if (staged.status !== 0) return [];
  return String(staged.stdout ?? '').split('\0').filter(Boolean);
}

/**
 * Kill a command and everything it started.
 *
 * Killing the shell alone is not enough: `npm test` immediately spawns vitest, which spawns
 * workers, and on Windows those are grandchildren of a `cmd.exe` that dies without taking them
 * along. A gate that "timed out" while a test runner keeps chewing CPU is worse than one that
 * hangs visibly, because nothing on screen says work is still happening.
 */
export async function terminateProcessTree(gateChild, { run = spawnSync } = {}) {
  if (!gateChild?.pid || gateChild.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      run('taskkill', ['/pid', String(gateChild.pid), '/t', '/f'], { timeout: 5_000, stdio: 'ignore' });
    } else {
      // Negative pid = the whole process group, which detached:true gave this child.
      try { process.kill(-gateChild.pid, 'SIGKILL'); } catch { gateChild.kill('SIGKILL'); }
    }
  } catch { /* already gone is the outcome we wanted */ }
}

/**
 * Run one command under a deadline this process owns.
 * Resolves to an exit code; a timeout resolves non-zero AFTER the tree is torn down.
 */
export function runGateCommand(command, { projectRoot, timeoutMs, spawnChild = spawn, onTimeout = terminateProcessTree } = {}) {
  return new Promise((resolve) => {
    // `shell: true` so a config can name any command a developer would type. The config is
    // repo-owned and already trusted -- it sits next to the code the commit is about to run.
    const gateChild = spawnChild(command, {
      cwd: projectRoot, stdio: 'inherit', shell: true,
      detached: process.platform !== 'win32', // gives POSIX a process GROUP to kill as one unit
    });

    let settled = false;
    const settle = (code) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(code); } };

    const deadline = setTimeout(async () => {
      console.error(`[scoped-gate] TIMED OUT after ${Math.round(timeoutMs / 1000)}s: ${command}`);
      await onTimeout(gateChild);
      settle(124); // the conventional timeout exit code
    }, timeoutMs);

    gateChild.on('error', () => settle(1));
    gateChild.on('close', (code) => settle(code ?? 1));

    // A cancelled parent must not orphan the tree either. Same teardown, different trigger.
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, async () => { await onTimeout(gateChild); settle(130); });
    }
  });
}

async function main() {
  const projectRoot = process.cwd();
  const gateTiers = readGateTiers(projectRoot);
  if (!gateTiers) process.exit(0); // no config here: this repo has not adopted scoping, stay silent

  const selection = selectGateCommands(stagedPaths(projectRoot), gateTiers);
  console.error(`[scoped-gate] ${selection.name}: ${selection.commands.join(' && ')}`);

  const timeoutMs = Number(gateTiers.timeoutMs) > 0 ? Number(gateTiers.timeoutMs) : defaultGateTimeoutMs;
  for (const command of selection.commands) {
    const exitCode = await runGateCommand(command, { projectRoot, timeoutMs });
    if (exitCode !== 0) {
      console.error(`[scoped-gate] FAILED: ${command}`);
      process.exit(exitCode);
    }
  }
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
