#!/usr/bin/env node
// install.mjs — copy selected hooks into ~/.claude/hooks/, merge their
// registrations into ~/.claude/settings.json (NON-destructively), and
// optionally drop the starter templates. Dependency-free Node.
//
// Usage:
//   node scripts/install.mjs --dry-run            show every change, write nothing
//   node scripts/install.mjs --all                install every kit hook
//   node scripts/install.mjs --tier1 [--tier2]    install whole tiers
//   node scripts/install.mjs --hooks a,b,c        install named hooks
//   node scripts/install.mjs --templates [dir]    also drop CLAUDE.md/learnings.md/HANDOFF.md
//                                                 (default dir: ~/.claude)
//   node scripts/install.mjs --remove <name>      remove a hook + its settings entries
//   node scripts/install.mjs                      (no selection) prints the menu
//
// Safe by design: it only ADDS hook entries it recognizes, never deletes
// entries it didn't add (except the explicit --remove). Re-running is
// idempotent — an already-registered command is skipped, not duplicated.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOKS_SRC = join(KIT_ROOT, 'hooks');
const TEMPLATES_SRC = join(KIT_ROOT, 'templates');
const SKILLS_SRC = join(KIT_ROOT, 'skills');
const FRAGMENT_PATH = join(KIT_ROOT, 'settings.fragment.json');

const CLAUDE_DIR = join(homedir(), '.claude');
const HOOKS_DEST = join(CLAUDE_DIR, 'hooks');
const SKILLS_DEST = join(CLAUDE_DIR, 'skills');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const flagValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const DRY_RUN = hasFlag('--dry-run');

const changes = []; // human-readable log of everything done/would-do
const note = (line) => changes.push(line);

// ── Load the registration map (tierName -> { hookName -> [entries] }) ──────
function loadFragment() {
	const raw = JSON.parse(readFileSync(FRAGMENT_PATH, 'utf8'));
	const byHook = {};
	const tierOf = {};
	for (const [tierName, hooks] of Object.entries(raw)) {
		if (tierName.startsWith('_')) continue;
		for (const [hookName, entries] of Object.entries(hooks)) {
			byHook[hookName] = entries;
			tierOf[hookName] = tierName;
		}
	}
	return { byHook, tierOf };
}

function availableHookFiles() {
	if (!existsSync(HOOKS_SRC)) return new Set();
	return new Set(readdirSync(HOOKS_SRC).filter((f) => f.endsWith('.mjs')).map((f) => basename(f, '.mjs')));
}

// ── Settings.json merge (the careful part) ─────────────────────────────────
function loadSettings() {
	if (!existsSync(SETTINGS_PATH)) return {};
	try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); }
	catch { console.error(`! ${SETTINGS_PATH} is not valid JSON — fix it before installing.`); process.exit(1); }
}

function commandFor(hookName) { return `node ~/.claude/hooks/${hookName}.mjs`; }

// Is this exact command already registered anywhere under this event? (dedupe)
function commandAlreadyRegistered(settings, event, command) {
	const groups = settings.hooks?.[event] || [];
	return groups.some((group) => (group.hooks || []).some((h) => h.command === command));
}

function addRegistration(settings, hookName, entry) {
	settings.hooks ??= {};
	settings.hooks[entry.event] ??= [];
	const command = commandFor(hookName);
	if (commandAlreadyRegistered(settings, entry.event, command)) {
		note(`  = ${hookName}: already registered on ${entry.event} (skipped)`);
		return;
	}
	const hookSpec = { type: 'command', command, timeout: entry.timeout ?? 5 };
	const groups = settings.hooks[entry.event];
	// Reuse a group with the same matcher if present, else create one.
	const matcher = entry.matcher ?? null;
	let group = groups.find((g) => (g.matcher ?? null) === matcher);
	if (!group) { group = matcher ? { matcher, hooks: [] } : { hooks: [] }; groups.push(group); }
	group.hooks ??= [];
	group.hooks.push(hookSpec);
	note(`  + ${hookName}: registered on ${entry.event}${matcher ? ` [${matcher}]` : ''}`);
}

function removeRegistrations(settings, hookName) {
	const command = commandFor(hookName);
	let removed = 0;
	for (const event of Object.keys(settings.hooks || {})) {
		for (const group of settings.hooks[event]) {
			const before = (group.hooks || []).length;
			group.hooks = (group.hooks || []).filter((h) => h.command !== command);
			removed += before - group.hooks.length;
		}
		settings.hooks[event] = settings.hooks[event].filter((g) => (g.hooks || []).length > 0);
	}
	return removed;
}

// ── Selection ──────────────────────────────────────────────────────────────
function resolveSelection({ byHook, tierOf }, available) {
	if (hasFlag('--all')) return Object.keys(byHook).filter((h) => available.has(h));
	const selected = new Set();
	for (const tier of ['tier1', 'tier2', 'tier3']) {
		if (hasFlag(`--${tier}`)) {
			for (const [hook, t] of Object.entries(tierOf)) if (t.startsWith(tier) && available.has(hook)) selected.add(hook);
		}
	}
	const named = flagValue('--hooks');
	if (named) for (const h of named.split(',').map((s) => s.trim()).filter(Boolean)) {
		if (available.has(h)) selected.add(h);
		else console.error(`! unknown or not-yet-ported hook: ${h}`);
	}
	return [...selected];
}

