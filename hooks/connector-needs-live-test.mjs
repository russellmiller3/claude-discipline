#!/usr/bin/env node
// =============================================================================
// CONNECTOR-NEEDS-LIVE-TEST — a Stop gate: a new/changed external-connector client
// under src/lib/server/** must have a LIVE round-trip test, or block.
// =============================================================================
//
// new-hook-category: Test discipline (external-contract coverage). Nearest existing hook is the
// learnings/test family, but none check that a connector client is backed by a real round-trip test —
// this is the mechanical form of the "mocks cover the gateway, live tests cover the contract" rule.
//
// THE MISTAKE (Macher, 2026-07-18): every shopping unit test passed for MONTHS with injected fakes,
// while Zinc's real /search 402'd on every production call. A connector's mock proves your branching;
// only a live test proves the provider still accepts your request. This is one shadow of the distilled
// "the proxy lies" meta-lesson (~/.claude/learnings.md).
//
// THE RULE: if this SESSION wrote/edited a connector client (a file under src/lib/server/** that talks
// to an external API) and NO *.live.test.ts references it, BLOCK at Stop until one exists (or is waived).
//
// TEETH: Stop decision 'block'. FAILS OPEN. basename entry-guard. No-ops in any repo without src/lib/server.
// Escape: the token `no-live-test-needed` in the reply (a genuinely pure/no-network module).
// =============================================================================

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join as joinPath, basename, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, contentBlocks } from './lib/transcript.mjs';

const WAIVE_TOKEN = /\bno-live-test-needed\b/;
const CONNECTOR_DIR_RE = /src[\\/]lib[\\/]server[\\/]/;
const NON_SOURCE_RE = /\.(test|spec|live\.test)\.[cm]?[jt]sx?$|\.d\.ts$/;
const SOURCE_RE = /\.[cm]?[jt]sx?$/;
// An external API call — a hardcoded https provider host or a fetch to one. Local/relative fetches don't match.
const EXTERNAL_API_RE = /https:\/\/(?:[a-z0-9-]+\.)*(?:retellai|zinc|zincapi|googleapis|openai|stripe|twilio|supabase|parallel|anthropic)\.com|fetch\(\s*[`"']https:\/\//i;

/** PURE decision core — given the connector clients touched this session and every live test's referenced
 *  basenames, return the connector files that have NO live test. Testable with plain arrays. */
export function connectorsMissingLiveTest(touchedConnectorFiles, liveTestReferencedBasenames) {
  const referenced = new Set(liveTestReferencedBasenames.map((name) => name.replace(/\.[cm]?[jt]sx?$/, '')));
  const missing = [];
  for (const filePath of touchedConnectorFiles) {
    const stem = basename(filePath).replace(/\.[cm]?[jt]sx?$/, '');
    if (!referenced.has(stem)) missing.push(filePath);
  }
  return missing;
}

/** Does this file's content look like an external-connector client? (hardcoded provider host / https fetch) */
export function looksLikeConnectorClient(fileText) {
  return typeof fileText === 'string' && EXTERNAL_API_RE.test(fileText);
}

function listFilesRecursive(rootDirectory, matcher, matchingPaths = [], depth = 0) {
  if (depth > 8 || !existsSync(rootDirectory)) return matchingPaths;
  let entries = [];
  try { entries = readdirSync(rootDirectory, { withFileTypes: true }); } catch { return matchingPaths; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.svelte-kit')) continue;
    const childPath = joinPath(rootDirectory, entry.name);
    if (entry.isDirectory()) listFilesRecursive(childPath, matcher, matchingPaths, depth + 1);
    else if (matcher(childPath)) matchingPaths.push(childPath);
  }
  return matchingPaths;
}

function findProjectRoot(startDirectory) {
  let probe = startDirectory;
  for (let steps = 0; steps < 12; steps++) {
    if (existsSync(joinPath(probe, '.git')) || existsSync(joinPath(probe, 'package.json'))) return probe;
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  return null;
}

/** Collect the connector-client files this SESSION wrote/edited (that still exist + look like clients). */
export function collectTouchedConnectors(
  sessionEntries,
  readFile = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } },
  fileExists = existsSync,
) {
  const touched = new Set();
  for (const entry of sessionEntries || []) {
    for (const block of contentBlocks(entry)) {
      if (block.type !== 'tool_use') continue;
      if (!['Write', 'Edit', 'MultiEdit'].includes(block.name)) continue;
      const filePath = block.input?.file_path || block.input?.path || '';
      if (!filePath || !CONNECTOR_DIR_RE.test(filePath) || NON_SOURCE_RE.test(filePath) || !SOURCE_RE.test(filePath)) continue;
      touched.add(filePath.replace(/\//g, sep));
    }
  }
  return [...touched].filter((filePath) => fileExists(filePath) && looksLikeConnectorClient(readFile(filePath)));
}

function onStop(hookEvent) {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot || !existsSync(joinPath(projectRoot, 'src', 'lib', 'server'))) return; // no connector convention → no-op

  const sessionEntries = readTranscript(hookEvent.transcript_path);
  const touchedConnectors = collectTouchedConnectors(sessionEntries);
  if (touchedConnectors.length === 0) return;

  // Every *.live.test.ts in the repo → the basenames it imports/references.
  const liveTestFiles = listFilesRecursive(joinPath(projectRoot, 'src'), (p) => /\.live\.test\.[cm]?[jt]sx?$/.test(p));
  const referencedBasenames = [];
  for (const liveTestPath of liveTestFiles) {
    let liveTestSource = ''; try { liveTestSource = readFileSync(liveTestPath, 'utf8'); } catch { /* skip */ }
    for (const match of liveTestSource.matchAll(/from\s+['"][^'"]*\/([\w.-]+?)(?:\.[cm]?[jt]sx?)?['"]/g)) referencedBasenames.push(match[1]);
  }

  const missing = connectorsMissingLiveTest(touchedConnectors, referencedBasenames);
  if (missing.length === 0) return;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      'LIVE TEST REQUIRED — you touched an external-connector client this session with no *.live.test.ts:',
      ...missing.map((filePath) => `  • ${filePath.replace(projectRoot + sep, '')}`),
      '',
      'Russell\'s rule (Macher, the Zinc 402 that hid for MONTHS): mocks cover the gateway, LIVE tests cover the',
      'contract. A unit test with an injected fake proves your branching, never that the provider still accepts',
      'your request. This is a shadow of "the proxy lies" — a mock is a stand-in, not proof of the real path.',
      '',
      'Do ONE of:',
      '  1. Add a `<name>.live.test.ts` gated by `describe.runIf(process.env.RUN_<NAME>_LIVE === \'1\')` that exercises',
      '     the REAL client factory against the real sandbox (money-safety guard on any spend, per the Zinc pilot).',
      '  2. If this module makes no external call (pure logic / no network), say so with the token: no-live-test-needed',
    ].join('\n'),
  }));
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  try {
    const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
    if (eventName !== 'Stop') { process.exit(0); }
    const replyText = hookEvent.reply_text || '';
    if (WAIVE_TOKEN.test(replyText)) { process.exit(0); }
    onStop(hookEvent);
  } catch { /* fail open */ }
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
