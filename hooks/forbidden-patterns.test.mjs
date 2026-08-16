// forbidden-patterns.test.mjs — run: node --test ~/.claude/hooks/forbidden-patterns.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoAboveItsOwnCost } from './forbidden-patterns.mjs';

// The exact shape written twice on 2026-08-15, in one session, in one file.
const MEMO_ABOVE_THE_COST = `
    def file_first_catalog(self):
        snapshot_version, file_statuses = self._file_first_inventory()
        if self._file_first_catalog_version == snapshot_version:
            return self._file_first_catalog_memo
        built = build_standard_entry_catalog(snapshot_version, file_statuses)
        return built
`;

const SECOND_INSTANCE = `
    def _code_entries_by_catalog_ref(self):
        code_entries, _, snapshot_version = self._symbol_catalog_state()
        if self._code_entries_snapshot == snapshot_version:
            return self._code_entries_memo
        return snapshot_version, build(code_entries)
`;

// The correct shape: the key is cheap and needs no derivation.
const MEMO_BELOW_THE_COST = `
    def _symbol_catalog_state(self):
        fingerprint = self._symbol_state_stat_fingerprint()
        if self._symbol_state_fingerprint == fingerprint:
            return self._symbol_state_memo
        derived = self._derive_symbol_catalog_state()
        self._symbol_state_fingerprint = fingerprint
        return derived
`;

// An ordinary unpack with no cache anywhere near it.
const PLAIN_UNPACK = `
    def resolve(self):
        version, entries = self._catalog_state()
        return {name: entry for name, entry in entries.items()}
`;

// A cache keyed on a caller-supplied argument, not on a derivation.
const CACHE_ON_AN_ARGUMENT = `
    def render(self, snapshot_version):
        if self._render_snapshot == snapshot_version:
            return self._render_memo
        payload, extra = self._build_payload()
        return payload
`;

test('BLOCKS a memo keyed on what the expensive call produced', () => {
  assert.equal(memoAboveItsOwnCost(MEMO_ABOVE_THE_COST).length, 1);
});

test('BLOCKS the second instance shape from the same session', () => {
  assert.equal(memoAboveItsOwnCost(SECOND_INSTANCE).length, 1);
});

test('ALLOWS a memo keyed on a cheap fingerprint above the cost', () => {
  assert.deepEqual(memoAboveItsOwnCost(MEMO_BELOW_THE_COST), []);
});

test('ALLOWS an ordinary unpack with no cache', () => {
  assert.deepEqual(memoAboveItsOwnCost(PLAIN_UNPACK), []);
});

test('ALLOWS a cache keyed on a caller-supplied argument', () => {
  assert.deepEqual(memoAboveItsOwnCost(CACHE_ON_AN_ARGUMENT), []);
});

test('reports the offending pair so the fix is obvious', () => {
  const [finding] = memoAboveItsOwnCost(MEMO_ABOVE_THE_COST);
  assert.match(finding, /_file_first_inventory/);
  assert.match(finding, /if self\._file_first_catalog_version/);
});

test('empty and non-Python input is ignored', () => {
  assert.deepEqual(memoAboveItsOwnCost(''), []);
  assert.deepEqual(memoAboveItsOwnCost('const a = b();'), []);
});
