#!/usr/bin/env node
// =============================================================================
// name-by-use — STOP TYPE-NAMED IDENTIFIERS LIKE `text`, `result`, `data`
// =============================================================================
//
// Russell's rule (verbatim, 2026-05-14):
//
//   Always name variables with the function or use they relate to, not what
//   they literally are. So we should replace `text` with `function-name` or
//   similar. Then everything makes much more sense.
//
// Type-named identifiers (text, list, num, arr, obj, str, val, result, data,
// tmp, item, items) signal NOTHING about what the variable carries.
// Future-Claude reading the line has to scroll up to figure out what `text`
// is. Use-named identifiers (command, open_tasks, approval_count) document
// themselves — the name IS the meaning.
//
// This applies to ALL .clear files (Meph's output + hand-written) and to
// .js / .ts / .py we write here. The hook fires on PreToolUse(Edit|Write)
// and BLOCKS the write when it spots a fresh assignment to a type-named
// variable. Override exists for the rare legitimate cases (loop counter
// `i`, the literal field name in a schema declaration, etc).
//
// Single-letter override: `i`, `j`, `k` are allowed (loop counters).
//
// Bypass: include the literal string `name-by-use-override` in the text,
// or set NAME_BY_USE_OVERRIDE=1 in the env. Use ONLY when the variable
// is genuinely about the type (a schema declaration like `phrase is text`
// where `text` is the TYPE keyword, not an identifier).
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';

// Identifiers that are pure type/role labels and therefore say nothing
// about WHAT the variable carries. Anything in this set used as a fresh
// variable name (the LHS of an assignment, a function parameter name, a
// `let / const / var` binding in JS, a `define X as` in Clear) is a
// violation. Adding to this list is welcome — every entry is a lesson
// somebody learned the hard way.
const BANNED_NAMES = new Set([
  'text', 'string', 'str',
  'number', 'num', 'n',
  'list', 'arr', 'array', 'items',
  'obj', 'object', 'thing',
  'val', 'value', 'v',
  'result', 'response', 'resp', 'r',
  'data', 'datum', 'd',
  'tmp', 'temp', 'foo', 'bar', 'baz',
  'item',
  'output', 'out',
]);

// Single-letter identifiers allowed only as loop counters or short-scope
// indices. Anywhere else they're banned.
const LOOP_COUNTERS = new Set(['i', 'j', 'k']);

// NO CRYPTIC ACRONYMS (Russell, 2026-06-16): "no hhmm — should be hours_minutes
// or something obvious." A vowelless identifier segment (hhmm, btn, idx, ctx,
// mgr, ptr, cfg, hdr, qty, cnt, fn, cb) is a cryptic abbreviation — spell it out.
// EXCEPT the standard tech acronyms below, which ARE the obvious name for the
// thing (no one writes `commaSeparatedValues` instead of `csv`). 'y' counts as a
// vowel so words like `by`/`my` pass; single letters are handled by LOOP_COUNTERS.
const TECH_ACRONYM_ALLOWLIST = new Set([
  'id', 'url', 'uri', 'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'json', 'csv', 'tsv',
  'xml', 'yaml', 'yml', 'md', 'api', 'db', 'sql', 'http', 'https', 'ssl', 'tls',
  'dom', 'cli', 'sdk', 'ui', 'ux', 'io', 'os', 'ms', 'ns', 'px', 'rgb', 'rgba',
  'hsl', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'pdf', 'mp3', 'mp4', 'wav', 'ttl',
  'utc', 'gmt', 'uuid', 'jwt', 'cors', 'mime', 'ascii', 'utf', 'regex', 'regexp',
  'tts', 'stt', 'vad', 'llm', 'ai', 'idb', 'crud', 'mvp', 'faq', 'toc', 'wal',
  'sqlite', 'cpu', 'gpu', 'ram', 'usb', 'ip', 'dns', 'cdn', 'crm', 'ok', 'kv',
]);

const VOWELS = /[aeiouy]/;

// A model-size designator — 7b, 1.5b, 15b, 70b — is a parameter-count suffix that is part of the
// upstream model's LITERAL product name (Qwen2.5-Coder-7B-Instruct, Llama-3-70B), not a cryptic
// abbreviation. Spelling it out ("SEVEN_BILLION") makes identifiers worse and breaks the convention
// every ML repo uses, so it's allowed exactly like `csv`/`url`/`id`. (2026-07-16, marcus exp154)
const MODEL_SIZE_DESIGNATOR = /^\d+(?:_\d+)?b$/i;

/** Is `name` a cryptic vowelless abbreviation (not a standard tech acronym)?
 *  Returns the offending segment to name in the error, or null when it's fine.
 *  Checks the whole token AND each snake_case segment (so hours_hhmm is caught). */
