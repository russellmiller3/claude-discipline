#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

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

function buildContextMessage(eventName, projectRoot, checkpointReason) {
  const handoffPath = join(projectRoot, 'HANDOFF.md');
  if (eventName === 'SessionStart') {
    return [
      'HANDOFF CONTINUITY: Before substantive work, read/check HANDOFF.md for this project.',
      `Project root detected: ${projectRoot}`,
      `Expected handoff path: ${handoffPath}`,
      'If this is a post-compaction continuation, treat HANDOFF.md as the source of truth before resuming.',
      'Use HANDOFF.md as a compaction parachute: update it before/after compaction, at phase boundaries, branch/worktree changes, live proof, unresolved blockers, or explicit handoff/wrap requests.'
    ].join('\n');
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

try {
  main();
} catch {
  process.exit(0);
}
