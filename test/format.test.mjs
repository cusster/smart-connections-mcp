// Index-format correctness. Every case here is a bug that produced unit-norm
// vectors and no error, i.e. one that only a slot-identifying fixture can catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { VaultIndex } from '../src/vault.js';
import { makeFixture, slotOf, BLOCK_DIM } from './helpers/fixture.mjs';

const root = path.join(os.tmpdir(), `sc-mcp-test-format-${process.pid}`);
makeFixture(root);
const idx = new VaultIndex(root);
await idx.load();

test('deletion tombstones remove the note (C1)', () => {
  const paths = idx.items.map((i) => i.path);
  assert.ok(!paths.includes('ghost.md'), `ghost.md survived its tombstone: ${paths.join(', ')}`);
  assert.equal(idx.tombstones, 1);
});

test('last-wins still applies to non-deleted records', () => {
  assert.deepEqual(idx.items.map((i) => i.path).sort(),
    ['ProjA/one.md', 'ProjB/two.md', 'alive.md', 'blocky.md', 'multiref.md', 'stale.md']);
});

test('embedding ref is chosen by greatest `at`, not listing order (C2)', () => {
  const mr = idx.items.find((i) => i.path === 'multiref.md');
  assert.ok(mr, 'multiref.md missing');
  // mf_old slot 5 is listed first; mf_new slot 3 has the later `at` and must win.
  assert.equal(slotOf(mr.vec), 3);
});

test('block vectors resolve against smart_blocks/, not the same-named source file', () => {
  assert.equal(idx.blocks.length, 1, 'expected exactly one should_embed block');
  // slot 4 of smart_blocks/mf_old marks BLOCK_DIM; slot 4 of smart_sources/mf_old
  // marks dim 4. Resolving against the wrong file yields 4 — unit-norm, no error.
  assert.equal(slotOf(idx.blocks[0].vec), BLOCK_DIM,
    'resolved against smart_sources/mf_old instead of smart_blocks/mf_old');
});

test('blocks with should_embed:false are skipped', () => {
  assert.ok(!idx.blocks.some((b) => b.subKey === '#blocky#{2}'));
});

test('block line ranges are 1-based inclusive, matching get_line_range2', () => {
  assert.equal(idx.readLines('blocky.md', [1, 3]), '# blocky\nline two of blocky\nline three of blocky');
  assert.equal(idx.readLines('blocky.md', [2, 2]), 'line two of blocky');
});

test('search collapses to one row per note and reports what matched', () => {
  const q = new Float32Array(384); q[BLOCK_DIM] = 1;   // the block's vector
  const hits = idx.search(q, { limit: 10, minScore: 0.5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'blocky.md');
  assert.equal(hits[0].matched, 'block');
  assert.deepEqual(hits[0].lines, [1, 3]);
});

test('scope:notes excludes block vectors', () => {
  const q = new Float32Array(384); q[BLOCK_DIM] = 1;
  assert.equal(idx.search(q, { limit: 10, minScore: 0.5, scope: 'notes' }).length, 0);
  // and scope:blocks still finds it, so the exclusion is scope-driven, not an
  // artefact of the query missing everything
  assert.equal(idx.search(q, { limit: 10, minScore: 0.5, scope: 'blocks' }).length, 1);
});

test('a vector whose read_hash predates the file is flagged, not dropped', () => {
  const stale = idx.items.filter((i) => i.stale).map((i) => i.path);
  assert.deepEqual(stale, ['stale.md'], 'read_hash != last_read.hash must set stale');
  assert.ok(idx.items.some((i) => i.path === 'stale.md'), 'stale notes stay searchable');
  assert.equal(idx.items.find((i) => i.path === 'alive.md').stale, false);
});

test('an unresolvable pointer is counted, not silently dropped', () => {
  // lost.md points at slot 999 of a 6-slot multifile.
  assert.ok(!idx.items.some((i) => i.path === 'lost.md'), 'unreadable vector must not be served');
  assert.equal(idx.unresolvable, 1);
  assert.equal(idx.status().unresolvable_pointers, 1,
    'index_status must report it, or "search never finds that note" is undiagnosable');
});

test('a non-finite stored vector never reaches a caller', () => {
  const poisoned = new VaultIndex(root);
  poisoned.items = [
    { path: 'inf.md', vec: (() => { const v = new Float32Array(384); v[0] = Infinity; return v; })(), stale: false },
    { path: 'ok.md', vec: (() => { const v = new Float32Array(384); v[0] = 1; return v; })(), stale: false },
  ];
  poisoned.blocks = [];
  const q = new Float32Array(384); q[0] = 1;
  const hits = poisoned.search(q, { limit: 10, minScore: -1 });
  assert.deepEqual(hits.map((h) => h.path), ['ok.md'], 'Infinity sorts first and serialises as null');
});

test('a malformed line is skipped without taking the load down', async () => {
  const fs = await import('node:fs');
  const p = path.join(root, '.smart-env', 'smart_sources', 'smart_sources.ajson');
  const orig = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, orig + 'this is not a record at all\n"unterminated: {broken\n');
  const idx2 = new VaultIndex(root);
  await idx2.load(true);
  assert.equal(idx2.items.length, 6);
  fs.writeFileSync(p, orig);
});

