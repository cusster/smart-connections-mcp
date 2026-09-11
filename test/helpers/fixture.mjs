// Builds a synthetic Smart Connections vault whose vectors encode their own slot
// number: slot i is the unit vector e_(i mod 384). A resolved vector therefore
// says exactly which slot of which file it came from, which is what lets these
// tests catch "wrong vector, still unit-norm" bugs that no norm check can see.
import fs from 'node:fs';
import path from 'node:path';

export const DIMS = 384;
// The dimension smart_blocks/mf_old marks hot at slot 4. Deliberately unequal to
// any slot index used by packed(), so "wrong file" and "wrong slot" are
// distinguishable in an assertion.
export const BLOCK_DIM = 200;

export function slotOf(vec) {
  for (let d = 0; d < DIMS; d++) if (vec[d] > 0.5) return d;
  return -1;
}

const packed = (slots) => {
  const b = Buffer.alloc(slots * DIMS * 4);
  for (let s = 0; s < slots; s++) b.writeFloatLE(1, s * DIMS * 4 + (s % DIMS) * 4);
  return b;
};

const ref = (file, file_i, at, read_hash = 'h1') => ({ file, file_i, at, read_hash });
const rec = (p, embedding, blocks_data = {}) => JSON.stringify({
  class_name: 'SmartSource', path: p, last_read: { hash: 'h1' }, embedding, blocks_data,
});

export function makeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
  const SRC = path.join(root, '.smart-env', 'smart_sources');
  const BLK = path.join(root, '.smart-env', 'smart_blocks');
  fs.mkdirSync(SRC, { recursive: true });
  fs.mkdirSync(BLK, { recursive: true });

  // A plugin secrets file, to prove dot-folders are unreachable.
  fs.mkdirSync(path.join(root, '.obsidian', 'plugins', 'somePlugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.obsidian', 'plugins', 'somePlugin', 'data.json'), '{"apiKey":"sk-SECRET"}');
  fs.writeFileSync(path.join(root, '.obsidian', 'workspace.json'), '{}');

  for (const n of ['alive', 'ghost', 'multiref', 'blocky', 'stale', 'lost'])
    fs.writeFileSync(path.join(root, n + '.md'), `# ${n}\nline two of ${n}\nline three of ${n}\n`);
  // Two notes in project folders, so folder scoping has something to scope. They
  // reuse slots 0 and 1, i.e. the same vectors as alive.md and blocky.md — a
  // query therefore matches across folders and the filter is what separates them.
  for (const [dir, n] of [['ProjA', 'one'], ['ProjB', 'two']]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, n + '.md'), `# ${n}\nbody of ${dir}/${n}\n`);
  }
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'ok.md'), '# fine\nreal content here\n');

  fs.writeFileSync(path.join(SRC, 'mf_old'), packed(6));
  fs.writeFileSync(path.join(SRC, 'mf_new'), packed(6));
  // smart_blocks/mf_old SHARES A NAME with smart_sources/mf_old and must hold
  // DIFFERENT data, or the test that claims to catch cross-collection resolution
  // proves nothing. packed() puts slot 4's hot dimension at 4; this file puts
  // slot 4's hot dimension at BLOCK_DIM, so a vector read from the wrong file is
  // immediately visible. (An earlier fixture wrote dim 4 here too — the two
  // files were byte-identical at slot 4 and the test passed with the bug
  // reintroduced.)
  const blk = Buffer.alloc(6 * DIMS * 4);
  blk.writeFloatLE(1, 4 * DIMS * 4 + BLOCK_DIM * 4);
  fs.writeFileSync(path.join(BLK, 'mf_old'), blk);

  const L = [
    `"smart_sources:alive.md": ${rec('alive.md', { default: { mf_old: ref('mf_old', 0, 1) } })},`,
    // a record, then a tombstone: must not survive
    `"smart_sources:ghost.md": ${rec('ghost.md', { default: { mf_old: ref('mf_old', 2, 1) } })},`,
    '"smart_sources:ghost.md": null,',
    // two refs: the greater `at` must win, regardless of listing order
    `"smart_sources:multiref.md": ${rec('multiref.md', { default: {
      mf_old: ref('mf_old', 5, 100),
      mf_new: ref('mf_new', 3, 999),
    } })},`,
    // read_hash disagrees with last_read.hash -> the vector predates the file's
    // current content. Flagged, not dropped.
    `"smart_sources:stale.md": ${rec('stale.md', { default: { mf_old: ref('mf_old', 2, 1, 'OLDHASH') } })},`,
    // file_i past the end of a 6-slot multifile: unresolvable, so the note
    // vanishes from the index and must be COUNTED rather than lost silently.
    `"smart_sources:lost.md": ${rec('lost.md', { default: { mf_old: ref('mf_old', 999, 1) } })},`,
    `"smart_sources:ProjA/one.md": ${rec('ProjA/one.md', { default: { mf_old: ref('mf_old', 0, 1) } })},`,
    `"smart_sources:ProjB/two.md": ${rec('ProjB/two.md', { default: { mf_old: ref('mf_old', 0, 1) } })},`,
    `"smart_sources:blocky.md": ${rec('blocky.md', { default: { mf_old: ref('mf_old', 1, 1) } }, {
      '#blocky#{1}': {
        key: 'blocky.md#blocky#{1}', lines: [1, 3], size: 300, should_embed: true,
        last_read: { hash: 'h1' }, embedding: { default: { mf_old: ref('mf_old', 4, 1) } },
      },
      // should_embed false -> no vector exists for it, must be skipped
      '#blocky#{2}': {
        key: 'blocky.md#blocky#{2}', lines: [2, 3], size: 10, should_embed: false,
        last_read: { hash: 'h1' }, embedding: { default: { mf_old: ref('mf_old', 0, 1) } },
      },
    })},`,
  ];
  fs.writeFileSync(path.join(SRC, 'smart_sources.ajson'), L.join('\n') + '\n');
  fs.writeFileSync(path.join(root, '.smart-env', 'smart_env.json'), JSON.stringify({
    smart_sources: { embed_model: { transformers: { model_key: 'TaylorAI/bge-micro-v2' } } },
  }));
  return { root, SRC, BLK };
}

export function padAjson(srcDir, count) {
  const p = path.join(srcDir, 'smart_sources.ajson');
  const base = fs.readFileSync(p, 'utf8').trimEnd().split('\n');
  const pad = [];
  for (let i = 0; i < count; i++) {
    pad.push(`"smart_sources:pad/note${i}.md": ${rec(`pad/note${i}.md`, {
      default: { mf_old: ref('mf_old', i % 6, 1) },
    })},`);
  }
  fs.writeFileSync(p, [...base, ...pad].join('\n') + '\n');
}
