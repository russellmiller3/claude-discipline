import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSignals, computeGaps, extractHardcodedBase, extractLiveIds, staleBaseWarning, buildBlockReason, retellVerifierPresent } from './retell-deploy-guard.mjs';

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

// ── Stop: deployed gateway must still satisfy every live Retell tool URL ─────
test('computeGaps: BLOCKS the exact incident — gateway deployed without a live tool-contract probe', () => {
  const signals = extractSignals([
    entry(bash('npm run deploy:gateway')),
    entry(toolResult('Uploaded macher-gateway\nCurrent Version ID: version_broken'))
  ]);
  assert.equal(signals.gatewayDeployed, true);
  assert.equal(signals.liveToolContractVerified, false);
  assert.match(computeGaps(signals, {})[0], /live Retell tool contract was not verified/i);
});

test('computeGaps: direct wrangler gateway deploy is the same protected failure class', () => {
  const signals = extractSignals([
    entry(bash('wrangler deploy --config cloudflare/retell-gateway/wrangler.jsonc')),
    entry(toolResult('Deployed macher-gateway'))
  ]);
  assert.match(computeGaps(signals, {})[0], /live Retell tool contract was not verified/i);
});

test('computeGaps: an echoed success marker cannot fake the real verifier', () => {
  const signals = extractSignals([
    entry(bash('npm run deploy:gateway')),
    entry(toolResult('Deployed macher-gateway')),
    entry(bash('echo RETELL_TOOL_CONTRACT_OK')),
    entry(toolResult('RETELL_TOOL_CONTRACT_OK'))
  ]);
  assert.match(computeGaps(signals, {})[0], /live Retell tool contract was not verified/i);
});

test('computeGaps: MUST-ALLOW a deploy followed by the real successful live verifier', () => {
  const signals = extractSignals([
    entry(bash('npm run deploy:gateway')),
    entry(toolResult('Deployed macher-gateway')),
    entry(bash('node scripts/verify-live-retell-tool-contract.mjs')),
    entry(toolResult('RETELL_TOOL_CONTRACT_OK owner=34 party=4 endpoints=1'))
  ]);
  assert.equal(signals.liveToolContractVerified, true);
  assert.deepEqual(computeGaps(signals, {}), []);
});

test('computeGaps: a verifier run before the deploy does not certify the new deployment', () => {
  const signals = extractSignals([
    entry(bash('node scripts/verify-live-retell-tool-contract.mjs')),
    entry(toolResult('RETELL_TOOL_CONTRACT_OK owner=34 party=4 endpoints=1')),
    entry(bash('npm run deploy:gateway')),
    entry(toolResult('Deployed macher-gateway'))
  ]);
  assert.equal(signals.liveToolContractVerified, false);
  assert.match(computeGaps(signals, {})[0], /live Retell tool contract was not verified/i);
});

test('computeGaps: MUST-ALLOW a failed deploy because production state did not change', () => {
  const signals = extractSignals([
    entry(bash('npm run deploy:gateway')),
    entry(toolResult('Exit code: 1\nDEPLOY FAILED'))
  ]);
  assert.equal(signals.gatewayDeployed, false);
  assert.deepEqual(computeGaps(signals, {}), []);
});

test('computeGaps: MUST-ALLOW sessions with no gateway deployment', () => {
  const signals = extractSignals([entry(bash('npm test'))]);
  assert.equal(signals.gatewayDeployed, false);
  assert.deepEqual(computeGaps(signals, {}), []);
});

// ── FIX (2026-08-09): npm run deploy:gateway chains its own real verifier ────
// package.json: "deploy:gateway": "... && wrangler deploy ... && node scripts/verify-live-retell-tool-contract.mjs"
// So a single `npm run deploy:gateway` Bash call's combined stdout legitimately carries BOTH the
// wrangler success text AND the verifier's own RETELL_TOOL_CONTRACT_OK marker in ONE tool_result —
// there is no separate Bash call naming the script directly. Reproduces the live false positive:
// several routine `npm run deploy:gateway` runs, zero make-{party,owner}-agent.mjs calls, still blocked
// with "you minted a new voice agent this session."
test('computeGaps: MUST-ALLOW deploy:gateway chaining its own verifier internally (real package.json shape)', () => {
  const signals = extractSignals([
    entry(bash('npm run deploy:gateway')),
    entry(toolResult(
      'Uploaded macher-gateway\nCurrent Version ID: version_abc\n' +
      'RETELL_TOOL_CONTRACT_OK agents=34 tools=4 endpoints=1 custom_llm=1 owner_agent=agent_x owner_tools=4\n'
    ))
  ]);
  assert.equal(signals.gatewayDeployed, true);
  assert.equal(signals.liveToolContractVerified, true);
  assert.deepEqual(computeGaps(signals, {}), []);
});

