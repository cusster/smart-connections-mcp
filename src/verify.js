// Standing proof that this server actually does semantic search.
//
// The failure this guards against is silent: if the query embedder drifts from
// the one that wrote the index, every search still returns ranked results that
// simply are not about the query. Nothing throws.
//
// The test: rebuild a note's embed input EXACTLY as the plugin does, re-embed
// it, and compare to the stored vector. Agreement means ~1.0; disagreement
// collapses it. Nothing about the index is assumed — the number is measured.
//
// Three things this file previously got wrong, all of which inflated confidence:
//   - it embedded the raw note body, while the plugin embeds
//     `${breadcrumbs}:\n${content}`.substring(0, 1894) — so it was comparing
//     different text and spending the safety margin on a self-inflicted gap.
//   - it took items.slice(0, 5), the same five notes every run, so a problem
//     anywhere else in the vault was invisible.
//   - it passed at 0.75. With the correct input the real figure is ~0.99, so
//     0.75 would have waved through a genuinely broken embedder.
//
// It also cannot detect slot misalignment from a mid-read compaction: those
// vectors are all unit-norm and all real, just attached to the wrong notes.
// That is prevented in vault.js by re-checking the file signature after the
// read, not detected here.
import { VaultIndex } from './vault.js';
import { embedQuery, embedInfo } from './embed.js';

const VAULT = process.env.SMART_VAULT_PATH;
if (!VAULT) { console.error('SMART_VAULT_PATH is required'); process.exit(1); }

const SAMPLE = Number(process.env.SMART_VERIFY_SAMPLE || 12);
const PASS = 0.95;
const MAX_CHARS = 1894; // floor(max_tokens 512 * 3.7), the plugin's own figure

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (v) => Math.sqrt(dot(v, v));
const pick = (arr, n) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};

// The plugin's source_get_embed_input_markdown, verbatim.
const noteInput = (relPath, content) => {
  const breadcrumbs = relPath.split('/').join(' > ').replace('.md', '');
  return `${breadcrumbs}:\n${content}`.substring(0, MAX_CHARS);
};
// The plugin's block_get_embed_input_markdown + SmartBlock#breadcrumbs, verbatim.
// Note there is no substring cap on this one; the tokenizer's 512-token limit is
// what bounds it.
const blockInput = (blockKey, content) => {
  const breadcrumbs = blockKey.split('/').join(' > ').split('#').slice(0, -1).join(' > ').replace('.md', '');
  return `${breadcrumbs}\n${content}`;
};

const idx = new VaultIndex(VAULT);
await idx.load();

console.log('=== index ===');
const st = idx.status();
console.log(`  notes embedded : ${st.embedded_notes}   (stale: ${st.stale_notes})`);
console.log(`  blocks embedded: ${st.embedded_blocks}   (stale: ${st.stale_blocks})`);
console.log(`  tombstones      : ${st.deletion_tombstones_applied} deleted notes dropped`);
console.log(`  load retries    : ${st.load_retries_from_concurrent_reindex}`);
console.log(`  model (vault)  : ${st.model}`);
console.log(`  model (query)  : ${embedInfo.model}  pooling=${embedInfo.pooling} normalize=${embedInfo.normalize}`);
console.log(`  multifiles     : sources=[${st.multifiles.smart_sources.join(', ')}] blocks=[${st.multifiles.smart_blocks.join(', ')}]`);
if (st.model && st.model !== embedInfo.model) {
  console.log('  !! MODEL MISMATCH — query vectors will not match the index');
}

console.log('\n=== stored vectors are unit-norm? ===');
let bad = 0;
const all = [...idx.items, ...idx.blocks];
for (const it of all) if (Math.abs(norm(it.vec) - 1) > 0.01) bad++;
console.log(`  ${all.length - bad}/${all.length} unit-norm  ${bad ? '<-- PROBLEM' : 'OK'}`);

let worst = 1;
let worstLabel = '';
let compared = 0;

console.log(`\n=== note self-similarity (random ${SAMPLE}, plugin's exact embed input) ===`);
for (const it of pick(idx.items.filter((i) => !i.stale), SAMPLE)) {
  const body = idx.readNote(it.path, Infinity);
  if (!body) { console.log(`  ----    (unreadable) ${it.path}`); continue; }
  const sim = dot(await embedQuery(noteInput(it.path, body)), it.vec);
  compared++;
  if (sim < worst) { worst = sim; worstLabel = it.path; }
  console.log(`  ${sim.toFixed(4)}  ${it.path.slice(0, 66)}`);
}

console.log(`\n=== block self-similarity (random ${SAMPLE}) ===`);
for (const b of pick(idx.blocks.filter((x) => !x.stale && x.lines), SAMPLE)) {
  const body = idx.readLines(b.path, b.lines, Infinity);
  if (!body) { console.log(`  ----    (unreadable) ${b.key}`); continue; }
  const sim = dot(await embedQuery(blockInput(b.key, body)), b.vec);
  compared++;
  if (sim < worst) { worst = sim; worstLabel = b.key; }
  console.log(`  ${sim.toFixed(4)}  ${b.key.slice(0, 66)}`);
}

// An empty sample would leave `worst` at its initial 1 and report PASS without
// having measured anything — the exact kind of vacuous green this file exists to
// prevent.
console.log(`\n  samples compared: ${compared}`);
if (!compared) {
  console.log('  FAIL — nothing was measured. No readable, non-stale notes or blocks in the index.');
} else {
  console.log(`  worst self-similarity: ${worst.toFixed(4)}  (${worstLabel.slice(0, 60)})`);
  console.log(worst > PASS
    ? `  PASS — query embedder shares the index's vector space (threshold ${PASS}).`
    : `  FAIL — below ${PASS}. Embedder drift: searches would return confident nonsense.`);
}

const q = process.argv.slice(2).join(' ');
if (q) {
  console.log(`\n=== live query: "${q}" ===`);
  const qv = await embedQuery(q);
  for (const h of idx.search(qv, { limit: 8 })) {
    console.log(`  ${h.score.toFixed(4)}  [${h.matched}] ${h.path}${h.block ? ' ' + h.block : ''}`);
  }
}

process.exitCode = compared && worst > PASS && !bad ? 0 : 1;
