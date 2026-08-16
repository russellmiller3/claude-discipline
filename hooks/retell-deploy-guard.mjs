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
 *
 * Second, independent trigger (mint-free): ANY successful gateway deploy (`npm run deploy:gateway`
 * or a raw `wrangler deploy ... retell-gateway`) must be followed by a live tool-contract verification
 * (`node scripts/verify-live-retell-tool-contract.mjs` printing `RETELL_TOOL_CONTRACT_OK`) — a deploy
 * can change the tool endpoints/secret a live agent calls, with no mint involved at all.
 *
 * FIX (2026-08-09, false positive hit live): `npm run deploy:gateway` chains that exact verifier as
 * its OWN last step (package.json: "... && node scripts/verify-live-retell-tool-contract.mjs"), so a
 * routine deploy with no mint activity legitimately prints RETELL_TOOL_CONTRACT_OK inside the SAME
 * tool_result as the deploy-success text. The old code unconditionally reset liveToolContractVerified
 * to false on any gateway-deploy success and only ever set it true when a SEPARATE Bash command's own
 * text named verify-live-retell-tool-contract.mjs directly — so it could never see the marker sitting
 * in the deploy command's own combined stdout, and blocked with "you minted a new voice agent this
 * session" even when no mint script had run at all. Now: (a) the deploy-success branch re-checks the
 * SAME tool_result for the OK marker before deciding verified is false, and (b) buildBlockReason()
 * frames the message around whichever gap actually fired instead of always accusing a mint.
 *
 * FIX (2026-08-09, same-day red-team pass on the fix above caught two regressions before either
 * shipped further): (1) trusting the marker in the deploy's OWN tool_result opened a real bypass —
 * `npm run deploy:gateway && echo RETELL_TOOL_CONTRACT_OK` would fabricate the marker in that same
 * output, since a real deploy-success text plus a chained echo both land in one tool_result. Added
 * COMMAND_CHAIN_INJECTION_RE: the in-place marker is trusted only when the triggering command has no
 * `&&`/`||`/`;`/backtick/`$(` chaining (a plain `| tail`-style read-only pipe stays allowed — that's
 * how huge deploy output normally gets trimmed). Not adversarial-proof (a pipe into something that
 * rewrites text, e.g. `| sed`, is undetected) — documented, not fixed, matching this file's existing
 * fail-toward-the-checkable posture. (2) buildBlockReason's `minted` flag read raw
 * signals.partyRebuilt/ownerRebuilt, not gated on signals.escaped like computeGaps's own mint-gap
 * logic — so an ESCAPED mint (`retell-deploy-ok: <why>`) combined with an unrelated gateway-only gap
 * still produced the "you minted a new voice agent" header even though the mint contributed zero
 * gaps. `minted` now mirrors computeGaps's exact condition: `(partyRebuilt || ownerRebuilt) &&
 * !escaped`.
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
const GATEWAY_DEPLOY_RE = /(?:npm\s+run\s+deploy:gateway\b|(?:^|\s)[^\s]*wrangler(?:\.cmd)?\s+deploy\b[\s\S]{0,300}retell-gateway)/i;
const GATEWAY_DEPLOY_SUCCESS_RE = /(?:Current Version ID:|Deployed\s+macher-gateway|Uploaded\s+macher-gateway)/i;
const LIVE_TOOL_CONTRACT_PROBE_RE = /(?:^|[\\/])verify-live-retell-tool-contract\.mjs\b/i;
const LIVE_TOOL_CONTRACT_OK_RE = /\bRETELL_TOOL_CONTRACT_OK\b/;
// A single Bash command can chain arbitrary extra text onto real deploy output
// (`npm run deploy:gateway && echo RETELL_TOOL_CONTRACT_OK`), fabricating the marker instead of
// letting the real chained verifier print it. Trust an in-place marker only when the command has
// no command-chaining metacharacters — the real `npm run deploy:gateway` invocation never needs
// them (npm runs its own chain internally); a plain `| tail`/`| grep`-style read-only pipe is still
// allowed since that's the normal way to trim huge deploy output. Not adversarial-proof (a pipe into
// something that rewrites text, e.g. `| sed`, is not blocked) — this guards the realistic failure
// mode (a rushed session tacking on `&& echo ...` to unblock itself), not a hardened boundary.
const COMMAND_CHAIN_INJECTION_RE = /&&|\|\||;|`|\$\(/;
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
    escaped: false,
    gatewayDeployed: false,
    liveToolContractVerified: false
  };
  let gatewayDeployPending = false;
  let gatewayDeployCommandTrusted = false;
  let liveToolContractProbePending = false;
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
        if (GATEWAY_DEPLOY_RE.test(command)) {
          gatewayDeployPending = true;
          gatewayDeployCommandTrusted = !COMMAND_CHAIN_INJECTION_RE.test(command);
        }
        if (LIVE_TOOL_CONTRACT_PROBE_RE.test(command)) liveToolContractProbePending = true;
      }
      if (block?.type === 'tool_result') {
        const scriptOutput = toolResultText(block);
        if (gatewayDeployPending) {
          if (GATEWAY_DEPLOY_SUCCESS_RE.test(scriptOutput)) {
            signals.gatewayDeployed = true;
            // `npm run deploy:gateway` chains the real verifier as its OWN last step (package.json:
            // "... && node scripts/verify-live-retell-tool-contract.mjs"), so this same tool_result can
            // already carry the OK marker in its combined stdout — that's the real script's output, not
            // a separate step still owed. Only trust it when the triggering command itself couldn't have
            // fabricated the marker (gatewayDeployCommandTrusted — see COMMAND_CHAIN_INJECTION_RE).
            signals.liveToolContractVerified = gatewayDeployCommandTrusted && LIVE_TOOL_CONTRACT_OK_RE.test(scriptOutput);
          }
          gatewayDeployPending = false;
        }
        if (liveToolContractProbePending) {
          if (LIVE_TOOL_CONTRACT_OK_RE.test(scriptOutput)) signals.liveToolContractVerified = true;
          liveToolContractProbePending = false;
        }
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
  if (!signals) return [];
  const recorded = (agentId) => Boolean(agentId) && (changelogText.includes(agentId) || handoffText.includes(agentId));
  const gaps = [];
  if (!signals.escaped && signals.partyRebuilt) {
    if (!signals.secretPuts.has(PARTY_SECRET)) {
      gaps.push(`Party agent was rebuilt but ${PARTY_SECRET} was never repointed — run: echo "<new party id>" | npx wrangler secret put ${PARTY_SECRET} --config cloudflare/retell-gateway/wrangler.jsonc`);
    }
    if (signals.newPartyId && !recorded(signals.newPartyId)) {
      gaps.push(`New party agent ${signals.newPartyId} is not recorded in CHANGELOG.md or HANDOFF.md — write it down so the next rebuild clones the live base, not a stale one.`);
    }
  }
  if (!signals.escaped && signals.ownerRebuilt) {
    if (!signals.secretPuts.has(OWNER_SECRET)) {
      gaps.push(`Owner agent was rebuilt but ${OWNER_SECRET} was never repointed — run: echo "<new owner id>" | npx wrangler secret put ${OWNER_SECRET} --config cloudflare/retell-gateway/wrangler.jsonc (also sync .macher/demo-state.json + .env).`);
    }
    if (signals.newOwnerId && !recorded(signals.newOwnerId)) {
      gaps.push(`New owner agent ${signals.newOwnerId} is not recorded in CHANGELOG.md or HANDOFF.md — write it down so the next rebuild clones the live base, not a stale one.`);
    }
  }
  if (signals.gatewayDeployed && !signals.liveToolContractVerified) {
    gaps.push('Gateway was deployed but the live Retell tool contract was not verified afterward — run: node scripts/verify-live-retell-tool-contract.mjs');
  }
  return gaps;
}

