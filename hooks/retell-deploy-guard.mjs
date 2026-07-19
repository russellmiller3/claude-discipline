#!/usr/bin/env node
/**
 * retell-deploy-guard — Stop hook (Macher-scoped by trigger). Enforces the FULL Retell voice-agent
 * deploy protocol whenever this session MINTED a new agent, so a half-finished cutover can't ship.
 *
 * new-hook-category: Project-scoped — nearest existing hooks are docs-on-feature-commit (requires
 * front-door docs to move on ANY deploy) and modal-run-telemetry-guard (enforces a run protocol).
 * Neither covers this: docs-on-feature-commit is satisfied by touching a README/CHANGELOG and never
 * checks that the MINTED AGENT ID was repointed into its secret or is the id recorded; modal is a
 * different domain (Modal jobs). A minted-but-unrepointed orphan, or an unrecorded id that makes the
 * next rebuild clone a stale base, sails past both — this gates on the Retell mint→repoint→record chain.
 *
 * Why (hit live 2026-07-19): a Retell agent/LLM is version-LOCKED — you can't edit a published one.
 * Changing its prompt/tools means running scripts/make-{party,owner}-agent.mjs to MINT a brand-new
 * agent, THEN repointing a Cloudflare secret at it AND recording the new id so the next session
 * doesn't clone a stale base. That session I (a) cloned a stale hardcoded base id, and (b) nearly
 * called it done without repointing/verifying. Minting without repointing = an orphan agent + a live
 * line still on the old brain. Recording nothing = the next rebuild clones a stale base and reverts
 * live prompt changes.
 *
 * The invariant (session-wide, so we scan the WHOLE transcript, not just this turn): if a
 * make-{party,owner}-agent.mjs run appears in the session, then before Stop —
 *   1. the MATCHING secret was repointed via `wrangler secret put`
 *      (party → MACHER_PARTY_LINE_AGENT_ID, owner → RETELL_AGENT_ID), AND
 *   2. the newly-minted agent id (parsed from the script's own "NEW [OWNER] AGENT: agent_…" output)
 *      is recorded in CHANGELOG.md or HANDOFF.md.
 * Gates on the ACTIONS (the real commands ran) + the STATE (the id is on disk in the docs), never on
 * a self-asserted claim (Rule 1.6).
 *
 * PreToolUse half (added 2026-07-19): BEFORE a `make-{party,owner}-agent.mjs` run, block it if the
 * script's hardcoded clone-base (`const currentAgentId = 'agent_…'`) differs from the current-live id
 * ARCHITECTURE.md records — cloning a stale base silently reverts live prompt changes (hit live this day).
 * Fires only when staleness is PROVABLE (hardcoded base + a differing recorded live id); a dynamic base
 * or a missing record fails open. Escape: prepend `stale-base-ok: <why>` to the command, or STALE_BASE_OK=1.
 *
 * Escape (deliberate orphan / not deploying this mint): put `retell-deploy-ok: <why>` in your reply
 * or the command, or set RETELL_DEPLOY_GUARD_OK=1. Fails OPEN on any error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { readTranscript, contentBlocks, toolResultText } from './lib/transcript.mjs';

const PARTY_REBUILD_RE = /make-party-agent\.mjs/;
const OWNER_REBUILD_RE = /make-owner-agent\.mjs/;
const PARTY_SECRET = 'MACHER_PARTY_LINE_AGENT_ID';
const OWNER_SECRET = 'RETELL_AGENT_ID';
// The scripts print "NEW AGENT: agent_x" (party) and "NEW OWNER AGENT: agent_x" (owner). "NEW AGENT:"
// deliberately does NOT match "NEW OWNER AGENT:" (the word OWNER sits between), so the two never cross.
const NEW_PARTY_ID_RE = /NEW AGENT:\s*(agent_[a-z0-9]+)/i;
const NEW_OWNER_ID_RE = /NEW OWNER AGENT:\s*(agent_[a-z0-9]+)/i;
const ESCAPE_RE = /retell-deploy-ok\s*:|RETELL_DEPLOY_GUARD_OK/;
// PreToolUse half: catch a rebuild about to clone a STALE base. `const currentAgentId = 'agent_…'` is the
// hardcoded base the party script clones FROM (the owner script resolves its base dynamically, no hardcode).
const REBUILD_RE = /make-(party|owner)-agent\.mjs/;
const HARDCODED_BASE_RE = /const\s+currentAgentId\s*=\s*['"](agent_[a-z0-9]+)['"]/;
const STALE_BASE_ESCAPE_RE = /stale-base-ok\s*:/i;

function secretPutRe(secretName) {
  return new RegExp(`secret\\s+put\\s+${secretName}\\b`);
}

/** The hardcoded clone-base a make-*-agent.mjs script clones FROM (null if it resolves the base dynamically). */
export function extractHardcodedBase(scriptText) {
  return (scriptText || '').match(HARDCODED_BASE_RE)?.[1] || null;
}