test('deploy:gateway ran, no agent mint call happened -> hook stays quiet', () => {
  const signals = extractSignals([
    entry(bash('npm run deploy:gateway')),
    entry(toolResult(
      'Deployed macher-gateway\nCurrent Version ID: version_def\n' +
      'RETELL_TOOL_CONTRACT_OK agents=34 tools=4 endpoints=1 custom_llm=1 owner_agent=agent_x owner_tools=4\n'
    ))
  ]);
  assert.equal(signals.partyRebuilt, false);
  assert.equal(signals.ownerRebuilt, false);
  assert.equal(signals.newPartyId, null);
  assert.equal(signals.newOwnerId, null);
  assert.deepEqual(computeGaps(signals, { changelogText: '', handoffText: '' }), []);
});

test('computeGaps: gateway deploy WITHOUT the chained marker (verify step truncated/failed) still gaps', () => {
  // Guards the fix above didn't just make the check unconditionally pass — the marker must actually
  // be present in the deploy's own output for verification to count.
  const signals = extractSignals([
    entry(bash('npm run deploy:gateway')),
    entry(toolResult('Uploaded macher-gateway\nCurrent Version ID: version_broken'))
  ]);
  assert.equal(signals.liveToolContractVerified, false);
  assert.match(computeGaps(signals, {})[0], /live Retell tool contract was not verified/i);
});

// ── FIX (2026-08-09, same-day red-team pass): chained-command echo can't fake the marker ────
test('extractSignals: SECURITY — "npm run deploy:gateway && echo RETELL_TOOL_CONTRACT_OK" cannot fake verification', () => {
  const signals = extractSignals([
    entry(bash('npm run deploy:gateway && echo RETELL_TOOL_CONTRACT_OK')),
    entry(toolResult('Uploaded macher-gateway\nCurrent Version ID: version_abc\nRETELL_TOOL_CONTRACT_OK\n'))
  ]);
  assert.equal(signals.gatewayDeployed, true);
  assert.equal(signals.liveToolContractVerified, false);
  assert.match(computeGaps(signals, {})[0], /live Retell tool contract was not verified/i);
});

test('extractSignals: SECURITY — semicolon/pipe-into-injection chaining also cannot fake it', () => {
  for (const command of [
    'npm run deploy:gateway; echo RETELL_TOOL_CONTRACT_OK',
    'npm run deploy:gateway || echo RETELL_TOOL_CONTRACT_OK',
    'npm run deploy:gateway && echo `echo RETELL_TOOL_CONTRACT_OK`',
  ]) {
    const signals = extractSignals([
      entry(bash(command)),
      entry(toolResult('Deployed macher-gateway\nRETELL_TOOL_CONTRACT_OK\n'))
    ]);
    assert.equal(signals.liveToolContractVerified, false, `should not trust: ${command}`);
  }
});

test('MUST-ALLOW: a real deploy piped through tail still trusts its own chained OK marker', () => {
  // The realistic, non-adversarial shape: trimming huge deploy output with a read-only pipe.
  const signals = extractSignals([
    entry(bash('npm run deploy:gateway 2>&1 | tail -40')),
    entry(toolResult('Uploaded macher-gateway\nCurrent Version ID: version_abc\nRETELL_TOOL_CONTRACT_OK agents=1 tools=1\n'))
  ]);
  assert.equal(signals.liveToolContractVerified, true);
  assert.deepEqual(computeGaps(signals, {}), []);
});

