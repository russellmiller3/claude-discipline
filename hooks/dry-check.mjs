#!/usr/bin/env node
// =============================================================================
// DRY + BEST-PRACTICES GUARD — generic design-quality detector for ANY project
// =============================================================================
//
// Replaces (and merges) the previous Clear-specific hooks:
//   - dry-check-before-feature.mjs (plan/intent.md scans, FAQ/FEATURES greps)
//   - dry-check-named-primitive.mjs (theme/NodeType/synonym/validator greps)
//
// Both were hardcoded to Clear's docs + source files. Russell flagged the
// gap 2026-05-14 night: "All hooks should be generic and re-usable." This
// hook is the merged generic form.
//
// BIG PICTURE (Russell, 2026-06-26): this is the ONE place that enforces DRY +
// good engineering practice at BOTH plan time (edits to plans/*.md) and build
// time (edits to source). It is an EXTENSIBLE SET of advisory checks — add a
// new practice by writing one more check + a row in dry-check.test.mjs, never a
// new bespoke hook. Each check is a soft warning (never blocks) so momentum
// stays; the warning surfaces the smell so you fix it BEFORE it compounds (the
// brain.js import-time-wiring sprawl and the kv_append copy-paste are the two
// smells that motivated Checks 3 + 4).
//
// HOW IT WORKS
// ============
//
// Fires PreToolUse on Edit / Write to ANY source file. Two checks run:
//
// CHECK 1 — Named-primitive collision (was dry-check-named-primitive).
//   Detects ADDITIONS of named identifiers in the edit (function names,
//   const/let/var declarations, class names, object keys with backtick
//   values, Python def/class — see DEFAULT_NAME_PATTERNS below). For each
//   name, greps the same file + the project's doc files for prior
//   declarations. Warns if found.
//
// CHECK 2 — Domain-noun match (was dry-check-before-feature).
//   When the edit touches a plan/spec markdown file, extracts domain
//   nouns from the new text and greps the project's docs for whether
//   those concepts are already documented. Warns if so.
//
// PROJECT CONFIG
// ==============
//
// The hook auto-detects the project root by walking up from the edited
// file until it finds either a `.git/` directory or a `CLAUDE.md` file.
// Then it looks for `<project>/.claude/dry-check.json` for opt-in
// customization:
//
//   {
//     "docs": ["FAQ.md", "FEATURES.md", "intent.md", "SYNTAX.md"],
//     "namePatterns": [
//       { "kind": "theme", "regex": "^\\s*(\\w+):\\s*`\\[data-theme=" },
//       { "kind": "NodeType", "regex": "^\\s*([A-Z][A-Z0-9_]+):\\s*['\"]\\w+['\"]" }
//     ],
//     "planFiles": ["plans/*.md", "intent.md"]
//   }
//
// If no config file exists, the hook uses generic defaults that work for
// most JS/TS/Python projects.
//
// SOFT-WARN, NEVER BLOCK
// ======================
//
// Both checks emit advisory messages via `additionalContext`. They never
// block writes. Soft warnings keep momentum on legit edits while surfacing
// the collision so I can confirm intent.
// =============================================================================

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';

// ---------------------------------------------------------------------------
// Project root + config discovery
// ---------------------------------------------------------------------------