function crypticAbbreviation(name) {
  const lower = name.toLowerCase();
  for (const segment of [lower, ...lower.split('_')]) {
    if (segment.length < 2) continue;            // single letters handled elsewhere
    if (TECH_ACRONYM_ALLOWLIST.has(segment)) continue;
    if (MODEL_SIZE_DESIGNATOR.test(segment)) continue; // 7b/15b/70b — a model's literal name, not cryptic
    if (!VOWELS.test(segment)) return segment;   // no vowel + not a known acronym = cryptic
  }
  return null;
}

// CALL-SITE KWARGS ARE NOT NEW IDENTIFIERS (fix 2026-07-03): a Python line
// like `    cwd=HERE,` inside an unclosed call's parentheses is a keyword
// argument — the CALLEE's API name, not a fresh binding — so it must not be
// flagged (the old line-anchored assignment regex blocked multi-line
// subprocess.run(..., cwd=HERE, text=True) calls). We track bracket depth
// across lines, skipping string literals and comments, so we know whether a
// line starts inside an open (/[/{ group. Multi-line `def` signatures keep
// their parameter checks via the def-signature tracker in findHits.
function scanPythonBrackets(sourceLine, scanState) {
  let position = 0;
  while (position < sourceLine.length) {
    const symbol = sourceLine[position];
    if (scanState.stringMode) {
      if (symbol === '\\') { position += 2; continue; }
      if (sourceLine.startsWith(scanState.stringMode, position)) {
        position += scanState.stringMode.length;
        scanState.stringMode = null;
        continue;
      }
      position += 1;
      continue;
    }
    if (symbol === '#') break; // comment runs to end of line
    if (symbol === "'" || symbol === '"') {
      const tripleQuote = symbol.repeat(3);
      if (sourceLine.startsWith(tripleQuote, position)) {
        scanState.stringMode = tripleQuote;
        position += 3;
      } else {
        scanState.stringMode = symbol;
        position += 1;
      }
      continue;
    }
    if (symbol === '(' || symbol === '[' || symbol === '{') scanState.bracketDepth += 1;
    if (symbol === ')' || symbol === ']' || symbol === '}') scanState.bracketDepth = Math.max(0, scanState.bracketDepth - 1);
    position += 1;
  }
  // Ordinary (non-triple) Python strings cannot span lines.
  if (scanState.stringMode && scanState.stringMode.length === 1) scanState.stringMode = null;
}

// PYTEST BUILT-IN FIXTURES ARE API KEYWORDS (fix 2026-07-04): pytest injects
// fixtures BY PARAMETER NAME — `def test_x(tmp_path)` asks pytest for its
// built-in tmp_path fixture, so the parameter name IS the framework's API;
// renaming it breaks the injection. In test files (test_*.py / *_test.py /
// conftest.py) these names are exempt AS PARAMETERS only. An ordinary
// assignment to one of them (`tmp_path = ...`) is still a lazy name and
// still blocks, as does the same parameter name outside a test file.
const PYTEST_BUILTIN_FIXTURES = new Set([
  'tmp_path', 'tmpdir', 'capsys', 'monkeypatch', 'caplog', 'capfd',
  'tmp_path_factory', 'request', 'pytestconfig',
]);
const PYTEST_FILE_NAME = /(?:^|[\\/])(?:test_[^\\/]*\.py|[^\\/]*_test\.py|conftest\.py)$/i;

const OVERRIDE_PATTERNS = [
  /name-by-use-override/i,
  /NAME_BY_USE_OVERRIDE\s*=\s*1/i,
];

function isOverride(text) {
  if (process.env.NAME_BY_USE_OVERRIDE === '1') return true;
  for (const re of OVERRIDE_PATTERNS) if (re.test(text)) return true;
  return false;
}

/**
 * Scan a chunk of source text for assignments / parameters / bindings
 * to banned identifiers. Returns a list of { line, name, sample, kind }.
 *
 * Cheap line-based regex — won't catch every pattern but catches the
 * common shapes that hurt readability. False positives are rare; false
 * negatives are fine because Meph + Claude both have CLAUDE.md as the
 * authoritative rule.
 */