/**
 * The current-live agent ids ARCHITECTURE.md records on its canonical "Current live … party `agent_X`,
 * owner `agent_Y`" line. Scoped to a 200-char window after "Current live" so incidental party/owner
 * mentions elsewhere in the doc can't be mistaken for the live record; tolerant of the id wrapping a line.
 */
export function extractLiveIds(architectureText) {
  const window = (architectureText || '').match(/current live[\s\S]{0,200}/i)?.[0] || '';
  return {
    party: window.match(/party\s+`?(agent_[a-z0-9]+)`?/i)?.[1] || null,
    owner: window.match(/owner\s+`?(agent_[a-z0-9]+)`?/i)?.[1] || null
  };
}

/**
 * Warn when a rebuild is about to clone a STALE base. Pure over (command, the target script's text,
 * ARCHITECTURE.md text) → warning string or null. Only fires when staleness is PROVABLE: the script has a
 * hardcoded base AND ARCHITECTURE records a DIFFERENT current-live id for that line. A dynamic base (owner)
 * or a missing/absent record → null (fail open — never block a rebuild we can't prove is stale).
 */
export function staleBaseWarning({ command = '', scriptText = '', architectureText = '' }) {
  if (ESCAPE_RE.test(command) || STALE_BASE_ESCAPE_RE.test(command)) return null;
  const rebuild = command.match(REBUILD_RE);
  if (!rebuild) return null;
  const line = rebuild[1]; // 'party' | 'owner'
  const base = extractHardcodedBase(scriptText);
  if (!base) return null; // dynamically-resolved base → nothing to be stale
  const live = extractLiveIds(architectureText)[line];
  if (!live || live === base) return null; // no recorded live id, or base already matches → fine
  return `Clone-base looks STALE: make-${line}-agent.mjs clones ${base}, but ARCHITECTURE.md records the live ${line} agent as ${live}. Rebuilding from ${base} would silently REVERT live prompt changes. Update currentAgentId/currentLlmId to the live base first (confirm against the secret), or prepend "stale-base-ok: <why>" if this is intentional.`;
}

/**
 * Walk the whole session and pull the deploy signals. Pure over an entries array so tests feed plain
 * objects. Reads tool_use command text AND tool_result output text (the minted id lives in output).
 */
export function extractSignals(entries) {
  const signals = {
    partyRebuilt: false,
    ownerRebuilt: false,
    newPartyId: null,
    newOwnerId: null,
    secretPuts: new Set(),
    escaped: false
  };
  for (const entry of entries || []) {
    for (const block of contentBlocks(entry)) {
      if (block?.type === 'text' && ESCAPE_RE.test(block.text || '')) signals.escaped = true;
      if (block?.type === 'tool_use') {
        const command = block.input?.command || '';
        if (ESCAPE_RE.test(command)) signals.escaped = true;
        if (PARTY_REBUILD_RE.test(command)) signals.partyRebuilt = true;
        if (OWNER_REBUILD_RE.test(command)) signals.ownerRebuilt = true;
        if (secretPutRe(PARTY_SECRET).test(command)) signals.secretPuts.add(PARTY_SECRET);
        if (secretPutRe(OWNER_SECRET).test(command)) signals.secretPuts.add(OWNER_SECRET);
      }
      if (block?.type === 'tool_result') {
        const scriptOutput = toolResultText(block);
        const ownerMatch = scriptOutput.match(NEW_OWNER_ID_RE);
        if (ownerMatch) signals.newOwnerId = ownerMatch[1];
        // Run the party match on output with the owner lines removed, so "NEW OWNER AGENT:" can never
        // be mis-read as a party mint even if a future log reorders the words.
        const partyMatch = scriptOutput.replace(NEW_OWNER_ID_RE, '').match(NEW_PARTY_ID_RE);
        if (partyMatch) signals.newPartyId = partyMatch[1];
      }
    }
  }
  return signals;
}

