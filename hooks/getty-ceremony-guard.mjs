#!/usr/bin/env node
// =============================================================================
// CEREMONY-RABBITHOLE-GUARD — Stop: bite when the session becomes CEREMONY —
//   a streak of INFRA churn with no commit landing the CORE deliverable.
// =============================================================================
//
// new-hook-category: Ceremony / rabbit-hole detection — nearest existing is getty-no-repeat-mistakes (both enforce a Getty rule) but that arms ONLY on Russell's CORRECTION wording in a user message; it has NO detector for the ceremony pattern (many turns on the same infra layer with no core-value commit). This is that missing detector, session-scoped.
//
// The incident (2026-07-19, Russell "WHY DIDNT GETTY BITE?"): the core deliverable was a
// reduced-to-practice 1.5B claim; instead ~10 turns went to chasing a TRANSIENT pod crash and
// hand-patching pod-lifecycle plumbing — real bugs, but NOT the science, and the crash didn't even
// reproduce. That is the Getty "avoid ceremony that doesn't create value" rule + its "attempt #3+ at
// the same infra layer AFTER the core result is banked -> bank + hand off" signal. The rule lived only
// in CLAUDE.md (advisory), so it got ignored — the exact "advisory rules get ignored, use a hook".
//
// PROJECT-AGNOSTIC — no repo-specific paths. THE PATTERN (detectable, session-scoped):
//   (1) A trailing STREAK of INFRA-only commits (meta/tooling/config/docs — hooks, CI, *.md, *.json/
//       yaml, dotfiles, monitor dashboards) with NO commit touching the CORE deliverable (a real
//       SOURCE file that ships value — product code, a library, worker logic, a shipped surface, or a
//       test of it) since. Infra fixes IN SERVICE of a result are fine; a STREAK with no result is the
//       tell. A healthy loop (infra -> core -> infra -> core) never fires.
//   (2) ≥3 attempts at the SAME external op (an identical launch/deploy/remote-run/network command
//       retried 3+ times) — the Getty "attempt #3+ at the same layer" signal, verbatim.
//
// Override: `ceremony-ok: <why this infra IS the core deliverable right now>` in the reply (e.g. the
// task literally IS building the hook/launcher). Never self-grant to keep grinding. Fail-open.
//
// -----------------------------------------------------------------------------------------------
// DETECTOR 3 (2026-07-21) — DUPLICATE VERIFICATION: the same whole-project gate (npm test, pytest,
// go test ./..., a full lint/typecheck/build/e2e run, …) proving success TWICE against the SAME
// content snapshot. The incident: focused tests + diagnostics passed, then the identical 615-test
// full gate re-ran across multiple commits with no material code change between runs — one full
// gate was proof, every rerun after it was ceremony, not additional evidence.
//
// Honest boundary: this is a Stop hook. It cannot intercept or rewind a command already run — it
// can only look back at the transcript at the end of a turn, name the exact proof that got
// duplicated, and block a clean stop until the session either does something about it or states a
// real reason. It has no PreToolUse half; Russell chose Stop-only ownership for this detector.
//
// A "content epoch" is the span between real file-content mutations (a successful Write/Edit/
// MultiEdit/NotebookEdit, or an unambiguous patch-apply shell command). Two whole-project gate runs
// are only a duplicate if they both SUCCEEDED in the SAME epoch — `git add`/`git commit`/`git
// status`/`git diff`/rereading files never advance the epoch, so committing between two identical
// full-suite runs does not excuse the second one. A gate echoed inside a successful `git commit`
// (pre-commit/husky output) counts exactly like a direct run for this purpose.
//
// Override: `verification-rerun-ok: <why repeating the unchanged full gate was necessary>` (reason
// required — a bare token does not clear it). The pre-existing `ceremony-ok:` token also clears this
// detector, kept intentionally so both detectors share one override vocabulary.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentBlocks, effectiveHumanTask, humanSafetyApproval, isHumanPrompt, lastAssistantText, readTranscript, textOf, toolResultText, toolUsesOf } from './lib/transcript.mjs';

const OVERRIDE_RE = /\bceremony-ok\s*:/i;
const INFRA_STREAK_THRESHOLD = 4; // ≥4 trailing infra-only commits, no core since
const SAME_OP_THRESHOLD = 3;      // ≥3 attempts at the SAME external op

// Duplicate-verification override: requires an actual reason, not just the bare token.
const VERIFICATION_RERUN_OVERRIDE_RE = /\bverification-rerun-ok\s*:\s*(\S.*)/i;