function readIfExists(filePath) {
  try { return existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''; } catch { return ''; }
}

/**
 * Two independent failure classes share this hook, and the block message must not claim the wrong
 * one: a bare `npm run deploy:gateway` with no mint is a real, common, mint-free path (fixed
 * 2026-08-09 — see header), so the reason text must not accuse the session of minting an agent
 * unless it actually did.
 */
export function buildBlockReason(signals, gaps) {
  // Match computeGaps's own gating exactly: an escaped mint contributes NO gap, so it must not
  // drive the header either — else an escaped mint + an unrelated gateway-only gap would still
  // wrongly read "you minted a new voice agent this session" (found in the 2026-08-09 red-team
  // pass on the fix above).
  const minted = Boolean((signals?.partyRebuilt || signals?.ownerRebuilt) && !signals?.escaped);
  const header = minted
    ? [
        'RETELL DEPLOY INCOMPLETE — you minted a new voice agent this session but the cutover is half-done.',
        'A Retell agent is version-locked: minting a fresh one without repointing its secret leaves an ORPHAN',
        'while the live line still runs the OLD brain, and not recording the new id makes the next rebuild clone',
        'a STALE base (silently reverting live prompt changes). Close the gap(s):'
      ]
    : [
        'RETELL DEPLOY INCOMPLETE — the gateway was deployed but the live Retell tool contract was never verified.',
        'A gateway deploy can change the endpoints/secret a live Retell agent calls — shipping without verifying',
        'against the real API risks a broken tool wiring going live silently. Close the gap(s):'
      ];
  const footer = minted
    ? [
        '',
        'Then deploy the gateway if its code changed (npm run deploy:gateway) and VERIFY the publish:',
        "  get-agent/<id>?version=0 → is_published:true, and the LLM's prompt/tools carry your change.",
        'Full runbook: ARCHITECTURE.md "Redeploy a voice agent".',
        '',
        'If you minted an orphan on purpose / are NOT deploying this mint, say: retell-deploy-ok: <why>'
      ]
    : [
        '',
        'Run: node scripts/verify-live-retell-tool-contract.mjs',
        '',
        'If this deploy intentionally skips verification, say: retell-deploy-ok: <why>'
      ];
  return [...header, '', ...gaps.map((gap) => `  • ${gap}`), ...footer].join('\n');
}

