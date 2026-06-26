#!/usr/bin/env node
/**
 * filename-quality-guard — PreToolUse(Write) HARD BLOCK on a low-quality new-file name.
 *
 * Russell, 2026-06-25 ("'findigns' is bullshit"): when CREATING a file, the name must be helpful and
 * correctly spelled. A typo'd or lazy filename (findigns.md, tmp.mjs, output2.js, asdf.txt) is noise that
 * future-Russell/Meph have to decode. This guard fires at write time and DENIES the create until the name is
 * fixed — it does not "suggest", it stops (permissionDecision: 'deny' = real teeth).
 *
 * What it blocks (high-confidence only — low false-positive by design):
 *   1. JUNK exact names — tmp / temp / test / foo / bar / asdf / untitled / output / final / copy / stuff …
 *   2. VOWELLESS tokens (len>=5, not a known acronym) — fndngs, bnchmrk, schdlr …
 *   3. LIKELY TYPOS — a token (len>=5) one edit away from a known word but not itself a word
 *      (findigns→findings, recieve→receive, benchmrk→benchmark, lenght→length). Optimal-string-alignment
 *      distance == 1, which counts an adjacent transposition as a single edit.
 *
 * What it ALLOWS: conventional caps files (README, LICENSE, FINDINGS, HANDOFF, CLAUDE…), dotfiles, standard
 * config stems (package, tsconfig, index, vite.config…), tech acronyms, and any word it doesn't recognize as
 * a near-miss typo (new domain words are fine — it only blocks CLOSE misspellings, not unknown words).
 *
 * Override (rare — a real word it wrongly flags): set FILENAME_GUARD_OVERRIDE=1 in env.
 * Fail-open on any internal error — never brick a legitimate Write.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Conventional all-caps / standard stems that are correct AS-IS regardless of dictionary status.
const ALLOWED_STEMS = new Set([
  'readme', 'license', 'licence', 'changelog', 'contributing', 'codeowners', 'authors', 'notice',
  'findings', 'handoff', 'memory', 'claude', 'agents', 'notes', 'todo', 'roadmap', 'philosophy',
  'guide', 'syntax', 'intent', 'learnings', 'index', 'main', 'app', 'cli', 'api', 'package',
  'tsconfig', 'jsconfig', 'vite', 'vitest', 'webpack', 'rollup', 'eslint', 'prettier', 'babel',
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'manifest', 'config', 'settings', 'setup',
]);

// Lazy / scratch / placeholder stems — blocked even though some are real words: a filename of just "data"
// or "output" tells the reader nothing.
const JUNK_STEMS = new Set([
  'tmp', 'temp', 'test', 'tests', 'foo', 'bar', 'baz', 'qux', 'asdf', 'qwerty', 'untitled', 'new',
  'newfile', 'file', 'files', 'doc', 'docs', 'output', 'out', 'input', 'in', 'copy', 'final', 'final2',
  'finalfinal', 'stuff', 'things', 'thing', 'misc', 'data', 'data2', 'aaa', 'aaaa', 'xxx', 'test1',
  'test2', 'untitled1', 'scratch', 'placeholder', 'todo2', 'wip', 'draft1', 'version2', 'v2file',
]);

// Standard tech acronyms / short tokens that are legitimately vowelless or terse.
const KNOWN_ACRONYMS = new Set([
  'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml', 'csv', 'tsv',
  'md', 'mdx', 'xml', 'svg', 'png', 'jpg', 'gif', 'pdf', 'sql', 'sh', 'ps1', 'http', 'https', 'url',
  'uri', 'api', 'cli', 'sdk', 'ui', 'ux', 'db', 'id', 'os', 'io', 'rpc', 'grpc', 'ssr', 'csr', 'dom',
  'jwt', 'cors', 'csrf', 'xss', 'vad', 'tts', 'stt', 'llm', 'rag', 'env', 'cdn', 'dns', 'tcp', 'udp',
  'ws', 'wss', 'pcm', 'wav', 'mp3', 'mp4', 'cpu', 'gpu', 'ram', 'kv', 'gpt', 'ai', 'ml', 'qa',
]);

// A focused dev/doc vocabulary. Doubles as the "known-good" set AND the corpus for typo near-miss
// detection: a token within OSA distance 1 of one of these (but not itself listed) is a likely misspelling.
const COMMON_WORDS = new Set([
  'findings', 'benchmark', 'benchmarks', 'bakeoff', 'latency', 'voice', 'realtime', 'client', 'clients',
  'server', 'servers', 'harness', 'runner', 'scenario', 'scenarios', 'verifier', 'verifiers', 'summary',
  'report', 'reports', 'result', 'results', 'metric', 'metrics', 'smoke', 'probe', 'probes', 'fixture',
  'fixtures', 'sample', 'samples', 'accuracy', 'length', 'width', 'height', 'receive', 'separate',
  'definitely', 'environment', 'transport', 'controller', 'control', 'session', 'sessions', 'request',
  'requests', 'response', 'responses', 'message', 'messages', 'payload', 'schema', 'schemas', 'parser',
  'parse', 'decode', 'encode', 'stream', 'streaming', 'socket', 'sockets', 'audio', 'transcript',
  'transcription', 'model', 'models', 'provider', 'providers', 'pricing', 'cost', 'tokens', 'token',
  'usage', 'config', 'settings', 'options', 'helper', 'helpers', 'utils', 'utility', 'common', 'shared',
  'module', 'modules', 'component', 'components', 'service', 'services', 'adapter', 'adapters', 'bridge',
  'storage', 'memory', 'database', 'query', 'queries', 'index', 'router', 'route', 'routes', 'routing',
  'dispatch', 'dispatcher', 'registry', 'register', 'handler', 'handlers', 'middleware', 'feature',
  'features', 'explainer', 'explainers', 'document', 'documents', 'manager', 'pulse', 'ledger', 'recipe',
  'recipes', 'calendar', 'gmail', 'sheets', 'docs', 'google', 'gemini', 'openai', 'anthropic', 'claude',
  'agent', 'agents', 'brain', 'cascade', 'grounding', 'contract', 'check', 'guard', 'hook', 'hooks',
  'inject', 'palette', 'screenshot', 'walkthrough', 'evidence', 'dispersion', 'inference', 'decision',
  'analysis', 'compare', 'comparison', 'profile', 'profiles', 'baseline', 'connectivity', 'lifecycle',
  'page', 'pages', 'browser', 'navigate', 'extract', 'reader', 'writer', 'loader', 'builder', 'factory',
  'validate', 'validator', 'normalize', 'serialize', 'deserialize', 'aggregate', 'percentile', 'trial',
  'trials', 'concurrency', 'parallel', 'resume', 'durable', 'idempotent', 'checkpoint', 'progress',
]);

// Optimal String Alignment distance (Levenshtein + adjacent transposition counted as one edit). Bounded
// early-exit at >1 is all we need for near-miss typo detection.
function osaDistance(left, right) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let row = 0; row < rows; row++) grid[row][0] = row;
  for (let col = 0; col < cols; col++) grid[0][col] = col;
  for (let row = 1; row < rows; row++) {
    for (let col = 1; col < cols; col++) {
      const substitutionCost = left[row - 1] === right[col - 1] ? 0 : 1;
      grid[row][col] = Math.min(
        grid[row - 1][col] + 1,
        grid[row][col - 1] + 1,
        grid[row - 1][col - 1] + substitutionCost,
      );
      if (row > 1 && col > 1 && left[row - 1] === right[col - 2] && left[row - 2] === right[col - 1]) {
        grid[row][col] = Math.min(grid[row][col], grid[row - 2][col - 2] + 1);
      }
    }
  }
  return grid[left.length][right.length];
}

function hasVowel(word) {
  return /[aeiouy]/.test(word);
}

// Split a stem into alphabetic word tokens: break on -, _, ., space, digits, and camelCase boundaries.
function tokenizeStem(stem) {
  return stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .map((piece) => piece.toLowerCase())
    .filter(Boolean);
}

// Pure verdict. Returns { ok } or { ok:false, reason, suggestion? }. Unit-tested directly.
export function assessFilename(filePath) {
  const base = String(filePath || '').replace(/\\/g, '/').split('/').pop() || '';
  if (!base) return { ok: true };
  if (base.startsWith('.')) return { ok: true };               // dotfiles (.gitignore, .env)

  // The stem is everything before the first dot (drop all extensions, e.g. ".test.mjs").
  const stem = base.split('.')[0];
  const stemLower = stem.toLowerCase();
  if (!stem) return { ok: true };
  if (ALLOWED_STEMS.has(stemLower)) return { ok: true };
  if (JUNK_STEMS.has(stemLower)) {
    return { ok: false, reason: `"${base}" is a lazy/scratch name — it says nothing about what the file holds.`, suggestion: 'Name it for its role (e.g. voice-latency-findings, sheets-client, retry-policy).' };
  }

  const tokens = tokenizeStem(stem);
  for (const token of tokens) {
    if (JUNK_STEMS.has(token)) {
      return { ok: false, reason: `"${base}" contains the placeholder word "${token}" — name the file for what it does.`, suggestion: 'Replace the placeholder token with the file\'s real role.' };
    }
    if (token.length >= 5 && !hasVowel(token) && !KNOWN_ACRONYMS.has(token)) {
      return { ok: false, reason: `"${base}" has a vowelless token "${token}" — looks like a dropped-vowel abbreviation or typo.`, suggestion: 'Spell the word out in full.' };
    }
    if (token.length >= 5 && !COMMON_WORDS.has(token) && !ALLOWED_STEMS.has(token) && !KNOWN_ACRONYMS.has(token)) {
      // Near-miss typo: one edit from a known word but not itself a known word.
      for (const knownWord of COMMON_WORDS) {
        if (Math.abs(knownWord.length - token.length) > 1) continue;
        if (osaDistance(token, knownWord) === 1) {
          return { ok: false, reason: `"${base}" — "${token}" looks like a misspelling of "${knownWord}".`, suggestion: `Did you mean "${knownWord}"?` };
        }
      }
    }
  }
  return { ok: true };
}

function main() {
  if (process.env.FILENAME_GUARD_OVERRIDE === '1') process.exit(0);
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  if ((event.tool_name || '') !== 'Write') process.exit(0);

  const filePath = event.tool_input?.file_path || '';
  if (!filePath) process.exit(0);

  let verdict;
  try { verdict = assessFilename(filePath); } catch { process.exit(0); }   // fail-open
  if (verdict.ok) process.exit(0);

  const reason = `Filename BLOCKED — give it a helpful, correctly-spelled name.

${verdict.reason}
${verdict.suggestion ? `\n${verdict.suggestion}` : ''}

Russell's rule (2026-06-25): a created file's name must be helpful and correctly spelled — a typo or lazy
name ("findigns", "tmp", "output2") is noise the next reader has to decode. Rename and Write again.

Override (rare — a real word wrongly flagged as a typo): set FILENAME_GUARD_OVERRIDE=1 in env.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Only run as a hook when executed directly — importing (from the test) must not read stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
