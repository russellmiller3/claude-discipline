import assert from 'node:assert/strict';
import { extractSignals, computeGaps, extractHardcodedBase, extractLiveIds, staleBaseWarning } from './retell-deploy-guard.mjs';

let passed = 0;
function test(name, runCase) { runCase(); passed++; console.log(`  ✓ ${name}`); }

// Build a transcript entry from blocks.
const entry = (...blocks) => ({ message: { role: 'assistant', content: blocks } });
const bash = (command) => ({ type: 'tool_use', name: 'Bash', input: { command } });
const toolResult = (text) => ({ type: 'tool_result', content: text });
const say = (text) => ({ type: 'text', text });

// ── extractSignals ──────────────────────────────────────────────────────────
test('extractSignals: detects a party rebuild + its secret put + minted id from output', () => {
  const signals = extractSignals([
    entry(bash('node scripts/make-party-agent.mjs 2>&1 | tail -12')),
    entry(toolResult('NEW LLM: llm_abc\nNEW AGENT: agent_party123 | version: 0\nPUBLISH ok: {}')),
    entry(bash('echo "agent_party123" | npx wrangler secret put MACHER_PARTY_LINE_AGENT_ID --config x'))
  ]);
  assert.equal(signals.partyRebuilt, true);
  assert.equal(signals.newPartyId, 'agent_party123');
  assert.ok(signals.secretPuts.has('MACHER_PARTY_LINE_AGENT_ID'));
  assert.equal(signals.ownerRebuilt, false);
});

test('extractSignals: owner "NEW OWNER AGENT:" is NOT misread as a party mint', () => {
  const signals = extractSignals([
    entry(bash('node scripts/make-owner-agent.mjs')),
    entry(toolResult('NEW OWNER LLM: llm_o\nNEW OWNER AGENT: agent_owner999 | version: 0'))
  ]);
  assert.equal(signals.ownerRebuilt, true);
  assert.equal(signals.newOwnerId, 'agent_owner999');
  assert.equal(signals.newPartyId, null); // the guard: owner line never counts as a party mint
});

test('extractSignals: escape token in reply text is picked up', () => {
  const signals = extractSignals([
    entry(bash('node scripts/make-party-agent.mjs')),
    entry(say('retell-deploy-ok: minted an orphan to inspect its schema, not deploying it'))
  ]);
  assert.equal(signals.escaped, true);
});

// ── computeGaps ─────────────────────────────────────────────────────────────
test('computeGaps: party minted but secret never repointed → gap', () => {
  const gaps = computeGaps(
    { partyRebuilt: true, newPartyId: 'agent_p', secretPuts: new Set(), escaped: false },
    { changelogText: 'agent_p', handoffText: 'agent_p' }
  );
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /MACHER_PARTY_LINE_AGENT_ID was never repointed/);
});

test('computeGaps: party minted + repointed but id recorded nowhere → gap', () => {
  const gaps = computeGaps(
    { partyRebuilt: true, newPartyId: 'agent_p', secretPuts: new Set(['MACHER_PARTY_LINE_AGENT_ID']), escaped: false },
    { changelogText: 'nothing here', handoffText: 'nor here' }
  );
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /agent_p is not recorded/);
});

test('computeGaps: full party protocol (secret + id in CHANGELOG) → no gap', () => {
  const gaps = computeGaps(
    { partyRebuilt: true, newPartyId: 'agent_p', secretPuts: new Set(['MACHER_PARTY_LINE_AGENT_ID']), escaped: false },
    { changelogText: 'live party agent_p deployed', handoffText: '' }
  );
  assert.deepEqual(gaps, []);
});

test('computeGaps: this-session scenario — both lines fully deployed → no gap', () => {
  const gaps = computeGaps(
    {
      partyRebuilt: true, ownerRebuilt: true,
      newPartyId: 'agent_59ea', newOwnerId: 'agent_b136',
      secretPuts: new Set(['MACHER_PARTY_LINE_AGENT_ID', 'RETELL_AGENT_ID']),
      escaped: false
    },
    { changelogText: 'party agent_59ea owner agent_b136', handoffText: 'agent_59ea agent_b136' }
  );
  assert.deepEqual(gaps, []);
});

test('computeGaps: owner minted, secret + id present → no gap; missing either → gap', () => {
  const base = { ownerRebuilt: true, newOwnerId: 'agent_o', escaped: false };
  assert.deepEqual(
    computeGaps({ ...base, secretPuts: new Set(['RETELL_AGENT_ID']) }, { handoffText: 'agent_o' }),
    []
  );
  assert.equal(
    computeGaps({ ...base, secretPuts: new Set() }, { handoffText: 'agent_o' }).length,
    1
  );
});

test('computeGaps: minted id unparseable (truncated output) → only the secret is required', () => {
  // newPartyId null → skip the record check, still require the secret.
  const missingSecret = computeGaps(
    { partyRebuilt: true, newPartyId: null, secretPuts: new Set(), escaped: false },
    { changelogText: '', handoffText: '' }
  );
  assert.equal(missingSecret.length, 1);
  const secretDone = computeGaps(
    { partyRebuilt: true, newPartyId: null, secretPuts: new Set(['MACHER_PARTY_LINE_AGENT_ID']), escaped: false },
    { changelogText: '', handoffText: '' }
  );
  assert.deepEqual(secretDone, []);
});

