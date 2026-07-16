#!/usr/bin/env node
// Tests for large-upload-guard: block oversized scp/rsync uploads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAP_BYTES, pathSizeBytes, oversizeUpload } from './large-upload-guard.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'large-upload-guard-'));
}

/** Create a file of exactly `bytes` (sparse, instant) — must exist before truncate on Windows. */
function bigFile(path, bytes) {
  writeFileSync(path, '');
  truncateSync(path, bytes);
}

test('a small local file is not flagged', () => {
  const dir = scratch();
  try {
    const small = join(dir, 'source.py');
    writeFileSync(small, 'print("hi")\n');
    assert.equal(oversizeUpload(`scp -P 22 ${small} root@host:/workspace/x`), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a local file over the cap is flagged with its size', () => {
  const dir = scratch();
  try {
    const big = join(dir, 'bundle.staging');
    bigFile(big, CAP_BYTES + 1024 * 1024); // 26MB sparse file — instant
    const hit = oversizeUpload(`scp -i key -P 22 ${big} root@host:/workspace/x`);
    assert.ok(hit, 'expected an oversize hit');
    assert.equal(hit.path, big);
    assert.ok(hit.bytes > CAP_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('option flags and remote host:path targets are skipped (not stat-able locally)', () => {
  // -P, -i and the remote target don't exist on local disk -> never flagged.
  assert.equal(oversizeUpload('scp -P 22 -i /no/such/key root@1.2.3.4:/remote/huge'), null);
});

test('a dir whose recursive size exceeds the cap is flagged', () => {
  const dir = scratch();
  try {
    // one big file inside a directory being rsync'd
    bigFile(join(dir, 'evidence.jsonl'), CAP_BYTES + 512 * 1024);
    const hit = oversizeUpload(`rsync -a ${dir} root@host:/dest`);
    assert.ok(hit, 'expected the oversized directory to be flagged');
    assert.equal(hit.path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pathSizeBytes early-outs once over the cap (does not walk forever)', () => {
  const dir = scratch();
  try {
    bigFile(join(dir, 'a.bin'), CAP_BYTES + 1);
    assert.ok(pathSizeBytes(dir) > CAP_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
