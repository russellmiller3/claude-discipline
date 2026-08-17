#!/usr/bin/env node
/**
 * repo-truth-doc — one entry document per repository, kept true by machine.
 *
 * Built for CodeServo on 2026-08-17 and made global the same day, because the
 * problem was never CodeServo's. Four files there each described themselves as
 * the source of truth, the entry doc claimed "69 tools" while there were 73, and
 * HANDOFF.md had grown to 68 KB with 45 headings and "# START HERE" buried at
 * line 578. A fresh session had to read all four and could trust none.
 *
 * WHAT IT GUARANTEES, in any repository, in any language:
 *
 *   TRUTH.md is the one document to read first, and three of its sections are
 *   GENERATED — who owns which document, what is parked on other branches, and
 *   what shipped recently. Generated means they cannot rot into fiction.
 *
 * The marker discipline is the whole safety property. Only text BETWEEN a
 * matched pair of markers is ever rewritten, so the judgement a human wrote
 * around them survives untouched. A generator that rewrote the file wholesale
 * would erase the very thing the document exists to hold.
 *
 * WHAT IS DELIBERATELY NOT GATED: the branch table and the recent-work list are
 * both read from git, so making a commit invalidates them. A gate demanding they
 * be exact would fail every commit, including the commit that refreshed them —
 * a gate whose satisfying action re-falsifies it teaches people to bypass the
 * hook, and the real checks leave with it. They are refreshed on demand and
 * checked only against a generous window.
 *
 * Usage:
 *   node repo-truth-doc.mjs [--repo <path>]            refresh (creates TRUTH.md if absent)
 *   node repo-truth-doc.mjs --check [--repo <path>]    exit 1 if stale, write nothing
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HANDOFF_MAX_BYTES = 20000;
export const RECENT_COMMIT_COUNT = 20;
// Russell, 2026-08-17: tighten this. Four commits of grace, not twenty-five —
// a work log a whole session behind is already fiction to the next reader.
// Still satisfiable, which is the constraint that matters: regenerate once and
// the next four commits stay green, so the gate can never demand an action that
// re-falsifies it.
export const RECENT_WORK_MAX_COMMITS_BEHIND = 4;
const SUBJECT_MAX = 96;
const DETAILED_BRANCH_LIMIT = 12;
const UNIT = String.fromCharCode(31);

/** Which front-door files exist here, and the one job each owns. */
const KNOWN_OWNERS = [
  ['TRUTH.md', 'THIS FILE. Read first: what this project is, what it can do, and where everything else lives.'],
  ['HANDOFF.md', 'The live work queue ONLY - what to do next. Not history.'],
  ['README.md', 'The public front door: what it is, install, use.'],
  ['CLAUDE.md', 'Project rules that override defaults for agents working here.'],
  ['AGENTS.md', 'Agent-facing project rules and capability map.'],
  ['learnings.md', 'The scars: every expensive mistake and how to avoid repeating it.'],
  ['CONTRIBUTING.md', 'How to contribute; conventions and review expectations.'],
  ['docs/', 'Reference material. Never the entry point.'],
  ['plans/', 'Numbered implementation plans. Historical once executed.'],
];

export function git(repositoryRoot, ...args) {
  try {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    }).trim();
  } catch {
    return '';
  }
}

function marker(name, edge) {
  return `<!-- truth:generated:${name} ${edge} -->`;
}

export function renderDocumentMap(repositoryRoot) {
  const present = KNOWN_OWNERS.filter(([path]) => existsSync(join(repositoryRoot, path)));
  if (!present.length) return '_No front-door documents found._';
  return [
    'Every document below has ONE job. When two files would answer the same',
    'question, the one named here wins.',
    '',
    '| file | what it owns |',
    '|---|---|',
    ...present.map(([path, owns]) => `| \`${path}\` | ${owns} |`),
  ].join('\n');
}

export function renderBranches(repositoryRoot) {
  const trunk = ['main', 'master'].find(
    (name) => git(repositoryRoot, 'rev-parse', '--verify', `refs/heads/${name}`)
  );
  if (!trunk) return '_Not a git repository, or no trunk branch._';

  const rows = git(
    repositoryRoot, 'for-each-ref', '--sort=-committerdate',
    `--format=%(refname:short)${UNIT}%(committerdate:short)${UNIT}%(subject)`, 'refs/heads/'
  )
    .split('\n').filter(Boolean)
    .map((line) => line.split(UNIT))
    .filter((parts) => parts.length === 3 && parts[0] !== trunk);

  const worktrees = git(repositoryRoot, 'worktree', 'list')
    .split('\n').filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter((path) => path.replace(/\\/g, '/') !== repositoryRoot.replace(/\\/g, '/'));

  if (!rows.length && !worktrees.length) {
    return `**Nothing in flight.** Only \`${trunk}\`, no linked worktrees - every branch landed and deleted.`;
  }
  const lines = [
    `Work parked outside \`${trunk}\`. A branch far behind is a decision waiting,`,
    'not a branch: rebase and land it, or archive and delete it.',
    '',
    '| branch | last commit | ahead | behind | subject |',
    '|---|---|---|---|---|',
  ];
  for (const [name, date, subject] of rows.slice(0, DETAILED_BRANCH_LIMIT)) {
    const ahead = git(repositoryRoot, 'rev-list', '--count', `${trunk}..${name}`) || '?';
    const behind = git(repositoryRoot, 'rev-list', '--count', `${name}..${trunk}`) || '?';
    const clean = subject.slice(0, SUBJECT_MAX).replace(/\|/g, '\\|');
    lines.push(`| \`${name}\` | ${date} | ${ahead} | ${behind} | ${clean} |`);
  }
  if (rows.length > DETAILED_BRANCH_LIMIT) {
    lines.push(`| _...and ${rows.length - DETAILED_BRANCH_LIMIT} more_ | | | | |`);
  }
  if (worktrees.length) {
    lines.push('', '**Linked worktrees on disk:**', '');
    lines.push(...worktrees.map((path) => `- \`${path}\``));
  }
  return lines.join('\n');
}

