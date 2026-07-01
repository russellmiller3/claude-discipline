#!/usr/bin/env node
/**
 * PreToolUse hook — block Python escape-sequence corruption.
 *
 * Python silently interprets \v (0x0B), \b (0x08), \f (0x0C), \a (0x07)
 * in regular string/bytes literals — but NOT in raw strings (r'...').
 * This has corrupted launch-cast.ps1 TWICE by turning \v1.0 into a VT byte.
 *
 * Fires on:
 *   - Bash commands that invoke python / python3 inline (-c) or as a script
 *   - Write / Edit tool calls writing .py files
 *
 * Denies when any of \v \b \f \a appear outside a raw string prefix.
 *
 * Fix: use raw strings or escaped bytes:
 *   BAD:  content.replace('\v1.0', ...)       # \v = VT byte 0x0B
 *   GOOD: content.replace(r'\v1.0', ...)      # raw string, literal backslash
 *   GOOD: content.replace(b'\\v1.0', ...)     # byte literal, double-escaped
 */

import { readFileSync } from 'node:fs';

// Strip raw-string literals so r'\v' doesn't false-positive.
// Handles: r'...', r"...", rb'...', rb"...", br'...', br"...", and triple-quoted variants.
function stripRawStrings(pythonSource) {
  const rawPrefix = String.raw`(?:r[b]?|[b]r)\s*`;
  let stripped = pythonSource;
  // Triple-quoted first (greedy inner match avoids runaway)
  stripped = stripped.replace(new RegExp(rawPrefix + '"""[\\s\\S]*?"""', 'g'), '""');
  stripped = stripped.replace(new RegExp(rawPrefix + "'''[\\s\\S]*?'''", 'g'), "''");
  // Single-quoted
  stripped = stripped.replace(new RegExp(rawPrefix + '"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"', 'g'), '""');
  stripped = stripped.replace(new RegExp(rawPrefix + "'[^'\\\\]*(?:\\\\.[^'\\\\]*)*'", 'g'), "''");
  return stripped;
}

// Dangerous escape sequences (backslash + letter) in Python string literals.
// Each entry: [regexStr to find it, human label, hex value]
const DANGERS = [
  [String.raw`(?<!\\)\\v`, '\\v', '0x0B vertical tab'],
  [String.raw`(?<!\\)\\b`, '\\b', '0x08 backspace'],
  [String.raw`(?<!\\)\\f`, '\\f', '0x0C form feed'],
  [String.raw`(?<!\\)\\a`, '\\a', '0x07 bell'],
];

function findDangers(pythonSource) {
  const withoutRawStrings = stripRawStrings(pythonSource);
  const hits = [];
  for (const [pat, label, hex] of DANGERS) {
    const re = new RegExp(pat, 'g');
    let m;
    while ((m = re.exec(withoutRawStrings)) !== null) {
      const start = Math.max(0, m.index - 25);
      const end = Math.min(withoutRawStrings.length, m.index + 25);
      const ctx = withoutRawStrings.slice(start, end).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      hits.push({ label, hex, ctx });
      if (hits.length >= 5) return hits;
    }
  }
  return hits;
}

// Pull the quoted payload of python's inline-code flags (-c/-e/-p) out of a bash command.
// Only these hold actual Python string literals; bare path args do not.
function extractInlinePythonCode(bashCommand) {
  if (!/\bpython3?(?:\d)?(?:\.exe)?\s+(?:-[a-z]+\s+)*-[cep]\b/.test(bashCommand)) return '';
  const payloads = [...bashCommand.matchAll(/\s-[cep]\s+("(?:\\.|[^"\\])*"|'(?:[^'\\]|\\.)*'|\S+)/g)];
  return payloads.map((payload) => payload[1]).join('\n');
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  const tool = event.tool_name || '';
  const input = event.tool_input || {};
  let codeToScan = '';

  if (tool === 'Bash') {
    const bashCommand = input.command || '';
    // ONLY scan inline python code (-c/-e/-p payloads). A path ARGUMENT like
    // `python "C:\Users\...\validate.py"` holds \v as a Windows separator, NOT a Python escape —
    // scanning the whole command false-fired on every backslash path (2026-07-01). A real
    // Python string literal with \v only lives in inline code.
    codeToScan = extractInlinePythonCode(bashCommand);
    if (!codeToScan) process.exit(0);
  } else if (tool === 'Write' || tool === 'Edit') {
    const filePath = (input.file_path || '').replace(/\\/g, '/');
    if (!filePath.endsWith('.py')) process.exit(0);
    codeToScan = tool === 'Write' ? (input.content || '') : (input.new_string || '');
  } else {
    process.exit(0);
  }

  if (!codeToScan) process.exit(0);

  const hits = findDangers(codeToScan);
  if (hits.length === 0) process.exit(0);

  const escList = [...new Set(hits.map(h => `${h.label} (${h.hex})`))]
    .join(', ');
  const ctxLines = hits
    .map(h => `    ...${h.ctx}...`)
    .join('\n');

  const reason = [
    'Python escape-sequence corruption — STOP.',
    '',
    `Dangerous escape sequences found: ${escList}`,
    '',
    'Context:',
    ctxLines,
    '',
    'In Python, \\v = 0x0B (vertical tab), \\b = 0x08 (backspace),',
    '\\f = 0x0C (form feed), \\a = 0x07 (bell).',
    'These silently corrupt file content when used in .replace() or file writes.',
    'This bug destroyed launch-cast.ps1 TWICE.',
    '',
    'Fix — use raw strings or escaped byte literals:',
    "  BAD:  content.replace('\\v1.0', ...)       # \\v = VT byte",
    "  GOOD: content.replace(r'\\v1.0', ...)      # raw string, literal backslash",
    "  GOOD: content.replace(b'\\\\v1.0', ...)    # bytes, double-escaped",
    '',
    'If this is an intentional escape (not a file-path patch), say:',
    '"python-escape-guard override: [reason]" and retry.',
  ].join('\n');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    }
  }));
  process.exit(0);
}

try { main(); } catch { process.exit(0); }
