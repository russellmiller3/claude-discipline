#!/usr/bin/env node
// require-langdocs-read.mjs — PreToolUse on Edit/Write/MultiEdit
//
// Russell's rule "Read The Language Docs Before Writing In It" (2026-05-15):
// Before editing a file in a target language or DSL, the SESSION must have
// already Read that language's teaching docs, conventions, reference docs,
// capability map, and FAQ as configured by the project.
//
// Generic by default. Project-tuned via <project>/.claude/langdocs.json:
//   {
//     ".clear": [
//       "C:/Users/rmill/Desktop/programming/clear/USER-GUIDE.md",
//       "C:/Users/rmill/Desktop/programming/clear/AI-INSTRUCTIONS.md",
//       "C:/Users/rmill/Desktop/programming/clear/SYNTAX.md",
//       "C:/Users/rmill/Desktop/programming/clear/FEATURES.md",
//       "C:/Users/rmill/Desktop/programming/clear/FAQ.md"
//     ],
//     ".rs": ["<path-to-rust-book-section>"]
//   }
//
// Hook reads session transcript (passed via $CLAUDE_TRANSCRIPT_PATH or fallback)
// and confirms each required doc was Read this session. If not, BLOCKS.
//
// Override: LANGDOCS_OVERRIDE=1 in env. Use only for trivial edits where
// no native primitive is in play.

import fs from 'node:fs';
import path from 'node:path';

const READ_BUF = process.stdin.fd;
let stdin = '';
try { stdin = fs.readFileSync(READ_BUF, 'utf8'); } catch {}

let payload;
try { payload = JSON.parse(stdin || '{}'); } catch { process.exit(0); }

if (process.env.LANGDOCS_OVERRIDE === '1') process.exit(0);

const toolName = payload.tool_name || '';
if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) process.exit(0);

const filePath = payload.tool_input?.file_path || '';
if (!filePath) process.exit(0);

// ── GENERIC external-API-docs gate (every project, NO config, NO per-API allowlist) ────────────────
// Editing code that integrates an external API you can't unit-test locally (HTTP API, realtime/WebRTC/
// WebSocket, an SDK) requires having READ that API's docs THIS SESSION and auditing the whole protocol
// in one pass. Russell's rule (2026-06-20, the OpenAI Realtime saga: ~2h lost patching one server error
// at a time — voice field → top-level override → session.type → response overlap — every one in the
// docs). Fires on the API SIGNALS in the code, so it catches the NEXT unknown API automatically.
(function genericApiDocsGate() {
  if (/\.(test|spec)\./i.test(filePath)) return; // editing a test, not integrating
  if (/\.(md|txt|rst)$/i.test(filePath)) return; // docs MENTION APIs; they don't integrate them
  const editText = [
    payload.tool_input?.content,
    payload.tool_input?.new_string,
    payload.tool_input?.old_string,
    JSON.stringify(payload.tool_input?.edits || ''),
  ].filter(Boolean).join('\n');
  if (process.env.API_DOCS_OVERRIDE === '1') return;         // env override

  let fileText = '';
  try { fileText = fs.readFileSync(filePath, 'utf8'); } catch { /* new file — use edit text only */ }
  const haystack = `${fileText}\n${editText}`;
  // Sticky per-file override: once a file has justified itself (the token
  // landed in it from ANY accepted edit), later edits to that SAME file
  // don't need to repeat the token in every diff — it's already sitting in
  // the file on disk. A brand-new file/new API domain still needs a fresh
  // token in its own edit text, since fileText is empty until the first
  // Write lands. (Fix 2026-07-15: previously only checked editText, so a
  // file that already had the token was still re-blocked on every
  // subsequent edit whose diff didn't itself repeat it.)
  if (/api-docs-read\s*:/i.test(haystack)) return;

  const API_SIGNAL_RE = new RegExp([
    'new\\s+RTCPeerConnection', 'RTCPeerConnection\\s*\\(',
    'new\\s+WebSocket', 'WebSocket\\s*\\(', 'new\\s+EventSource',
    // "api" must be its OWN word in the host ("api.", "-api.", "api-"), NOT a substring — bare
    // /api/ false-positived on fonts.googleapis.com (a static <link> in marcus.html, 2026-07-01).
    'https?://[a-z0-9.-]*\\bapi\\b[a-z0-9.-]*\\.[a-z]',
    'https?://[a-z0-9.-]+/v\\d',                       // a versioned API path
    '/v\\d+/(realtime|chat|completions|responses|messages|audio|embeddings|images|models)\\b',
    "from\\s+['\"](openai|@anthropic|@anthropic-ai|stripe|twilio|googleapis|@google-cloud|@aws-sdk|cohere|replicate|@deepgram|elevenlabs)",
    'api\\.(openai|anthropic|stripe|twilio|deepgram|elevenlabs)\\.com',
  ].join('|'), 'i');
  if (!API_SIGNAL_RE.test(haystack)) return; // not external-API code

  const transcriptPath = payload.transcript_path || process.env.CLAUDE_TRANSCRIPT_PATH || '';
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return; // can't verify → fail open
  let transcript = '';
  try { transcript = fs.readFileSync(transcriptPath, 'utf8'); } catch { return; }
  if (/"name"\s*:\s*"(WebFetch|WebSearch)"/.test(transcript)) return; // docs were fetched this session

  process.stderr.write(`BLOCKED — external-API code, but no API docs were read this session.

You're about to ${toolName} ${path.basename(filePath)}, which integrates an external API (HTTP / realtime
/ socket / SDK). Russell's rule (2026-06-20): READ that API's official docs and audit the WHOLE protocol
in ONE pass BEFORE editing — don't patch one server error at a time across many reload-test rounds. The
OpenAI Realtime saga cost ~2 hours exactly this way (voice field → top-level override → session.type →
response overlap — every one was in the docs).

Do this first: WebFetch/WebSearch the API's official docs — auth, the full request/response shape, the
event/streaming lifecycle, and error formats — then re-try the edit.

Override (rare — a trivial edit with no protocol surface, e.g. a comment/rename):
  - put the literal token  api-docs-read: <why>  in the edit, or
  - set API_DOCS_OVERRIDE=1 in env.\n`);
  process.exit(2);
})();

