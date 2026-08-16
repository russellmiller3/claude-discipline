#!/usr/bin/env node
/**
 * SessionStart hook — make every Node project's COMMIT GATE correct, without being asked.
 *
 * Two halves of one idea: "the gate that runs on commit is set up right here."
 *
 * HALF ONE — the gate must EXIST (Russell's rule, 2026-06-01). A watcher commit shipped with
 * tests unrun because FileBrain had no git hooks. husky makes the gate real: git runs it whether
 * the committer is Claude or Russell. No husky -> print how to wire it.
 *
 * HALF TWO — the gate must be PROPORTIONATE (Russell, 2026-08-16). A one-line Cloudflare Worker
 * fix in Macher took 24 minutes end to end: six commits, each paying the full release gate,
 * including a ~115s browser suite a Worker cannot possibly affect. "This is madness." The scoped
 * gate fixes that, and it first shipped as "add one line to .husky/pre-commit" -- which Russell
 * rejected on sight: "adoption must be automatic not manual. thats the whole point." He is right,
 * and structurally so: an opt-in speed fix is OFF in every repo nobody remembered, which is
 * exactly where a slow gate is quietly taxing someone. So this half MIGRATES the repo itself.
 *
 * WHY MIGRATING WITHOUT ASKING IS SAFE
 * The migration is behaviour-preserving by construction. Whatever pre-commit ran before becomes,
 * verbatim and in order, the `full` command list in the generated `.claude/gate-tiers.json`. With
 * no tier inferred, every commit runs exactly what it ran yesterday. A tier is only ADDED on
 * unambiguous evidence: a frontend directory AND a server directory AND a narrow test script the
 * repo's own author already wrote. In doubt it infers nothing, and nothing means identical.
 * The original is copied to `.husky/pre-commit.pre-scoped-gate`, so one `mv` undoes it.
 *
 * WHAT IT REFUSES TO TOUCH
 *   - a pre-commit already mentioning scoped-gate, or a repo that already has the config
 *   - a pre-commit containing shell logic (conditionals, loops, pipes, redirects, `&&`,
 *     variables) -- flattening that into a list would change its meaning, so it is left alone
 *     with a printed note
 * Every failure path leaves the repo untouched and exits 0. A bootstrap hook must never be able
 * to block a session or a commit.
 */
import { existsSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join as pathJoin, basename } from 'node:path';

const preCommitRelativePath = pathJoin('.husky', 'pre-commit');
const gateTiersRelativePath = pathJoin('.claude', 'gate-tiers.json');
const scopedGateInvocation = 'node ~/.claude/scripts/scoped-gate.mjs';

function projectHasHusky(projectDir) {
  // 1) a .husky directory (where the hook scripts live)
  const huskyDir = pathJoin(projectDir, '.husky');
  try { if (existsSync(huskyDir) && statSync(huskyDir).isDirectory()) return true; } catch { /* ignore */ }
  // 2) husky as a dependency, or a prepare script that runs husky
  try {
    const manifest = JSON.parse(readFileSync(pathJoin(projectDir, 'package.json'), 'utf8'));
    const allDeps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
    if (allDeps.husky) return true;
    const prepareScript = manifest.scripts && manifest.scripts.prepare;
    if (prepareScript && /husky/.test(prepareScript)) return true;
  } catch { /* unreadable package.json — caller already gated on its existence */ }
  return false;
}

/**
 * Shell constructs whose meaning cannot survive being split into an ordered command list.
 * `&&` is included deliberately: `a && b` and ["a","b"] agree only while both succeed, and what a
 * gate does when something FAILS is the entire point of having one.
 */
