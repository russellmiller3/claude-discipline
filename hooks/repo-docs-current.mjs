#!/usr/bin/env node
/**
 * repo-docs-current — every repository has ONE trustworthy entry document.
 *
 * new-hook-category: Docs/explainer/spec sync — nearest existing hook is
 *   `docs-on-feature-commit`, which asks whether the front-door docs MOVED after
 *   a commit. This asks a different question: whether the entry document is
 *   TRUE. A README updated every commit can still name four competing sources of
 *   truth, claim a tool count that is years old, and sit beside a 68 KB "queue".
 *   Freshness and truthfulness are separate failures; one hook cannot mean both.
 *
 * Russell, 2026-08-17: "all the documentation and update machinery you created
 * for this repo i want it to be enforced for every repo." Built for CodeServo,
 * where four files each called themselves the source of truth, TRUTH.md said
 * "69 tools" while there were 73, and HANDOFF.md had grown to 68 KB with
 * "# START HERE" at line 578.
 *
 * WHAT IT CHECKS, in any repository and any language:
 *   1. TRUTH.md exists — the one document a fresh session reads first.
 *   2. Its document map matches the files actually on disk.
 *   3. HANDOFF.md, if present, is still a QUEUE and not a diary (20 KB ceiling).
 *   4. Its recent-work list is within 25 commits of HEAD.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: that the git-derived sections are exact.
 * Committing changes them, so demanding exactness would fail every commit
 * including the one that refreshed them — an unsatisfiable gate teaches people
 * to bypass the hook, and the real checks leave with it.
 *
 * Warns rather than blocks, ONCE per repository per session. A repo that has not
 * adopted this yet must not have its every turn stopped; the goal is adoption,
 * not obstruction. Escape: REPO_DOCS_OK=1.
 */
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { findDocProblems, git } from '../scripts/repo-truth-doc.mjs';

const STATE_DIR = join(process.env.REPO_DOCS_STATE_DIR || tmpdir(), 'repo-docs-current');

/** Once per repository per session: the same nag every turn is noise, not a gate. */
function alreadyToldThisSession(repositoryRoot, sessionId) {
  const key = createHash('sha256')
    .update(`${repositoryRoot.toLowerCase()}::${sessionId}`)
    .digest('hex')
    .slice(0, 24);
  const marker = join(STATE_DIR, `${key}.seen`);
  if (existsSync(marker)) return true;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(marker, new Date().toISOString(), 'utf8');
  } catch { /* unwritable state must not silence the finding */ }
  return false;
}

export function buildNotice(problems) {
  if (!problems.length) return null;
  return [
    `ENTRY DOCS NOT TRUSTWORTHY — ${problems.length} problem(s) in this repository:`,
    '',
    ...problems.map((problem) => `  - ${problem}`),
    '',
    'Every repository gets ONE entry document, TRUTH.md, whose document map says',
    'which file owns which question. Without it a fresh session reads four files',
    'and can trust none of them.',
    '',
    'Fix all of the above with: node ~/.claude/scripts/repo-truth-doc.mjs',
  ].join('\n');
}

function main() {
  if (process.env.REPO_DOCS_OK === '1') return;
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return; }

  const requested = event.cwd || process.cwd();
  const repositoryRoot = git(requested, 'rev-parse', '--show-toplevel');
  if (!repositoryRoot) return; // not a repo: nothing to keep true

  let problems;
  try { problems = findDocProblems(repositoryRoot); } catch { return; }
  const notice = buildNotice(problems);
  if (!notice) return;

  if (alreadyToldThisSession(repositoryRoot, event.session_id || 'no-session')) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event.hook_event_name || 'SessionStart', additionalContext: notice },
  }));
}

if (process.argv[1] && process.argv[1].endsWith('repo-docs-current.mjs')) main();