function findProjectRoot(startDir) {
  // Walk up until a `.git/` directory or a CLAUDE.md file is found. The
  // first such directory IS the project root.
  let cur = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(cur, '.git')) || existsSync(resolve(cur, 'CLAUDE.md'))) return cur;
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function readProjectConfig(projectRoot) {
  if (!projectRoot) return {};
  const cfgPath = resolve(projectRoot, '.claude', 'dry-check.json');
  if (!existsSync(cfgPath)) return {};
  try { return JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { return {}; }
}

function listMarkdownAtRoot(projectRoot) {
  // Default doc list when project has no .claude/dry-check.json — every
  // .md file at the project root, excluding LICENSE-ish stuff.
  if (!projectRoot) return [];
  try {
    return readdirSync(projectRoot)
      .filter(f => f.endsWith('.md') && !/^(LICENSE|CODE_OF_CONDUCT|CONTRIBUTING)/i.test(f));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Default name-collision patterns (language-agnostic-ish)
// ---------------------------------------------------------------------------

const DEFAULT_NAME_PATTERNS = [
  // JS/TS function declarations
  { kind: 'function', regex: '^(?:export\\s+)?(?:async\\s+)?function\\s+(\\w+)' },
  // JS/TS class declarations
  { kind: 'class', regex: '^(?:export\\s+)?class\\s+(\\w+)' },
  // JS/TS top-level const/let/var
  { kind: 'const', regex: '^(?:export\\s+)?(?:const|let|var)\\s+(\\w+)\\s*=' },
  // Python def
  { kind: 'def', regex: '^def\\s+(\\w+)' },
  // Python class
  { kind: 'pyclass', regex: '^class\\s+(\\w+)' },
];

// ---------------------------------------------------------------------------
// Stdin parsing
// ---------------------------------------------------------------------------

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Check 1: Named-primitive collisions
// ---------------------------------------------------------------------------

function extractAddedNames(newContent, oldContent, patterns) {
  const added = [];
  for (const p of patterns) {
    let re;
    try { re = new RegExp(p.regex, 'gm'); } catch { continue; }
    let m;
    while ((m = re.exec(newContent)) !== null) {
      const name = m[1];
      if (!name) continue;
      // Skip names that were already in the OLD content. For Edit tools,
      // we want to flag only NEW names — names you're introducing.
      if (oldContent) {
        // Re-check the pattern against old content to see if this exact
        // name was previously declared. If so, the edit is modifying not
        // introducing.
        const reOldOnce = new RegExp(p.regex, 'm');
        const oldMatch = reOldOnce.exec(oldContent);
        if (oldMatch && oldMatch[1] === name) continue;
      }
      added.push({ kind: p.kind, name });
    }
  }
  return added;
}

function findCollisions(name, filePath, fileContent, projectRoot, docs) {
  const hits = [];
  if (!name) return hits;
  const wordRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`);

  // Same-file scan — declarations only, not casual references.
  const fileLines = fileContent.split('\n');
  for (let i = 0; i < fileLines.length; i++) {
    if (!wordRe.test(fileLines[i])) continue;
    // Definition-shape heuristic: line looks like a top-level declaration.
    const looksLikeDef = /^\s*(\w+:|function\s|class\s|const\s|let\s|var\s|export\s|def\s)/.test(fileLines[i]);
    if (looksLikeDef) {
      hits.push({ where: basename(filePath), line: i + 1, context: fileLines[i].trim().slice(0, 120) });
    }
  }

  // Cross-doc scan.
  if (projectRoot && Array.isArray(docs)) {
    for (const doc of docs) {
      const docPath = resolve(projectRoot, doc);
      if (!existsSync(docPath)) continue;
      try {
        const docLines = readFileSync(docPath, 'utf8').split('\n');
        for (let i = 0; i < docLines.length; i++) {
          if (wordRe.test(docLines[i])) {
            hits.push({ where: doc, line: i + 1, context: docLines[i].trim().slice(0, 120) });
            break; // one hit per doc is enough — the doc clearly already mentions it
          }
        }
      } catch {}
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Check 2: Domain-noun match (for plan/spec markdown edits)
// ---------------------------------------------------------------------------

function isPlanOrSpecFile(filePath, projectRoot, planGlobs) {
  // True if the file is a plan or spec — those are the ones where adding
  // new domain nouns is the highest-risk-of-duplicate-work moment.
  const fileBase = basename(filePath);
  if (Array.isArray(planGlobs) && planGlobs.length) {
    return planGlobs.some(g => {
      const pat = g.replace(/\./g, '\\.').replace(/\*/g, '[^/]*');
      const re = new RegExp(`(^|/)${pat}$`);
      return re.test(filePath.replace(/\\/g, '/'));
    });
  }
  // Default: any .md file in a plans/ directory, or intent.md / SPEC.md at root.
  if (/plans?\//.test(filePath.replace(/\\/g, '/')) && fileBase.endsWith('.md')) return true;
  if (/^(intent|SPEC|DESIGN)\.md$/i.test(fileBase)) return true;
  return false;
}

function extractDomainNouns(content) {
  // Heuristic: capitalized multi-word phrases or single capitalized nouns
  // that appear more than once in the content. Skip common stopwords.
  const nouns = new Set();
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;
  const counts = new Map();
  let m;
  while ((m = re.exec(content)) !== null) {
    const phrase = m[1];
    if (phrase.length < 4) continue;
    if (/^(The|This|That|Then|There|These|Those|When|Where|While|With|For|And|But|Add|All|Use)$/.test(phrase)) continue;
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  for (const [phrase, count] of counts.entries()) {
    if (count >= 2) nouns.add(phrase);
  }
  return [...nouns].slice(0, 8); // cap to keep the warning short
}

function findNounInDocs(noun, projectRoot, docs) {
  if (!projectRoot || !Array.isArray(docs)) return [];
  const hits = [];
  const wordRe = new RegExp(`\\b${noun.replace(/\s+/g, '\\s+').replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
  for (const doc of docs) {
    const docPath = resolve(projectRoot, doc);
    if (!existsSync(docPath)) continue;
    try {
      const text = readFileSync(docPath, 'utf8');
      if (wordRe.test(text)) hits.push(doc);
    } catch {}
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Check 3: Duplicated LOGIC (copy-pasted expressions, not just colliding names)
// ---------------------------------------------------------------------------
//
// Check 1 catches a re-declared NAME. It is blind to copy-pasted LOGIC: a
// distinctive multi-line expression pasted into a new block with FRESH local
// names introduces no colliding identifier, so it sailed straight through.
// That is exactly the smell Russell flagged 2026-06-26 — `kv_append` inlined
// the same `String(x).split('.').reduce(...)` reducer `kv_set` already had (and
// that `resolveContextPath` already wrapped). This check matches the ADDED
// lines against the rest of the file: a distinctive, logic-bearing line that
// already exists verbatim elsewhere is a copy — extract a shared helper.

const LOGIC_MARKERS = /=>|\.reduce\(|\.map\(|\.filter\(|\.flatMap\(|\.split\(|&&|\|\||\?\?|\.then\(/;

function normalizeCodeLine(line) {
  return String(line)
    .replace(/\/\/.*$/, '')   // drop a trailing line comment
    .replace(/\s+/g, ' ')      // collapse whitespace so indentation doesn't matter
    .trim();
}

// The EXPRESSION a line carries, with its binding stripped — so two lines that assign the SAME expression to
// DIFFERENT names match. This is the crux: the real kv_set/kv_append smell was `const valueToStore = <expr>`
// vs `const rowToAppend = <expr>` — identical RHS, different LHS, so a whole-line compare misses it. Strip a
// leading `const|let|var X =`, a `return`, and the trailing `;` to compare the logic itself.
function logicSignature(line) {
  return normalizeCodeLine(line)
    .replace(/^(?:export\s+)?(?:const|let|var)\s+[\w.[\]]+\s*=\s*/, '')
    .replace(/^return\s+/, '')
    .replace(/;$/, '')
    .trim();
}

const isDistinctiveLogic = (norm) => norm.length >= 40 && LOGIC_MARKERS.test(norm);

function findDuplicatedLogic(toolName, newContent, oldContent, fileContent) {
  const warnings = [];
  const alreadyFlagged = new Set();
  const newLines = String(newContent).split('\n');

  if (toolName === 'Write') {
    // A Write replaces the whole file, so `fileContent` === `newContent` (a new file falls back to it). Comparing
    // a line against the file would self-match EVERY line. The real smell here is INTERNAL duplication: a
    // distinctive expression that appears 2+ times within the written content.
    const occurrences = new Map();
    const firstLineAt = new Map();
    for (let i = 0; i < newLines.length; i++) {
      const signature = logicSignature(newLines[i]);
      if (!signature) continue;
      occurrences.set(signature, (occurrences.get(signature) || 0) + 1);
      if (!firstLineAt.has(signature)) firstLineAt.set(signature, i + 1);
    }
    for (const [signature, count] of occurrences) {
      if (count >= 2 && isDistinctiveLogic(signature) && !alreadyFlagged.has(signature)) {
        alreadyFlagged.add(signature);
        warnings.push({ at: firstLineAt.get(signature), snippet: signature.slice(0, 110) });
      }
    }
    return warnings.slice(0, 4);
  }

  // Edit: `fileContent` is the PRE-edit file (does not yet contain new_string). A distinctive ADDED expression
  // that already exists in that file — and is not part of the old_string being REMOVED — is a copy of existing
  // logic (the var name it is bound to may differ; we compare the expression, not the whole line).
  const removedSignatures = new Set(String(oldContent || '').split('\n').map(logicSignature).filter(Boolean));
  const existingAt = new Map();
  const fileLines = String(fileContent).split('\n');
  for (let i = 0; i < fileLines.length; i++) {
    const signature = logicSignature(fileLines[i]);
    if (signature && !existingAt.has(signature)) existingAt.set(signature, i + 1);
  }
  for (const rawLine of newLines) {
    const signature = logicSignature(rawLine);
    if (!isDistinctiveLogic(signature)) continue;
    if (alreadyFlagged.has(signature) || removedSignatures.has(signature)) continue;
    if (existingAt.has(signature)) {
      alreadyFlagged.add(signature);
      warnings.push({ at: existingAt.get(signature), snippet: signature.slice(0, 110) });
    }
  }
  return warnings.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Check 4: Import-time singleton wiring (god-module / untestable-by-construction)
// ---------------------------------------------------------------------------
//
// A module that wires the whole app at MODULE TOP LEVEL — `const x = createX()`,
// `registerY(x, ...)`, `installZ(...)` all running as import-time side effects —
// produces singletons nothing can test or inject (importing the module DOES the
// wiring, with real adapters). brain.js grew to ~12 such statements before
// Russell flagged it 2026-06-26: "a refactor hook should have caught this and
// made you extract." The fix is always the same — wrap the wiring in a
// `create<Name>Runtime()` FACTORY so it's callable + injectable; the module's
// top level becomes one call. This check fires when an edit GROWS that sprawl.

const WIRING_LINE = /^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*(?:create|register|install|build|make|wire|setup|configure|init)\w*\(|^(?:register|install|wire|setup|configure)\w*\(/;
const WIRING_THRESHOLD = 8; // a handful of top-level factory calls is fine; a dozen is a god-module

function isSourceFile(filePath) {
  return /\.(js|mjs|cjs|ts|jsx|tsx)$/.test(filePath) && !/\.(test|spec)\./.test(filePath) && !/node_modules/.test(filePath.replace(/\\/g, '/'));
}

// Reuses the same test/spec detection Check 4 already trusts. Two independent test cases in one
// file legitimately computing the same "expected value" via the same expression is normal,
// self-contained test style, not the silent-drift hazard Check 3 exists to catch in PRODUCTION
// logic — proven live (2026-07-27): adding a second `it()` block that recomputes an existing
// total via `.filter(...).reduce(...)` got DENIED, which would brick this exact common pattern in
// every project. Detection still runs on test files (the advisory stays informative); only the
// BLOCK is scoped to non-test source, where verbatim copy-paste really does mean two copies to
// keep in sync forever.
function isTestFile(filePath) {
  return /\.(test|spec)\./.test(String(filePath || '').replace(/\\/g, '/'));
}

function countTopLevelWiring(content) {
  let count = 0;
  for (const rawLine of String(content).split('\n')) {
    if (WIRING_LINE.test(rawLine)) count += 1; // WIRING_LINE is anchored at column 0 → only module-top-level statements
  }
  return count;
}

function checkImportTimeWiring(toolName, filePath, newContent, fileContent) {
  if (!isSourceFile(filePath)) return null;
  // The edit must actually ADD a top-level wiring statement — don't nag on an unrelated edit to a big module.
  const addsWiring = String(newContent).split('\n').some((line) => WIRING_LINE.test(line));
  if (!addsWiring) return null;
  // Count the resulting file: a Write IS the whole file; an Edit grows the pre-edit file by its added lines.
  const resultingWiring = toolName === 'Write'
    ? countTopLevelWiring(newContent)
    : countTopLevelWiring(fileContent) + 1; // at least the line being added
  if (resultingWiring < WIRING_THRESHOLD) return null;
  return resultingWiring;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const payload = readPayload();
const toolName = payload.tool_name || '';
if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

const input = payload.tool_input || {};
const filePath = input.file_path || '';
if (!filePath) process.exit(0);

// Escape hatch for a DELIBERATE duplicate (a fixture that must stay verbatim, a generated file,
// two copies that genuinely must not share a helper). Env var or the token anywhere in the content.
const DRY_ESCAPE = process.env.DRY_OK === '1'
  || /\bDRY_OK\b/.test(String(input.new_string || input.content || ''));

const newContent = toolName === 'Edit' ? (input.new_string || '') : (input.content || '');
const oldContent = toolName === 'Edit' ? (input.old_string || '') : '';
if (!newContent) process.exit(0);

const projectRoot = findProjectRoot(dirname(filePath));
const config = readProjectConfig(projectRoot);

const docs = Array.isArray(config.docs) && config.docs.length
  ? config.docs
  : listMarkdownAtRoot(projectRoot);
const namePatterns = Array.isArray(config.namePatterns) && config.namePatterns.length
  ? [...DEFAULT_NAME_PATTERNS, ...config.namePatterns]
  : DEFAULT_NAME_PATTERNS;
const planGlobs = Array.isArray(config.planFiles) ? config.planFiles : null;

const fileContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : newContent;

// ---- Check 1: named-primitive collisions -----------------------------------
const added = extractAddedNames(newContent, oldContent, namePatterns);
const nameWarnings = [];
for (const item of added) {
  const collisions = findCollisions(item.name, filePath, fileContent, projectRoot, docs);
  if (collisions.length === 0) continue;
  // Filter: if the only collision IS the line we're editing (line we just
  // matched in fileContent === the line we're adding), skip — that's not
  // a duplicate, that's the SAME declaration.
  const realCollisions = collisions.filter(c => {
    // A self-match: same file + the trimmed context appears in newContent.
    if (c.where !== basename(filePath)) return true;
    const trimmed = c.context;
    return !newContent.includes(trimmed);
  });
  if (realCollisions.length === 0) continue;
  nameWarnings.push({ item, collisions: realCollisions });
}

// ---- Check 2: domain-noun match (plan/spec files) --------------------------
const nounWarnings = [];
if (isPlanOrSpecFile(filePath, projectRoot, planGlobs) && projectRoot) {
  const nouns = extractDomainNouns(newContent);
  for (const noun of nouns) {
    const docHits = findNounInDocs(noun, projectRoot, docs);
    if (docHits.length > 0) nounWarnings.push({ noun, docs: docHits });
  }
}

// ---- Check 3: duplicated logic (copy-pasted expressions) -------------------
const logicWarnings = findDuplicatedLogic(toolName, newContent, oldContent, fileContent);

// ---- Check 4: import-time singleton wiring (god-module) --------------------
const wiringCount = checkImportTimeWiring(toolName, filePath, newContent, fileContent);

if (nameWarnings.length === 0 && nounWarnings.length === 0 && logicWarnings.length === 0 && !wiringCount) process.exit(0);

// ---------------------------------------------------------------------------
// TEETH (2026-07-27). Russell: "the goal is to create a hook to make my coding DRY."
//
// This hook already DETECTED duplication — and then said, verbatim: "This is a soft warning, not
// a block. The edit proceeds either way." So every copy-paste it caught got waved through, which
// is precisely the "why would you ever build a hook that makes suggestions?" failure in
// learnings.md. A detector without teeth is a comment with extra steps.
//
// ONLY Check 3 blocks, deliberately. It is the high-precision signal: the SAME distinctive
// logic-bearing expression (>=40 chars, carries =>/.reduce/.map/&&/... ) appearing verbatim twice.
// That is copy-paste, not coincidence. Checks 1/2/4 stay advisory because they are heuristics with
// real false-positive rates — Check 1 flags ordinary function PARAMETERS as "collisions" (proven
// live on this very edit: it reported `toolName`, `input`, `filePath`). Blocking on those would
// brick routine work and get the whole hook escaped forever, which is worse than no hook.
if (logicWarnings.length > 0 && !DRY_ESCAPE && !isTestFile(filePath)) {
  const denial = [
    'DRY VIOLATION — this edit copy-pastes logic that already exists in this file.',
    '',
    ...logicWarnings.map(({ at, snippet }) => `  already at line ${at}: ${snippet}`),
    '',
    'Extract a shared helper and call it from both places (or call the existing one). Copy-paste is',
    'how two copies drift: the next fix lands in one and silently misses the other.',
    '',
    'If this duplicate is genuinely deliberate (a fixture that must stay verbatim, generated code,',
    'two copies that must NOT share a helper), set DRY_OK=1 or put the token DRY_OK in the content.',
  ].join('\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial,
    },
  }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Emit the warning
// ---------------------------------------------------------------------------

const lines = ['DRY-CHECK WARNING — your edit may duplicate existing work.', ''];

if (nameWarnings.length > 0) {
  lines.push('Named primitives in your edit that already appear elsewhere:');
  for (const { item, collisions } of nameWarnings) {
    lines.push(`- ${item.kind}: "${item.name}"`);
    for (const c of collisions.slice(0, 3)) {
      lines.push(`    already in ${c.where}:${c.line} — ${c.context}`);
    }
  }
  lines.push('');
}

if (nounWarnings.length > 0) {
  lines.push('Domain concepts in your plan/spec that are already documented elsewhere:');
  for (const { noun, docs: docList } of nounWarnings) {
    lines.push(`- "${noun}" — already mentioned in: ${docList.join(', ')}`);
  }
  lines.push('');
}

if (logicWarnings.length > 0) {
  lines.push('Duplicated LOGIC — these lines already exist verbatim in this file (you are copy-pasting, not reusing):');
  for (const { at, snippet } of logicWarnings) {
    lines.push(`    line ${at}: ${snippet}`);
  }
  lines.push('EXTRACT a shared helper (or call the existing one) instead of inlining the same expression twice.');
  lines.push('');
}

if (wiringCount) {
  lines.push(`Import-time wiring sprawl — ${basename(filePath)} runs ~${wiringCount} create/register/install statements at MODULE TOP LEVEL.`);
  lines.push('That wires the app as import-time side effects → singletons nothing can test or inject. EXTRACT a');
  lines.push('create<Name>Runtime({ ...injectable deps }) FACTORY that returns the wired object; let the module top');
  lines.push('level be one call to it. Tests then build a runtime with fakes instead of importing real adapters.');
  lines.push('');
}

lines.push('Review the existing definitions BEFORE landing this edit. If you are intentionally extending or replacing existing work, that is fine; this warning surfaces the collision so you can confirm intent. If you missed an existing primitive, step back — extend it in place rather than adding alongside.');
lines.push('');
lines.push("These are advisory (heuristics with real false-positive rates): the edit proceeds. Verbatim copy-pasted logic is the one that BLOCKS.");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext: lines.join('\n'),
  },
}));
process.exit(0);
