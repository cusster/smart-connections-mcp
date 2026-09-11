// Payload and read bounds. get_note used to pass Infinity, returning a 39MB note
// as a successful result; excerpts read whole files to quote 1200 characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultIndex } from '../src/vault.js';
import { makeFixture } from './helpers/fixture.mjs';

const root = path.join(os.tmpdir(), `sc-mcp-test-limits-${process.pid}`);
makeFixture(root);

const LINE = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod';
const BIG = path.join(root, 'huge.md');
fs.writeFileSync(BIG, (LINE + '\n').repeat(160000));        // ~11MB, 160k lines
const BIG_SIZE = fs.statSync(BIG).size;

const idx = new VaultIndex(root);
await idx.load();

// Count bytes actually pulled off disk. A timing comparison is a coin-flip —
// an earlier version of this file asserted `smallMs < fullMs` and passed with the
// byte cap removed entirely.
function countingRead(fn) {
  const real = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => { const n = real.apply(fs, args); bytes += n; return n; };
  try { return { value: fn(), bytes }; } finally { fs.readSync = real; }
}

test('an oversized note is truncated and says so', () => {
  const t = idx.readNote('huge.md', 100_000);
  assert.ok(t.length <= 100_000, `${t.length} chars exceeds the cap`);
  assert.match(t, /truncated — \d+ bytes total/);
});

test('max_chars is a ceiling, including the truncation marker', () => {
  for (const cap of [50, 1000, 100_000]) {
    const t = idx.readNote('huge.md', cap);
    assert.ok(t.length <= cap, `max_chars ${cap} returned ${t.length} chars`);
  }
});

test('a small excerpt reads a bounded number of bytes, not the whole file', () => {
  const { value, bytes } = countingRead(() => idx.readNote('huge.md', 1200));
  assert.ok(value.length <= 1200);
  assert.ok(bytes < BIG_SIZE / 10, `read ${bytes} of ${BIG_SIZE} bytes for a 1200-char excerpt`);
});

test('a block excerpt near the top does not read the whole note', () => {
  // This is the DEFAULT excerpt path: blocks outnumber notes in a real index.
  const { value, bytes } = countingRead(() => idx.readLines('huge.md', [2, 4], 1200));
  assert.equal(value.split('\n').length, 3);
  assert.ok(bytes < BIG_SIZE / 10, `read ${bytes} of ${BIG_SIZE} bytes to quote 3 lines`);
});

test('a block excerpt deep in the note still returns the right lines', () => {
  const text = idx.readLines('huge.md', [159_000, 159_002], 1200);
  assert.equal(text, [LINE, LINE, LINE].join('\n'));
});

test('a short note is returned whole, with no truncation marker', () => {
  assert.equal(idx.readNote('alive.md', 100_000), '# alive\nline two of alive\nline three of alive\n');
});

test('exact-boundary reads do not spuriously mark truncation', () => {
  const body = fs.readFileSync(path.join(root, 'alive.md'), 'utf8');
  assert.equal(idx.readNote('alive.md', body.length), body);
});

test('status() reports both collections and its diagnostics', () => {
  const st = idx.status();
  assert.equal(st.embedded_notes, 6);
  assert.equal(st.embedded_blocks, 1);
  assert.equal(st.notes_missing_on_disk, 0);
  assert.equal(st.deletion_tombstones_applied, 1);
  assert.equal(st.unresolvable_pointers, 1);
  assert.deepEqual(st.multifiles.smart_blocks, ['mf_old']);
});

test('status() does not re-stat every note on each call', () => {
  idx.status();                                   // warm
  const real = fs.existsSync;
  let calls = 0;
  fs.existsSync = (...a) => { calls++; return real.apply(fs, a); };
  try { idx.status(); } finally { fs.existsSync = real; }
  assert.equal(calls, 0, 'the missing-file count must be cached against the loaded index');
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
