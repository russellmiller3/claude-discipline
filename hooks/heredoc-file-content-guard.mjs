#!/usr/bin/env node
// =============================================================================
// HEREDOC-FILE-CONTENT-GUARD — PreToolUse(Bash): build file CONTENT with the
//   Write tool, never a Bash heredoc redirected to a file.
// =============================================================================
//
// new-hook-category: Shell-safety / file-content creation — nearest existing is long-running-script-guard (it has a stripHeredocBodies parser) but that guard's IDEA is "long jobs must be chunked/resumable"; it never steers file creation anywhere. This is a distinct idea: quote-heavy heredoc bodies mis-parse in the Bash tool, so file content belongs in the encoding-safe Write tool.
//
// The bug (2026-07-18, Macher MemphisLanding.svelte): `head -n N f > tmp && cat >> tmp <<'STYLE'
// …css with 'quotes' and "fonts" and $( ) and &&… STYLE && cp tmp f` died with
// `bash: -c: unexpected EOF while looking for matching '` — the tool's command layer
// mis-parses a multi-line heredoc whose body carries single quotes, so the WHOLE command
// fails and the file is left untouched (a wasted round-trip). Same family as the standing
// rule "never `node -e` for multi-line code — write a temp `.mjs`".
//
// RULE: file CONTENT (code/CSS/HTML/JSON/markdown) must be created/replaced with the Write
// tool. Heredocs are fine ONLY for small quote-free bodies piped to a program's STDIN
// (`git commit -F- <<MSG`, `python <<PY`). Escape: HEREDOC_OK anywhere in the command.
//
// Teeth: permissionDecision 'deny'. Fail-open on any error.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_RE = /\bHEREDOC_OK\b/;
// A heredoc opener whose redirect target is a FILE: `> file <<TAG`, `>> file <<TAG`, `cat > f <<TAG`,
// `tee f <<TAG` (with -a). Captures the delimiter. A program-stdin heredoc (`python <<PY`, `psql <<SQL`,
// `git commit -F- <<MSG`) has NO `>`/`tee` before `<<`, so it does not match — exactly the allow case.
const HEREDOC_TO_FILE_RE = /(?:>>?\s*[^\s<>|&]+|(?:^|\s)tee\s+(?:-a\s+)?[^\s<>|&]+)\s*<<-?\s*(['"]?)([A-Za-z_]\w*)\1/;

function escapeForRegExp(rawText) {
  return String(rawText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A heredoc body "looks like content" (not a trivial config value): it carries a quote or code/markup
// punctuation, OR it spans 3+ lines. A one-line quote-free body to a file is allowed.
function bodyLooksLikeContent(body) {
  const bodyText = String(body || '');
  if (/['"{};]|<\/|\/>/.test(bodyText)) return true;
  return bodyText.split(/\r?\n/).filter((line) => line.trim() !== '').length >= 3;
}

// Pure detector. True when the command writes a code/markup heredoc body to a FILE.
export function flagsHeredocFileWrite(command) {
  const commandText = String(command || '');
  if (OVERRIDE_RE.test(commandText)) return false;
  const fileHeredoc = commandText.match(HEREDOC_TO_FILE_RE);
  if (!fileHeredoc) return false;
  const delimiter = fileHeredoc[2];
  // Extract that heredoc's body: from the opener line through the closing delimiter line.
  const bodyMatch = commandText.match(
    new RegExp(`<<-?\\s*['"]?${escapeForRegExp(delimiter)}['"]?[^\\n]*\\n([\\s\\S]*?)\\n[ \\t]*${escapeForRegExp(delimiter)}[ \\t]*(?:\\n|$)`),
  );
  // If the closing delimiter isn't found (unterminated in the command text), treat a quote-carrying
  // opener region as content too — the unterminated-quote parse failure is the exact bug we prevent.
  if (!bodyMatch) return /['"{}]/.test(commandText.slice(fileHeredoc.index));
  return bodyLooksLikeContent(bodyMatch[1]);
}

const DENY_REASON = `Build file content with the Write tool, not a Bash heredoc.

A quote-heavy heredoc body (CSS/HTML/JS with 'single' or "double" quotes, \`$( )\`, \`&&\`) mis-parses in the Bash tool — the WHOLE command fails ("unexpected EOF while looking for matching '") and the file is left untouched, wasting the call. The Write tool is encoding- and quote-safe.

Do this instead:
  - Create/replace the file (or just the block) with the Write tool.
  - If you're keeping part of the original, splice with a trivial quote-free \`head\`/\`cat\` afterward.

Heredocs are fine for SMALL, quote-free bodies piped to a program's STDIN (e.g. \`git commit -F- <<'MSG'\`).
Override (rare legit file-content heredoc): put HEREDOC_OK anywhere in the command.`;

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  if ((event.tool_name || '') !== 'Bash') process.exit(0);

  const command = event.tool_input?.command || '';
  let flagged;
  try { flagged = flagsHeredocFileWrite(command); } catch { process.exit(0); } // fail-open
  if (!flagged) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    },
  }));
  process.exit(0);
}

// Entry-point guard by BASENAME (the Windows import.meta gotcha) so tests import the pure detector.
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
