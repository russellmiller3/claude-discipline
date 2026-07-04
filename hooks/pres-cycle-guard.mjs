#!/usr/bin/env node
// =============================================================================
// pres-cycle-guard — enforces AGENTS.md rules 13/14 in any repo that opts in:
//   rule 13: every experiment/build cycle goes through /pres (plan -> red-team
//            -> execute -> ship); no ad-hoc launches off an un-red-teamed plan.
//   rule 14: every plan starts from a research review before it's written.
//
// Two independent PreToolUse checks:
//   1. PLAN QUALITY CHECK (Write/Edit on plans/*.md): the plan content must
//      have a `## Research notes` section that cites at least one primary
//      source (a URL, or an author/year citation, or a named source doc like
//      Truth-ledger.md). Missing it -> deny (rule 14).
//   2. TRAINING LAUNCH CHECK (Bash/PowerShell): a command that looks like it
//      launches training/sweeps is blocked unless the newest file in plans/
//      has BOTH a `## Research notes` section AND a `red-teamed: YYYY-MM-DD`
//      stamp (only the red-team-plan skill honestly writes that stamp).
//      Missing either -> deny (rule 13).
//
// SCOPE: only fires in a repo whose AGENTS.md contains the opt-in rule text
// ("reviews the research" or a "## Research notes" mention) — so this hook is
// silent noise everywhere else. The ledger repo (AGENTS.md rules 13/14) is the
// first opted-in repo.
//
// ESCAPE VALVES:
//   - PRES_CYCLE_OK anywhere in the edited content / command text: genuine
//     exception (e.g. reproducing an existing RESULTS.md entry verbatim).
//   - Smoke tests: a `--steps N` value <= 100 on the training-launch check
//     passes ungated (tiny step counts are dev/smoke runs, not real launches).
//     No --steps value at all means a full run — stays gated.
// =============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_TOKEN = 'PRES_CYCLE_OK';
const SMOKE_STEPS_CEILING = 100;

const RESEARCH_NOTES_HEADING = /^##\s*research notes\b/im;
const RED_TEAM_STAMP = /red-teamed:\s*\d{4}-\d{2}-\d{2}/i;

// A "primary source" citation: a URL, an author-year style citation
// (Graves 2014, Lindner 2023), or a named source-of-record doc (Truth-ledger,
// RESULTS.md, a paper title in quotes). Loose by design — this is a nudge to
// cite SOMETHING concrete, not a bibliography format checker.
const PRIMARY_SOURCE_EVIDENCE = /https?:\/\/\S+|\b[A-Z][a-zA-Z-]+\s+\(?\d{4}\)?|\bTruth-ledger\.md\b|\bRESULTS\.md\b|"[^"]{6,}"/;

// Training/sweep launch shapes named in the spec, plus a keyword fallback so
// new launcher names (another *_gate*.py, another diag_*.py) are still caught
// without editing this file.
const NAMED_LAUNCH_SHAPES = [
	/\bmodal_gate1\.py\b/i,
	/\bgate1\.py\b[^\n]*--single\b/i,
	/\bdiag_[\w-]*\.py\b/i,
	/\bseed_distribution\.py\b/i
];

function main() {
	let hookEvent;
	try {
		hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}');
	} catch {
		process.exit(0);
		return;
	}

	const toolName = hookEvent.tool_name || hookEvent.toolName || '';
	const workingDirectory = hookEvent.cwd || process.cwd();
	const repoRoot = findRepoRoot(workingDirectory);

	if (!repoRoot || !repoOptsIntoPresCycle(repoRoot)) {
		process.exit(0);
		return;
	}

	if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
		runPlanQualityCheck(hookEvent, repoRoot);
		return;
	}

	if (toolName === 'Bash' || toolName === 'PowerShell') {
		runTrainingLaunchCheck(hookEvent, repoRoot);
		return;
	}

	process.exit(0);
}

// Single place every check reads the tool's input payload from, so the
// `tool_input || toolInput || {}` fallback expression lives in exactly one
// spot instead of being copy-pasted at every call site.
function getToolInput(hookEvent) {
	return hookEvent.tool_input || hookEvent.toolInput || {};
}

// ---------------------------------------------------------------------------
// Check 1: plan quality (rule 14 — plans start from the research)
// ---------------------------------------------------------------------------

