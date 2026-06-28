// Tests for local-db-before-creds-blocked — the pure detector. Run: node --test local-db-before-creds-blocked.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaresCredsBlockWithoutLocalDb } from './local-db-before-creds-blocked.mjs';

// POSITIVES — declaring a creds/live-DB block with NO embedded-DB attempt → must BLOCK (≥3 differently worded).
test('blocks "gated on your Supabase creds/Docker"', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('Every remaining item is gated on your Supabase creds or Docker; no local path.'), true);
});
test('blocks "the isolation proof can\'t run without a live database"', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb("The vector-RPC isolation proof can't run without a live database."), true);
});
test('blocks "needs Docker / a real db"', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('That proof needs Docker and a real db, so it stays owed.'), true);
});
test('blocks "owed live — held until a live-db pass"', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('The integration->main merge is held until a live-db pass.'), true);
});

// NEGATIVES — already reached for an embedded DB → must NOT block.
test('does NOT block when pglite was used', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('I wired it to pglite to run the isolation proof locally against real Postgres — no Docker needed.'), false);
});
test('does NOT block when better-sqlite3 / :memory: is used', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('Stood up an in-memory sqlite database and ran the queries; supabase not required.'), false);
});

// NEGATIVES — a GENUINE managed-service reason → allowed.
test('does NOT block a genuine managed-service reason (real auth tokens)', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('This one genuinely needs real auth tokens for the OAuth session, so it needs the live service.'), false);
});

// NEGATIVE — override token.
test('honors the local-db-override token', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('Blocked on Supabase creds. local-db-override: pgvector cosine parity differs and the test asserts an exact score.'), false);
});

// NEGATIVES — no false positives.
test('does NOT fire on an unrelated reply (no creds noun)', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('Shipped the store wiring and the suite is green.'), false);
});
test('does NOT fire on a creds noun with NO blocked verb (just a mention)', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('I added the Supabase client to the route and committed it.'), false);
});
test('does NOT fire when the trigger is only inside a code span (meta-quote)', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb('The hook matches `blocked on supabase creds` literally, so my quote should not trip it.'), false);
});
test('empty reply → no block', () => {
  assert.equal(declaresCredsBlockWithoutLocalDb(''), false);
});