// A scalar lookup should be one direct query, with room for two bounded fallbacks. The incident
// this closes used nineteen tool calls, two temporary programs, schema archaeology, and two data
// sources to answer "count the rows." The existing Stop-only detectors could complain only after
// the time was gone; this detector also runs at PreToolUse and denies the fourth tool call.
const SIMPLE_SCALAR_REQUEST_RE = /\b(?:how many|count(?:\s+the)?|what(?:'s|\s+is)\s+(?:the\s+)?(?:count|total|number)|(?:count|total|number)\s+of|average|avg)\b/i;
const COMPLEX_SCALAR_REQUEST_RE = /\b(?:research|investigat\w*|audit|breakdown|analy[sz]\w*|compare|debug|fix|build|implement|design|why)\b/i;
const SIMPLE_SCALAR_TOOL_LIMIT = 3;

const DOC_TARGET_RE = /\b(?:readme|changelog|handoff|truth|roadmap|agents|claude)(?:\.md)?\b|[\w./\\-]+\.(?:md|markdown|rst|adoc|txt)\b/i;
const LITERAL_DOC_EDIT_RE = /\b(?:replace|rename|append|correct|record\s+durably|fix\s+(?:(?:a|the)\s+)?(?:typo|spelling|wording)|change\b[\s\S]{0,100}\bto\b|add\s+(?:this|the\s+following|an?\s+(?:rule|sentence|line))|update\b[\s\S]{0,80}\bto\s+(?:say|read|reflect))\b/i;
const COMPLEX_DOC_REQUEST_RE = /\b(?:research|audit|investigat\w*|analy[sz]\w*|compare|fact[- ]?check|source|design|architect|implement|build|debug|deploy|migrat\w*|benchmark|experiment|plan|create|draft|current|latest|pricing|funding|competitor)\b/i;
const TOOL_COMPARISON_REQUEST_RE = /\b(?:compare|evaluate|benchmark|install|available|portable)\b[\s\S]{0,100}\b(?:sed|awk|grep|rg|perl|python|powershell|bash)\b|\b(?:sed|awk|grep|rg|perl|python|powershell|bash)\b[\s\S]{0,100}\b(?:compare|versus|vs\.?|install|available|portable)\b/i;
const TOOL_PROBE_RE = /(?:^|["'`;\s])(?:command\s+-v|which|where(?:\.exe)?|get-command)\s+(?:sed|awk|grep|rg|perl|python|node|powershell|pwsh|bash)(?:["'`;\s]|$)/i;
// LOOSENED 2026-08-08 (self-blocking false positive). The landing script is ceremony only
// when INVOKED. The bare token also appears in its own test filename, so
// `node --test scripts/safe-merge-to-main.test.mjs` was refused as "merge setup" -- the guard
// blocked the very work it exists to keep honest, and even refused a quiet-override whose
// REASON TEXT merely named the script. Requiring the .sh extension frees the test file
// (never an invocation) while keeping every real invocation matched. Same tightening applied
// to COMMIT_RAN_RE so a test run cannot masquerade as a commit having happened.
const WORKFLOW_EXPANSION_RE = /\bgit\s+worktree\s+add\b|\bgit\s+(?:switch|checkout)\s+(?:-[^\s]*[cb]|--create)\b|\bgit\s+merge\b/i;
// SPLIT OUT 2026-08-08 (live deadlock): safe-merge-to-main.sh used to share
// WORKFLOW_EXPANSION_RE with genuinely NEW-scope actions (a fresh worktree/branch/merge),
// so it inherited the SAME askedFor gate below -- but landing already-finished, already-tested
// work is CLAUDE.md's own standing default ("Ship the moment a feature is DONE... Never wait
// to be asked"), never new scope. A session's driving human message can be anything (a status
// question, "continue", a redirect) with zero obligation to repeat "land it" every time
// completed work is ready to merge; the old shared gate blocked exactly that, and then blocked
// the `git worktree add` needed to fix itself -- a self-referential dead end with no legal move.
const LANDING_RITUAL_RE = /\bsafe-merge-to-main\.sh\b/i;
const PLAN_ARTIFACT_RE = /(?:^|[\\/"'])plans?[\\/]|(?:^|[\\/"'])plan-[^\\/"']+\.md\b/i;
const OUTCOME_ACTION_RE = /\b(?:fix|change|update|edit|replace|rename|remove|add|implement|make|correct|prevent|enforce)\b/i;
const COMPLEX_OUTCOME_RE = /\b(?:research|audit|investigat\w*|analy[sz]\w*|redesign|architect|migrat\w*|refactor|benchmark|experiment|sweep|clean\s+up\s+all|repo-wide|system-wide|global|structural|complex|multi-file|across\s+(?:the|all)|deploy|production|paid)\b/i;
const ITERATION_REQUEST_RE = /\b(?:retry|repeat|poll|monitor|watch|iterate|iterative|refactor|migrat\w*|redesign|multi-step)\b/i;
const MUTATION_TOOL_RE = /^(?:edit|write|multiedit|notebookedit|apply_patch)$/i;
const SHELL_MUTATION_RE = /\b(?:sed\s+-i|git\s+apply|patch\s+-p\d*|set-content|out-file|add-content)\b/i;
// NARROWED 2026-08-07 (live deadlock, CodeServo session). The extension must be a REAL
// file extension, not any alphanumeric run after a dot.
//
// What broke: a pasted architecture spec described repository predicates and contained
// `UserService.archive` and `user.archived`. The old open-ended `\.[A-Za-z0-9]+` read both
// as filenames, so this guard believed the human had "named" two files and then blocked
// EVERY edit outside them for the rest of the session. It deadlocked against
// ross-perot-guard, which was simultaneously demanding the queued work proceed — the same
// two-hook standoff Russell hit 2026-07-30 — and it blocked its own repair.
//
// Why an allowlist rather than a cleverer pattern: dotted identifiers (`obj.method`,
// `Class.field`, `module.CONSTANT`) are ordinary prose in any design discussion, and no
// structural rule separates them from real paths. A scope guard that mistakes them for
// paths misfires on exactly the conversations that talk about code.
//
// The list is generous ON PURPOSE. A missing extension only means the guard does not fire
// (a false negative on scope, recoverable); a wrong match hard-blocks legitimate queued
// work with no way out.
const FILE_EXTENSIONS = [
  'mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'py', 'pyi', 'ipynb', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'r', 'pl',
  'vue', 'svelte', 'astro', 'proto', 'graphql', 'gql', 'prisma', 'tf', 'tfvars',
  'json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock',
  'properties', 'md', 'mdx', 'txt', 'rst', 'org', 'markdown', 'csv', 'tsv', 'xml',
  'svg', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'mk', 'cmake', 'gradle',
  'sql', 'db', 'sqlite', 'sqlite3', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'log',
].join('|');
const FILE_PATH_RE = new RegExp(
  String.raw`(?:[A-Za-z]:[\\/])?[\w.-]+(?:[\\/][\w.-]+)*\.(?:${FILE_EXTENSIONS})\b`,
  'gi',
);
const TEST_PATH_RE = /(?:^|[\\/])(?:tests?|specs?)(?:[\\/]|$)|\.(?:test|spec)\.[^.]+$/i;
// RAISED 5->8 and made ERROR-AWARE 2026-08-07 (live deadlock: a Consulting-project session asked
// to "update my reports" — bounded per OUTCOME_ACTION_RE, no COMPLEX_OUTCOME_RE word present, so
// this branch applied — but the project's OWN CLAUDE.md defines that request as a mandate to
// web-search five categories and verify each listing before touching the report file. This global,
// project-agnostic hook cannot see that project-local mandate, so a handful of legitimate
// orientation reads (an orientation doc, a research-tool contract, a couple of hook sources after
// unrelated denials) blew past a flat count of 5 raw attempts. Worse: every one of those DENIALS
// was itself counted as a "prior orientation action" toward the SAME ceiling, so one false-positive
// block from ANY hook manufactured its own permanent lockout — the exact retry-death-spiral the
// spinning check above already excludes errored attempts from (2026-08-05: "an attempt that ERRORED
// proved nothing"). This applies that identical, already-Russell-approved principle here: only
// SUCCESSFUL prior actions count toward the ceiling, and the ceiling itself moves up one notch to
// give a real multi-step orientation phase room before the hard stop.
const EFFICIENCY_ORIENTATION_LIMIT = 8;
// Identical attempts — successful OR errored — that prove a genuinely stuck retry loop. The spin
// rule below is outcome-aware (a failed attempt proved nothing, so retrying it is progress), and
// this ceiling is what keeps that loosening from opening a blind spot.
const EFFICIENCY_STUCK_RETRY_LIMIT = 4;
// LOOSENED 2026-08-05 (Russell: "it's not like we need an explicit bar per se, our goal is to
// prevent thrashing and sidequests and bikeshedding"). A flat per-file edit count measures FILE
// SIZE, not thrashing — a genuine multi-part fix to one module is composition, and a count blocked
// it twice mid-implementation. What actually distinguishes thrashing is REWORK: editing the same
// REGION again, or rewriting the whole file again, rather than moving on to the next region. So the
// signal is region churn; the count below survives only as a runaway backstop, deliberately far
// above any real change.
const EFFICIENCY_SAME_FILE_EDIT_LIMIT = 12;
// The same region reworked this many times is bikeshedding one passage, not composing a change.
const EFFICIENCY_SAME_REGION_EDIT_LIMIT = 3;
const WHOLE_FILE_REGION = ' whole-file';

function inputText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  try { return JSON.stringify(toolInput ?? {}); } catch { return String(toolInput || ''); }
}

function isLiteralDocEdit(request) {
  const text = String(request || '');
  const namedDocs = text.match(/[\w./\\-]+\.(?:md|markdown|rst|adoc|txt)\b/gi) || [];
  return DOC_TARGET_RE.test(text)
    && LITERAL_DOC_EDIT_RE.test(text)
    && !COMPLEX_DOC_REQUEST_RE.test(text)
    && namedDocs.length <= 3;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function toolRecord(name, input, outcome = {}) {
  return {
    name: String(name || ''),
    input: input ?? {},
    isError: outcome?.isError === true,
    resultText: String(outcome?.resultText || ''),
  };
}

// LOOSENED 2026-08-05 (Russell, "fix hook first"): three sibling guards each DEMANDED an action this
// detector denied, deadlocking a live turn with no legal move — the exact failure Rule 9 proof 8
// forbids. A guard's own denial arrives as an ERRORED tool result carrying its instruction text, so
// the demand is read from real harness state, never from model prose (Rule 1.6). Each pattern must
// match a guard's compound denial wording, not a bare mention of the word.
const GUARD_DEMAND_PATTERNS = {
  'branch, worktree, or merge setup': /(?:worktree|branch)\s+required[\s\S]{0,400}?git\s+worktree\s+add|create\s+one\s+isolated\s+branch\s+worktree/i,
  planning: /\bplan\s+(?:file\s+)?(?:is\s+)?required\b|\bwrite\s+the\s+plan\s+first\b/i,
  'handoff maintenance': /\bHANDOFF\.md\b[\s\S]{0,200}?\b(?:required|must\s+be\s+(?:refreshed|updated))\b/i,
  'external research': /\btwo\s+independent\s+primary\s+sources\b|\bfact-?check\s+before\s+delivery\b/i,
  'a broad test suite': /\bfull\s+(?:test\s+)?suite\s+(?:is\s+)?required\b|\brun\s+the\s+full\s+gate\s+before\b/i,
};

// True when a SIBLING guard's actual denial this turn instructed exactly this detour. Only an errored
// tool result counts: that text is written by the harness, so it cannot be self-granted by the model.
function guardDemandedDetour(prior, detour) {
  const pattern = GUARD_DEMAND_PATTERNS[detour];
  if (!pattern) return false;
  return (prior || []).some((record) => record?.isError === true && pattern.test(String(record?.resultText || '')));
}

function actionSignature(name, input) {
  return `${String(name || '').toLowerCase()}|${inputText(input).replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

function isMutation(record) {
  const name = String(record?.name || '');
  const action = inputText(record?.input);
  return MUTATION_TOOL_RE.test(name) || SHELL_MUTATION_RE.test(action);
}

function actionPaths(record) {
  const input = record?.input;
  const paths = [];
  if (input && typeof input === 'object') {
    for (const key of ['file_path', 'path', 'filePath']) if (typeof input[key] === 'string') paths.push(input[key]);
  }
  const text = inputText(input);
  for (const match of text.matchAll(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*([^\r\n]+)/g)) paths.push(match[1].trim());
  return [...new Set(paths.map(normalizePath).filter(Boolean))];
}

// Which REGION of a file an action rewrites. An Edit is identified by the text it anchors on, so
// two edits to different passages are different regions; a Write (or a patch with no visible anchor)
// replaces everything and shares one whole-file region. This is what separates composing a change
// from reworking the same passage — the distinction a flat edit count cannot make.
function editRegion(record) {
  const input = record?.input;
  const anchor = input && typeof input === 'object'
    ? (input.old_string ?? input.oldString ?? input.old_str)
    : null;
  if (typeof anchor !== 'string' || !anchor.trim()) return WHOLE_FILE_REGION;
  return anchor.replace(/\s+/g, ' ').trim().slice(0, 160).toLowerCase();
}

function namedGoalPaths(request) {
  return [...new Set((String(request || '').match(FILE_PATH_RE) || []).map(normalizePath))];
}

function pathTail(path, segments = 2) {
  return String(path || '').split('/').slice(-segments).join('/');
}

function isGoalOrTestPath(path, goals) {
  if (goals.some((goal) => path === goal || path.endsWith(`/${goal}`) || pathTail(path) === pathTail(goal))) return true;
  if (!TEST_PATH_RE.test(path)) return false;
  const base = path.split('/').pop() || '';
  return goals.some((goal) => {
    const stem = (goal.split('/').pop() || '').split('.')[0];
    return stem.length > 1 && base.includes(stem);
  });
}

// True when this action is the FIRST read of a file the human named in the request. Edit refuses an
// unread file, so counting that read as orientation made the requested edit unreachable — no legal
// move existed. Only the first read of each named target is exempt; a re-read still hits the spin rule.
function isFirstReadOfNamedGoal(request, prior, current) {
  if (isMutation(current)) return false;
  const goals = namedGoalPaths(request);
  if (!goals.length) return false;
  const targets = actionPaths(current);
  if (!targets.length) return false;
  const matchesNamedGoal = (path) => goals.some((goal) => path === goal || path.endsWith(`/${goal}`) || goal.endsWith(`/${path}`));
  if (!targets.some(matchesNamedGoal)) return false;
  const alreadyRead = (prior || []).some((record) => !record.isError && actionPaths(record).some((path) => targets.includes(path)));
  return !alreadyRead;
}

// LOOSENED 2026-08-07 (Russell, "fix hook first" — the docs/efficiency deadlock).
//
// WHY: the front-door docs rule REQUIRES HANDOFF.md / CHANGELOG.md / README.md to move
// after every commit. That demand arrives as STOP feedback, which `guardDemandedDetour`
// structurally CANNOT see — it reads only errored TOOL results. So a mandatory doc
// refresh was classified a detour and blocked, while the docs guard simultaneously
// refused to end the turn without it. Two guards, opposite demands, no legal move —
// the exact deadlock Russell's 2026-07-30 rule forbids.
//
// KEPT NARROW ON PURPOSE: this does NOT blanket-exempt these files. Gratuitous handoff
// bookkeeping with no commit still blocks, which is the protection worth keeping. The
// exemption applies only once a commit or merge has actually run this turn — precisely
// when the docs rule fires and the update stops being optional.
const SHIP_RITUAL_DOC_RE = /\b(?:HANDOFF|CHANGELOG|README)\.md\b/i;
const COMMIT_RAN_RE = /\bgit\s+(?:commit|merge)\b|safe-merge-to-main\.sh/i;

// TIGHTENED 2026-08-07, same session, by red-teaming the loosening above.
// The first version tested the whole action text, so ANY edit whose CONTENT merely
// mentioned "HANDOFF.md" — a plan file, a source comment — inherited the exemption
// and skipped detour classification entirely. Match the TARGET PATH instead: the
// carve-out exists for writing those files, never for writing about them.
function shipRitualDocAfterCommit(prior, current) {
  const targets = actionPaths(current);
  if (!targets.some((path) => SHIP_RITUAL_DOC_RE.test(path))) return false;
  return (prior || []).some((record) => COMMIT_RAN_RE.test(inputText(record?.input)));
}

function processDetour(request, name, action, prior, current) {
  const askedFor = String(request || '');
  // LANDING RITUAL IS STANDING-AUTHORIZED, NEVER GATED ON THIS TURN'S WORDING (2026-08-08,
  // live deadlock -- see LANDING_RITUAL_RE's own comment above for the full incident). This
  // ONLY exempts the "branch, worktree, or merge setup" classification below -- a real
  // safe-merge-to-main.sh invocation never needs askedFor to contain land/ship/commit/etc for
  // THAT check. It deliberately does NOT skip the OTHER checks later in this function (e.g. the
  // "broad test suite" gate on line ~344): the script's own invocation is always sanctioned, but
  // an unscoped test-cmd ARGUMENT passed to it (bare "npm test" instead of a focused selector)
  // is still exactly the signal that check exists to catch, and an early return here would have
  // silently swallowed it too (caught by red-teaming this very fix: an existing true-positive
  // test for that separate case broke when the first draft returned null unconditionally).
  const isLandingRitual = LANDING_RITUAL_RE.test(action);
  // "land the WIP", "ship it", "commit that" all REQUEST landing work without ever saying
  // the words worktree/branch/merge, so the detour check must recognise them too. Otherwise
  // the guard refuses the exact landing the human just asked for (2026-08-08: "fix the WIP"
  // was refused as unrequested setup, leaving uncommitted work with no sanctioned way to land).
  if (!isLandingRitual && WORKFLOW_EXPANSION_RE.test(action) && !/\b(?:worktree|branch|merge|land|ship|wip|commit|uncommitted)\b/i.test(askedFor)) return 'branch, worktree, or merge setup';
  // TIGHTENED 2026-08-08 (found live while fixing the same-file edit-limit incident below): this used
  // to test PLAN_ARTIFACT_RE against the whole stringified action blob, which includes old_string/
  // new_string CONTENT -- so a test file whose fixtures merely contain the sample string
  // "plans/foo.md" (exactly what a regression test for plan-artifact behavior needs to contain)
  // false-positived as "unrequested planning." Same root cause as the safe-merge-to-main.sh test-
  // filename fix above: a literal string appearing IN an edit is not the same as the edit TARGETING
  // that kind of file. Check the actual target path instead.
  // EXEMPTED plain Read 2026-08-08 (found live seconds after the fix above shipped): this check ran
  // for EVERY tool call, including a plain Read -- so re-reading an existing plan file mid-task (to
  // see current content before resuming an edit -- completely ordinary, necessary orientation) was
  // itself classified as "unrequested planning." A Read can never DO planning/handoff work; only
  // writing to one (or `update_plan`, which IS the planning action regardless of file target) can.
  // Scoped to the Read TOOL specifically, not a broader isMutation() gate -- `update_plan` itself
  // isn't classified as a mutation by isMutation() either, and an existing test (line ~965) requires
  // an update_plan call that merely MENTIONS HANDOFF.md to still be classified, so a blanket
  // isMutation gate would have silently un-covered that case too.
  // WIDENED 2026-08-08 (red-team-code found this live, same session as the Read fix): Grep and Glob
  // are exactly as read-only as Read -- neither can DO planning/handoff work -- but only `Read` was
  // exempted, so "grep the plans/ directory for TODOs" or "glob plans/*.md" reproduced the identical
  // false positive via a different tool name. All three take a path-shaped input that can innocently
  // match PLAN_ARTIFACT_RE/HANDOFF.md without the call being an unrequested WRITE to one.
  const isReadOnlyTool = /^(?:read|grep|glob)$/i.test(name);
  const targetIsPlanArtifact = actionPaths(current).some((path) => PLAN_ARTIFACT_RE.test(path));
  if (!isReadOnlyTool && (/update_plan/i.test(name) || targetIsPlanArtifact) && !/\bplan\b/i.test(askedFor)) return 'planning';
  if (shipRitualDocAfterCommit(prior, current)) return '';
  if (!isReadOnlyTool && /handoff\.md/i.test(action) && !/\bhandoff\b/i.test(askedFor)) return 'handoff maintenance';
  if ((/(?:websearch|webfetch|exa|research)/i.test(name) || /\b(?:curl|wget)\s+https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(action)) && !/\b(?:research|source|web|current|latest)\b/i.test(askedFor)) return 'external research';
  // SCOPED TO COMMAND-EXECUTION TOOLS 2026-08-08 (live false positive, same root cause as the
  // plan-artifact/handoff-maintenance content-vs-target bugs above): matchGateFamily's bare-word
  // triggers (a Python test-runner name, a JS test-runner name, etc) are meant to catch a REAL
  // command invocation, but this check ran on `action` for EVERY tool -- so writing an HTML/doc
  // file whose PROSE merely mentions a real project name containing one of those trigger words
  // false-positived as "running the whole [runner] suite." Only Bash/PowerShell tool calls
  // actually EXECUTE their input; an Edit/Write's content is never itself an invocation, whatever
  // words happen to appear in it.
  const isCommandExecutionTool = /^(?:bash|powershell)$/i.test(name);
  if (isCommandExecutionTool && matchGateFamily(action) && !/\b(?:full|broad|all|suite|repository)\s+(?:test|gate|check)|\btest\s+suite\b/i.test(askedFor)) return 'a broad test suite';
  return '';
}

function efficiencyReason(detail) {
  return `EFFICIENCY — ${detail}. Take the smallest next action that directly advances the human's stated goal. If that action creates a real safety concern, raise the concrete risk to the human; only their approval can unlock it.`;
}

export function detectEfficiencyKernel({ userText = '', completedTools = [], toolName = '', toolInput = {}, humanSafetyApproval = false } = {}) {
  if (humanSafetyApproval) return { block: false };
  const request = String(userText || '');
  const prior = (completedTools || []).map((record) => toolRecord(record?.name, record?.input, record));
  const current = toolRecord(toolName, toolInput);
  const action = inputText(toolInput);

  // LOOSENED 2026-08-05: an attempt that ERRORED proved nothing, so retrying it after fixing the
  // cause is progress, not spinning. Counting failures as repeats made the retry illegal while other
  // guards demanded it. Successful repeats still block at two; a stuck loop still blocks at four.
  const sameAction = prior.filter((record) => actionSignature(record.name, record.input) === actionSignature(current.name, current.input));
  const succeededRepeats = sameAction.filter((record) => !record.isError).length;
  const spinning = succeededRepeats >= 2 || sameAction.length >= EFFICIENCY_STUCK_RETRY_LIMIT;
  if (spinning && !ITERATION_REQUEST_RE.test(request)) {
    const detail = succeededRepeats >= 2
      ? 'the same action already ran twice; a third identical attempt is spinning'
      : `the same action already failed ${sameAction.length} times; change the approach instead of retrying`;
    return { block: true, reason: efficiencyReason(detail) };
  }

  if (isMutation(current) && !ITERATION_REQUEST_RE.test(request)) {
    const currentPaths = actionPaths(current);
    const editsTo = (path) => prior.filter((record) => isMutation(record) && actionPaths(record).includes(path));
    const currentRegion = editRegion(current);
    let thrashDetail = '';
    for (const path of currentPaths) {
      const edits = editsTo(path);
      const erroredSameRegion = edits.filter((record) => record.isError && editRegion(record) === currentRegion).length;
      if (erroredSameRegion >= 2) {
        thrashDetail = 'this same passage already failed to edit twice; fix the blocker instead of retrying the same change';
        break;
      }
      const sameRegion = edits.filter((record) => editRegion(record) === currentRegion).length;
      if (sameRegion >= EFFICIENCY_SAME_REGION_EDIT_LIMIT) {
        thrashDetail = currentRegion === WHOLE_FILE_REGION
          ? 'this file has been rewritten whole several times; edit the specific part that is wrong'
          : 'the same passage has been reworked several times; it is bikeshedding, not progress';
        break;
      }
      // EXEMPTED 2026-08-08 (Russell, "WHY DID YOU STOP" -- a live write-plan session got hard-blocked
      // mid-plan). Root cause: write-plan's OWN Rule 0 mandates composing a large plan via many small,
      // non-overlapping Edits (30-80 lines each, one section per call) and explicitly FORBIDS batching
      // sections to "save tool calls" -- so a real, correctly-authored plan document routinely needs
      // 15-20+ edits, well past this flat backstop of 12. The region checks just above already prove
      // such edits aren't thrashing (each targets a distinct, never-before-touched region); this flat
      // count fired anyway as a redundant, miscalibrated second gate. The hook already has a
      // first-class notion of "plan artifact" (PLAN_ARTIFACT_RE, used by processDetour above) -- reuse
      // it: a plan file is exempt from the flat count, but NOT from the region-rework checks directly
      // above (erroredSameRegion / sameRegion still fire normally), so bikeshedding one section of a
      // plan is still caught -- only legitimate composition of NEW sections is freed.
      if (edits.length >= EFFICIENCY_SAME_FILE_EDIT_LIMIT && !PLAN_ARTIFACT_RE.test(path)) {
        thrashDetail = `${edits.length} edits to one file in a single turn; land what you have before continuing`;
        break;
      }
    }
    if (thrashDetail) return { block: true, reason: efficiencyReason(thrashDetail) };
  }

  const bounded = OUTCOME_ACTION_RE.test(request) && !COMPLEX_OUTCOME_RE.test(request);
  if (!bounded) return { block: false };

  const detour = processDetour(request, current.name, action, prior, current);
  if (detour && !guardDemandedDetour(prior, detour)) {
    return { block: true, reason: efficiencyReason(`${detour} was not requested and does not advance this bounded task`) };
  }

  const priorHasMutation = prior.some(isMutation);
  // Only SUCCESSFUL priors count (see the dated comment on EFFICIENCY_ORIENTATION_LIMIT above) — a
  // denial from this or any sibling guard proves nothing about whether the model is wandering, so
  // it must not manufacture its own lockout by inflating the very count that blocks it.
  const successfulOrientation = prior.filter((record) => !record.isError);
  if (!priorHasMutation && successfulOrientation.length >= EFFICIENCY_ORIENTATION_LIMIT && !isMutation(current) && !isFirstReadOfNamedGoal(request, prior, current)) {
    return { block: true, reason: efficiencyReason(`${successfulOrientation.length} orientation actions already ran without changing the deliverable`) };
  }

  if (isMutation(current)) {
    const goals = namedGoalPaths(request);
    const targets = actionPaths(current);
    if (goals.length > 0 && goals.length <= 3 && targets.some((path) => !isGoalOrTestPath(path, goals))) {
      return { block: true, reason: efficiencyReason('this edit leaves the file scope named by the human') };
    }
  }
  return { block: false };
}

export function detectSimpleEditCeremony({ userText = '', completedToolInputs = [], toolName = '', toolInput = {} } = {}) {
  const request = String(userText || '');
  const action = inputText(toolInput);

  const priorProbe = (completedToolInputs || []).some((value) => TOOL_PROBE_RE.test(inputText(value)));
  if (TOOL_PROBE_RE.test(action) && priorProbe && !TOOL_COMPARISON_REQUEST_RE.test(request)) {
    return { block: true, reason: 'TOOL-CHOICE CEREMONY — one adequate utility was already found. Use it and advance the requested outcome.' };
  }

  if (!isLiteralDocEdit(request)) return { block: false };

  let offense = '';
  if (WORKFLOW_EXPANSION_RE.test(action)) offense = 'branch, worktree, or merge setup';
  else if (/update_plan/i.test(toolName) || PLAN_ARTIFACT_RE.test(action)) offense = 'a plan artifact';
  else if (/handoff\.md/i.test(action) && !/handoff/i.test(request)) offense = 'an unrequested handoff expansion';
  else if (matchGateFamily(action)) offense = 'a broad test suite';
  else if (/(?:websearch|webfetch|exa|research)/i.test(toolName) || /\b(?:curl|wget)\s+https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(action)) offense = 'external research';
  if (!offense) return { block: false };

  return {
    block: true,
    reason: `SIMPLE EDIT — this is a literal documentation change. ${offense} does not advance it. Use the fast lane: targeted read, patch, direct verification, commit.`,
  };
}

export function detectSimpleScalarToolBudget({ userText = '', completedToolCount = 0, toolLimit = SIMPLE_SCALAR_TOOL_LIMIT } = {}) {
  const request = String(userText || '');
  if (!SIMPLE_SCALAR_REQUEST_RE.test(request) || COMPLEX_SCALAR_REQUEST_RE.test(request)) return { block: false };
  if (!Number.isFinite(completedToolCount) || completedToolCount < toolLimit) return { block: false };
  return {
    block: true,
    reason: `SIMPLE COUNT BUDGET — this is a scalar lookup and ${completedToolCount} tool calls already ran.

Stop digging. Do not create another script, inspect another layer, or add another fallback. Use the evidence already gathered and answer the number in one line. If the authoritative count genuinely failed, state that one hard blocker in one line. Explicit research, audit, debug, and breakdown requests are outside this gate.`,
  };
}

// A normalized-identity table of whole-project gate families. Each `trigger` matches the command
// (or, for a commit-hook run, the echoed output) that invokes the WHOLE suite/check; `requireAll`
// (when present) are additional markers that must ALSO be present (e.g. go test needs `./...`).
// Data-driven and project-agnostic — no repo names, paths, or test counts.
const GATE_FAMILIES = [
  { id: 'js-test', trigger: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::all)?\b/i },
  { id: 'vitest', trigger: /\bvitest\s+run\b/i },
  { id: 'jest', trigger: /\bjest\b/i },
  { id: 'pytest', trigger: /\bpytest\b/i },
  { id: 'go-test', trigger: /\bgo\s+test\b/i, requireAll: [/\.\/\.\.\.(?:\s|$)/] },
  { id: 'cargo-test', trigger: /\bcargo\s+test\b/i },
  { id: 'dotnet-test', trigger: /\bdotnet\s+test\b/i },
  { id: 'lint', trigger: /\b(?:npm|pnpm|yarn|bun)\s+run\s+lint\b|\beslint\s+\.(?:\s|$)/i },
  { id: 'typecheck', trigger: /\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:typecheck|type-check|check)\b|\btsc\s+--noEmit\b/i },
  { id: 'build', trigger: /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b/i },
  { id: 'e2e', trigger: /\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:e2e|test:e2e)\b|\bplaywright\s+test\b|\bcypress\s+run\b/i },
];

// A file/test/pattern selector anywhere in the command downgrades a would-be whole-project gate to
// FOCUSED — it is scoped to less than the whole project, so it never counts as a whole-project gate.
const SELECTOR_FLAG_RE = /(^|\s)(-t|--testNamePattern|--grep|-k|--filter|--testPathPattern|-run)(=|\s|$)/i;
const SELECTOR_NODE_ID_RE = /::[\w./-]+/;
const SELECTOR_JS_TEST_FILE_RE = /[\w./-]*\.(?:test|spec)\.[cm]?[jt]sx?\b/i;
const SELECTOR_PY_FILE_ARG_RE = /(^|[\s"'])[\w./-]+\.py(?=[\s"']|$)/;

// A content-mutating shell idiom that isn't a Write/Edit/MultiEdit/NotebookEdit tool call but still
// changes file content — advances the content epoch just like those tool calls do.
const PATCH_COMMAND_RE = /\bgit\s+apply\b|\bpatch\s+-p\d?\b|\bsed\s+-i\b/i;
const CONTENT_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// PROJECT-AGNOSTIC classification. INFRA = meta/tooling/config/docs churn (the scaffolding around a
// product); CORE = a real source file that ships value (product code, a library, worker logic, a
// shipped surface) or a test of it. No project-specific paths — works for any repo.
const META_DIR = /(?:^|\/)(?:hooks|\.github|\.claude|\.husky|\.circleci|\.gitlab|ci|deploy|infra|scripts\/deploy)\//i;
const DASHBOARD = /-live\.html$/i;                    // a monitor/telemetry dashboard, not product UI
const DOC_EXT = /\.(?:md|markdown|rst|txt|adoc)$/i;   // docs (README/CHANGELOG/HANDOFF/notes/briefs)
const CONFIG_EXT = /\.(?:json|ya?ml|toml|ini|cfg|conf|lock|env)$/i; // config / lockfiles
const DOTFILE = /(?:^|\/)\.[^/]+$/;                   // .gitignore / .editorconfig / etc.

// True when a changed path is INFRA (not the CORE deliverable). Anything else — a real source file with
// a code extension outside a meta dir — is CORE.
export function isInfraPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return false;
  if (META_DIR.test(normalized)) return true;
  if (DASHBOARD.test(normalized)) return true;
  if (DOC_EXT.test(normalized) || CONFIG_EXT.test(normalized)) return true;
  if (DOTFILE.test(normalized)) return true;
  return false;
}

// Classify one commit by its changed files: 'infra' (all files infra), 'core' (≥1 non-infra file), or
// 'empty' (no known files — neither counts nor breaks a streak).
export function classifyCommit(files) {
  const changedFiles = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!changedFiles.length) return 'empty';
  return changedFiles.every((filePath) => isInfraPath(filePath)) ? 'infra' : 'core';
}

// Count the trailing run of infra-only commits (newest-last order), stopping at the first CORE commit.
// 'empty' commits are skipped (no evidence either way). A CORE commit anywhere in the trailing run
// resets the streak to what came after it — so a healthy infra->core->infra loop never accumulates.
export function trailingInfraOnlyStreak(classifications) {
  let streak = 0;
  for (let index = (classifications || []).length - 1; index >= 0; index--) {
    const kind = classifications[index];
    if (kind === 'core') break;
    if (kind === 'infra') streak += 1;
  }
  return streak;
}

// An EXTERNAL / expensive op — a launch, deploy, remote run, or network retry. Project-agnostic verb
// list; a repeated IDENTICAL such command across the session is the "attempt #3+ at the same op" signal.
// Read-only/local commands (git status, ls, cat, node --test) are never external ops.
const EXTERNAL_OP_RE = /\b(?:launch|deploy|publish|terminate|provision|runpod\w*|modal|kubectl|terraform|helm|ansible|docker\s+(?:run|build|push)|curl|wget|ssh|scp|rsync|npm\s+publish|gh\s+(?:release|workflow)|sbatch|srun|aws\s+\w+|gcloud\s+\w+)\b/i;

// The op signature: the command with volatile-only noise (surrounding whitespace) normalized, but its
// DISTINGUISHING args intact — so the SAME op retried collapses to one key while genuinely different
// targets (different seeds, different endpoints) stay distinct. Null when it's not an external op.
export function externalOpSignature(command) {
  const commandText = String(command || '');
  if (!EXTERNAL_OP_RE.test(commandText)) return null;
  return commandText.replace(/\s+/g, ' ').trim().toLowerCase();
}

// The largest count of any single external op repeated across the session. ≥ SAME_OP_THRESHOLD is the
// "same failing op attempted 3+ times" rabbit-hole (a launch that won't take, an endpoint retried).
export function repeatedSameOpCount(commands) {
  const counts = new Map();
  for (const command of commands || []) {
    const signature = externalOpSignature(command);
    if (!signature) continue;
    counts.set(signature, (counts.get(signature) || 0) + 1);
  }
  let maxCount = 0;
  for (const count of counts.values()) if (count > maxCount) maxCount = count;
  return maxCount;
}

// Pure decision.
export function detectCeremony({ commitFileLists = [], commands = [], replyText = '', infraStreakThreshold = INFRA_STREAK_THRESHOLD, sameOpThreshold = SAME_OP_THRESHOLD } = {}) {
  if (OVERRIDE_RE.test(replyText)) return { block: false };
  const streak = trailingInfraOnlyStreak(commitFileLists.map(classifyCommit));
  if (streak >= infraStreakThreshold) {
    return { block: true, reason: ceremonyReason(`${streak} straight INFRA-only commits with no commit landing the CORE deliverable`) };
  }
  const sameOp = repeatedSameOpCount(commands);
  if (sameOp >= sameOpThreshold) {
    return { block: true, reason: ceremonyReason(`the SAME external op attempted ${sameOp}× (attempt #3+ at the same layer)`) };
  }
  return { block: false };
}

function ceremonyReason(what) {
  return `CEREMONY CHECK — ${what}. This is the rabbit-hole the Getty "avoid ceremony that doesn't create value" rule names.

BANK what works, state the CORE result's status in ONE line, then either:
  (a) take the ONE action that advances the core deliverable (the science / the shipped surface / the verdict), or
  (b) if it's genuinely blocked, say the blocker in one line and HAND OFF — do NOT keep patching the infra.

Infra fixes in service of a result are fine; a STREAK of them with no result landing is the tell (attempt #3+ at the same layer after the core is banked = bank + hand off, not push).
Override (only when the infra IS the deliverable right now — e.g. the task literally is building this hook/launcher): put ceremony-ok: <why> in your reply.`;
}

// ---------- duplicate-verification detection (session-scoped) ----------

// True when `command` carries a selector that scopes it to LESS than the whole project — a
// specific file/spec, a test-name pattern, a pytest/dotnet node id, or a package filter. Any match
// means the command is FOCUSED, never a whole-project gate, regardless of which family it belongs to.
export function hasSelectorMarker(command) {
  const normalizedCommand = String(command || '');
  if (SELECTOR_FLAG_RE.test(normalizedCommand)) return true;
  if (SELECTOR_NODE_ID_RE.test(normalizedCommand)) return true;
  if (SELECTOR_JS_TEST_FILE_RE.test(normalizedCommand)) return true;
  if (SELECTOR_PY_FILE_ARG_RE.test(normalizedCommand) && /\bpytest\b/i.test(normalizedCommand)) return true;
  return false;
}

// The normalized whole-project gate family `command` invokes, or null when it doesn't match any
// known family, or matches one but is scoped down by a selector (focused, not whole-project).
export function matchGateFamily(command) {
  const normalizedCommand = String(command || '');
  for (const family of GATE_FAMILIES) {
    if (!family.trigger.test(normalizedCommand)) continue;
    if (family.requireAll && !family.requireAll.every((marker) => marker.test(normalizedCommand))) continue;
    if (hasSelectorMarker(normalizedCommand)) return null;
    return family.id;
  }
  return null;
}

// Every whole-project family whose trigger appears in `commitOutput` with no selector — used to find
// a gate that ran NESTED inside a `git commit`'s own output (a pre-commit/husky hook echoing the
// underlying test/lint/build command it ran). Each hit is paired with its outcome from that same output.
export function nestedGateRunsInOutput(commitOutput) {
  const normalizedOutput = String(commitOutput || '');
  const found = [];
  for (const family of GATE_FAMILIES) {
    if (!family.trigger.test(normalizedOutput)) continue;
    if (family.requireAll && !family.requireAll.every((marker) => marker.test(normalizedOutput))) continue;
    if (hasSelectorMarker(normalizedOutput)) continue;
    found.push({ familyId: family.id, outcome: classifyGateOutcome(family.id, normalizedOutput, false) });
  }
  return found;
}

// 'pass' | 'fail' | 'unknown' — read from OUTPUT TEXT, never from the shell exit code: a command
// chained through `| tail` or `2>&1 | grep` reports the pipeline's exit, not the test runner's, so
// `is_error` on the tool result is unreliable and only used as a last-resort signal for generic gates.
export function classifyGateOutcome(familyId, gateOutput, isError) {
  const normalizedGateOutput = String(gateOutput || '');
  switch (familyId) {
    case 'pytest': {
      const failed = normalizedGateOutput.match(/(\d+)\s+failed\b/i);
      const errored = normalizedGateOutput.match(/(\d+)\s+error(?:s)?\b/i);
      const passed = normalizedGateOutput.match(/(\d+)\s+passed\b/i);
      if ((failed && Number(failed[1]) > 0) || (errored && Number(errored[1]) > 0)) return 'fail';
      if (passed && Number(passed[1]) > 0) return 'pass';
      return 'unknown';
    }
    case 'js-test':
    case 'vitest':
    case 'jest':
    case 'e2e': {
      const failed = normalizedGateOutput.match(/(\d+)\s+(?:failed|failing)\b/i);
      if (failed && Number(failed[1]) > 0) return 'fail';
      if (/npm ERR!/i.test(normalizedGateOutput)) return 'fail';
      const passed = normalizedGateOutput.match(/(\d+)\s+passing\b/i) || normalizedGateOutput.match(/(\d+)\s+passed\b/i);
      if (passed && Number(passed[1]) > 0) return 'pass';
      return 'unknown';
    }
    case 'go-test':
      if (/\bFAIL\b/.test(normalizedGateOutput)) return 'fail';
      if (/\bok\s+\S+/.test(normalizedGateOutput)) return 'pass';
      return 'unknown';
    case 'cargo-test':
      if (/test result:\s*FAILED/i.test(normalizedGateOutput)) return 'fail';
      if (/test result:\s*ok/i.test(normalizedGateOutput)) return 'pass';
      return 'unknown';
    case 'dotnet-test': {
      const failed = normalizedGateOutput.match(/Failed:\s*(\d+)/i);
      const passed = normalizedGateOutput.match(/Passed:\s*(\d+)/i);
      if (failed && Number(failed[1]) > 0) return 'fail';
      if (/Passed!/i.test(normalizedGateOutput) || (passed && Number(passed[1]) > 0)) return 'pass';
      return 'unknown';
    }
    default: { // lint / typecheck / build — formats vary too much per project to pattern-match precisely
      if (/\berror(?:s)?\b/i.test(normalizedGateOutput) && !/\b0\s+errors?\b/i.test(normalizedGateOutput)) return 'fail';
      if (isError) return 'fail';
      return normalizedGateOutput.trim() ? 'pass' : 'unknown';
    }
  }
}

// One session-scoped, chronologically-ordered pass over `events` (see parseSession's `events`
// output) that returns every PROVEN (successful) whole-project gate run, each tagged with the
// content epoch it ran in. Epoch advances only on a real content mutation — see CONTENT_EDIT_TOOLS /
// PATCH_COMMAND_RE above; `git add`/`git commit`/reads/reruns never advance it.
export function buildVerificationLedger(events) {
  let epoch = 0;
  const provenRuns = [];
  for (const event of events || []) {
    if (!event) continue;
    if (event.kind === 'edit') {
      if (event.isError !== true) epoch += 1;
      continue;
    }
    if (event.kind !== 'shell') continue;
    const command = event.command || '';
    if (/\bgit\s+commit\b/.test(command)) {
      for (const { familyId, outcome } of nestedGateRunsInOutput(event.outputText)) {
        if (outcome === 'pass') provenRuns.push({ familyId, epoch, viaCommitHook: true });
      }
    } else {
      const familyId = matchGateFamily(command);
      if (familyId) {
        const outcome = classifyGateOutcome(familyId, event.outputText, event.isError);
        if (outcome === 'pass') provenRuns.push({ familyId, epoch, viaCommitHook: false });
      }
    }
    if (PATCH_COMMAND_RE.test(command) && event.isError !== true) epoch += 1;
  }
  return provenRuns;
}

function hasDuplicateVerificationOverride(replyText) {
  const reply = String(replyText || '');
  const match = reply.match(VERIFICATION_RERUN_OVERRIDE_RE);
  if (match && match[1] && match[1].trim()) return true;
  return OVERRIDE_RE.test(reply); // the pre-existing ceremony-ok token, kept working for both detectors
}

// Pure decision. Groups every PROVEN whole-project run by `${epoch}:${familyId}`; ≥2 in the same
// group is the same gate proving success twice against unchanged code.
export function detectDuplicateVerification({ events = [], replyText = '' } = {}) {
  if (hasDuplicateVerificationOverride(replyText)) return { block: false };
  const groups = new Map();
  for (const run of buildVerificationLedger(events)) {
    const key = `${run.epoch}:${run.familyId}`;
    const group = groups.get(key) || { familyId: run.familyId, epoch: run.epoch, count: 0, viaCommitHook: false };
    group.count += 1;
    if (run.viaCommitHook) group.viaCommitHook = true;
    groups.set(key, group);
  }
  const duplicates = [...groups.values()].filter((group) => group.count >= 2);
  if (!duplicates.length) return { block: false };
  return { block: true, reason: duplicateVerificationReason(duplicates) };
}

const GATE_LABELS = {
  'js-test': 'the JS/TS test suite (npm/pnpm/yarn/bun test)',
  vitest: 'vitest run',
  jest: 'jest',
  pytest: 'pytest',
  'go-test': 'go test ./...',
  'cargo-test': 'cargo test',
  'dotnet-test': 'dotnet test',
  lint: 'the full lint gate',
  typecheck: 'the full typecheck/check gate',
  build: 'the full build',
  e2e: 'the end-to-end suite',
};

function duplicateVerificationReason(duplicates) {
  const lines = duplicates.map((duplicate) => `  - ${GATE_LABELS[duplicate.familyId] || duplicate.familyId}: succeeded ${duplicate.count}× in the same content epoch${duplicate.viaCommitHook ? ' (includes a commit-hook copy)' : ''}`);
  return `DUPLICATE VERIFICATION — the same whole-project gate proved success more than once against unchanged code:
${lines.join('\n')}

One successful full gate is proof. Running it again with no content change is ceremony, not additional evidence.
  1. Keep focused tests during development.
  2. Choose ONE owner for the final whole-project proof.
  3. If pre-commit already owns the full gate, do not manually run that same full gate immediately before committing — let the commit hook provide the single canonical proof.
  4. Never bypass a required hook with --no-verify merely to silence this guard.
  5. After a real content edit, one new full gate is valid because it proves a new snapshot.
Override only for a genuine exception: verification-rerun-ok: <why repeating the unchanged full gate was necessary>`;
}

// ---------- banked-then-polish detection (session-scoped, project-agnostic) ----------
//
// DETECTOR 3 (2026-07-25) — BANKED RESULT then POLISH STREAK: the in-session, pre-commit,
// no-correction trap neither this hook's own commit-streak detector (detector 1) nor `getty-no-repeat`
// (correction/cost-admission only) catches. The live incident (Macher, 2026-07-25, cost ~2h): the
// identity-card fix was silently PROVEN when the authed replay returned firstName=Russell, then
// 6 more tool calls chased polish (strip diagnostic → npm test → npm check → npm build → wrangler
// deploy → re-verify) with no commit in between, no correction from Russell, no self-admission —
// so neither sibling detector armed. This is the missing one.
//
// Two arming paths, shared override:
//   (A) EXPLICIT MARKER — an assistant text block with `BANKED: <one-line claim>`. Threshold: ≥2
//       further productive tools without a clear. The semantic judgment of "is this the core
//       result?" is human's (Russell or the assistant, deliberately); once marked, mechanical.
//   (B) VICTORY-CLAIM (softer, catches the case where nobody wrote BANKED:) — high-precision
//       patterns claiming a WORKING, VERIFIED result ("confirmed end-to-end", "verified live",
//       "the fix works"). Threshold: ≥4 (softer signal, higher bar). Diagnostic progress
//       ("root cause found") deliberately does NOT arm.
// CLEAR: `polish-override: <why>`, `new-task: <what>` (reason-bearing — bare tokens don't clear),
//   a real new user prompt (Russell redirecting), or a `git commit` (the result is then durable).
//
// PROJECT-AGNOSTIC — no project paths, no tool names unique to any repo. `Bash`/`Edit`/etc. are
// the universal Claude Code mutating-tool names; `git commit` is universal. The detector reasons
// over transcript shape, never content semantics specific to one codebase.

const BANKED_MARKER = /\bBANKED\s*:\s*(\S[^\n]{0,200})/i;
const POLISH_OVERRIDE = /\bpolish-override\s*:\s*(\S[^\n]{0,200})/i;
const NEW_TASK_MARKER = /\bnew-task\s*:\s*(\S[^\n]{0,200})/i;
const COMMIT_COMMAND = /\bgit\s+commit\b/i;

// HIGH-PRECISION claims of a WORKING, VERIFIED result (not diagnostic progress). Each is a
// false-positive risk, so add sparingly. "Root cause found" / "diagnostic shows X" / normal
// mid-task language must NOT arm — only a declared victory does.
const VICTORY_CLAIM_PATTERNS = [
  /\bconfirmed (end-?to-?end|live|working)\b/i,
  /\bverified (live|end-?to-?end|working)\b/i,
  /\bfix (works|is proven|landed|is confirmed)\b/i,
  /\b(?:the )?(?:fix|feature|migration|change) (?:works|is proven|succeeded)\b/i,
];

// Productive (content-mutating) tool names — universal Claude Code mutating tools. Read/Glob/Grep
// are deliberately excluded: reading/searching is not polishing.
const PRODUCTIVE_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell']);

const BANKED_EXPLICIT_THRESHOLD = 2; // ≥2 productive tools after BANKED: (single follow-up is fine)
const BANKED_VICTORY_THRESHOLD = 4;  // ≥4 after a victory claim (softer signal, higher bar)

const matchesVictoryClaim = (text) => VICTORY_CLAIM_PATTERNS.some((pattern) => pattern.test(String(text || '')));

// Pure decision. Walks `assistantBlocks` (the chronological {role, text, toolUses} list from
// parseSession) tracking the most recent bank event and counting productive tools since. Exported
// for the test file. Project-agnostic — reasons only over transcript shape.
export function detectBankedThenPolish({ assistantBlocks = [], replyText = '' } = {}) {
  if (!Array.isArray(assistantBlocks) || assistantBlocks.length === 0) return { block: false };

  let bankedAtIndex = -1;
  let bankedKind = '';
  let bankedClaim = '';
  let toolsSinceBank = 0;
  let overrideActive = false;

  for (let index = 0; index < assistantBlocks.length; index++) {
    const entry = assistantBlocks[index];

    // A real user prompt closes the bank — Russell redirecting naturally starts a new task.
    // tool_result messages are user-role but NOT turn starts, so they don't reset.
    if (entry.role === 'user') {
      if (!entry.isToolResult) {
        bankedAtIndex = -1;
        bankedKind = '';
        bankedClaim = '';
        toolsSinceBank = 0;
        overrideActive = false;
      }
      continue;
    }
    if (entry.role !== 'assistant') continue;

    // First pass over the text: overrides, then markers, then victory claims.
    if (POLISH_OVERRIDE.test(entry.text) && bankedAtIndex >= 0) overrideActive = true;
    if (NEW_TASK_MARKER.test(entry.text) && bankedAtIndex >= 0) overrideActive = true;

    const bankedMatch = entry.text.match(BANKED_MARKER);
    if (bankedMatch) {
      bankedAtIndex = index;
      bankedKind = 'explicit';
      bankedClaim = bankedMatch[1].trim();
      toolsSinceBank = 0;
      overrideActive = false;
      continue;
    }
    if (bankedAtIndex < 0 && matchesVictoryClaim(entry.text)) {
      bankedAtIndex = index;
      bankedKind = 'victory-claim';
      bankedClaim = entry.text.slice(0, 150);
      toolsSinceBank = 0;
      overrideActive = false;
    }

    // Second pass: count productive tools, clear on git commit.
    for (const toolUse of entry.toolUses || []) {
      if (!PRODUCTIVE_TOOLS.has(toolUse.name)) continue;
      if (toolUse.name === 'Bash' && COMMIT_COMMAND.test(String(toolUse.input?.command || ''))) {
        bankedAtIndex = -1;
        bankedKind = '';
        bankedClaim = '';
        toolsSinceBank = 0;
        overrideActive = false;
        continue;
      }
      if (bankedAtIndex >= 0 && !overrideActive) toolsSinceBank += 1;
    }
  }

  if (bankedAtIndex < 0 || overrideActive) return { block: false };

  if (bankedKind === 'explicit' && toolsSinceBank >= BANKED_EXPLICIT_THRESHOLD) {
    return { block: true, kind: bankedKind, claim: bankedClaim, toolsSinceBank,
      reason: bankedReason(bankedKind, bankedClaim, toolsSinceBank) };
  }
  if (bankedKind === 'victory-claim' && toolsSinceBank >= BANKED_VICTORY_THRESHOLD) {
    return { block: true, kind: bankedKind, claim: bankedClaim, toolsSinceBank,
      reason: bankedReason(bankedKind, bankedClaim, toolsSinceBank) };
  }
  return { block: false };
}

function bankedReason(kind, claim, toolsSinceBank) {
  const claimLine = claim ? `\n  BANKED CLAIM: "${claim.slice(0, 150)}"\n` : '\n';
  const how = kind === 'explicit'
    ? `an explicit BANKED: marker ${toolsSinceBank} productive tool call(s) ago`
    : `a victory claim ${toolsSinceBank} productive tool call(s) ago (no explicit BANKED: marker — softer signal)`;
  return `BANKED-RESULT CHECK — the core result was declared proven via ${how}, and you're still working.${claimLine}
The Getty rule (2026-07-15): "Declare victory when the CORE result lands — don't chase 'complete' past the point of value." The eval / archive / polish / "make it fully clean" is a SEPARATE, resumable task — not a reason to keep spending live (paid pods, your energy, context).

Before stopping, choose ONE:
  (a) STATE the banked result in one line and STOP — let Russell decide if polish is worth more time.
  (b) If this polish IS load-bearing right now, say so explicitly: \`polish-override: <one-line why>\`.
  (c) If you've switched to a NEW task, say: \`new-task: <what the new task is>\`.

A \`git commit\` also closes the bank (the result is then durable in history). Override tokens are REASON-BEARING — a bare token without a reason does not clear the gate.`;
}

// ---------- pattern-named-but-not-generalized detection (session-scoped, project-agnostic) ----------
//
// DETECTOR 5 (2026-07-25) — NAMED A PATTERN, PATCHED ONE HOLE. The Getty rule (updated 2026-07-25)
// requires the fix to cover the most general reasonable CLASS of the bug, not just the instance
// that bit. The live incident (2026-07-25): three bugs in one night with the same root shape (a
// value stored under one auth context that fails under another — PostgREST GRANT, Stripe test
// customer). The assistant wrote "this is the THIRD instance of the same root pattern tonight" in
// its own reply, then patched ONE Stripe function and stopped — never audited the other siblings
// until Russell pointed out the rule text never said "generalize."
//
// MECHANICAL SIGNAL: assistant prose claims a recurring pattern (specific phrasings below) AND the
// session's edits touched only ONE distinct source file in the affected area. Two arming shapes:
//   (A) EXPLICIT RECURRENCE CLAIM — "same root cause/bug/pattern", "Nth instance", "this is the
//       class of bug", "again" near a fix-naming verb. Threshold: only 1 distinct edited source
//       file in the session after the claim (a single-site patch on a named class).
//   (B) ONE-SITE FIX WITH "ROOT CAUSE" CLAIMING — softer. Claims to have found root cause AND
//       edited only 1 file. Threshold: the prose explicitly scopes the fix to "the function" /
//       "this lookup" / "this one path" rather than the class.
// CLEAR: a follow-up edit to a SECOND distinct source file (generalizing the fix), an explicit
//   `audited-siblings: <result>` token (the assistant states it checked for sibling instances and
//   what it found — even "no other siblings exist" with a one-line justification clears it), or
//   `class-fix-override: <why this single-site fix IS the general fix>` (e.g. the fix landed in a
//   shared helper that ALL callers already funnel through — that IS the general fix).
//
// PROJECT-AGNOSTIC — reasons over assistant prose + edit-count shape only. No project paths.

const RECURRENCE_CLAIM_PATTERNS = [
  /\bsame (root (?:cause|bug|pattern)|bug|pattern|class|shape|mistake|failure)\b/i,
  /\b(?:second|third|fourth|fifth|nth|3rd|2nd|4th|5th)\s+(?:instance|time|case|bug|occurrence)\b/i,
  /\bthis is the (?:class|kind|shape|family) of (?:bug|mistake|failure|issue)\b/i,
  /\b(?:recurring|repeats|repeats itself|keeps happening)\b/i,
  /\bthe same (?:mistake|bug|pattern) (?:again|twice|repeats)\b/i,
];

const SINGLE_SITE_SCOPE_PATTERNS = [
  /\b(?:fixed|patched|updated|changed) (?:the |this |one )?(?:function|method|lookup|call site|endpoint|handler|line)\b/i,
  /\bonly (?:this |the one )?(?:function|method|lookup|site|file|path)\b/i,
];

const SIBLINGS_AUDITED_TOKEN = /\baudited-siblings\s*:\s*(\S[^\n]{0,200})/i;
const CLASS_FIX_OVERRIDE = /\bclass-fix-override\s*:\s*(\S[^\n]{0,200})/i;

const matchesRecurrenceClaim = (text) => RECURRENCE_CLAIM_PATTERNS.some((p) => p.test(String(text || '')));
const matchesSingleSiteScope = (text) => SINGLE_SITE_SCOPE_PATTERNS.some((p) => p.test(String(text || '')));

// A path that is NOT a production source fix — test/spec files, docs, configs, hooks. Detector 5
// uses this (separately from isInfraPath, which serves detector 1's commit-streak logic and
// intentionally counts test files as CORE) so that editing only tests/docs after naming a pattern
// does NOT count as "generalizing the source fix."
const TEST_OR_NON_SOURCE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\//i;
const TEST_EXT_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const isNonSourcePath = (filePath) => {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return true;
  if (TEST_OR_NON_SOURCE_RE.test(normalized)) return true;
  if (TEST_EXT_RE.test(normalized)) return true;
  return isInfraPath(normalized);
};

// Pure decision. Walks `assistantBlocks` looking for a recurrence claim followed by only one
// distinct edited source file across the rest of the session (and no audited-siblings token).
// Test/doc/hook/config edits don't count toward "did you generalize" — only real source files do.
// Exported for the test file.
export function detectPatternNotGeneralized({ assistantBlocks = [], replyText = '', isInfraPathFn = isNonSourcePath } = {}) {
  if (!Array.isArray(assistantBlocks) || assistantBlocks.length === 0) return { block: false };

  let claimAtIndex = -1;
  let claimText = '';
  let singleSiteClaimed = false;

  // First pass: find the most recent recurrence claim (last one wins — if the assistant named the
  // pattern in an early message and then generalized later, the later edits clear it).
  for (let index = 0; index < assistantBlocks.length; index++) {
    const entry = assistantBlocks[index];
    if (entry.role !== 'assistant') continue;
    if (matchesRecurrenceClaim(entry.text)) {
      claimAtIndex = index;
      claimText = entry.text;
    }
    if (matchesSingleSiteScope(entry.text)) singleSiteClaimed = true;
  }
  if (claimAtIndex < 0) return { block: false };

  // Collect distinct source files edited AFTER the claim (test/doc/hook edits don't count — only
  // real source files generalize the fix).
  const editedSourceFiles = new Set();
  let overrideStated = false;
  let auditedStated = false;
  for (let index = claimAtIndex; index < assistantBlocks.length; index++) {
    const entry = assistantBlocks[index];
    if (entry.role !== 'assistant') continue;
    if (CLASS_FIX_OVERRIDE.test(entry.text)) overrideStated = true;
    if (SIBLINGS_AUDITED_TOKEN.test(entry.text)) auditedStated = true;
    for (const filePath of entry.editedPaths || []) {
      if (!isInfraPathFn(filePath)) editedSourceFiles.add(filePath);
    }
  }
  if (overrideStated || auditedStated) return { block: false };

  // Block when a recurrence was claimed but only one source file was touched (single-site patch on
  // a named class). Softer path (B) also requires a single-site scope claim to avoid false-positive
  // on a legitimate "found root cause, fixing the one real owner" workflow.
  const editedCount = editedSourceFiles.size;
  const recurrenceClaimStrong = matchesRecurrenceClaim(claimText);
  if (recurrenceClaimStrong && editedCount === 1) {
    const editedFile = [...editedSourceFiles][0];
    return { block: true, kind: 'recurrence-one-site', claim: claimText.slice(0, 150), editedFile,
      reason: patternNotGeneralizedReason(claimText, editedFile, singleSiteClaimed) };
  }
  return { block: false };
}

function patternNotGeneralizedReason(claimText, editedFile, singleSiteClaimed) {
  const claimSnippet = claimText ? `\n  YOUR CLAIM: "${String(claimText).slice(0, 200).replace(/\n/g, ' ')}"\n` : '\n';
  const scopeLine = singleSiteClaimed ? '\n  You also scoped the fix to a single site ("the function", "this lookup", "one path").' : '';
  return `PATTERN-NOT-GENERALIZED CHECK — you named a recurring pattern/class of bug in your reply, but this session edited only ONE source file (${editedFile}).${scopeLine}${claimSnippet}
The Getty rule (updated 2026-07-25): the fix must cover the most general reasonable CLASS of the bug, not just the instance that bit. Naming a pattern in prose but patching one hole in code is the half-fix the rule forbids — the next sibling to fire IS the same mistake again.

Before stopping, choose ONE:
  (a) AUDIT THE SIBLINGS — grep for other call sites / other columns / other lookups with the same shape, and either fix them or confirm they're already covered. Then state: \`audited-siblings: <what you found>\` (even "no other siblings — <reason>" clears it).
  (b) If this single-site fix IS the general fix (e.g. it landed in a shared helper ALL callers funnel through), say so: \`class-fix-override: <why one site IS the class fix>\`.

Both tokens are REASON-BEARING — a bare token does not clear the gate. The point is to make the audit a conscious act, not a skip.`;
}

// ---------- transcript parsing (session-scoped) ----------

// Files a `git commit` command committed: `-o a b c` args, plus any `git add a b c` in the same command.
function commitFilesFrom(command) {
  const commandText = String(command || '');
  if (!/\bgit\s+commit\b/.test(commandText)) return null;
  const files = [];
  const dashOMatch = commandText.match(/\bgit\s+commit\b[\s\S]*?\s-o\s+([\s\S]*?)(?=\s-m\b|\s--message\b|$)/);
  if (dashOMatch) files.push(...dashOMatch[1].split(/\s+/).filter((token) => token && !token.startsWith('-')));
  for (const addMatch of commandText.matchAll(/\bgit\s+add\s+([\s\S]*?)(?=&&|;|\bgit\b|$)/g)) {
    files.push(...addMatch[1].split(/\s+/).filter((token) => token && !token.startsWith('-') && token !== '.' && token !== '-A'));
  }
  return files;
}

// Every tool_result in the transcript, keyed by the tool_use_id it answers — built in one pass so the
// second pass (below) can pair each tool_use with its outcome without a nested scan.
// Every tool_result keyed by the tool_use_id it answers. The single owner of that pairing: the
// duplicate-verification ledger needs it over raw JSONL lines, and the efficiency kernel needs it
// over normalized entries, so both call this rather than keeping two copies that drift.
export function collectToolOutcomes(entries) {
  const resultsByCallId = new Map();
  for (const entry of entries || []) {
    for (const block of contentBlocks(entry)) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      const outputText = typeof block.content === 'string' ? block.content : (toolResultText(block) || JSON.stringify(block.content ?? ''));
      resultsByCallId.set(block.tool_use_id, { outputText, isError: block.is_error === true });
    }
  }
  return resultsByCallId;
}

function toolResultsByCallId(lines) {
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { continue; }
  }
  return collectToolOutcomes(entries);
}

