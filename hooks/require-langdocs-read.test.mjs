#!/usr/bin/env node
// require-langdocs-read.test.mjs — locks the GENERIC external-API-docs gate (the second branch added
// 2026-06-20). Editing code with external-API signals must be preceded by a WebFetch/WebSearch this
// session, or the hook BLOCKS (exit 2). No per-API config — it fires on signals in the code.
//
// Run: node require-langdocs-read.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'require-langdocs-read.mjs');

const failures = [];
const check = (label, condition) => { if (condition) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };
const cleanups = [];

function workspace() {
  const workDirectory = mkdtempSync(join(tmpdir(), 'apidocs-'));
  cleanups.push(workDirectory);
  return workDirectory;
}

// A transcript that did / didn't fetch docs (WebFetch tool_use) this session.
function transcriptFile(workDirectory, { fetchedDocs }) {
  const transcriptPath = join(workDirectory, 'transcript.jsonl');
  const lines = [JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'fix the voice' }] })];
  lines.push(fetchedDocs
    ? JSON.stringify({ role: 'assistant', content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://developers.openai.com/docs/realtime' } }] })
    : JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'editing without reading docs' }] }));
  writeFileSync(transcriptPath, lines.join('\n'));
  return transcriptPath;
}

// Returns true if the hook BLOCKED (exit 2).
function blocked({ targetFile, transcriptPath, newString = 'x = 1;' }) {
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: targetFile, new_string: newString, old_string: 'old' },
      transcript_path: transcriptPath,
    }),
    encoding: 'utf8',
  });
  return proc.status === 2;
}

const work = workspace();

// An external-API integration file (real signal: api.openai.com + /v1/realtime).
const apiFile = join(work, 'realtimeVoiceSession.js');
writeFileSync(apiFile, "const url = 'https://api.openai.com/v1/realtime/calls'; new RTCPeerConnection();");

// A plain file with no API signals.
const plainFile = join(work, 'formatDate.js');
writeFileSync(plainFile, 'export const formatDate = (d) => String(d);');

// A test file that mentions API signals but is a test (should be skipped).
const apiTestFile = join(work, 'realtimeVoiceSession.test.js');
writeFileSync(apiTestFile, "const url = 'https://api.openai.com/v1/realtime';");

// BLOCK: external-API code, no docs fetched this session.
check('API code + docs unread → blocked',
  blocked({ targetFile: apiFile, transcriptPath: transcriptFile(work, { fetchedDocs: false }) }) === true);

// ALLOW: docs were fetched this session.
check('API code + docs fetched (WebFetch) → allowed',
  blocked({ targetFile: apiFile, transcriptPath: transcriptFile(work, { fetchedDocs: true }) }) === false);

// ALLOW: no API signals in the code.
check('plain file → allowed',
  blocked({ targetFile: plainFile, transcriptPath: transcriptFile(work, { fetchedDocs: false }) }) === false);

// ALLOW: a .test. file is skipped even with API signals.
check('API .test. file → allowed (skipped)',
  blocked({ targetFile: apiTestFile, transcriptPath: transcriptFile(work, { fetchedDocs: false }) }) === false);

// ALLOW: the api-docs-read override token in the edit.
check('API code + api-docs-read override → allowed',
  blocked({ targetFile: apiFile, transcriptPath: transcriptFile(work, { fetchedDocs: false }), newString: '// api-docs-read: trivial rename' }) === false);

// Sticky per-file override (fix 2026-07-15): once the token has landed IN the file from an
// earlier accepted edit, a LATER edit to that SAME file whose own diff does not repeat the
// token must still be allowed — the hook checks fileText, not just this edit's new_string.
const alreadyJustifiedFile = join(work, 'alreadyJustified.js');
writeFileSync(
  alreadyJustifiedFile,
  "// api-docs-read: verified against the live API earlier this session\n" +
  "const url = 'https://api.openai.com/v1/realtime/calls'; new RTCPeerConnection();",
);
check('second edit to an already-justified file, token NOT repeated in this diff → allowed',
  blocked({
    targetFile: alreadyJustifiedFile,
    transcriptPath: transcriptFile(work, { fetchedDocs: false }),
    newString: 'const timeoutMs = 30000; // unrelated follow-up edit',
  }) === false);

// BLOCK still works: a DIFFERENT new file with API signals, no token anywhere, is unaffected
// by the sticky check above (scope containment — the fix must not leak across files).
const stillUnjustifiedFile = join(work, 'stillUnjustified.js');
writeFileSync(stillUnjustifiedFile, "const url = 'https://api.stripe.com/v1/charges';");
check('a different new API file with no token anywhere → still blocked',
  blocked({
    targetFile: stillUnjustifiedFile,
    transcriptPath: transcriptFile(work, { fetchedDocs: false }),
  }) === true);

// ALLOW: a static HTML page whose only "API-ish" string is a Google Fonts stylesheet link.
// (Regression: bare /api/ matched the "api" inside "googleapis" and blocked marcus.html, 2026-07-01.)
const staticHtmlFile = join(work, 'explainer.html');
writeFileSync(staticHtmlFile, '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans" rel="stylesheet">');
check('static HTML + fonts.googleapis.com link → allowed (no false positive)',
  blocked({ targetFile: staticHtmlFile, transcriptPath: transcriptFile(work, { fetchedDocs: false }) }) === false);

// BLOCK still works: a REAL api.* host in HTML inline script is still caught.
const htmlWithApiFile = join(work, 'widget.html');
writeFileSync(htmlWithApiFile, "<script>fetch('https://api.openai.com/v1/responses')</script>");
check('HTML with real api.* fetch → still blocked',
  blocked({ targetFile: htmlWithApiFile, transcriptPath: transcriptFile(work, { fetchedDocs: false }) }) === true);

// ALLOW: markdown docs that MENTION an API host are not integrations.
const docsFile = join(work, 'NOTES.md');
writeFileSync(docsFile, 'We call https://api.openai.com/v1/messages from the server.');
check('markdown mentioning an API host → allowed (docs skip)',
  blocked({ targetFile: docsFile, transcriptPath: transcriptFile(work, { fetchedDocs: false }) }) === false);

for (const path of cleanups) { try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ } }

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll require-langdocs-read (generic API gate) checks passed.');
