#!/usr/bin/env node
/**
 * PreToolUse hook — block git commit directly to main or master.
 *
 * Fills the gap between:
 *   - worktree-default-for-edits.mjs (blocks file edits in primary checkout)
 *   - no-feature-branch-push.mjs (blocks pushing non-main branches)
 *
 * This hook closes the remaining escape hatch: you could create a worktree
 * but name it after main, or checkout main in the worktree before committing.
 * Any `git commit` on main/master is blocked here.
 *
 * Allows: git commit on any branch other than main/master
 * Blocks: git commit (any flags) when current branch is main or master
 * Merge exemption (2026-07-06): a `git commit` COMPLETING an in-progress merge (MERGE_HEAD
 *   present) or a `git merge`/`git pull` command is ALLOWED on main without the override — a
 *   merge commit MUST land on the target branch, so blocking it was over-broad.
 * Override: COMMIT_MAIN_OVERRIDE=1
 *
 * --- Concurrency check (added 2026-07-02, skaffen-desktop incident) ---
 * A plain `git commit ... COMMIT_MAIN_OVERRIDE=1` is a compare-nothing write: it never
 * checks whether main moved since it was last read (unlike safe-merge-to-main.sh's
 * three-arg CAS). The orchestrator used this override for what looked like a "safe,
 * doc-only" HANDOFF.md/README.md commit while a background agent's safe-merge-to-main.sh
 * landing raced in at nearly the same moment. The override commit's parent was stale by
 * exactly one commit; the result silently became a 991-line regression (deleted a
 * just-shipped feature, its tests, and its screenshots).
 *
 * A solo doc-only override commit with nothing else running is genuinely safe — this
 * hook does NOT block that case. It only escalates when `git worktree list` (against the
 * repo the commit actually targets) shows another worktree beyond the primary checkout
 * that is currently LOCKED — the marker background agents' worktrees carry while active.
 * That signals a background agent may be mid-landing right now, so the plain override
 * commit is denied in favor of safe-merge-to-main.sh (or CONCURRENT_COMMIT_OK=1 for a
 * deliberate, supervised exception).
 *
 * Override for the no-concurrency case: COMMIT_MAIN_OVERRIDE=1 (unchanged)
 * Override for the concurrency-detected case: CONCURRENT_COMMIT_OK=1 (new, additive —
 * both tokens must be present to force a commit while a locked worktree exists)
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// The command may target ANOTHER repo than the session cwd: `cd <kit> && git commit ...`
// or `git -C <kit> commit ...`. Resolve the directory the commit actually runs in —
// checking the session repo's directory false-blocked a commit on another repo's fix
// branch just because the SESSION repo sat on main (2026-07-01). Shared by the branch
// check and the concurrency check below so both judge the same target repo.
// The cd is NOT always the first segment: `X=1 true && cd <kit> && git commit ...` was
// false-blocked (2026-07-03) because a ^-anchored cd regex missed the mid-chain cd. Honor
// the LAST `cd <dir>` in any chain segment (start, `&&`, or `;`) BEFORE the first
// `git commit` — a cd after the commit can't retarget it.
function effectiveDirectory(normalizedCommand, sessionDirectory) {
  const commitIndex = normalizedCommand.search(/\bgit\s+commit\b/);
  const beforeCommit = commitIndex === -1 ? normalizedCommand : normalizedCommand.slice(0, commitIndex);
  const cdMatches = [...beforeCommit.matchAll(/(?:^|&&|;)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/g)];
  if (cdMatches.length) {
    const lastCd = cdMatches[cdMatches.length - 1];
    return lastCd[1] || lastCd[2] || lastCd[3];
  }
  const dashCMatch = normalizedCommand.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (dashCMatch) return dashCMatch[1] || dashCMatch[2] || dashCMatch[3];
  return sessionDirectory;
}

// A git MERGE must complete on the TARGET branch — you cannot finish a merge on a feature
// branch, so blocking every commit on main also blocks the final commit of a legitimate
// `git merge`/`git pull`. That over-broad block forced COMMIT_MAIN_OVERRIDE=1 for every
// routine merge-to-main (friction + trains override-habits). This detects a legitimate
// merge and ALLOWS it without the override. Three independent signals, ANY one is enough:
//   (1) MERGE_HEAD exists — a merge/pull is mid-flight and this `git commit` completes it
//       (the most reliable tell for `git commit` finishing a merge). Also honor
//       CHERRY_PICK_HEAD / REVERT_HEAD (same "completing an in-progress operation" shape).
//   (2) the git command itself is `git merge …` or `git pull …` (the merge is being run now).
//   (3) the commit that will be created is a merge commit (HEAD already has 2+ parents is
//       not knowable pre-commit, so we rely on (1)/(2); left here as the conceptual third).
// Fails CLOSED for detection purposes on any git error (returns false = "not a merge") so a
// plumbing hiccup never turns an ordinary direct commit into an allowed one — the ordinary
// block still applies. MERGE_HEAD is the load-bearing check.
function isMergeInProgress(targetDirectory) {
  for (const pseudoRef of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    try {
      execSync(`git rev-parse -q --verify ${pseudoRef}`, {
        cwd: targetDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true; // rev-parse exits 0 only when the pseudo-ref exists
    } catch {
      // exit != 0 => that pseudo-ref absent (or a git error); try the next / fall through
    }
  }
  return false;
}

// Is the command itself running a merge or pull (as opposed to a plain `git commit` that
// happens to complete one)? Scans the already-quote-masked command so a `git merge` inside
// quoted prose does not count. `git pull` fast-forwards or creates a merge commit on the
// current branch; `git merge` likewise — both legitimately land on the target branch.
function isMergeOrPullCommand(commandWithoutQuotedSpans) {
  return /\bgit\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(?:merge|pull)\b/.test(commandWithoutQuotedSpans);
}

// DOC-ONLY exemption (2026-07-07, Russell asked directly). A commit whose STAGED changes are all
// documentation is a legitimate main commit — no branch, no COMMIT_MAIN_OVERRIDE=1 needed. A file
// is documentation iff its extension (case-insensitive) is one of the set below; a commit is
// doc-only iff EVERY staged path qualifies. Any code file (.py/.mjs/.js/.ts/.html/.json/.sh, or a
// no-extension file like Makefile/LICENSE) makes the commit NOT doc-only → the ordinary block stands.
const DOC_ONLY_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst']);

// True iff `path` (forward-slash, as git emits) has one of the doc-only extensions. Basename is
// the last `/`-segment; a no-extension file or a dotfile like `.gitignore` is never doc-only.
function hasDocOnlyExtension(path) {
  const baseName = path.split('/').pop();
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex <= 0) return false;
  return DOC_ONLY_EXTENSIONS.has(baseName.slice(dotIndex).toLowerCase());
}

// PreToolUse fires BEFORE the shell command runs — including every earlier segment of the SAME
// chained command. `git add a.md b.md && git commit -m x` is one Bash-tool invocation: at the
// moment this hook inspects `git diff --cached --name-only`, the `git add` has NOT executed yet,
// so the staged set looks EMPTY (or reflects some earlier, unrelated staging) and the doc-only
// check fails closed even though the commit-to-be is 100% documentation. (Regression 2026-07-13:
// exactly this chain — three .md files added then committed in one command — was wrongly blocked.)
// This scans the command text BEFORE the `git commit` token for `git add` invocations and returns
// the pathspecs they are about to stage, so those can be unioned with whatever is ALREADY staged.
// Returns `{ paths: [...] }` for a fully-resolved explicit file list, or `{ ambiguous: true }` when
// a `git add` uses a pathspec this can't statically resolve to specific files (`-A`, `--all`, `.`,
// a bare directory, or a glob) — those must fail closed rather than guess what they will stage.
const GIT_ADD_AMBIGUOUS_TOKENS = new Set(['-A', '--all', '-u', '--update', '.', '--']);
function extractPendingGitAddPaths(commandBeforeCommit) {
  const paths = [];
  const addSegments = commandBeforeCommit.matchAll(/\bgit\s+add\b([^&;|]*)/g);
  for (const addSegment of addSegments) {
    const argsText = addSegment[1] || '';
    const tokens = [...argsText.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)]
      .map((tokenMatch) => tokenMatch[1] || tokenMatch[2] || tokenMatch[3]);
    for (const token of tokens) {
      if (GIT_ADD_AMBIGUOUS_TOKENS.has(token)) return { ambiguous: true };
      if (token.startsWith('-')) continue; // other flags (-v, -f, -p, ...) don't add ambiguity by themselves
      if (/[*?[\]]/.test(token)) return { ambiguous: true }; // glob pathspec — can't resolve statically
      paths.push(token.replace(/\\/g, '/'));
    }
  }
  return { paths };
}

// True iff the change set this commit is ABOUT TO CREATE is NON-EMPTY and every path in it is a
// doc-only extension. Combines what's already staged (`git diff --cached --name-only`, for a
// `git add` that ran as an earlier, separate command) with what an earlier segment of THIS SAME
// chained command is about to stage (see extractPendingGitAddPaths). Fails CLOSED (returns false =
// "not doc-only, keep blocking") on ANY git error, an empty combined set, or an ambiguous pending
// `git add` pathspec — a plumbing hiccup, a nothing-staged commit, or an unresolvable `git add .`
// must never turn a possibly-code commit into an allowed one.
function isDocOnlyStagedChange(targetDirectory, commandBeforeCommit) {
  let stagedOutput;
  try {
    stagedOutput = execSync('git diff --cached --name-only', {
      encoding: 'utf8',
      cwd: targetDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return false; // fail closed
  }
  const alreadyStagedPaths = stagedOutput.split('\n').map((line) => line.trim()).filter(Boolean);

  const pending = extractPendingGitAddPaths(commandBeforeCommit || '');
  if (pending.ambiguous) return false; // fail closed — can't tell what an `-A`/`.`/glob add will stage

  const combinedPaths = [...new Set([...alreadyStagedPaths, ...pending.paths])];
  if (combinedPaths.length === 0) return false; // nothing staged, nothing pending → NOT doc-only
  return combinedPaths.every(hasDocOnlyExtension);
}

// Is there another worktree of this repo, besides the primary checkout, that is
// currently locked? That's the signal a background agent may be mid-landing. Fails
// open (returns false = "no concurrency detected") on ANY git error — a `git worktree
// list` plumbing hiccup must never block a legitimate commit.
function hasLockedConcurrentWorktree(targetDirectory) {
  let worktreeListOutput;
  try {
    worktreeListOutput = execSync('git worktree list --porcelain', {
      encoding: 'utf8',
      cwd: targetDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return false; // fail open
  }

  const worktreeEntries = worktreeListOutput.split(/\n\n+/).filter((entryText) => entryText.trim());
  // First entry is always the primary checkout (listed first by git); every subsequent
  // entry is a linked worktree — those are the ones a background agent would be using.
  return worktreeEntries.slice(1).some((entryText) => /^locked\b/m.test(entryText));
}

// Strip the two NON-EXECUTABLE region kinds from a raw bash command so keyword scanning only
// ever sees executable structure. Returns a command string of the SAME shape (newlines kept)
// with heredoc bodies and `#` comments blanked out. Never used for cd/branch resolution or the
// deny message — only to decide whether a REAL `git commit` token exists.
//
// (a) HEREDOC BODIES — `cmd << TAG … TAG` writes everything between the opener line and the
//     closing TAG to a file (or stdin); it is DATA, never executed. Handles `<<EOF`, `<< 'EOF'`,
//     `<<"EOF"`, and the indented `<<-EOF` form (closing tag may be tab-indented). The opener
//     `<<TAG` token is KEPT (it is real structure); only the body + closing tag line are dropped.
// (b) `#` COMMENTS — from an unquoted `#` to end of line, the shell discards the rest of the line.
function neutralizeNonExecutableRegions(rawCommand) {
  let stripped = String(rawCommand);

  // (a) Heredoc bodies. `<<-?` then optional space, an optional quote, the tag word, matching
  //     quote; body runs until a line that is just the tag (indented only for the `<<-` form).
  //     Replace the body + closing-tag line with a single newline; keep the opener line.
  stripped = stripped.replace(
    /(<<-?\s*)(['"]?)(\w+)\2([^\n]*)\n[\s\S]*?^[ \t]*\3[ \t]*$/gm,
    (_whole, opener, _quote, tag, restOfOpenerLine) => `${opener}${tag}${restOfOpenerLine}\n`
  );

  // (b) `#` comments — strip from an unquoted `#` to end of line. Require the `#` to be at line
  //     start or preceded by whitespace so a `#` inside a token (URLs, `${x#y}`) is left alone.
  stripped = stripped.replace(/(^|\s)#[^\n]*/g, '$1');

  return stripped;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  if (event.tool_name !== 'Bash') process.exit(0);

  const command = (event.tool_input && event.tool_input.command) || '';
  if (typeof command !== 'string') process.exit(0);

  // Neutralize the NON-EXECUTABLE regions of the RAW command (heredoc bodies + `#` comments)
  // BEFORE collapsing whitespace — both are line-structured, so they must be stripped while the
  // newlines still exist. A shell command has executable structure AND non-executable data: a
  // heredoc body is text written to a file (never run), and a `#` comment is discarded by the
  // shell. Scanning either for `git commit` is scanning prose. (Regression 2026-07-06: a
  // `cat >> log.txt << 'EOF' … git commit … EOF` heredoc-append and a `# … git commit …` comment
  // were both DENIED.) `c` below stays the FULL raw command — cd/branch/-C resolution and the deny
  // message must still see the real structure; only the TRIGGER scan runs on the neutralized copy.
  const commandForTrigger = neutralizeNonExecutableRegions(command);

  const c = command.replace(/\s+/g, ' ').trim();

  // Only fire on git commit. Mask quoted spans too so a `git commit` that appears only INSIDE quoted
  // text — echo/prose (`echo "remember to git commit"`) or a quoted argument to another program
  // (`node brief.mjs --goal "git commit then merge to main"`) — does NOT trigger the guard. The word
  // must be a real command token, not prose. (Quote-mask pattern reused from phantom-delete-commit-guard.)
  const commandWithoutQuotedSpans = commandForTrigger.replace(/"[^"]*"|'[^']*'/g, ' ');
  if (!/\bgit\s+commit\b/.test(commandWithoutQuotedSpans)) process.exit(0);

  const targetDirectory = effectiveDirectory(c, event.cwd || process.cwd());

  // MERGE EXEMPTION (added 2026-07-06). A merge commit MUST land on the target branch — a
  // `git merge`/`git pull` into main, or a `git commit` completing an in-progress merge, is a
  // legitimate main commit, NOT a stray direct feature commit. Allow it without requiring
  // COMMIT_MAIN_OVERRIDE=1. Runs BEFORE the override/concurrency and branch-block paths so the
  // routine merge-to-main never trips either. Ordinary direct commits (no merge in progress,
  // not a merge/pull command) fall through and are still blocked below.
  if (isMergeOrPullCommand(commandWithoutQuotedSpans) || isMergeInProgress(targetDirectory)) {
    process.exit(0);
  }

  // Inline env-var prefix like `COMMIT_MAIN_OVERRIDE=1 git commit ...` sets the var
  // for the git subprocess but not for this hook process. Detect both the inline form
  // and the real env var, so the two forms behave identically below.
  const overridePresent = process.env.COMMIT_MAIN_OVERRIDE === '1' || /\bCOMMIT_MAIN_OVERRIDE=1\b/.test(c);
  const concurrentOkPresent = process.env.CONCURRENT_COMMIT_OK === '1' || /\bCONCURRENT_COMMIT_OK=1\b/.test(c);

  if (overridePresent) {
    // Solo override (no concurrency): behave exactly as before — allow immediately,
    // stay fast, don't even shell out to `git worktree list` for the common case.
    if (concurrentOkPresent || !hasLockedConcurrentWorktree(targetDirectory)) {
      process.exit(0);
    }

    const concurrencyReason = [
      'Commit to main blocked (concurrency detected).',
      '',
      `Command: ${c.slice(0, 120)}${c.length > 120 ? '...' : ''}`,
      '',
      'COMMIT_MAIN_OVERRIDE=1 is present, but another worktree of this repo is currently',
      'LOCKED — that marker means a background agent may be mid-landing right now. A plain',
      '`git commit` never checks whether main moved since it was last read (unlike',
      'safe-merge-to-main.sh, which lands via a compare-and-swap). Racing a plain override',
      'commit against an in-flight agent landing is exactly how a 991-line regression',
      'silently landed on 2026-07-02 (a just-shipped feature, its tests, and its',
      'screenshots got deleted because the override commit\'s parent was stale by one commit).',
      '',
      'Fix — use the sanctioned landing script instead:',
      '  ~/.claude/scripts/safe-merge-to-main.sh <repo-path> <your-branch> "<test-command>"',
      '',
      'Or wait for the other agent(s) to finish (check `git worktree list` for `locked`',
      'entries), then retry.',
      '',
      'Override ONLY if you have verified the locked worktree is genuinely inert/about to',
      'be torn down and this commit is still safe:',
      '  CONCURRENT_COMMIT_OK=1',
    ].join('\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: concurrencyReason,
      },
    }));
    process.exit(0);
  }

  // A chained branch switch BEFORE the commit changes where the commit lands:
  // `git switch -c fix/x && git add ... && git commit` never touches main. Honor the LAST
  // explicit branch switch preceding the first `git commit` (only `switch` and `checkout -b`
  // — a plain `checkout <target>` may be a file restore, not a branch change). Without this,
  // the standard branch-then-commit one-liner was false-blocked (2026-07-01).
  let branch;
  const commandBeforeCommit = c.slice(0, c.search(/\bgit\s+commit\b/));
  const branchSwitches = [...commandBeforeCommit.matchAll(
    /\bgit\s+(?:switch\s+(?:-[cC]\s+)?|checkout\s+-[bB]\s+)(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/g
  )].map((match) => (match[1] || match[2] || match[3] || '').trim()).filter((name) => name && !name.startsWith('-'));
  if (branchSwitches.length) {
    branch = branchSwitches[branchSwitches.length - 1];
  } else {
    try {
      branch = execSync('git branch --show-current', {
        encoding: 'utf8',
        cwd: targetDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      process.exit(0); // fail open — don't block on git errors (incl. a bad cd path: git itself will error)
    }
  }

  if (branch !== 'main' && branch !== 'master') process.exit(0);

  // DOC-ONLY EXEMPTION (2026-07-07, Russell's call): a commit whose staged changes are ALL
  // documentation (.md/.markdown/.mdx/.txt/.rst) is allowed on main WITHOUT a branch or override —
  // the branch dance is pure friction for doc edits. Still respects the concurrency lock: if another
  // worktree is mid-landing, a plain doc commit can still race a compare-and-swap landing, so block
  // and point at safe-merge (same guard the override path uses). A plain repo has no lock → allow.
  if (isDocOnlyStagedChange(targetDirectory, commandBeforeCommit)) {
    if (!hasLockedConcurrentWorktree(targetDirectory)) process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          'Doc-only commit to main blocked (concurrency detected).',
          '',
          'This commit is documentation-only (normally allowed on main with no branch), but another',
          'worktree of this repo is LOCKED — a background agent may be mid-landing, and a plain commit',
          'can race its compare-and-swap. Wait for it, or land via:',
          '  ~/.claude/scripts/safe-merge-to-main.sh <repo-path> <your-branch> "<test-command>"',
          'Or, if you have verified the locked worktree is inert: CONCURRENT_COMMIT_OK=1',
        ].join('\n'),
      },
    }));
    process.exit(0);
  }

  const reason = [
    'Commit to main blocked.',
    '',
    `Current branch: ${branch}`,
    `Command: ${c.slice(0, 120)}${c.length > 120 ? '...' : ''}`,
    '',
    "Rule: never commit CODE directly to main. Always work on a feature/ or fix/ branch.",
    '(Documentation-only commits — .md/.markdown/.mdx/.txt/.rst — are allowed on main automatically.)',
    '',
    'To create a branch and commit:',
    '  git switch -c feature/<task>',
    '  git commit ...',
    '',
    'When done, merge back:',
    '  git switch main',
    '  git merge --ff-only feature/<task>',
    '  git branch -d feature/<task>',
    '  git push origin main',
    '',
    'Override for deliberate main commits (version bumps, doc-only, repo maintenance):',
    '  COMMIT_MAIN_OVERRIDE=1',
  ].join('\n');

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
