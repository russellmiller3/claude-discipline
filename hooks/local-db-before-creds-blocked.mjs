#!/usr/bin/env node
/**
 * local-db-before-creds-blocked — Stop hook WITH TEETH.
 *
 * Russell, 2026-06-28 (FURIOUS): "just wire it to local pglite for testing. wtf is wrong with you… why do I
 * have to think of this? Maybe your dumb ass needs a hook?" — after the assistant spent ~15 turns declaring the
 * vector-RPC isolation proof / dreaming persist / cross-deal-move proofs "blocked on Supabase creds / no Docker /
 * no local path" and trying to STOP on that basis, when an EMBEDDED Postgres (pglite) runs the real schema +
 * queries with zero external services.
 *
 * THE RULE: you may NOT end a turn declaring database / integration / query work "blocked on creds / Docker /
 * a live DB / no local path" unless you EITHER (a) already reached for an embedded local DB this turn
 * (pglite / better-sqlite3 / :memory: / testcontainers / *-memory-server), OR (b) stated that the blocker is a
 * genuinely managed-service-only thing (real auth tokens, the vendor's exact RLS, production data volume), OR
 * (c) used the explicit `local-db-override:` token. Schema/query CORRECTNESS is almost never creds-blocked.
 *
 * Detection is structural: a BLOCKED-claim verb near a CREDS/live-DB noun, in the final assistant message.
 * Fail-open on any error. Locked by local-db-before-creds-blocked.test.mjs.
 */

import { lastAssistantText } from './lib/transcript.mjs';

// A "blocked / can't / owed" framing — the assistant declaring it can't proceed.
const BLOCKED_VERB = /\b(blocked|gated|owed|can'?t|cannot|can\s+not|no\s+(?:local\s+)?(?:path|way)|unable|stuck|need(?:s|ed)?|require(?:s|d)?|waiting\s+on|depends?\s+on|(?:hold(?:ing)?|held)\s+until)\b/i;

// A creds / managed-DB / live-DB noun — the thing being claimed as the blocker.
const CREDS_NOUN = /\b(creds?|credentials|docker|podman|supabase|live[\s-]?db|live\s+database|live[\s-]?gate|service[\s-]?role\s+key|a\s+real\s+(?:db|database)|prod(?:uction)?\s+(?:db|database)|access\s+token)\b/i;

// Proof the assistant ALREADY reached for an embedded/local DB → no false block.
const LOCAL_DB_TRIED = /\b(pglite|electric-sql\/pglite|better-sqlite3|sqlite(?::|\s|3|\b)|:memory:|in[\s-]?memory\s+(?:db|database|postgres|sqlite)|testcontainers?|mongodb-memory-server|ioredis-mock|embedded\s+(?:db|database|postgres|sqlite)|pg-mem)\b/i;

// A GENUINE managed-service-only reason (these really do need the live service) → allowed.
const GENUINE_MANAGED_REASON = /\b(real\s+(?:auth|user)\s+(?:token|session)|managed\s+service|vendor'?s?\s+(?:exact\s+)?rls|production\s+data\s+volume|oauth\s+(?:flow|session)|a\s+browser\s+session|hardware\s+(?:key|mfa)|paid\s+api\s+key|browserbase|steel)\b/i;

const OVERRIDE = /local-db-override:/i;

// Strip code spans/fences so QUOTING a trigger (e.g. explaining this hook) never false-fires.
function stripCode(reply) {
  return String(reply || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

// Pure core (tested): does the message DECLARE a creds/live-DB block without an embedded-DB attempt or a genuine
// managed reason? Require the blocked-verb and the creds-noun within the SAME sentence-ish window so an unrelated
// "needs X" elsewhere doesn't pair with an unrelated "supabase" mention.
export function declaresCredsBlockWithoutLocalDb(rawReply) {
  const reply = stripCode(rawReply);
  if (!reply) return false;
  if (OVERRIDE.test(reply)) return false;
  if (LOCAL_DB_TRIED.test(reply)) return false;       // already reached for an embedded DB → fine
  if (GENUINE_MANAGED_REASON.test(reply)) return false; // genuinely needs the managed service → fine
  // Pair a blocked-verb with a creds-noun within a bounded window (either order), per sentence.
  for (const sentence of reply.split(/(?<=[.!?\n])/)) {
    if (!CREDS_NOUN.test(sentence)) continue;
    if (BLOCKED_VERB.test(sentence)) return true;
  }
  return false;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }
  const said = lastAssistantText(payload.transcript_path);
  if (!declaresCredsBlockWithoutLocalDb(said)) { process.exit(0); return; }
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `STOP-BLOCKED — you declared database/integration work "blocked on creds / Docker / a live DB" without first standing up an EMBEDDED local database.

Russell, 2026-06-28: "just wire it to local pglite for testing. wtf is wrong with you." Schema/query/isolation CORRECTNESS is almost never creds-blocked — an in-process DB runs the REAL schema + queries with zero external services.

Reach for the embedded DB BEFORE claiming blocked:
  - Postgres  -> @electric-sql/pglite (WASM Postgres in Node; pgvector via @electric-sql/pglite/vector). Apply the real migrations/*.sql + call the real RPCs / project_id WHERE-clauses against a real planner.
  - SQLite    -> better-sqlite3 / :memory: ; Mongo -> mongodb-memory-server ; Redis -> ioredis-mock ; ext-exact parity -> Testcontainers (needs Docker = the FALLBACK).

Then run the proof. Only these are genuinely owed-on-the-managed-service: real auth tokens / OAuth sessions, the vendor's exact RLS, production data volume, paid-API/browser keys.

Do that now, OR state the genuine managed-service reason, OR add  local-db-override: <why an embedded DB truly can't prove this>.`,
  }));
  process.exit(0);
}

if (process.argv[1] && /local-db-before-creds-blocked\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) main().catch(() => process.exit(0));