function printMenu({ byHook, tierOf }, available) {
	console.log('Claude Discipline installer — pick a selection flag:\n');
	console.log('  --all            everything available');
	console.log('  --tier1          standalone guardrails (work anywhere)');
	console.log('  --tier2          memory system (needs companion files)');
	console.log('  --tier3          opinionated defaults');
	console.log('  --hooks a,b,c    specific hooks\n');
	console.log('Available hooks (✓ = ported and installable, ⏳ = mapped but not yet ported):\n');
	for (const tier of ['tier1_standalone', 'tier2_memory', 'tier3_opinionated']) {
		console.log(`  ${tier}:`);
		for (const [hook, t] of Object.entries(tierOf)) {
			if (t !== tier) continue;
			console.log(`    ${available.has(hook) ? '✓' : '⏳'} ${hook}`);
		}
	}
	const skillNames = availableSkillDirs();
	if (skillNames.length) {
		console.log('\nSkills (workflows) — add --skills to install all of them:');
		console.log(`    ${skillNames.join(', ')}`);
	}
	console.log('\nAdd --templates to also drop CLAUDE.md / learnings.md / HANDOFF.md.');
	console.log('Add --dry-run to preview without writing.');
}

// ── Templates ────────────────────────────────────────────────────────────
function installTemplates(targetDir) {
	if (!existsSync(TEMPLATES_SRC)) return;
	for (const file of readdirSync(TEMPLATES_SRC)) {
		const dest = join(targetDir, file);
		if (existsSync(dest)) { note(`  = template ${file}: exists at ${dest} (left untouched)`); continue; }
		note(`  + template ${file} -> ${dest}`);
		if (!DRY_RUN) { mkdirSync(targetDir, { recursive: true }); copyFileSync(join(TEMPLATES_SRC, file), dest); }
	}
}

// ── Skills ────────────────────────────────────────────────────────────────
// Skills are directories under skills/<name>/ with a SKILL.md. Claude Code
// auto-discovers anything in ~/.claude/skills/ — no settings.json registration
// needed, so this is just a careful recursive copy (existing skills untouched).
function availableSkillDirs() {
	if (!existsSync(SKILLS_SRC)) return [];
	return readdirSync(SKILLS_SRC).filter((entry) => {
		try { return statSync(join(SKILLS_SRC, entry)).isDirectory(); } catch { return false; }
	});
}

function installSkills() {
	const skillNames = availableSkillDirs();
	if (skillNames.length === 0) return;
	for (const skillName of skillNames) {
		const dest = join(SKILLS_DEST, skillName);
		if (existsSync(dest)) { note(`  = skill ${skillName}: exists at ${dest} (left untouched)`); continue; }
		note(`  + skill ${skillName} -> ${dest}`);
		if (!DRY_RUN) cpSync(join(SKILLS_SRC, skillName), dest, { recursive: true });
	}
}

// ── Main ────────────────────────────────────────────────────────────────
function main() {
	const fragment = loadFragment();
	const available = availableHookFiles();

	if (hasFlag('--help') || hasFlag('-h')) { printMenu(fragment, available); return; }

	// Remove mode
	const removeName = flagValue('--remove');
	if (removeName) {
		const settings = loadSettings();
		const removed = removeRegistrations(settings, removeName);
		note(`  - ${removeName}: removed ${removed} settings entr${removed === 1 ? 'y' : 'ies'}`);
		const hookFile = join(HOOKS_DEST, `${removeName}.mjs`);
		if (existsSync(hookFile)) note(`  - delete ${hookFile}`);
		if (!DRY_RUN) {
			writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
			if (existsSync(hookFile)) { try { rmSync(hookFile, { force: true }); } catch {} }
		}
		report();
		return;
	}

	const selection = resolveSelection(fragment, available);
	const wantsTemplates = hasFlag('--templates');
	const wantsSkills = hasFlag('--skills') || hasFlag('--all');

	if (selection.length === 0 && !wantsTemplates && !wantsSkills) { printMenu(fragment, available); return; }

	// Copy hook files
	if (!DRY_RUN && selection.length) mkdirSync(HOOKS_DEST, { recursive: true });
	for (const hook of selection) {
		const dest = join(HOOKS_DEST, `${hook}.mjs`);
		note(`  + copy hook ${hook}.mjs -> ${dest}`);
		if (!DRY_RUN) copyFileSync(join(HOOKS_SRC, `${hook}.mjs`), dest);
	}

	// Merge settings.json
	const settings = loadSettings();
	for (const hook of selection) for (const entry of fragment.byHook[hook]) addRegistration(settings, hook, entry);
	if (!DRY_RUN && selection.length) writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

	// Templates
	if (wantsTemplates) installTemplates(flagValue('--templates') && !flagValue('--templates').startsWith('--') ? flagValue('--templates') : CLAUDE_DIR);

	// Skills
	if (wantsSkills) installSkills();

	report();
}

function report() {
	console.log(`\n${DRY_RUN ? '[DRY RUN] would make these changes:' : 'Done. Changes:'}\n`);
	console.log(changes.length ? changes.join('\n') : '  (nothing to do)');
	if (DRY_RUN) console.log('\nRe-run without --dry-run to apply.');
	else console.log(`\nSettings: ${SETTINGS_PATH}\nRestart Claude Code (or start a new session) to load the hooks.`);
}

main();
