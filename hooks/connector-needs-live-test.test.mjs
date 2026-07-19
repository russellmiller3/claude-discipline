// Tests for connector-needs-live-test.mjs — the Stop gate that requires a *.live.test.ts for any
// external-connector client touched this session. Regression target: the Zinc /search 402 that hid
// for MONTHS behind green unit tests with injected fakes (Macher, 2026-07-18).
//
//   node --test hooks/connector-needs-live-test.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectorsMissingLiveTest, looksLikeConnectorClient, collectTouchedConnectors,
} from './connector-needs-live-test.mjs';

const edit = (file_path) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path } }] });
const connectorSource = 'const orders = await fetch("https://api.zinc.com/v2/orders", { headers });';
const pureLogicSource = 'export function priceCap(a, b) { return Math.min(a, b); }';

// ── the missing-live-test core ────────────────────────────────────────────────
test('connectorsMissingLiveTest: flags a connector with no live test', () => {
  const missing = connectorsMissingLiveTest(
    ['src/lib/server/zinc/client.ts', 'src/lib/server/twilio/sms.ts'],
    ['sms', 'other-helper'],  // only sms is covered
  );
  assert.deepEqual(missing, ['src/lib/server/zinc/client.ts']);
});
test('connectorsMissingLiveTest: ALLOWS when every connector has a live test (no over-fire)', () => {
  const missing = connectorsMissingLiveTest(
    ['src/lib/server/zinc/client.ts'],
    ['client', 'zinc'],  // referenced by a live test
  );
  assert.deepEqual(missing, []);
});

// ── connector detection ───────────────────────────────────────────────────────
test('looksLikeConnectorClient: true for an https provider call, false for pure logic', () => {
  assert.equal(looksLikeConnectorClient(connectorSource), true);
  assert.equal(looksLikeConnectorClient('fetch("https://api.retellai.com/x")'), true);
  assert.equal(looksLikeConnectorClient(pureLogicSource), false);
  assert.equal(looksLikeConnectorClient('await fetch("/api/local")'), false); // relative → not a connector
});

// ── collectTouchedConnectors: only real connector sources under src/lib/server ──
const fileSources = { 'src/lib/server/zinc/client.ts': connectorSource, 'src/lib/server/pricing.ts': pureLogicSource };
const readFake = (p) => fileSources[p.replace(/\\/g, '/')] ?? '';
const existsFake = (p) => (p.replace(/\\/g, '/')) in fileSources;

test('collectTouchedConnectors: picks up a real connector client edited this session', () => {
  const found = collectTouchedConnectors([edit('src/lib/server/zinc/client.ts')], readFake, existsFake);
  assert.deepEqual(found.map((p) => p.replace(/\\/g, '/')), ['src/lib/server/zinc/client.ts']);
});
test('collectTouchedConnectors: ALLOWS (ignores) a pure module under src/lib/server (no external call)', () => {
  const found = collectTouchedConnectors([edit('src/lib/server/pricing.ts')], readFake, existsFake);
  assert.deepEqual(found, []);
});
test('collectTouchedConnectors: ALLOWS (ignores) files outside src/lib/server and test files', () => {
  const entries = [
    edit('src/lib/MemphisLanding.svelte'),                    // not server
    edit('src/lib/server/zinc/client.test.ts'),               // a test file
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }, // not a write
  ];
  assert.deepEqual(collectTouchedConnectors(entries, readFake, existsFake), []);
});