// ── buildBlockReason: message must match which gap actually fired ────────────
test('buildBlockReason: mint-free gateway-only gap never claims a mint happened', () => {
  const signals = { partyRebuilt: false, ownerRebuilt: false, gatewayDeployed: true, liveToolContractVerified: false };
  const gaps = computeGaps(signals, {});
  const reason = buildBlockReason(signals, gaps);
  assert.doesNotMatch(reason, /you minted a new voice agent/i);
  assert.match(reason, /live Retell tool contract was never verified/i);
});

test('buildBlockReason: a real mint still gets the mint/orphan framing', () => {
  const signals = { partyRebuilt: true, ownerRebuilt: false, secretPuts: new Set(), newPartyId: 'agent_p', escaped: false };
  const gaps = computeGaps(signals, { changelogText: '', handoffText: '' });
  const reason = buildBlockReason(signals, gaps);
  assert.match(reason, /you minted a new voice agent this session/i);
});

test('buildBlockReason: FIX — an ESCAPED mint + an unrelated gateway-only gap must not claim a mint', () => {
  // Regression: minted used to read raw partyRebuilt/ownerRebuilt, ignoring escaped — so an
  // escaped mint (contributes zero gaps) plus a real gateway gap still said "you minted a new
  // voice agent this session," misattributing the actual gap.
  const signals = {
    partyRebuilt: true, ownerRebuilt: false, escaped: true,
    secretPuts: new Set(), newPartyId: 'agent_p',
    gatewayDeployed: true, liveToolContractVerified: false
  };
  const gaps = computeGaps(signals, { changelogText: '', handoffText: '' });
  assert.deepEqual(gaps, ['Gateway was deployed but the live Retell tool contract was not verified afterward — run: node scripts/verify-live-retell-tool-contract.mjs']);
  const reason = buildBlockReason(signals, gaps);
  assert.doesNotMatch(reason, /you minted a new voice agent/i);
  assert.match(reason, /live Retell tool contract was never verified/i);
});

test('guard is registered for pre-deploy and stop in Claude, Codex, and Kimi', () => {
  // Claude consolidated all 54 direct Stop registrations into one arbiter (2026-08-08,
  // stop-arbiter.mjs + lib/stop-registry.mjs) — this hook's Stop half now lives as a
  // `repoHook('retell-deploy-guard', ...)` entry in the registry, not a second literal
  // "retell-deploy-guard.mjs" in settings.json. Codex and Kimi still register each hook
  // directly in one file, so they keep the original single-file, 2-occurrence check.
  const claudeText = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')
    + readFileSync(join(homedir(), '.claude', 'hooks', 'lib', 'stop-registry.mjs'), 'utf8');
  const registrations = [
    claudeText,
    readFileSync(join(homedir(), '.codex', 'hooks.json'), 'utf8'),
    readFileSync(join(homedir(), '.kimi-code', 'config.toml'), 'utf8'),
  ];
  for (const registration of registrations) {
    assert.ok(
      registration.match(/retell-deploy-guard/gu)?.length >= 2,
      'expected Retell guard in both command/deploy and Stop registrations',
    );
  }
});

console.log(`\n${passed} tests passed`);

// Found live, 2026-08-16: Macher dropped Retell as a vendor and deleted the verifier this guard
// demands. The guard kept firing on every deploy, demanding a script that no longer exists -- a
// gate nobody could satisfy, only waive, forever. That is not enforcement; it is a standing tax
// that teaches the reader to reach for the override without reading it.
test('self-retires in a project that no longer ships the verifier it names', () => {
  const retired = mkdtempSync(join(tmpdir(), 'retell-retired-'));
  assert.equal(retellVerifierPresent(retired), false, 'no verifier -> the guard must go quiet');

  const stillUsing = mkdtempSync(join(tmpdir(), 'retell-live-'));
  mkdirSync(join(stillUsing, 'scripts'), { recursive: true });
  writeFileSync(join(stillUsing, 'scripts', 'verify-live-retell-tool-contract.mjs'), '// live');
  assert.equal(retellVerifierPresent(stillUsing), true, 'verifier present -> keep guarding');

  // Unknown project is the dangerous case: going quiet there would silence a live cutover.
  assert.equal(retellVerifierPresent(undefined), true);
  assert.equal(retellVerifierPresent(''), true);
});