// Parses the transcript ONCE into everything the three detectors need:
//   `commitFileLists`/`commands` (ceremony detector) + `events` (duplicate-verification detector)
//   + `assistantBlocks` (banked-result detector) — a flat chronological list of every assistant
//   message's {text, toolUses} pairs, so the banked-result walk can interleave "marker armed in
//   message N" with "tool calls in messages N+1..N+k" exactly as they happened.
function parseSession(transcriptPath) {
  const commitFileLists = [];
  const commands = [];
  const events = [];
  const assistantBlocks = [];
  if (!transcriptPath || !existsSync(transcriptPath)) return { commitFileLists, commands, events, assistantBlocks };
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return { commitFileLists, commands, events, assistantBlocks }; }

  const resultsByCallId = toolResultsByCallId(lines);

  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const role = entry?.message?.role || entry?.role;
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;

    if (role === 'assistant') {
      const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n');
      const toolUses = blocks.filter((block) => block?.type === 'tool_use');
      // Collect edited file paths from Write/Edit/MultiEdit/NotebookEdit calls — detector 5
      // (pattern-named-but-not-generalized) uses these to count distinct sites touched.
      const editedPaths = toolUses
        .filter((tu) => CONTENT_EDIT_TOOLS.has(tu.name))
        .map((tu) => String(tu.input?.file_path || tu.input?.path || ''))
        .filter(Boolean);
      assistantBlocks.push({ role: 'assistant', text, toolUses, editedPaths });
    } else if (role === 'user') {
      // A real user prompt (turn start) vs a tool_result coming back (also user-role but NOT a turn
      // start) — the banked-result detector uses the distinction to close a bank on Russell redirecting.
      const isToolResult = blocks.length > 0 && blocks.every((block) => block?.type === 'tool_result');
      const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n');
      assistantBlocks.push({ role: 'user', isToolResult, text, toolUses: [] });
    }

    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue;
      if (block.name === 'Bash' || block.name === 'PowerShell') {
        const command = String(block.input?.command || '');
        if (!command) continue;
        commands.push(command);
        const committed = commitFilesFrom(command);
        if (committed) commitFileLists.push(committed);
        const outcome = resultsByCallId.get(block.id) || { outputText: '', isError: null };
        events.push({ kind: 'shell', command, outputText: outcome.outputText, isError: outcome.isError });
      } else if (CONTENT_EDIT_TOOLS.has(block.name)) {
        const outcome = resultsByCallId.get(block.id) || { outputText: '', isError: null };
        events.push({ kind: 'edit', tool: block.name, isError: outcome.isError });
      }
    }
  }
  return { commitFileLists, commands, events, assistantBlocks };
}