function runPlanQualityCheck(hookEvent, repoRoot) {
	const toolInput = getToolInput(hookEvent);
	const filePath = toolInput.file_path || toolInput.filePath || '';
	if (!isPlanMarkdownPath(filePath, repoRoot)) {
		process.exit(0);
		return;
	}

	const resultingContent = resultingPlanContent(toolInput, filePath);
	if (resultingContent === null) {
		// Can't determine resulting content (e.g. an Edit whose old_string isn't
		// found, or file unreadable) — fail open rather than block on a guess.
		process.exit(0);
		return;
	}

	if (resultingContent.includes(OVERRIDE_TOKEN)) {
		process.exit(0);
		return;
	}

	if (planHasResearchNotesWithSource(resultingContent)) {
		process.exit(0);
		return;
	}

	deny(
		'rule 14 — plans start from the research; add a Research notes section ' +
		'citing the Truth-ledger references you read + any web check.'
	);
}

export function isPlanMarkdownPath(filePath, repoRoot) {
	if (!filePath || !filePath.toLowerCase().endsWith('.md')) return false;
	const normalizedPath = String(filePath).replace(/\\/g, '/');
	const repoRelativePath = repoRoot
		? normalizedPath.replace(String(repoRoot).replace(/\\/g, '/') + '/', '')
		: normalizedPath;
	return /(^|\/)plans\/[^/]+\.md$/i.test(repoRelativePath) || /(^|\/)plans\/[^/]+\.md$/i.test(normalizedPath);
}

