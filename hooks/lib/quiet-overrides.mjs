/**
 * quiet-overrides — a SIDE CHANNEL for hook override tokens, so they stop
 * being printed at Russell.
 *
 * THE PROBLEM (Russell, 2026-07-30: "can you make a permanent global rule not
 * to spit out hook garbage to me? i dont benefit from it."): roughly thirty
 * hooks accept an escape token, and every one of them reads that token out of
 * the assistant's VISIBLE reply text. So satisfying a guard means printing
 * `style-override: ...` or `SHIP_RITUAL_SKIP_COMMIT: ...` into the chat — a
 * machine receipt in a human conversation. A learning was already written for
 * this on 2026-07-29 ("machine acknowledgements are receipts, not the answer")
 * and it did NOT stop the behavior, because the hooks' own contracts require
 * the tokens. An advisory rule cannot beat a mechanical requirement.
 *
 * THE FIX: a file the assistant writes instead of speaking. A hook asks
 * `overrideStated(name, replyText)` and gets a yes if the token appears EITHER
 * in the reply (unchanged, so nothing breaks) OR in the side channel. The new
 * behavior is purely additive; a hook that has not adopted the helper yet is
 * unaffected.
 *
 * SCOPED BY A SHORT TTL, deliberately. The assistant declares an override from
 * a Bash call, which has no session or turn identity to key on, so freshness is
 * the available guarantee: an override is honored only within
 * QUIET_OVERRIDE_TTL_MS of being written. A stale escape must never linger and
 * silently disarm a guard that should have fired — the same leak the Getty
 * marker hit on 2026-07-21, where a marker from one session blocked another.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Resolved PER CALL, not frozen at import. A path captured at module load ignores any later
// QUIET_OVERRIDE_PATH change, which makes the env var a lie and the module untestable — a test
// pointing at a scratch file would silently keep reading the real one.
function overridePath() {
  return process.env.QUIET_OVERRIDE_PATH
    || join(homedir(), '.claude', 'state', 'quiet-overrides.json');
}

// One turn's worth of wall-clock. Long enough for a reply plus its Stop-hook
// pass, short enough that an override cannot survive into unrelated work.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// How far into the future a stamp may sit and still be believed. Covers ordinary clock
// granularity between the writer process and the reading hook — not a real clock jump.
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

function ttlMs() {
  const configured = Number(process.env.QUIET_OVERRIDE_TTL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS;
}

/** Read the side-channel record, or an empty one when absent/corrupt (fail open). */
export function readQuietOverrides() {
  try {
    if (!existsSync(overridePath())) return {};
    const stored = JSON.parse(readFileSync(overridePath(), 'utf8'));
    return stored && typeof stored === 'object' ? stored : {};
  } catch {
    return {};
  }
}

/**
 * Declare an override without printing it. `reason` is still required in
 * spirit — a silent override must still say why, it just says it to the file
 * instead of to Russell, so the audit trail survives.
 */
export function declareQuietOverride(name, reason, now = Date.now()) {
  try {
    const stored = readQuietOverrides();
    stored[String(name)] = {
      reason: String(reason || '').slice(0, 500),
      writtenAt: now,
    };
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `name` overridden right now — by the side channel (fresh), or
 * (back-compat) by the token appearing in the reply text?
 *
 * `replyText` stays first-class so every existing hook keeps working exactly
 * as it does today while hooks migrate one at a time.
 */
export function overrideStated(name, replyText = '', now = Date.now()) {
  const token = String(name);
  if (token && String(replyText || '').includes(token)) return true;

  const record = readQuietOverrides()[token];
  if (!record || !Number.isFinite(Number(record.writtenAt))) return false;

  // A FUTURE-dated stamp must never count as fresh (found by red-teaming no-junk-files,
  // 2026-08-02). `now - writtenAt <= ttl` alone is satisfied by every negative age, so one
  // backward clock movement — an NTP correction, a VM resume, a DST-adjacent tooling bug —
  // turns every override already on disk into a PERMANENT disarm of every guard reading this
  // channel, `ship-ritual-guard` included. That is precisely the lingering-escape leak this
  // module's header says it exists to prevent. Small negative ages are kept legal because the
  // writer is a separate short-lived process and clock granularity can invert two near-
  // simultaneous reads by a hair.
  const ageMs = now - Number(record.writtenAt);
  if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) return false;
  return ageMs <= ttlMs();
}

/** The reason recorded for a fresh quiet override, for a hook that wants to log it. */
export function quietOverrideReason(name, now = Date.now()) {
  const record = readQuietOverrides()[String(name)];
  if (!record || !overrideStated(name, '', now)) return '';
  return String(record.reason || '');
}