// The current turn begins at the last real user prompt. Tool-result messages use the user role too,
// but never reset the budget. Pure shape keeps both PreToolUse and Stop paths on one definition.
export function latestTurnSummary(assistantBlocks) {
  const blocks = Array.isArray(assistantBlocks) ? assistantBlocks : [];
  let start = -1;
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index]?.role === 'user' && !blocks[index]?.isToolResult) { start = index; break; }
  }
  if (start < 0) return { userText: '', completedToolCount: 0 };
  let completedToolCount = 0;
  for (let index = start + 1; index < blocks.length; index++) {
    if (blocks[index]?.role === 'assistant') completedToolCount += blocks[index].toolUses?.length || 0;
  }
  return { userText: blocks[start].text || '', completedToolCount };
}

// Shared transcript normalization gives the PreToolUse gates the same current-turn view in
// Claude, Codex, and Kimi. Tool inputs are retained so repeated utility-selection probes can bite.
export function latestNormalizedTurnSummary(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  let start = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (isHumanPrompt(rows[index])) { start = index; break; }
  }
  if (start < 0) return { userText: '', completedToolCount: 0, completedToolInputs: [], completedTools: [], humanSafetyApproval: false };
  const userText = effectiveHumanTask(rows);
  const humanSafetyApproved = humanSafetyApproval(rows);
  const turnRows = rows.slice(start + 1);
  const toolUses = turnRows.flatMap((entry) => toolUsesOf(entry));
  // Pair each call with the outcome that answered it. Without this the 2026-08-05 deadlock repair
  // was dead on arrival: its rules read `isError`/`resultText`, the unit tests supplied those by
  // hand, and the live path never did — green tests, unchanged live behavior. Only piping a real
  // transcript through the INSTALLED hook catches that class.
  const outcomeByCallId = collectToolOutcomes(turnRows);
  const outcomeOf = (toolUse) => outcomeByCallId.get(toolUse?.id) || outcomeByCallId.get(toolUse?.call_id) || {};
  return {
    userText,
    completedToolCount: toolUses.length,
    completedToolInputs: toolUses.map((toolUse) => toolUse.input),
    completedTools: toolUses.map((toolUse) => {
      const outcome = outcomeOf(toolUse);
      return toolRecord(toolUse.name, toolUse.input, { isError: outcome.isError, resultText: outcome.outputText });
    }),
    humanSafetyApproval: humanSafetyApproved,
  };
}

