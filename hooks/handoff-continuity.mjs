#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptPath = process.argv[1] || '';
const stateFolderName = scriptPath.includes('.codex') ? '.codex' : '.claude';
const checkpointStatePath =
  process.env.HANDOFF_CONTINUITY_STATE_PATH ||
  join(homedir(), stateFolderName, 'state', 'handoff-continuity.json');
const rootMarkers = ['.git', 'HANDOFF.md', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
// Continual cadence: after this many turns with no HANDOFF update, a checkpoint comes due on its
// own — so the parachute stays current WITHOUT waiting for Russell to ask. Override via env.
const checkpointEveryTurns = Number(process.env.HANDOFF_CHECKPOINT_EVERY_TURNS) || 5;
const handoffPatterns = [
  /^\s*\/?handoff\s*$/i,
  /^\s*\$\s*handoff\s*$/i,
  /\b(write|save|create|prepare|do|make)\s+(the\s+)?handoff\b/i,
  /\bsave context\b/i,
  /\bwrite a resume prompt\b/i,
  /\bwrap up\b/i
];
const compactionPatterns = [
  /\bcompact(?:ion|ed|ing)?\b/i,
  /\bafter compactio\b/i,
  /\bcontext was summarized\b/i,
  /\bsummary after compaction\b/i
];

function isSubagentTranscript(transcriptPath) {
  if (!transcriptPath) return false;
  const normalizedPath = transcriptPath.replace(/\\/g, '/').toLowerCase();
  return /\/tasks\//.test(normalizedPath) && /\.output$/.test(normalizedPath);
}

function handoffRequiresContinuation(handoffContent) {
  if (typeof handoffContent !== 'string') return false;
  const statusLine = handoffContent.split(/\r?\n/).find((line) =>
    line.replace(/\*/g, '').trim().toUpperCase().startsWith('STATUS:'),
  );
  if (!statusLine) return false;
  const normalizedLine = statusLine.replace(/\*/g, '').trim();
  const status = normalizedLine.slice(normalizedLine.indexOf(':') + 1).trim().toUpperCase();
  return /^(?:ACTIVE|IN PROGRESS|RUNNING|WIP|RESTART REQUIRED)\b/.test(status);
}

function readHookInput() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseHookInput(rawHookInput) {
  if (!rawHookInput.trim()) return {};
  try {
    return JSON.parse(rawHookInput);
  } catch {
    return { rawHookInput };
  }
}

function ensureParentDirectory(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readStoredState(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { projects: {} };
  }
}

function writeStoredState(filePath, checkpointState) {
  ensureParentDirectory(filePath);
  writeFileSync(filePath, JSON.stringify(checkpointState, null, 2) + '\n', 'utf8');
}

function pathHasRootMarker(projectPath) {
  return rootMarkers.some((markerName) => existsSync(join(projectPath, markerName)));
}

function findProjectRoot(startPath) {
  let currentPath = resolve(startPath || process.cwd());
  while (true) {
    if (pathHasRootMarker(currentPath)) return currentPath;
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return resolve(startPath || process.cwd());
    currentPath = parentPath;
  }
}

// --- SCOPE BOUNDARY (2026-08-16) -------------------------------------------------------------
//
// WHY: Russell typed `g`. Servo's HANDOFF.md had a DO NOW saying "fix two misfiring guards" —
// guards that live in ~/.claude, a different repo. The action was ALSO already done. A whole
// turn went into the wrong repo on work that did not need doing. Every scope-lock rule he owns
// says "follow the handoff's next action", so nothing objected: the detour WAS the next action.
//
// A project's handoff cannot authorize work in another project. That is decidable from the path
// alone, so it is checked rather than trusted.

const HOME_DIRECTORY = homedir();

function normalizeForCompare(somePath) {
  return String(somePath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isInside(childPath, parentPath) {
  const child = normalizeForCompare(childPath);
  const parent = normalizeForCompare(parentPath);
  if (!child || !parent) return false;
  return child === parent || child.startsWith(parent + '/');
}

/**
 * The region of a handoff that DISPATCHES work. The file's structure is fixed (rules block →
 * DO THIS IN ORDER → Context), so everything above "## Context" is action and everything below
 * is background. Scanning the whole file would flag every path in the cross-repo status table,
 * which reports on other repos rather than sending work to them.
 */
export function handoffActionRegion(handoffContent) {
  const content = String(handoffContent || '');
  const contextHeading = content.search(/^##\s+Context\b/im);
  return contextHeading === -1 ? content.split(/\r?\n/).slice(0, 80).join('\n') : content.slice(0, contextHeading);
}

/** Absolute paths named in a handoff's action region that fall outside the project it belongs to. */
export function outOfRootDispatches(handoffContent, projectRoot) {
  const region = handoffActionRegion(handoffContent);
  const found = [];
  const candidates = [
    ...(region.match(/[A-Za-z]:[\\/][^\s`"'()<>,;]+/g) || []),
    ...(region.match(/~[\\/][^\s`"'()<>,;]+/g) || []),
  ];
  for (const candidate of candidates) {
    const trimmed = candidate.trim().replace(/[.,;:]+$/, '');
    const expanded = trimmed.startsWith('~') ? join(HOME_DIRECTORY, trimmed.slice(1)) : trimmed;
    if (isInside(expanded, projectRoot)) continue;
    if (!found.some((already) => normalizeForCompare(already) === normalizeForCompare(expanded))) found.push(expanded);
  }
  return found;
}

/**
 * Sibling linked worktrees of the same project are the SAME work, not another repo. They are
 * named `<project>-<branch-slug>` beside the primary checkout, which is the convention every
 * worktree in Russell's setup follows.
 */
function isSiblingWorktree(targetPath, projectRoot) {
  const projectParent = dirname(resolve(projectRoot));
  const projectName = normalizeForCompare(resolve(projectRoot).split(/[\\/]/).pop());
  const relative = normalizeForCompare(targetPath).slice(normalizeForCompare(projectParent).length + 1);
  const topSegment = relative.split('/')[0] || '';
  return isInside(targetPath, projectParent) && topSegment.startsWith(projectName + '-');
}

/** Paths that are never "leaving the project": scratch space, temp dirs, and sibling worktrees. */
export function isExemptFromScopeBoundary(targetPath, projectRoot) {
  if (!targetPath) return true;
  if (isInside(targetPath, projectRoot)) return true;
  if (isInside(targetPath, process.env.TEMP || '') || isInside(targetPath, process.env.TMP || '')) return true;
  if (/[\\/]temp[\\/]claude[\\/]/i.test(targetPath) || /[\\/]scratchpad[\\/]/i.test(targetPath)) return true;
  return isSiblingWorktree(targetPath, projectRoot);
}

function editTargetPath(hookInput) {
  const toolInput = hookInput.tool_input || hookInput.toolInput || {};
  return toolInput.file_path || toolInput.filePath || toolInput.notebook_path || '';
}

function firstExistingMentionedPath(promptBody) {
  const mentionedPaths = promptBody.match(/[A-Za-z]:\\[^\n`"')]+/g) || [];
  for (const mentionedPath of mentionedPaths) {
    const trimmedPath = mentionedPath.trim().replace(/[.,;:]+$/, '');
    if (existsSync(trimmedPath)) return trimmedPath;
  }
  return null;
}

function promptBodyFromHookInput(hookInput) {
  const candidateBodies = [
    hookInput.prompt,
    hookInput.user_prompt,
    hookInput.input,
    hookInput.message,
    hookInput.rawHookInput
  ];
  for (const candidateBody of candidateBodies) {
    if (typeof candidateBody === 'string') return candidateBody;
    if (candidateBody && typeof candidateBody.content === 'string') return candidateBody.content;
  }
  if (Array.isArray(hookInput.messages) && hookInput.messages.length > 0) {
    const latestMessage = hookInput.messages[hookInput.messages.length - 1];
    if (typeof latestMessage?.content === 'string') return latestMessage.content;
    if (Array.isArray(latestMessage?.content)) {
      return latestMessage.content.map((contentPart) => contentPart?.text || contentPart?.content || '').join('\n');
    }
  }
  return '';
}

function eventNameFromHookInput(hookInput) {
  return hookInput.hook_event_name || hookInput.hookEventName || hookInput.event || '';
}

function handoffUpdatedAfter(handoffPath, checkpointTime) {
  if (!existsSync(handoffPath)) return false;
  try {
    return statSync(handoffPath).mtimeMs >= checkpointTime;
  } catch {
    return false;
  }
}

function plainHtmlText(fragment = '') {
  return String(fragment)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&rarr;/gi, '→')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirst(html, pattern, fallback) {
  const match = String(html || '').match(pattern);
  return match ? plainHtmlText(match[1]) : fallback;
}

function labPriorityContext(projectRoot) {
  const boardPath = join(projectRoot, 'docs', 'LAB-PRIORITY-BOARD.html');
  if (!existsSync(boardPath)) return null;
  let html = '';
  try { html = readFileSync(boardPath, 'utf8'); } catch { return null; }

  const score = extractFirst(
    html,
    /<[^>]*class=["'][^"']*\bscore\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    'Read the board for the current score',
  );
  const activeLane = extractFirst(
    html,
    /<article[^>]*class=["'][^"']*\blane\b[^"']*\bactive\b[^"']*["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i,
    'Read the board for the active lane',
  );
  const activeGate = extractFirst(
    html,
    /<article[^>]*class=["'][^"']*\blane\b[^"']*\bactive\b[^"']*["'][^>]*>[\s\S]*?<div[^>]*class=["'][^"']*\bgate\b[^"']*\bnow\b[^"']*["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i,
    'Read the board for the current gate',
  );

  return [
    'LAB PRIORITY BOARD — this project has a canonical lab roadmap.',
    `Board: ${boardPath}`,
    `Current score: ${score}`,
    `First lane: ${activeLane}`,
    `Current gate: ${activeGate}`,
    'Read the whole board before choosing work. Mark a completed or changed claim off on that board in the same turn.',
    'HANDOFF.md is the live-state parachute in this project, not a competing priority source.',
  ].join('\n');
}

function buildContextMessage(eventName, projectRoot, checkpointReason) {
  const handoffPath = join(projectRoot, 'HANDOFF.md');
  if (eventName === 'SessionStart') {
    const labContext = labPriorityContext(projectRoot);
    let handoffContent = '';
    try { handoffContent = readFileSync(handoffPath, 'utf8'); } catch {}
    const strayDispatches = outOfRootDispatches(handoffContent, projectRoot);
    const handoffContext = [
      'HANDOFF CONTINUITY: Before substantive work, read/check HANDOFF.md for this project.',
      `Project root detected: ${projectRoot}`,
      `Expected handoff path: ${handoffPath}`,
      '',
      'VERIFY THE NEXT ACTION IS STILL TRUE BEFORE YOU DO IT. A handoff is written in the past;',
      'its top action is frequently ALREADY DONE. Confirm it with one cheap read (git log, ls, the',
      'file it names) FIRST. An action that turns out to be complete is not a task -- say so in one',
      'line, correct the handoff, and drop to the next live item instead of executing it anyway.',
      ...(strayDispatches.length ? [
        '',
        'SCOPE WARNING -- this handoff dispatches work OUTSIDE its own project:',
        ...strayDispatches.map((strayPath) => `  - ${strayPath}`),
        'A project handoff cannot authorize work in another repository. ASK RUSSELL before touching',
        'those paths, and work the in-project queue meanwhile.',
      ] : []),
      labContext
        ? 'If this is a post-compaction continuation, use HANDOFF.md for live state and the lab board for priority.'
        : 'If this is a post-compaction continuation, treat HANDOFF.md as the source of truth before resuming.',
      'Use HANDOFF.md as a compaction parachute: update it before/after compaction, at phase boundaries, branch/worktree changes, live proof, unresolved blockers, or explicit handoff/wrap requests.'
    ].join('\n');
    return labContext ? `${labContext}\n\n${handoffContext}` : handoffContext;
  }
  return [
    'HANDOFF CHECKPOINT DUE: Update HANDOFF.md before continuing or stopping.',
    `Reason: ${checkpointReason}.`,
    `Project root detected: ${projectRoot}`,
    `Expected handoff path: ${handoffPath}`,
    'REVIEW THE WHOLE FILE — do not just append. Keep what is live, PRUNE what is stale or done, re-order so the current priority is on top. This is working memory that must survive compaction, not a diary.',
    'Keep it short and priority-first: parachute, not log. If learnings.md does not exist yet, create it (long-term memory) alongside this update.',
    'If Russell explicitly asked to wrap/stop/handoff, stop after writing; otherwise update it and keep moving.'
  ].join('\n');
}

function emitAdditionalContext(eventName, contextMessage) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: contextMessage
    }
  }));
}

function emitStopBlock(blockReason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason }));
}

function emitPreToolDeny(denyReason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denyReason
    }
  }));
}

function projectKey(projectRoot) {
  return projectRoot.toLowerCase();
}

function checkpointRecord(checkpointState, projectRoot) {
  const key = projectKey(projectRoot);
  checkpointState.projects ||= {};
  checkpointState.projects[key] ||= {
    projectRoot,
    turnsSinceCheckpoint: 0,
    dueSince: null,
    dueReason: null
  };
  checkpointState.projects[key].projectRoot = projectRoot;
  return checkpointState.projects[key];
}

function clearSatisfiedCheckpoint(record, handoffPath) {
  if (record.dueSince && handoffUpdatedAfter(handoffPath, record.dueSince)) {
    record.turnsSinceCheckpoint = 0;
    record.dueSince = null;
    record.dueReason = null;
    return true;
  }
  return false;
}

function main() {
  const hookInput = parseHookInput(readHookInput());
  const eventName = eventNameFromHookInput(hookInput);
  const promptBody = promptBodyFromHookInput(hookInput);
  const mentionedPath = firstExistingMentionedPath(promptBody);
  const projectRoot = findProjectRoot(mentionedPath || hookInput.cwd || hookInput.workspace?.cwd || process.cwd());
  const handoffPath = join(projectRoot, 'HANDOFF.md');
  const checkpointState = readStoredState(checkpointStatePath);
  const record = checkpointRecord(checkpointState, projectRoot);

  clearSatisfiedCheckpoint(record, handoffPath);

  if (eventName === 'PreToolUse') {
    // Russell, 2026-08-16: "if you start work outside repo, you should check with me."
    // A deny, not a warning: the detour this exists for happened while every advisory rule in
    // the system agreed the work was authorized, so advice is exactly what already failed.
    if (process.env.HANDOFF_SCOPE_OK === '1') return;
    const targetPath = editTargetPath(hookInput);
    if (!targetPath) return;
    const resolvedTarget = resolve(targetPath);
    if (isExemptFromScopeBoundary(resolvedTarget, projectRoot)) return;
    emitPreToolDeny([
      'OUTSIDE THE PROJECT — ask Russell before editing this.',
      '',
      `Editing: ${resolvedTarget}`,
      `This session's project: ${projectRoot}`,
      '',
      'You are about to change a file in a different repository than the one this session is for.',
      'If a HANDOFF.md, plan, or doc is what sent you here, that is NOT authorization -- a project',
      'handoff cannot dispatch work into another repo, and it is usually stale as well.',
      '',
      'Do this instead: say in ONE line what you want to change out here and why, ask Russell, and',
      'work the in-project queue while you wait. If he says go, set HANDOFF_SCOPE_OK=1.'
    ].join('\n'));
    return;
  }

  if (eventName === 'SessionStart') {
    record.lastSessionStart = Date.now();
    writeStoredState(checkpointStatePath, checkpointState);
    emitAdditionalContext(eventName, buildContextMessage(eventName, projectRoot, 'session start'));
    return;
  }

  if (eventName === 'UserPromptSubmit') {
    const handoffAsked = handoffPatterns.some((pattern) => pattern.test(promptBody));
    const compactionReported = compactionPatterns.some((pattern) => pattern.test(promptBody));
    let checkpointReason = null;

    if (handoffAsked) checkpointReason = 'Russell made an explicit handoff request';
    else if (compactionReported) checkpointReason = 'Russell reported compaction';

    // Count every turn; once the cadence is reached, a checkpoint comes due on its own (continual
    // update, not just on demand). An explicit/compaction reason takes precedence over the periodic one.
    record.turnsSinceCheckpoint = (record.turnsSinceCheckpoint || 0) + 1;
    if (!checkpointReason && record.turnsSinceCheckpoint >= checkpointEveryTurns) {
      checkpointReason = `periodic checkpoint (${record.turnsSinceCheckpoint} turns since the last HANDOFF update)`;
    }

    if (checkpointReason && !record.dueSince) {
      record.dueSince = Date.now();
      record.dueReason = checkpointReason;
    }

    writeStoredState(checkpointStatePath, checkpointState);
    if (record.dueSince) {
      emitAdditionalContext(eventName, buildContextMessage(eventName, projectRoot, record.dueReason || checkpointReason));
    }
    return;
  }

  if (eventName === 'Stop') {
    const isParentSession = !isSubagentTranscript(hookInput.transcript_path || '');
    if (isParentSession && process.env.HANDOFF_ACTIVE_STOP_OK !== '1' && existsSync(handoffPath)) {
      let handoffContent = '';
      try { handoffContent = readFileSync(handoffPath, 'utf8'); } catch {}
      if (handoffRequiresContinuation(handoffContent)) {
        emitStopBlock([
          'STOP BLOCKED — project HANDOFF.md still says ACTIVE or IN PROGRESS.',
          '',
          'Resume the ▶ GO task now. A status update is not a completion boundary.',
          'Only stop after the objective is DONE, genuinely BLOCKED, or Russell explicitly pauses it and STATUS becomes PAUSED.',
          `Handoff: ${handoffPath}`,
          'Emergency escape: HANDOFF_ACTIVE_STOP_OK=1.'
        ].join('\n'));
        return;
      }
    }
    if (record.dueSince && !handoffUpdatedAfter(handoffPath, record.dueSince)) {
      emitStopBlock(buildContextMessage('Stop', projectRoot, record.dueReason || 'handoff checkpoint'));
      return;
    }
    if (record.dueSince) {
      record.turnsSinceCheckpoint = 0;
      record.dueSince = null;
      record.dueReason = null;
      writeStoredState(checkpointStatePath, checkpointState);
    }
  }
}

// Entry-point guard (Rule 5). Without it, a test that IMPORTS this module to reach an exported
// helper runs main(), which blocks on readFileSync(0) waiting for stdin that never arrives --
// the test hangs instead of failing, which reads as an infrastructure problem rather than a bug.
// Basename, not full path: Windows MSYS (/c/...) and native (C:\...) forms never compare equal.
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}
