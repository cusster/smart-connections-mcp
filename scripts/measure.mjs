// Measure this server against YOUR vault. Nothing here is baked into the docs —
// every number the README would otherwise assert is produced by running this,
// because the interesting ones drift: the index grows while Obsidian runs, and
// timings depend on whether the vault sits on a native filesystem or drvfs.
//
//   SMART_VAULT_PATH=/path/to/vault npm run measure
//
// Sections:
//   1. Index      — what loaded
//   2. Coverage   — how much of the vault's text sits inside some vector
//   3. Recall     — does block search actually find deep passages
//   4. Timings    — on this machine, this vault, right now
import fs from 'node:fs';
import path from 'node:path';
import { VaultIndex } from '../src/vault.js';
import { embedQuery } from '../src/embed.js';

const VAULT = process.env.SMART_VAULT_PATH;
if (!VAULT) { console.error('SMART_VAULT_PATH is required'); process.exit(1); }

const MAX_CHARS = 1894;           // floor(max_tokens 512 * 3.7), the plugin's figure
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
const ms = (t) => `${Date.now() - t}ms`;

const idx = new VaultIndex(VAULT);
let t = Date.now();
await idx.load();
const loadMs = ms(t);

console.log('=== 1. Index ===');
const st = idx.status();
console.log(`  notes embedded            : ${st.embedded_notes}`);
console.log(`  blocks embedded           : ${st.embedded_blocks}`);
console.log(`  stale (note / block)      : ${st.stale_notes} / ${st.stale_blocks}`);
console.log(`  deletion tombstones       : ${st.deletion_tombstones_applied}`);
console.log(`  unresolvable pointers     : ${st.unresolvable_pointers}`);
console.log(`  multifiles in use         : sources=${JSON.stringify(st.embedding_files_in_use.smart_sources)} blocks=${JSON.stringify(st.embedding_files_in_use.smart_blocks)}`);
console.log(`  model                     : ${st.model}`);

// ---------------------------------------------------------------------------
// 2. Coverage. ONE stated method, applied to every row of the table.
//
// A character is "covered" if it falls inside the text some vector was built
// from. Note vectors see `${breadcrumbs}:\n${content}` cut to MAX_CHARS, so the
// breadcrumbs eat into the content budget. Block vectors see
// `${breadcrumbs}\n${content}` for their line range, cut the same way.
//
// APPROXIMATION, stated plainly: the plugin truncates by TOKEN count, not
// characters (see prepare_input). MAX_CHARS is its own char-budget constant, so
// this is the plugin's estimate of the same boundary, not the exact boundary.
// Treat these as "close", not "exact".
// ---------------------------------------------------------------------------
console.log('\n=== 2. Coverage (method: chars inside a vector\'s input window) ===');
let totalChars = 0, noteCovered = 0, unionCovered = 0, overCap = 0, readable = 0;
const blocksByPath = new Map();
for (const b of idx.blocks) {
  if (!blocksByPath.has(b.path)) blocksByPath.set(b.path, []);
  blocksByPath.get(b.path).push(b);
}
for (const it of idx.items) {
  const body = idx.readNote(it.path, Infinity);
  if (body === null) continue;
  readable++;
  const lines = body.split('\n');
  totalChars += body.length;

  const noteBc = it.path.split('/').join(' > ').replace('.md', '').length;
  const noteBudget = Math.max(0, MAX_CHARS - noteBc - 2);
  if (body.length > noteBudget) overCap++;
  const noteChars = Math.min(body.length, noteBudget);
  noteCovered += noteChars;

  // union: mark characters covered by the note window OR any block window
  const covered = new Uint8Array(body.length);
  for (let i = 0; i < noteChars; i++) covered[i] = 1;
  const offsets = [];
  let acc = 0;
  for (const l of lines) { offsets.push(acc); acc += l.length + 1; }
  for (const b of blocksByPath.get(it.path) ?? []) {
    if (!Array.isArray(b.lines)) continue;
    const bBc = b.key.split('/').join(' > ').split('#').slice(0, -1).join(' > ').replace('.md', '').length;
    const budget = Math.max(0, MAX_CHARS - bBc - 1);
    const start = offsets[Math.max(0, b.lines[0] - 1)] ?? 0;
    const endLine = Math.min(b.lines[1], lines.length);
    const end = (offsets[endLine - 1] ?? body.length) + (lines[endLine - 1]?.length ?? 0);
    for (let i = start; i < Math.min(end, start + budget, body.length); i++) covered[i] = 1;
  }
  for (let i = 0; i < body.length; i++) if (covered[i]) unionCovered++;
}
console.log(`  notes read from disk      : ${readable}`);
console.log(`  total characters          : ${totalChars.toLocaleString()}`);
console.log(`  notes exceeding the cap   : ${overCap} (${pct(overCap, readable)})`);
console.log(`  covered by note vectors   : ${pct(noteCovered, totalChars)}`);
console.log(`  covered by note + blocks  : ${pct(unionCovered, totalChars)}   <- what scope:auto searches`);
console.log(`  still in no vector        : ${pct(totalChars - unionCovered, totalChars)}`);