function findHits(text, filePath) {
  if (!text || typeof text !== 'string') return [];
  if (isOverride(text)) return [];
  const ext = (filePath || '').toLowerCase().split('.').pop();
  const hits = [];
  const lines = text.split('\n');

  // JS / TS bindings: `const X = ...`, `let X = ...`, `var X = ...`,
  // function params `function f(X, Y)`, arrow params `(X, Y) =>`.
  const jsBinding = /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*[=,;]/g;
  const jsParamList = /\b(?:function\s+\w*\s*|=>\s*|\(\s*)\(([^)]*)\)/g;

  // Python bindings: `X = ...`, `def f(X, Y)`, `for X in ...`.
  // The `X = ...` shape only counts at bracket depth 0 — inside an open
  // (/[/{ group a `name=value` line is a call-site keyword argument (the
  // callee's API), not a new identifier. See scanPythonBrackets above.
  const pyBinding = /^\s*([a-zA-Z_][\w]*)\s*=\s*[^=]/;
  const pyDefOpener = /^\s*(?:async\s+)?def\s+\w+\s*\(/;
  const pyLeadingParam = /^\s*\*{0,2}([a-zA-Z_][\w]*)\s*(?:[:=,)]|$)/;
  const pythonScan = { bracketDepth: 0, stringMode: null, insideDefSignature: false };
  const inPytestFile = PYTEST_FILE_NAME.test(filePath || '');
  const isInjectedFixtureParam = (param) => inPytestFile && PYTEST_BUILTIN_FIXTURES.has(param);
  const pyDefParams = /\bdef\s+\w+\s*\(([^)]*)\)/g;
  const pyForLoop = /\bfor\s+([a-zA-Z_][\w]*)\s+in\b/;

  // Clear assignments: `define X as ...`, `X = look up ...`, `X = something`,
  // `function NAME receiving X:`. Schema declarations (`field is text`,
  // `phrase is text`) are EXEMPT — `text` is the type keyword, not an
  // identifier being bound.
  const clearDefine = /^\s*define\s+([a-zA-Z_][\w]*)\s+as\b/;
  const clearAssign = /^\s*([a-zA-Z_][\w]*)\s*=\s*\S/;
  const clearReceiving = /\breceiving\s+([a-zA-Z_][\w]*)\b/g;

  const flag = (line, name, sample, kind) => {
    if (LOOP_COUNTERS.has(name)) return;
    if (BANNED_NAMES.has(name.toLowerCase())) {
      hits.push({ line, name, sample: sample.slice(0, 120), kind, why: 'type-named' });
      return;
    }
    const cryptic = crypticAbbreviation(name);
    if (cryptic) {
      hits.push({ line, name, sample: sample.slice(0, 120), kind, why: 'acronym', cryptic });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const lineNo = i + 1;

    // Clear-specific: schema declarations end with ` is <type>`. Skip them.
    const isSchemaLine = /\bis\s+(?:text|number|boolean|timestamp|list|json)\b/.test(ln);

    if (ext === 'clear' || ext === '.clear') {
      if (isSchemaLine) continue;
      let m;
      m = ln.match(clearDefine);
      if (m) flag(lineNo, m[1], ln.trim(), 'clear-define');
      m = ln.match(clearAssign);
      if (m && !isSchemaLine && !/^\s*\/\//.test(ln) && !/^\s*#/.test(ln)) flag(lineNo, m[1], ln.trim(), 'clear-assign');
      while ((m = clearReceiving.exec(ln)) !== null) {
        flag(lineNo, m[1], ln.trim(), 'clear-receiving');
      }
      clearReceiving.lastIndex = 0;
      continue;
    }

    if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'ts') {
      let m;
      while ((m = jsBinding.exec(ln)) !== null) {
        flag(lineNo, m[1], ln.trim(), 'js-binding');
      }
      jsBinding.lastIndex = 0;
      while ((m = jsParamList.exec(ln)) !== null) {
        for (const raw of m[1].split(',')) {
          const param = raw.trim().split(/[=:\s]/)[0];
          if (param && /^[a-zA-Z_$][\w$]*$/.test(param)) {
            flag(lineNo, param, ln.trim(), 'js-param');
          }
        }
      }
      jsParamList.lastIndex = 0;
      continue;
    }

    if (ext === 'py') {
      const lineStartDepth = pythonScan.bracketDepth;
      const lineStartsInsideString = pythonScan.stringMode !== null;
      const continuesDefSignature = pythonScan.insideDefSignature;
      if (!lineStartsInsideString && pyDefOpener.test(ln)) pythonScan.insideDefSignature = true;
      scanPythonBrackets(ln, pythonScan);
      if (pythonScan.bracketDepth === 0) pythonScan.insideDefSignature = false;
      if (lineStartsInsideString) continue; // inside a triple-quoted string: no bindings here

      let m;
      if (lineStartDepth === 0) {
        m = ln.match(pyBinding);
        if (m) flag(lineNo, m[1], ln.trim(), 'py-binding');
      } else if (continuesDefSignature) {
        // Continuation line of a multi-line def signature: the leading name
        // IS a fresh parameter identifier — still subject to the rule.
        m = ln.match(pyLeadingParam);
        if (m && m[1] !== 'self' && m[1] !== 'cls' && !isInjectedFixtureParam(m[1])) flag(lineNo, m[1], ln.trim(), 'py-param');
      }
      // lineStartDepth > 0 outside a def signature = call-site kwargs /
      // collection literals: names there belong to the callee's API. Exempt.
      while ((m = pyDefParams.exec(ln)) !== null) {
        for (const raw of m[1].split(',')) {
          const param = raw.trim().split(/[=:\s]/)[0];
          if (param && /^[a-zA-Z_][\w]*$/.test(param) && param !== 'self' && param !== 'cls' && !isInjectedFixtureParam(param)) {
            flag(lineNo, param, ln.trim(), 'py-param');
          }
        }
      }
      pyDefParams.lastIndex = 0;
      m = ln.match(pyForLoop);
      if (m) flag(lineNo, m[1], ln.trim(), 'py-for');
    }
  }

  return hits;
}