function onStop(hookEvent) {
  const entries = readTranscript(hookEvent.transcript_path);
  const signals = extractSignals(entries);
  if (!signals.partyRebuilt && !signals.ownerRebuilt && !signals.gatewayDeployed) return;
  const projectDirectory = hookEvent.cwd || process.cwd();
  const gaps = computeGaps(signals, {
    changelogText: readIfExists(`${projectDirectory}/CHANGELOG.md`),
    handoffText: readIfExists(`${projectDirectory}/HANDOFF.md`)
  });
  if (gaps.length === 0) return;
  process.stdout.write(JSON.stringify({ decision: 'block', reason: buildBlockReason(signals, gaps) }));
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

/**
 * Has this project retired Retell?
 *
 * This guard's entire demand is "run the live tool-contract verifier after deploying". On
 * 2026-08-16 Macher deleted that verifier -- Russell dropped Retell as a vendor -- and the guard
 * kept demanding it on every deploy. A gate whose clearing action no longer EXISTS cannot be
 * satisfied by anyone; it can only be waived, every time, forever. That is not enforcement, it is
 * a permanent tax, and it trains the reader to reach for the override reflexively, which is
 * exactly how a real block later gets waved through unread.
 *
 * So the guard scopes itself to projects that still ship the verifier it names. Retiring a vendor
 * retires its gate automatically, in every project, without anyone having to remember.
 */
export function retellVerifierPresent(projectRoot) {
  if (!projectRoot) return true; // unknown project -> keep guarding; never go quiet on a live cutover
  return existsSync(`${projectRoot}/scripts/verify-live-retell-tool-contract.mjs`);
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); }
  try {
    if (!retellVerifierPresent(hookEvent.cwd)) process.exit(0);
    const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
    if (eventName === 'Stop') onStop(hookEvent);
    else if (eventName === 'PreToolUse') onPreToolUse(hookEvent);
  } catch { /* fail open */ }
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  main();
}