// ---------------------------------------------------------------------------
// 3. Recall. Quote a passage from deep inside a note and see whether that note
// comes back. Sampled across every note long enough to have content past the
// note-vector cap, so the result is not a hand-picked six.
// ---------------------------------------------------------------------------
console.log('\n=== 3. Recall: can a note be found by its own deep text? ===');
const OFFSET = 0.8, QLEN = 300, SAMPLE = Number(process.env.SMART_MEASURE_SAMPLE || 30);
const long = idx.items
  .map((i) => ({ i, txt: idx.readNote(i.path, Infinity) || '' }))
  .filter((x) => x.txt.length > MAX_CHARS * 2);
const stride = Math.max(1, Math.floor(long.length / SAMPLE));
const sample = long.filter((_, n) => n % stride === 0).slice(0, SAMPLE);
const rank = (hits, p) => { const r = hits.findIndex((h) => h.path === p); return r < 0 ? Infinity : r + 1; };
const res = { notes: [], blocks: [], auto: [] };
for (const { i, txt } of sample) {
  const q = txt.slice(Math.floor(txt.length * OFFSET), Math.floor(txt.length * OFFSET) + QLEN);
  const qv = await embedQuery(q);
  for (const scope of ['notes', 'blocks', 'auto']) {
    res[scope].push(rank(idx.search(qv, { limit: 500, minScore: -1, scope }), i.path));
  }
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const top1 = (a) => a.filter((r) => r === 1).length;
console.log(`  sample: ${sample.length} notes longer than ${MAX_CHARS * 2} chars, query = ${QLEN} chars from ${OFFSET * 100}% through`);
for (const scope of ['notes', 'blocks', 'auto']) {
  console.log(`  scope=${scope.padEnd(7)} ranked #1: ${String(top1(res[scope])).padStart(3)}/${sample.length}   median rank: ${median(res[scope])}`);
}
const regress = res.auto.filter((r, n) => r > res.notes[n]).length;
console.log(`  auto WORSE than notes-only in ${regress}/${sample.length} queries — adding blocks is not free`);

// ---------------------------------------------------------------------------
console.log('\n=== 4. Timings (this machine, this vault, right now) ===');
console.log(`  cold load                 : ${loadMs}`);
t = Date.now(); await idx.load(); console.log(`  warm load (no change)     : ${ms(t)}`);
const qv = await embedQuery('cache eviction policy');
t = Date.now(); idx.search(qv, { limit: 10, minScore: 0.5 }); console.log(`  search, no excerpts       : ${ms(t)}`);
t = Date.now();
for (const h of idx.search(qv, { limit: 10, minScore: -1 })) {
  h.matched === 'block' ? idx.readLines(h.path, h.lines, 1200) : idx.readNote(h.path, 1200);
}
console.log(`  10 excerpts               : ${ms(t)}`);
t = Date.now(); idx.status(); console.log(`  index_status (cold count) : ${ms(t)}`);
t = Date.now(); idx.status(); console.log(`  index_status (cached)     : ${ms(t)}`);
console.log('\nNote: timings on a Windows-hosted vault reached through /mnt/c are');
console.log('dominated by per-file syscalls, not by vector maths.');
