#!/usr/bin/env node
// learnings-toc-inject — SessionStart. Surface the learnings table-of-contents
// so the agent knows what hard-won lessons exist without reading the whole file.
// Reads the "## Table of Contents" section from both:
//   ~/.claude/learnings.md      (cross-project methods)
//   <projectRoot>/learnings.md  (this codebase's gotchas)
//
// Showing the TOC at session start tells the agent which sections exist; it
// opens the specific section on demand. No-ops gracefully if neither file
// exists (prints a one-line hint on how to start one).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath, dirname } from 'node:path';
import { homedir } from 'node:os';

const GLOBAL_LEARNINGS_PATH = resolvePath(homedir(), '.claude', 'learnings.md');
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const TOC_HEADER_PATTERN = /^##\s+Table of Contents\s*$/m;
const NEXT_H2_PATTERN = /^##\s+/m;

function findProjectRoot(startDirectory) {
	let probeDirectory = startDirectory;
	for (let depthSteps = 0; depthSteps < 12; depthSteps++) {
		for (const markerName of ROOT_MARKERS) {
			if (existsSync(joinPath(probeDirectory, markerName))) return probeDirectory;
		}
		const parentDirectory = dirname(probeDirectory);
		if (parentDirectory === probeDirectory) return null;
		probeDirectory = parentDirectory;
	}
	return null;
}

function extractTocSection(learningsContent) {
	const tocAnchorMatch = learningsContent.match(TOC_HEADER_PATTERN);
	if (!tocAnchorMatch) return null;
	const tocStartOffset = tocAnchorMatch.index + tocAnchorMatch[0].length;
	const afterToc = learningsContent.slice(tocStartOffset);
	const nextH2Match = afterToc.match(NEXT_H2_PATTERN);
	const tocBody = nextH2Match ? afterToc.slice(0, nextH2Match.index) : afterToc;
	return tocBody.trim();
}

function describeFileAge(filePath) {
	try {
		const fileStat = statSync(filePath);
		const ageDays = Math.floor((Date.now() - fileStat.mtimeMs) / 86_400_000);
		if (ageDays === 0) return 'updated today';
		if (ageDays === 1) return 'updated yesterday';
		return `updated ${ageDays} days ago`;
	} catch {
		return 'age unknown';
	}
}

function emitSection(label, learningsPath) {
	if (!existsSync(learningsPath)) return false;
	let learningsContent;
	try { learningsContent = readFileSync(learningsPath, 'utf8'); } catch { return false; }
	const tocSection = extractTocSection(learningsContent);
	if (!tocSection) return false;
	console.log(`\n=== ${label} (${learningsPath} — ${describeFileAge(learningsPath)}) ===`);
	console.log(tocSection);
	return true;
}

function main() {
	const projectRoot = findProjectRoot(process.cwd());

	console.log([
		'=== LEARNINGS AVAILABLE ===',
		'Before planning a feature, debugging a bug, or touching an unfamiliar subsystem:',
		'  1. Skim the TOC(s) below for relevant sections.',
		'  2. Read the matching section in the source file (paths shown).',
		'  3. Apply the lesson; after shipping a non-obvious fix, append to the right learnings file.',
		'Scope split: global = cross-project method, project = codebase-specific gotchas.',
	].join('\n'));

	const emittedGlobal = emitSection('GLOBAL LEARNINGS TOC', GLOBAL_LEARNINGS_PATH);
	let emittedProject = false;
	if (projectRoot) {
		emittedProject = emitSection('PROJECT LEARNINGS TOC', joinPath(projectRoot, 'learnings.md'));
	}

	if (!emittedGlobal && !emittedProject) {
		console.log('\nNo learnings.md found at either scope (this is normal on day one).');
		console.log('Start ~/.claude/learnings.md for cross-project methods,');
		console.log('and <projectRoot>/learnings.md for codebase-specific gotchas.');
		console.log('Give each a "## Table of Contents" section and this hook will surface it.');
	}
}

main();