test('concurrent loads share one parse instead of each re-reading the index', async () => {
  const idx2 = new VaultIndex(root);
  const [a, b, c] = await Promise.all([idx2.load(), idx2.load(), idx2.load()]);
  assert.equal(idx2.items.length, 6);
  assert.deepEqual([a, b, c], [undefined, undefined, undefined]);
});

test('folder scoping restricts the pool before ranking', () => {
  // slot 0 is shared by alive.md, ProjA/one.md and ProjB/two.md, so an unscoped
  // query matches all three and the filter is the only thing separating them.
  const q = new Float32Array(384); q[0] = 1;
  const all = idx.search(q, { limit: 10, minScore: 0.5 }).map((h) => h.path).sort();
  assert.deepEqual(all, ['ProjA/one.md', 'ProjB/two.md', 'alive.md']);

  assert.deepEqual(idx.search(q, { limit: 10, minScore: 0.5, folder: 'ProjA' }).map((h) => h.path),
    ['ProjA/one.md']);
  assert.deepEqual(idx.search(q, { limit: 10, minScore: 0.5, folder: ['ProjA', 'ProjB'] }).map((h) => h.path).sort(),
    ['ProjA/one.md', 'ProjB/two.md']);
});

test('folder matching is case-insensitive and segment-aware', () => {
  const q = new Float32Array(384); q[0] = 1;
  assert.deepEqual(idx.search(q, { limit: 10, minScore: 0.5, folder: 'proja' }).map((h) => h.path),
    ['ProjA/one.md'], 'folder names are typed from memory; match case-insensitively');
  // "Proj" must NOT prefix-match "ProjA"/"ProjB" — that would make scoping
  // unpredictable the moment two projects share a prefix.
  assert.equal(idx.search(q, { limit: 10, minScore: 0.5, folder: 'Proj' }).length, 0);
  assert.equal(idx.search(q, { limit: 10, minScore: 0.5, folder: 'ProjA/' }).length, 1, 'a trailing slash is tolerated');
});

test('limit applies WITHIN the folder, not to a post-filtered global top-N', () => {
  const q = new Float32Array(384); q[0] = 1;
  // limit 1 unscoped would return one of the three; scoped to ProjB it must
  // still return ProjB's note rather than nothing.
  assert.deepEqual(idx.search(q, { limit: 1, minScore: 0.5, folder: 'ProjB' }).map((h) => h.path),
    ['ProjB/two.md']);
});

test('status() lists folders with counts so a caller can discover them', () => {
  const f = idx.status().folders;
  assert.ok(f.ProjA && f.ProjB, `expected ProjA/ProjB in ${JSON.stringify(Object.keys(f))}`);
  assert.equal(f.ProjA.notes, 1);
});