const SHELL_LOGIC = /(\|\||&&|[|<>]|\$\(|`|^\s*(if|for|while|case|function)\b|\bexport\s|=\S)/mu;

function isNoiseLine(line) {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith('#') || /^\.\s+"?\$\(dirname/u.test(trimmed);
}

/**
 * Turn a pre-commit script into the ordered command list it is equivalent to.
 * Returns null when the script is NOT a plain list — the caller must then leave it alone.
 */
export function commandsFromPreCommit(scriptText) {
  const commands = String(scriptText ?? '')
    .split(/\r?\n/u)
    .filter((line) => !isNoiseLine(line))
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#!'));
  if (commands.length === 0) return null;
  if (commands.some((command) => SHELL_LOGIC.test(command))) return null;
  return commands;
}

/**
 * Propose a narrow tier, but only from unambiguous evidence.
 *
 * Both must hold: the repo genuinely has a browser half and a server half (so "server-only" is a
 * real category rather than a guess), AND it already exposes a script running only the non-browser
 * tests (so we name a command its author wrote, never one we invented). Missing either -> [].
 */
export function inferTiers({ directories = [], packageScripts = {} } = {}) {
  if (!directories.includes('src')) return [];
  const serverDirectories = ['cloudflare', 'workers', 'functions', 'server']
    .filter((name) => directories.includes(name));
  if (serverDirectories.length === 0) return [];

  const narrowScript = ['test:node', 'test:unit', 'test:server']
    .find((name) => typeof packageScripts[name] === 'string' && packageScripts[name].trim());
  if (!narrowScript) return [];

  return [{
    name: 'server-only',
    _why: 'These paths ship no line to a browser, so browser tests and frontend type checks cannot catch anything here. The full gate still runs at the merge boundary.',
    paths: [
      ...serverDirectories.map((name) => `^${name}/`),
      '^scripts/', '^supabase/', '^migrations/', '^\\.husky/', '^\\.claude/',
      '^[^/]+\\.(md|json|jsonc|txt|ya?ml)$',
    ],
    commands: [`npm run ${narrowScript}`],
  }];
}

/** Decide what to do with one repo. Pure: returns a plan, writes nothing. */
export function planMigration(projectDir, { readFile = readFileSync, exists = existsSync, directories = [] } = {}) {
  const preCommitPath = pathJoin(projectDir, preCommitRelativePath);
  if (!exists(preCommitPath)) return { action: 'skip', reason: 'no pre-commit to migrate' };
  if (exists(pathJoin(projectDir, gateTiersRelativePath))) return { action: 'skip', reason: 'already migrated' };

  let scriptText;
  try { scriptText = String(readFile(preCommitPath, 'utf8')); }
  catch { return { action: 'skip', reason: 'pre-commit unreadable' }; }
  if (scriptText.includes('scoped-gate')) return { action: 'skip', reason: 'already migrated' };

  const fullCommands = commandsFromPreCommit(scriptText);
  if (!fullCommands) {
    return { action: 'manual', reason: 'pre-commit contains shell logic; migrating it could change what it means' };
  }

  let packageScripts = {};
  try { packageScripts = JSON.parse(String(readFile(pathJoin(projectDir, 'package.json'), 'utf8'))).scripts ?? {}; }
  catch { /* no package.json only costs us tier inference */ }

  return {
    action: 'migrate',
    config: {
      _why: 'Generated automatically. "full" is exactly what .husky/pre-commit ran before this migration, so behaviour is unchanged unless a tier below applies. Original saved as .husky/pre-commit.pre-scoped-gate.',
      full: fullCommands,
      tiers: inferTiers({ directories, packageScripts }),
    },
  };
}

/** Only the handful of names tier inference asks about — cheap, and no directory listing needed. */
function topLevelDirectories(projectDir) {
  return ['src', 'cloudflare', 'workers', 'functions', 'server']
    .filter((name) => { try { return existsSync(pathJoin(projectDir, name)); } catch { return false; } });
}

function migrateCommitGate(projectDir) {
  let plan;
  try { plan = planMigration(projectDir, { directories: topLevelDirectories(projectDir) }); }
  catch { return null; }

  if (plan.action === 'skip') return null;
  if (plan.action === 'manual') {
    return `SCOPED GATE — ${basename(projectDir)}'s pre-commit was left alone: ${plan.reason}. `
      + 'To tier it by hand, see the "Shared gate scoping" section of ~/.claude/hooks/HOOKBOOK.md';
  }

  try {
    const preCommitPath = pathJoin(projectDir, preCommitRelativePath);
    copyFileSync(preCommitPath, `${preCommitPath}.pre-scoped-gate`);
    mkdirSync(pathJoin(projectDir, '.claude'), { recursive: true });
    writeFileSync(pathJoin(projectDir, gateTiersRelativePath), `${JSON.stringify(plan.config, null, 2)}\n`, 'utf8');
    writeFileSync(preCommitPath, `${scopedGateInvocation}\n`, 'utf8');
  } catch (failure) {
    return `SCOPED GATE — could not migrate ${basename(projectDir)}, left untouched: ${failure.message}`;
  }

  const tierNames = plan.config.tiers.map((tier) => tier.name).join(', ');
  return `SCOPED GATE — migrated ${basename(projectDir)}'s pre-commit so a commit only runs the suites it could break.\n`
    + `  Full gate (unchanged, still runs whenever a change is not fully covered by a tier): ${plan.config.full.join(' , ')}\n`
    + `  Narrow tiers: ${tierNames || 'none inferred — behaviour is identical to before'}\n`
    + '  Original saved as .husky/pre-commit.pre-scoped-gate; config in .claude/gate-tiers.json.';
}

const HUSKY_MISSING = `HUSKY MISSING — this Node project has no git hooks, so commits and pushes run NOTHING (no test gate). Russell's rule: always set up husky on new projects.

Wire it before the next commit:
  npm i -D husky
  npx husky init
  # then put the test gate in .husky/pre-commit, e.g.:  npm test

Until husky is wired, a "green" commit proves nothing — the tests never ran. (This rule exists because a watcher commit shipped 2026-06-01 with tests unrun.)`;

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  const projectDir = payload.cwd || process.cwd();

  // Scope: only Node projects inside a git repo. Don't nag anywhere else.
  const isNodeProject = existsSync(pathJoin(projectDir, 'package.json'));
  const isGitRepo = existsSync(pathJoin(projectDir, '.git'));
  if (!isNodeProject || !isGitRepo) process.exit(0);

  const message = projectHasHusky(projectDir) ? migrateCommitGate(projectDir) : HUSKY_MISSING;
  if (!message) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
  }));
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(new URL(import.meta.url).pathname)) {
  main().catch(() => process.exit(0));
}