function excoriation(hits, filePath) {
  const top = hits.slice(0, 5);
  const list = top
    .map((h) => `  - line ${h.line}: \`${h.name}\` (${h.why === 'acronym' ? `cryptic acronym "${h.cryptic}" — spell it out` : `type-named, kind: ${h.kind}`})\n    ${h.sample}`)
    .join('\n');
  const more = hits.length > 5 ? `\n  ...and ${hits.length - 5} more.` : '';
  return `STOP. Name-by-use violation.

You're about to introduce type-named identifiers in ${filePath || 'this file'}:

${list}${more}

Russell's rule (verbatim 2026-05-14):

  Always name variables with the function or use they relate to, not what
  they literally are. So we should replace \`text\` with \`function-name\`
  or similar. Then everything makes much more sense.

The names you used say nothing about what the variable carries. Future
readers (Meph, Russell, future-you) have to scroll up to figure out what
\`text\` is. Rename by USE, not by TYPE.

Translation table for the common offenders:

| Banned (says type) | Use instead (says role)                                  |
|--------------------|----------------------------------------------------------|
| \`text\`             | \`command\`, \`user_message\`, \`question\`, \`address\`           |
| \`list\`             | \`open_tasks\`, \`recent_logs\`, \`matching_rows\`             |
| \`num\` / \`number\`   | \`age\`, \`price\`, \`approval_count\`, \`quantity\`             |
| \`result\`           | \`open_notepad_response\`, \`grade\`, \`approved_deal\`        |
| \`data\`             | \`incoming_signup\`, \`raw_payload\`, \`stripe_event\`         |
| \`obj\`              | \`current_user\`, \`selected_record\`, \`pending_approval\`    |
| \`val\` / \`value\`    | \`new_threshold\`, \`chosen_color\`, \`refund_amount\`         |
| \`tmp\` / \`temp\`     | \`draft_caption\`, \`partial_summary\`                       |
| \`item\` / \`items\`   | \`approved_deal\`, \`approved_deals\`, \`shipped_orders\`      |

Single-letter loop counters (\`i\`, \`j\`, \`k\`) are fine for loops only.

NO CRYPTIC ACRONYMS (Russell, 2026-06-16): a vowelless abbreviation like
\`hhmm\`, \`btn\`, \`idx\`, \`ctx\`, \`mgr\`, \`ptr\`, \`cfg\` must be spelled out —
\`hours_minutes\`, \`button\`, \`index\`, \`context\`, \`manager\`, \`pointer\`, \`config\`.
Standard tech acronyms (url, csv, html, id, json, api, db…) are fine — they
ARE the obvious name for the thing.

Override (rare): include \`name-by-use-override\` in the text or set
NAME_BY_USE_OVERRIDE=1. Only when the identifier truly IS about its type
(a schema keyword, a literal type marker). Never to dodge the rule.

Rewrite with names that describe the role.`;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') {
    process.exit(0);
    return;
  }
  const toolName = event.tool_name || '';
  if (toolName !== 'Edit' && toolName !== 'Write') {
    process.exit(0);
    return;
  }
  const input = event.tool_input || {};
  const filePath = input.file_path || '';
  // Skip non-code files entirely.
  const ext = filePath.toLowerCase().split('.').pop();
  if (!['clear', 'js', 'mjs', 'cjs', 'ts', 'py'].includes(ext)) {
    process.exit(0);
    return;
  }
  const text = input.new_string || input.content || '';
  if (!text) {
    process.exit(0);
    return;
  }
  const hits = findHits(text, filePath);
  if (hits.length === 0) {
    process.exit(0);
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: excoriation(hits, filePath),
      },
    })
  );
  process.exit(0);
}

main();