test('computeGaps: escape token → no gaps even with a bare mint', () => {
  const gaps = computeGaps(
    { partyRebuilt: true, newPartyId: 'agent_p', secretPuts: new Set(), escaped: true },
    { changelogText: '', handoffText: '' }
  );
  assert.deepEqual(gaps, []);
});

test('computeGaps: no rebuild → no gaps', () => {
  assert.deepEqual(computeGaps({ partyRebuilt: false, ownerRebuilt: false, secretPuts: new Set(), escaped: false }, {}), []);
});

test('computeGaps: null signals → [] (fails open)', () => {
  assert.deepEqual(computeGaps(null, {}), []);
});

test('MUST-ALLOW: a session that only MENTIONS the script in prose (never runs it) does not fire', () => {
  // The guard must key on the ACTION (a Bash tool_use running the script), never a mere mention —
  // otherwise talking about make-party-agent.mjs (as this very session does) would wrongly block.
  const signals = extractSignals([
    entry(say('I updated scripts/make-party-agent.mjs and will run make-owner-agent.mjs later.')),
    entry({ type: 'tool_use', name: 'Read', input: { file_path: 'scripts/make-party-agent.mjs' } })
  ]);
  assert.equal(signals.partyRebuilt, false); // prose/Read mention ≠ a rebuild run
  assert.equal(signals.ownerRebuilt, false);
  assert.deepEqual(computeGaps(signals, { changelogText: '', handoffText: '' }), []); // → onStop returns early, never blocks
});

test('extractSignals: null / empty input → clean empty signals (fails open)', () => {
  const signals = extractSignals(null);
  assert.equal(signals.partyRebuilt, false);
  assert.equal(signals.ownerRebuilt, false);
  assert.equal(signals.secretPuts.size, 0);
});

// ── PreToolUse: stale clone-base ──────────────────────────────────────────────
const partyScript = (id) => `import x;\nconst currentLlmId = 'llm_z';\nconst currentAgentId = '${id}';\n`;
const architecture = (party, owner) => `Docs.\nSome party agent_ffffffffffffffffffffffffff mention earlier.\n- Current live (2026-07-19): party \`${party}\`, owner\n  \`${owner}\`.\n`;

test('extractHardcodedBase: reads currentAgentId; null when absent', () => {
  assert.equal(extractHardcodedBase(partyScript('agent_base1')), 'agent_base1');
  assert.equal(extractHardcodedBase("const other = 'agent_x';"), null);
});

test('extractLiveIds: reads the Current-live line (line-wrap safe), ignores incidental mentions', () => {
  const live = extractLiveIds(architecture('agent_liveparty', 'agent_liveowner'));
  assert.equal(live.party, 'agent_liveparty'); // NOT the earlier incidental agent_fff… mention
  assert.equal(live.owner, 'agent_liveowner'); // parsed even though it wrapped to the next line
});

test('staleBaseWarning: BLOCKS a party rebuild whose base != the recorded live id', () => {
  const warning = staleBaseWarning({
    command: 'node scripts/make-party-agent.mjs',
    scriptText: partyScript('agent_stale'),
    architectureText: architecture('agent_liveparty', 'agent_liveowner')
  });
  assert.match(warning, /Clone-base looks STALE/);
  assert.match(warning, /agent_stale/);
  assert.match(warning, /agent_liveparty/);
});

test('MUST-ALLOW: base already matches the recorded live id → no warning', () => {
  assert.equal(staleBaseWarning({
    command: 'node scripts/make-party-agent.mjs',
    scriptText: partyScript('agent_liveparty'),
    architectureText: architecture('agent_liveparty', 'agent_liveowner')
  }), null);
});

test('MUST-ALLOW: dynamic base (no hardcoded currentAgentId, e.g. owner script) → no warning', () => {
  assert.equal(staleBaseWarning({
    command: 'node scripts/make-owner-agent.mjs',
    scriptText: "const currentAgentId = demoState.retellAgentId ?? env.RETELL_AGENT_ID;",
    architectureText: architecture('agent_liveparty', 'agent_liveowner')
  }), null);
});

test('MUST-ALLOW: ARCHITECTURE has no Current-live line → fail open (no warning)', () => {
  assert.equal(staleBaseWarning({
    command: 'node scripts/make-party-agent.mjs',
    scriptText: partyScript('agent_stale'),
    architectureText: 'ARCHITECTURE with no live record here.'
  }), null);
});

test('MUST-ALLOW: escape token in command → no warning even if stale', () => {
  assert.equal(staleBaseWarning({
    command: 'stale-base-ok: intentional && node scripts/make-party-agent.mjs',
    scriptText: partyScript('agent_stale'),
    architectureText: architecture('agent_liveparty', 'agent_liveowner')
  }), null);
});

test('MUST-ALLOW: a non-rebuild command → no warning', () => {
  assert.equal(staleBaseWarning({ command: 'npm test', scriptText: partyScript('agent_stale'), architectureText: architecture('a', 'b') }), null);
});

console.log(`\n${passed} tests passed`);