function lastAssistantReply(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').trim().split('\n'); } catch { return ''; }
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry; try { entry = JSON.parse(lines[index]); } catch { continue; }
    if ((entry?.message?.role || entry?.role) !== 'assistant') continue;
    const blocks = entry?.message?.content ?? [];
    return Array.isArray(blocks) ? blocks.map((block) => block?.text || '').join(' ') : String(blocks || '');
  }
  return '';
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const hookEvent = event.hook_event_name || event.hookEventName;
  if (!['PreToolUse', 'Stop'].includes(hookEvent)) process.exit(0);
  const transcriptPath = event.transcript_path || event.transcriptPath || '';
  const { commitFileLists, commands, events, assistantBlocks } = parseSession(transcriptPath);
  const normalizedEntries = readTranscript(transcriptPath);
  const latestTurn = latestNormalizedTurnSummary(normalizedEntries);

  if (hookEvent === 'PreToolUse') {
    let earlyVerdict;
    try {
      earlyVerdict = detectSimpleScalarToolBudget(latestTurn);
      if (!earlyVerdict.block) earlyVerdict = detectEfficiencyKernel({
        ...latestTurn,
        toolName: event.tool_name || event.toolName || '',
        toolInput: event.tool_input || event.toolInput || {},
      });
      if (!earlyVerdict.block) earlyVerdict = detectSimpleEditCeremony({
        ...latestTurn,
        toolName: event.tool_name || event.toolName || '',
        toolInput: event.tool_input || event.toolInput || {},
      });
    } catch { process.exit(0); }
    if (!earlyVerdict.block) process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: earlyVerdict.reason,
      },
    }));
    process.exit(0);
  }

  if (event.stop_hook_active) process.exit(0); // never loop
  const replyText = lastAssistantText(normalizedEntries) || lastAssistantReply(transcriptPath);
  let verdict;
  try {
    verdict = detectSimpleScalarToolBudget(latestTurn);
    if (!verdict.block) verdict = detectCeremony({ commitFileLists, commands, replyText });
    if (!verdict.block) verdict = detectDuplicateVerification({ events, replyText });
    if (!verdict.block) verdict = detectBankedThenPolish({ assistantBlocks, replyText });
    if (!verdict.block) verdict = detectPatternNotGeneralized({ assistantBlocks, replyText });
  } catch { process.exit(0); } // fail-open
  if (!verdict.block) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