/**
 * Given the signals + the current CHANGELOG/HANDOFF text, list what's still missing. Empty = OK.
 * A rebuild with no matching secret-put is always a gap; a rebuild whose minted id we could parse but
 * that appears in NEITHER doc is a gap. (If we couldn't parse the id — truncated output — we skip the
 * doc check for that line but still require the secret; fail toward the checkable.)
 */
export function computeGaps(signals, { changelogText = '', handoffText = '' } = {}) {
  if (!signals || signals.escaped) return [];
  const recorded = (agentId) => Boolean(agentId) && (changelogText.includes(agentId) || handoffText.includes(agentId));
  const gaps = [];
  if (signals.partyRebuilt) {
    if (!signals.secretPuts.has(PARTY_SECRET)) {
      gaps.push(`Party agent was rebuilt but ${PARTY_SECRET} was never repointed — run: echo "<new party id>" | npx wrangler secret put ${PARTY_SECRET} --config cloudflare/retell-gateway/wrangler.jsonc`);
    }
    if (signals.newPartyId && !recorded(signals.newPartyId)) {
      gaps.push(`New party agent ${signals.newPartyId} is not recorded in CHANGELOG.md or HANDOFF.md — write it down so the next rebuild clones the live base, not a stale one.`);
    }
  }
  if (signals.ownerRebuilt) {
    if (!signals.secretPuts.has(OWNER_SECRET)) {
      gaps.push(`Owner agent was rebuilt but ${OWNER_SECRET} was never repointed — run: echo "<new owner id>" | npx wrangler secret put ${OWNER_SECRET} --config cloudflare/retell-gateway/wrangler.jsonc (also sync .macher/demo-state.json + .env).`);
    }
    if (signals.newOwnerId && !recorded(signals.newOwnerId)) {
      gaps.push(`New owner agent ${signals.newOwnerId} is not recorded in CHANGELOG.md or HANDOFF.md — write it down so the next rebuild clones the live base, not a stale one.`);
    }
  }
  return gaps;
}

function readIfExists(filePath) {
  try { return existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''; } catch { return ''; }
}

function onStop(hookEvent) {
  const entries = readTranscript(hookEvent.transcript_path);
  const signals = extractSignals(entries);
  if (!signals.partyRebuilt && !signals.ownerRebuilt) return; // no agent minted this session → nothing to enforce
  const projectDirectory = hookEvent.cwd || process.cwd();
  const gaps = computeGaps(signals, {
    changelogText: readIfExists(`${projectDirectory}/CHANGELOG.md`),
    handoffText: readIfExists(`${projectDirectory}/HANDOFF.md`)
  });
  if (gaps.length === 0) return;
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      'RETELL DEPLOY INCOMPLETE — you minted a new voice agent this session but the cutover is half-done.',
      'A Retell agent is version-locked: minting a fresh one without repointing its secret leaves an ORPHAN',
      'while the live line still runs the OLD brain, and not recording the new id makes the next rebuild clone',
      'a STALE base (silently reverting live prompt changes). Close the gap(s):',
      '',
      ...gaps.map((gap) => `  • ${gap}`),
      '',
      'Then deploy the gateway if its code changed (npm run deploy:gateway) and VERIFY the publish:',
      "  get-agent/<id>?version=0 → is_published:true, and the LLM's prompt/tools carry your change.",
      'Full runbook: ARCHITECTURE.md "Redeploy a voice agent".',
      '',
      'If you minted an orphan on purpose / are NOT deploying this mint, say: retell-deploy-ok: <why>'
    ].join('\n')
  }));
}

// ── PreToolUse: block a rebuild that would clone a STALE base ──────────────────
function onPreToolUse(hookEvent) {
  if (hookEvent.tool_name !== 'Bash') return;
  if (process.env.STALE_BASE_OK === '1' || process.env.RETELL_DEPLOY_GUARD_OK === '1') return;
  const command = hookEvent.tool_input?.command || '';
  const rebuild = command.match(REBUILD_RE);
  if (!rebuild) return;
  const projectDirectory = hookEvent.cwd || process.cwd();
  const warning = staleBaseWarning({
    command,
    scriptText: readIfExists(`${projectDirectory}/scripts/make-${rebuild[1]}-agent.mjs`),
    architectureText: readIfExists(`${projectDirectory}/ARCHITECTURE.md`)
  });
  if (!warning) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: warning
    }
  }));
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); }
  try {
    const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
    if (eventName === 'Stop') onStop(hookEvent);
    else if (eventName === 'PreToolUse') onPreToolUse(hookEvent);
  } catch { /* fail open */ }
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  main();
}
