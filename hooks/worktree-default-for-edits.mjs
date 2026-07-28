#!/usr/bin/env node
/**
 * worktree-default-for-edits
 *
 * Blocks AI file edits unless the target is on a non-main branch inside a
 * linked git worktree. A branch alone is not isolation; a linked worktree on
 * main (or detached HEAD) is not branch discipline. Non-repo files are allowed.
 *
 * Fail open on unexpected errors.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }

  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName && eventName !== 'PreToolUse') {
    process.exit(0);
    return;
  }

  const toolName = event.tool_name || '';
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'].includes(toolName)) {
    process.exit(0);
    return;
  }

  const requestedFilePaths = extractRequestedFilePaths(toolName, event.tool_input || {});
  if (requestedFilePaths.length === 0) {
    process.exit(0);
    return;
  }

  const cwd = event.cwd || process.cwd();
  for (const requestedFilePath of requestedFilePaths) {
    const targetPath = resolve(cwd, requestedFilePath);
    const searchStart = nearestExistingDirectory(targetPath);
    if (!searchStart) continue;

    const repoRoot = findGitRoot(searchStart);
    if (!repoRoot) continue;

    const gitMarkerPath = join(repoRoot, '.git');
    const linkedWorktree = isLinkedWorktree(gitMarkerPath);
    const currentBranch = getHeadBranch(gitMarkerPath);
    const branchAllowed = currentBranch && currentBranch !== 'main' && currentBranch !== 'master';
    if (linkedWorktree && branchAllowed) continue;

    denyEdit({ currentBranch, linkedWorktree, repoRoot, targetPath, toolName });
    return;
  }
}

function extractRequestedFilePaths(toolName, toolInput) {
  if (toolName !== 'apply_patch') {
    const requestedPath = toolInput.file_path || toolInput.notebook_path || toolInput.path;
    return typeof requestedPath === 'string' && requestedPath ? [requestedPath] : [];
  }

  const paths = [];
  for (const line of String(toolInput.command || '').split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match) paths.push(match[1].trim());
  }
  return [...new Set(paths)];
}

function denyEdit({ currentBranch, linkedWorktree, repoRoot, targetPath, toolName }) {
  const displayedFile = relative(repoRoot, targetPath) || targetPath;
  const repoName = repoRoot.split(/[\\/]/).filter(Boolean).pop() || 'repo';
  const checkoutProblem = linkedWorktree
    ? (currentBranch ? `linked worktree is on ${currentBranch}` : 'linked worktree has a detached HEAD')
    : 'target is in the primary checkout';
  const reason = [
    'Branch + worktree required: edit blocked.',
    '',
    `Repo: ${repoRoot}`,
    `File: ${displayedFile}`,
    `Tool: ${toolName}`,
    `Problem: ${checkoutProblem}.`,
    '',
    'Create one isolated branch worktree, then edit there:',
    `  git worktree add ../${repoName}-<task> -b feature/<task> main`,
    `  cd ../${repoName}-<task>`,
    '',
    'A feature branch in the primary checkout is still blocked. A linked worktree on main or detached HEAD is also blocked.',
    'There is no environment bypass: source work always gets both isolation layers.',
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

function nearestExistingDirectory(pathToCheck) {
  let currentPath = pathToCheck;
  try {
    if (existsSync(currentPath) && statSync(currentPath).isFile()) {
      currentPath = dirname(currentPath);
    }
  } catch {
    currentPath = dirname(currentPath);
  }
  while (currentPath && currentPath !== dirname(currentPath)) {
    try {
      if (existsSync(currentPath) && statSync(currentPath).isDirectory()) return currentPath;
    } catch {}
    currentPath = dirname(currentPath);
  }
  return null;
}

function findGitRoot(startDirectory) {
  let currentPath = startDirectory;
  while (currentPath && currentPath !== dirname(currentPath)) {
    if (existsSync(join(currentPath, '.git'))) return currentPath;
    currentPath = dirname(currentPath);
  }
  return null;
}

function isLinkedWorktree(gitMarkerPath) {
  try {
    return statSync(gitMarkerPath).isFile();
  } catch {
    return false;
  }
}

// Returns the branch for a primary checkout or linked worktree, or null for detached HEAD.
function getHeadBranch(gitMarkerPath) {
  try {
    let gitDirectory = gitMarkerPath;
    if (statSync(gitMarkerPath).isFile()) {
      const marker = readFileSync(gitMarkerPath, 'utf8').trim();
      const match = marker.match(/^gitdir:\s*(.+)$/i);
      if (!match) return null;
      gitDirectory = resolve(dirname(gitMarkerPath), match[1]);
    }
    const headPath = join(gitDirectory, 'HEAD');
    const head = readFileSync(headPath, 'utf8').trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

main();
