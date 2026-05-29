#!/usr/bin/env node
// learnings-error-match — PostToolUse(Bash|Edit|Write). When a tool emits error
// output, scan both learnings files for sections matching the error and inject
// the matching bullets — so the agent doesn't re-derive a fix it already solved.
//
// It also drops an "ack marker" (.claude/state/learnings-ack-needed.json). The
// companion hook require-learnings-ack.mjs reads that marker and BLOCKS code
// edits until the learnings file is actually Read — turning a passive reminder
// (easy to ignore) into a hard gate. No-ops if no learnings.md exists.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath, dirname } from 'node:path';
import { homedir } from 'node:os';

function writeAckMarker(projectRoot, matchedSections, errorTokens, learningsPaths) {
	if (!projectRoot) return;
	try {
		const stateDir = joinPath(projectRoot, '.claude', 'state');
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(joinPath(stateDir, 'learnings-ack-needed.json'), JSON.stringify({
			ts: Date.now(),
			sections: [...new Set(matchedSections)],
			tokens: errorTokens.slice(0, 5),
			files: [...new Set(learningsPaths)],
		}, null, 2));
	} catch { /* marker is best-effort */ }
}

const GLOBAL_LEARNINGS_PATH = resolvePath(homedir(), '.claude', 'learnings.md');
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];

// Output contains one of these → treat it as an error context and scan.
const ERROR_SIGNAL_RE =
	/\b(error|exception|failed|fatal|cannot|undefined|null|nan|enoent|eaddr|timeout|denied|invalid|missing|unexpected|syntaxerror|typeerror|referenceerror|rangeerror|panic|traceback|segfault)\b/i;

// Generic programming topic buckets — match an error to a learnings section by
// subject. Tune these to your stack (the value is the mechanism, not the list).
const ERROR_TOPIC_PATTERNS = [
	{ re: /\b(overflow|clipped|scroll|height|flex|grid|z-index|css|layout|stylesheet)\b/i, topic: 'layout css' },
	{ re: /\b(react|vue|svelte|angular|component|render|hook|state|effect|props)\b/i, topic: 'frontend' },
	{ re: /\b(vite|webpack|rollup|esbuild|node_modules|esm|cjs|require|import|bundle|transpile)\b/i, topic: 'build bundler' },
	{ re: /\b(prompt|llm|token|completion|openai|anthropic|embedding|context window|cache)\b/i, topic: 'llm prompt' },
	{ re: /\b(parser|tokenizer|syntax|grammar|ast|lexer)\b/i, topic: 'parser' },
	{ re: /\b(sql|query|migration|schema|index|deadlock|transaction|orm|postgres|sqlite|mongo)\b/i, topic: 'database' },
	{ re: /\b(async|await|promise|race|deadlock|mutex|concurren|thread|goroutine)\b/i, topic: 'concurrency async' },
	{ re: /\b(git|commit|push|rebase|worktree|merge|branch|conflict)\b/i, topic: 'git' },
	{ re: /\b(deploy|vercel|netlify|docker|kubernetes|serverless|lambda|sse|cors|env var)\b/i, topic: 'deployment' },
	{ re: /\b(type|interface|generic|coercion|cast|nil|none|null pointer)\b/i, topic: 'types' },
];

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

function extractTopics(errorOutputText) {
	const detectedTopics = new Set();
	for (const { re, topic } of ERROR_TOPIC_PATTERNS) {
		if (re.test(errorOutputText)) for (const word of topic.split(' ')) detectedTopics.add(word);
	}
	return [...detectedTopics];
}