const ext = path.extname(filePath).toLowerCase();
if (!ext) process.exit(0);

// Walk up from filePath looking for .claude/langdocs.json
function findLangdocsConfig(startPath) {
  let cur = path.dirname(startPath);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, '.claude', 'langdocs.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

const configPath = findLangdocsConfig(filePath);
if (!configPath) process.exit(0); // no config → no enforcement

let config;
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
catch { process.exit(0); }

const requiredDocs = config[ext];
if (!Array.isArray(requiredDocs) || requiredDocs.length === 0) process.exit(0);

// Determine session transcript path
const transcriptPath = payload.transcript_path
  || process.env.CLAUDE_TRANSCRIPT_PATH
  || '';

if (!transcriptPath || !fs.existsSync(transcriptPath)) {
  // Can't verify session state — fail open with a soft note in stderr
  process.stderr.write('require-langdocs: transcript not found, skipping enforcement\n');
  process.exit(0);
}

let transcriptText;
try { transcriptText = fs.readFileSync(transcriptPath, 'utf8'); }
catch { process.exit(0); }

// Check each required doc — look for Read tool calls on that path this session
function normalizePath(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

const missingDocs = [];
for (const docPath of requiredDocs) {
  const needle = normalizePath(docPath);
  const haystack = normalizePath(transcriptText);
  if (!haystack.includes(needle)) {
    missingDocs.push(docPath);
  }
}

if (missingDocs.length === 0) process.exit(0);

function describeDocRole(docPath) {
  const docName = path.basename(docPath).toUpperCase();
  if (docName === 'USER-GUIDE.MD') {
    return 'USER-GUIDE.md teaches the mental model and why the language works this way.';
  }
  if (docName === 'AI-INSTRUCTIONS.MD') {
    return 'AI-INSTRUCTIONS.md is the writing-conventions manual for agents.';
  }
  if (docName === 'SYNTAX.MD') {
    return 'SYNTAX.md is the exact grammar and canonical-example reference.';
  }
  if (docName === 'FEATURES.MD') {
    return 'FEATURES.md is the capability map: check what already exists before building.';
  }
  if (docName === 'FAQ.MD') {
    return 'FAQ.md is the where/how/why map and the gotcha index.';
  }
  return `${path.basename(docPath)} is required by this project's language-doc gate.`;
}

const docRoleLines = requiredDocs.map(docPath => `  - ${describeDocRole(docPath)}`);

// BLOCK with the message
const msg = `BLOCKED — language docs not read this session.

You're about to ${toolName} a ${ext} file but haven't read this language's reference docs yet:

${missingDocs.map(d => `  - ${d}`).join('\n')}

Doc roles:
${docRoleLines.join('\n')}

Russell's rule "Read The Language Docs Before Writing In It" (2026-05-15):
Reading project source files that USE the language is NOT a substitute for
reading the language's own learning guide, writing conventions, syntax
reference, capability map, and FAQ. The most expensive class of mistake is
hand-rolling primitives the language already provides.

Before this edit:
  1. Read each missing doc above.
  2. Grep for the primitive you're about to write — chances are it exists.
     Common offenders: substring, length, trim, fuzzy match, datetime,
     about-clause, regex-with-remainder, text-routing dispatcher, list
     column type, with-rows inline seed.
  3. If the primitive exists, USE IT. If you genuinely need to extend
     it, return here.

Override (rare, trivial edits only): LANGDOCS_OVERRIDE=1 in env.
`;

process.stderr.write(msg);
process.exit(2);
