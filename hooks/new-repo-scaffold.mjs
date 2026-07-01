#!/usr/bin/env node
/**
 * PostToolUse(Bash) hook — when a repo is initialized (`git init`), SCAFFOLD its memory files.
 *
 * Russell's rule (2026-07-01): a new repo should come with its working memory (HANDOFF.md) and
 * long-term memory (learnings.md) already there — the agent should not have to be told. This hook
 * has TEETH: it does not remind, it WRITES the files (only if missing — never overwrites). It also
 * sets up the commit gate for the project's language: pre-commit for Python, husky for Node.
 *
 * Fires after any Bash command; acts only when the command actually ran `git init`. Scaffolds into
 * the command's cwd (the repo root git just created). Fail-open on any error — never break the turn.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join as pathJoin } from 'node:path';

function ranGitInit(command) {
  return typeof command === 'string' && /(^|[\s;&|(])git\s+init\b/.test(command);
}

function handoffTemplate(repoName) {
  return `# HANDOFF — ${repoName}

> Parachute for a fresh / post-compaction agent. Read this and you're current. NOT a diary.
> Discipline: at each checkpoint, review this WHOLE file — keep what's live, PRUNE what's stale.
> Scaffolded on git init. Fill each section in as real work lands; delete this line when you do.

## What this project is (one line)
TODO: one sentence — what it does and why it matters.

## Status
TODO: where things stand right now (proven / in-progress / blocked).

## NEXT ACTION (the one thing)
TODO: the single next step to take.

## Files
TODO: the load-bearing files and what each is for.

## Guardrails / gotchas
TODO: what will bite the next agent. Link details to learnings.md.
`;
}

function learningsTemplate(repoName) {
  return `# ${repoName} — Project Learnings (long-term memory)

Project-specific gotchas and bug stories. Cross-project method lessons live in ~/.claude/learnings.md.
Read the relevant section before touching that area; append a bullet after any non-obvious fix.

## TOC
- (add sections here as lessons accumulate)

---

<!-- Append learnings below. Format: a bold one-line lesson, then the why + how-to-apply, dated. -->
`;
}

function readmeTemplate(repoName) {
  return `# ${repoName}

## North Star — why this project exists
TODO (one paragraph): the single purpose. What changes in the world if this succeeds? This is the
load-bearing sentence everything else serves — do NOT start building until it is real and specific.

## Main user story(s)
TODO: the 1-3 that matter most, each as "As a <user>, I want <capability>, so that <outcome>."

## Tech stack
TODO: decide this WITH Russell — do NOT guess. Run a short interview first, then record the choice + WHY:
  - Who is the user and what is the ONE job to be done?
  - Shape: web / desktop / CLI / service / library? Who hosts/runs it?
  - Data: what is stored, where, how sensitive?
  - Integrations with existing systems? Hard constraints (budget, latency, offline, compliance)?
  - Team + skills, and any preferred languages/frameworks?

## Roadmap
TODO: milestones. M0 = walking skeleton (thinnest end-to-end slice that runs) -> M1 = first user-visible
value -> M2 ... For each: the one capability it adds and how you will KNOW it is done.

## Go-to-market
TODO: who is the FIRST user, how do they find it, what makes them adopt it, what is the wedge? Applies
even to internal/research tools: name the first real user and why they will use it.
`;
}

function preCommitTemplate() {
  return `# pre-commit = husky for Python. A commit-time gate: these run on every \`git commit\`.
# Install the git hook once:   python -m pre_commit install
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v6.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-merge-conflict
      - id: check-added-large-files
        args: [--maxkb=1024]
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.15.20
    hooks:
      - id: ruff
        args: [--select, "E9,F63,F7,F82"]   # real breakage only (syntax, undefined names), not style nits
  - repo: local
    hooks:
      - id: python-syntax-check
        name: python syntax check (py_compile)
        entry: python -m py_compile
        language: system
        types: [python]
`;
}

function isPythonProject(repoDir) {
  const markers = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg'];
  return markers.some((marker) => existsSync(pathJoin(repoDir, marker)));
}

function scaffoldRepo(repoDir) {
  const repoName = basename(repoDir) || 'project';
  const created = [];
  const nextSteps = [];

  const readmePath = pathJoin(repoDir, 'README.md');
  if (!existsSync(readmePath)) { writeFileSync(readmePath, readmeTemplate(repoName), 'utf8'); created.push('README.md'); }

  const handoffPath = pathJoin(repoDir, 'HANDOFF.md');
  if (!existsSync(handoffPath)) { writeFileSync(handoffPath, handoffTemplate(repoName), 'utf8'); created.push('HANDOFF.md'); }

  const learningsPath = pathJoin(repoDir, 'learnings.md');
  if (!existsSync(learningsPath)) { writeFileSync(learningsPath, learningsTemplate(repoName), 'utf8'); created.push('learnings.md'); }

  // Commit gate per language. Python: scaffold a pre-commit config. Node: husky (handled below).
  if (isPythonProject(repoDir)) {
    const preCommitPath = pathJoin(repoDir, '.pre-commit-config.yaml');
    if (!existsSync(preCommitPath)) { writeFileSync(preCommitPath, preCommitTemplate(), 'utf8'); created.push('.pre-commit-config.yaml'); }
    nextSteps.push('Python commit gate: run `python -m pip install pre-commit && python -m pre_commit install` to arm it.');
  }
  if (existsSync(pathJoin(repoDir, 'package.json')) && !existsSync(pathJoin(repoDir, '.husky'))) {
    nextSteps.push('Node commit gate: run `npm i -D husky && npx husky init`, then put the test command in .husky/pre-commit.');
  }

  return { created, nextSteps };
}

async function main() {
  let rawInput = '';
  for await (const chunk of process.stdin) rawInput += chunk;
  let payload;
  try { payload = JSON.parse(rawInput); } catch { payload = {}; }

  const command = payload.tool_input?.command || '';
  if (!ranGitInit(command)) process.exit(0);

  const repoDir = payload.cwd || process.cwd();
  const { created, nextSteps } = scaffoldRepo(repoDir);
  if (created.length === 0 && nextSteps.length === 0) process.exit(0);

  const lines = ['NEW REPO SCAFFOLDED (memory files + commit gate):'];
  if (created.length) lines.push(`Created (were missing): ${created.join(', ')}.`);
  else lines.push('Memory files already present — left them untouched.');
  lines.push('HANDOFF.md is the compaction parachute (working memory); learnings.md is long-term memory. Fill the HANDOFF TODOs as real work lands.');
  if (created.includes('README.md')) {
    lines.push('README.md has a NORTH STAR / user-stories / tech-stack / roadmap / GTM skeleton. Before ANY building: INTERVIEW Russell to fill the North Star + main user story(s) + tech stack (do NOT guess the stack), then sketch the roadmap and go-to-market. These are the load-bearing decisions — get them from Russell first.');
  }
  for (const step of nextSteps) lines.push(step);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') },
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