function parseLearningsBullets(learningsContent) {
	const lines = learningsContent.split(/\r?\n/);
	const sectionBuckets = [];
	let currentSection = null;
	let currentBulletLines = [];

	function flushBullet() {
		if (currentSection && currentBulletLines.length > 0) {
			currentSection.bullets.push(currentBulletLines.join(' ').trim());
		}
		currentBulletLines = [];
	}
	function flushSection() {
		flushBullet();
		if (currentSection && currentSection.bullets.length > 0) sectionBuckets.push(currentSection);
		currentSection = null;
	}

	for (const rawLine of lines) {
		const h2Match = rawLine.match(/^##\s+(.+?)\s*$/);
		const h3Match = rawLine.match(/^###\s+(.+?)\s*$/);
		if (h2Match) {
			flushSection();
			const sectionTitle = h2Match[1].trim();
			currentSection = /table of contents/i.test(sectionTitle) ? null : { title: sectionTitle, bullets: [] };
			continue;
		}
		if (h3Match && currentSection) { flushBullet(); continue; }
		if (!currentSection) continue;
		const bulletStartMatch = rawLine.match(/^\s*-\s+(.+)$/);
		const continuationMatch = rawLine.match(/^\s{2,}\S.*$/);
		if (bulletStartMatch) {
			flushBullet();
			currentBulletLines.push(bulletStartMatch[1]);
		} else if (continuationMatch && currentBulletLines.length > 0) {
			currentBulletLines.push(rawLine.trim());
		} else if (rawLine.trim() === '') {
			flushBullet();
		}
	}
	flushSection();
	return sectionBuckets;
}

function scoreBulletsForKeywords(parsedSections, errorKeywords) {
	const candidates = [];
	for (const sectionEntry of parsedSections) {
		for (const bulletText of sectionEntry.bullets) {
			const lowerBullet = bulletText.toLowerCase();
			let keywordHits = 0;
			for (const keyword of errorKeywords) {
				if (lowerBullet.includes(keyword.toLowerCase())) keywordHits += 1;
			}
			if (keywordHits > 0) candidates.push({ section: sectionEntry.title, bullet: bulletText, hits: keywordHits });
		}
	}
	candidates.sort((a, b) => b.hits - a.hits);
	return candidates;
}

function gatherMatchesFromFile(learningsPath, scopeLabel, errorKeywords, maxBullets) {
	if (!existsSync(learningsPath)) return [];
	let fileBody;
	try { fileBody = readFileSync(learningsPath, 'utf8'); } catch { return []; }
	const parsed = parseLearningsBullets(fileBody);
	const ranked = scoreBulletsForKeywords(parsed, errorKeywords);
	return ranked.slice(0, maxBullets).map((entry) => ({ ...entry, scope: scopeLabel, path: learningsPath }));
}

function main() {
	let hookEvent;
	try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }

	const toolName = hookEvent.tool_name || '';
	if (!['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit'].includes(toolName)) process.exit(0);

	const toolResponse = hookEvent.tool_response || {};
	const combinedOutput = [
		toolResponse.stdout, toolResponse.stderr, toolResponse.output, toolResponse.error,
		typeof toolResponse === 'string' ? toolResponse : null,
	].filter(Boolean).join('\n');

	if (!ERROR_SIGNAL_RE.test(combinedOutput)) process.exit(0);

	const explicitErrorTokens = [...combinedOutput.matchAll(
		/\b([A-Z][a-zA-Z]+(?:Error|Exception)|E[A-Z]{3,}|cannot\s+\w+|undefined\s+is\s+not|null\s+is\s+not)\b/g
	)].map((m) => m[0]);
	const topicKeywords = extractTopics(combinedOutput);
	const searchKeywords = [...new Set([...explicitErrorTokens, ...topicKeywords])].filter((keyword) => keyword.length >= 4);

	if (searchKeywords.length === 0) process.exit(0);

	const globalMatches = gatherMatchesFromFile(GLOBAL_LEARNINGS_PATH, 'global', searchKeywords, 2);
	const projectRoot = findProjectRoot(hookEvent.cwd || process.cwd());
	const projectMatches = projectRoot
		? gatherMatchesFromFile(joinPath(projectRoot, 'learnings.md'), 'project', searchKeywords, 3)
		: [];

	const allMatches = [...projectMatches, ...globalMatches];
	if (allMatches.length === 0) process.exit(0);

	writeAckMarker(
		projectRoot,
		allMatches.map((m) => `[${m.scope}] ${m.section}`),
		searchKeywords,
		allMatches.map((m) => m.path)
	);

	const outputLines = [
		'=== LEARNINGS MATCH (error pattern recognized) ===',
		`Detected error tokens: ${searchKeywords.slice(0, 5).join(', ')}`,
		'Bullets below are from your prior debugging sessions on similar errors.',
		'Read before swinging at this one — you may have already solved it.',
		'',
	];
	for (const match of allMatches) {
		outputLines.push(`[${match.scope}] ${match.section}: ${match.bullet}`);
		outputLines.push(`    -> source: ${match.path}`);
		outputLines.push('');
	}

	process.stdout.write(JSON.stringify({
		hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: outputLines.join('\n') },
	}));
	process.exit(0);
}

main();