export function recentCommits(repositoryRoot, count) {
  const log = git(
    repositoryRoot, 'log', `-${count * 3}`, '--no-merges', '--date=short',
    `--pretty=format:%ad${UNIT}%s`
  );
  const commits = [];
  for (const line of log.split('\n')) {
    if (!line.includes(UNIT)) continue;
    const [date, subject] = line.split(UNIT);
    if (/^(wip|Merge)/i.test(subject)) continue;
    commits.push([date, subject.slice(0, SUBJECT_MAX)]);
    if (commits.length === count) break;
  }
  return commits;
}

export function renderRecentWork(repositoryRoot) {
  const commits = recentCommits(repositoryRoot, RECENT_COMMIT_COUNT);
  if (!commits.length) return '_No git history available._';
  return [
    "Read straight from git, so this can never become someone's recollection.",
    '`wip` checkpoints and merges are omitted.',
    '',
    '| date | what shipped |',
    '|---|---|',
    ...commits.map(([date, subject]) => `| ${date} | ${subject.replace(/\|/g, '\\|')} |`),
  ].join('\n');
}

const STARTER = (name) => `# ${name} - Truth

> **START HERE. This is the one document to read first.**

_Say in two or three plain sentences what this project IS and who it is for.
This paragraph is hand-written and the generator will never touch it._

---

## Where everything lives

${marker('document-map', 'START')}
${marker('document-map', 'END')}

**The three sections below are GENERATED** from the filesystem and from git by
\`repo-truth-doc.mjs\`, so they cannot drift into fiction. Everything else here is
judgement and stays hand-written - the generator only ever rewrites between its
own markers, so it can never erase it.

---

## What is in flight

${marker('branches', 'START')}
${marker('branches', 'END')}

---

## Recent work

${marker('recent-work', 'START')}
${marker('recent-work', 'END')}
`;

function replaceSection(document, name, body) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = marker(name, 'START');
  const end = marker(name, 'END');
  const pattern = new RegExp(`${escape(start)}[\\s\\S]*?${escape(end)}`);
  if (!pattern.test(document)) return document; // absent block: leave the file alone
  return document.replace(pattern, `${start}\n${body}\n${end}`);
}

export function renderTruth(document, repositoryRoot, { includeGitSections = true } = {}) {
  let next = replaceSection(document, 'document-map', renderDocumentMap(repositoryRoot));
  if (includeGitSections) {
    next = replaceSection(next, 'branches', renderBranches(repositoryRoot));
    next = replaceSection(next, 'recent-work', renderRecentWork(repositoryRoot));
  }
  return next;
}

/** Every reason this repository's entry docs are not currently trustworthy. */
export function findDocProblems(repositoryRoot) {
  const problems = [];
  const truthPath = join(repositoryRoot, 'TRUTH.md');
  const handoffPath = join(repositoryRoot, 'HANDOFF.md');

  if (existsSync(handoffPath)) {
    const size = readFileSync(handoffPath).length;
    if (size > HANDOFF_MAX_BYTES) {
      problems.push(
        `HANDOFF.md is ${size} bytes, over the ${HANDOFF_MAX_BYTES} ceiling. `
        + 'It answers ONE question - what to do next. Move the history into '
        + 'docs/handoff-archive-<date>.md and leave only live work.'
      );
    }
  }

  if (!existsSync(truthPath)) {
    problems.push(
      'No TRUTH.md. Every repository needs one entry document, or a fresh session '
      + 'reads four files and trusts none. Create it: node ~/.claude/scripts/repo-truth-doc.mjs'
    );
    return problems;
  }

  const current = readFileSync(truthPath, 'utf8');
  if (renderTruth(current, repositoryRoot, { includeGitSections: false }) !== current) {
    problems.push(
      "TRUTH.md's document map no longer matches the files on disk. "
      + 'Run: node ~/.claude/scripts/repo-truth-doc.mjs'
    );
  }
  const recent = recentCommits(repositoryRoot, RECENT_WORK_MAX_COMMITS_BEHIND);
  if (recent.length && !recent.some(([, subject]) => current.includes(subject.replace(/\|/g, '\\|')))) {
    problems.push(
      `TRUTH.md's recent-work list mentions none of the last ${RECENT_WORK_MAX_COMMITS_BEHIND} commits. `
      + 'Run: node ~/.claude/scripts/repo-truth-doc.mjs'
    );
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const repoFlag = args.indexOf('--repo');
  const requested = repoFlag >= 0 ? args[repoFlag + 1] : process.cwd();
  const root = git(requested, 'rev-parse', '--show-toplevel') || requested;

  if (args.includes('--check')) {
    const problems = findDocProblems(root);
    if (!problems.length) { console.log('docs are current'); return 0; }
    console.error(problems.join('\n\n'));
    return 1;
  }

  const truthPath = join(root, 'TRUTH.md');
  if (!existsSync(truthPath)) {
    writeFileSync(truthPath, STARTER(root.split(/[\\/]/).pop()), 'utf8');
    console.log(`created ${truthPath} - write its opening paragraph by hand`);
  }
  const current = readFileSync(truthPath, 'utf8');
  const next = renderTruth(current, root);
  if (next !== current) writeFileSync(truthPath, next, 'utf8');
  console.log(`wrote ${truthPath}`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('repo-truth-doc.mjs')) process.exit(main());