// Compute the plan's content AFTER the tool call would apply, for Write, Edit,
// and MultiEdit. Returns null when it cannot be determined safely.
export function resultingPlanContent(toolInput, filePath) {
	if (typeof toolInput.content === 'string') {
		// Write: full-file content is given directly.
		return toolInput.content;
	}

	let existingFileContent = '';
	if (filePath && existsSync(filePath)) {
		try {
			existingFileContent = readFileSync(filePath, 'utf8');
		} catch {
			return null;
		}
	} else if (typeof toolInput.old_string !== 'string') {
		// Neither an existing file nor a Write with content — nothing to check.
		return null;
	}

	if (Array.isArray(toolInput.edits)) {
		// MultiEdit
		let editedContent = existingFileContent;
		for (const edit of toolInput.edits) {
			if (typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') continue;
			if (edit.old_string === '') {
				editedContent = edit.new_string;
				continue;
			}
			if (!editedContent.includes(edit.old_string)) return null;
			editedContent = edit.replace_all
				? editedContent.split(edit.old_string).join(edit.new_string)
				: editedContent.replace(edit.old_string, edit.new_string);
		}
		return editedContent;
	}

	if (typeof toolInput.old_string === 'string' && typeof toolInput.new_string === 'string') {
		// Edit
		if (toolInput.old_string === '') return toolInput.new_string;
		if (!existingFileContent.includes(toolInput.old_string)) return null;
		return toolInput.replace_all
			? existingFileContent.split(toolInput.old_string).join(toolInput.new_string)
			: existingFileContent.replace(toolInput.old_string, toolInput.new_string);
	}

	return null;
}

export function planHasResearchNotesWithSource(planContent) {
	const content = String(planContent || '');
	const headingMatch = RESEARCH_NOTES_HEADING.exec(content);
	if (!headingMatch) return false;

	// Scope the source-citation search to the Research notes SECTION (from its
	// heading to the next `## ` heading or end of file) so a citation living
	// elsewhere in the plan (e.g. in "Existing code to reuse") doesn't count.
	const sectionStart = headingMatch.index + headingMatch[0].length;
	const contentAfterHeading = content.slice(sectionStart);
	const nextHeadingMatch = /^##\s+/m.exec(contentAfterHeading);
	const researchNotesSection = nextHeadingMatch
		? contentAfterHeading.slice(0, nextHeadingMatch.index)
		: contentAfterHeading;

	return PRIMARY_SOURCE_EVIDENCE.test(researchNotesSection);
}

// ---------------------------------------------------------------------------
// Check 2: training launch (rule 13 — experiments run inside a /pres cycle)
// ---------------------------------------------------------------------------

function runTrainingLaunchCheck(hookEvent, repoRoot) {
	const toolInput = getToolInput(hookEvent);
	const command = String(toolInput.command || '').trim();
	if (!command) {
		process.exit(0);
		return;
	}

	if (command.includes(OVERRIDE_TOKEN)) {
		process.exit(0);
		return;
	}

	if (!looksLikeTrainingLaunch(command)) {
		process.exit(0);
		return;
	}

	if (isExemptSmokeTest(command)) {
		process.exit(0);
		return;
	}

	const newestPlanFile = findNewestPlanFile(repoRoot);
	if (newestPlanFile && planIsRedTeamedWithResearch(newestPlanFile.content)) {
		process.exit(0);
		return;
	}

	deny(
		'rule 13 — experiments run inside a /pres cycle; the newest plan must be ' +
		'red-teamed (add the red-teamed: YYYY-MM-DD stamp via the red-team-plan ' +
		'skill) before launching runs.'
	);
}

export function looksLikeTrainingLaunch(command) {
	if (NAMED_LAUNCH_SHAPES.some((launchShapePattern) => launchShapePattern.test(command))) return true;
	return trainingKeywordFallback(command);
}

// Minimal fallback matcher (spec: "reuse the long-running-script guard's
// detection primitives if exported, else a minimal matcher") for launcher
// names not on the named list — a python/node run of a file whose name
// signals training/sweep work.
function trainingKeywordFallback(command) {
	const runnerInvocationPattern = /\b(?:python3?|py|node)\b[^\n|;&]*\.(?:py|mjs|cjs|js)\b/i;
	if (!runnerInvocationPattern.test(command)) return false;
	return /\b(train|sweep|gate\d*)[\w.-]*\.(?:py|mjs|cjs|js)\b/i.test(command);
}

export function isExemptSmokeTest(command) {
	const stepsFlagMatch = /--steps[= ]+(\d+)/i.exec(command);
	if (!stepsFlagMatch) return false; // no --steps value = full run = gated
	return Number(stepsFlagMatch[1]) <= SMOKE_STEPS_CEILING;
}

export function planIsRedTeamedWithResearch(planContent) {
	const content = String(planContent || '');
	return planHasResearchNotesWithSource(content) && RED_TEAM_STAMP.test(content);
}

export function findNewestPlanFile(repoRoot) {
	const plansDirectory = join(repoRoot, 'plans');
	if (!existsSync(plansDirectory)) return null;

	let newestPlanPath = null;
	let newestPlanMtime = -Infinity;
	for (const entryName of readdirSync(plansDirectory)) {
		if (!entryName.toLowerCase().endsWith('.md')) continue;
		const entryPath = join(plansDirectory, entryName);
		let entryStats;
		try {
			entryStats = statSync(entryPath);
		} catch {
			continue;
		}
		if (!entryStats.isFile()) continue;
		if (entryStats.mtimeMs > newestPlanMtime) {
			newestPlanMtime = entryStats.mtimeMs;
			newestPlanPath = entryPath;
		}
	}

	if (!newestPlanPath) return null;
	try {
		return { path: newestPlanPath, content: readFileSync(newestPlanPath, 'utf8') };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Repo scoping: only fire in a repo that has opted into the /pres rules via
// its AGENTS.md ("reviews the research" or a "## Research notes" mention).
// ---------------------------------------------------------------------------

export function findRepoRoot(startDirectory) {
	let currentDirectory = resolve(startDirectory || process.cwd());
	while (true) {
		if (existsSync(join(currentDirectory, '.git')) || existsSync(join(currentDirectory, 'AGENTS.md'))) {
			return currentDirectory;
		}
		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) return null;
		currentDirectory = parentDirectory;
	}
}

export function repoOptsIntoPresCycle(repoRoot) {
	const agentsFilePath = join(repoRoot, 'AGENTS.md');
	if (!existsSync(agentsFilePath)) return false;
	let agentsFileContent;
	try {
		agentsFileContent = readFileSync(agentsFilePath, 'utf8');
	} catch {
		return false;
	}
	return /review(?:s|ed|ing)?\s+the\s+research/i.test(agentsFileContent) ||
		/research[\s-]review/i.test(agentsFileContent) ||
		/##\s*research notes/i.test(agentsFileContent);
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function deny(reason) {
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason
		}
	}));
	process.exit(0);
}

// Entry-point guard so importing this for tests does not execute main() (which
// reads stdin and hangs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
