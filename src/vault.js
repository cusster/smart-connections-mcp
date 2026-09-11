// Reader for the Smart Connections v4 on-disk index (smart-env 3.x layout).
//
// FORMAT, verified empirically against a live vault rather than taken from docs:
//
//   .smart-env/smart_sources/smart_sources.ajson
//       An APPEND-ONLY log, one record per line:  "smart_sources:<path>": { ... },
//       A key may recur; the LAST occurrence wins. A line whose value is `null`
//       is a DELETION TOMBSTONE — the note is gone (deleted, renamed, excluded).
//       Skipping tombstones leaves the previous record standing as "last-wins",
//       so deleted notes keep ranking forever. This vault carries ~900 of them.
//
//   Each record carries a POINTER, not a vector:
//       "embedding": { "default": { "<fingerprint>": {
//           "file": "mf_ccarbz", "file_i": 18, "read_hash": "1xx9otn", "at": 178… } } }
//       `default` is a MAP keyed by model fingerprint (which defaults to the
//       multifile name), so there can be several refs per note — different models,
//       or a pre- and post-compaction file. The plugin selects the one with the
//       greatest `at` and reads the name from `ref.file`, NOT from the map key
//       (see get_embedding_ref in the plugin bundle); #pickRef mirrors that.
//       Older vaults store `embedding.default` as a single ref plus an
//       `embedding.history` array — also handled.
//
//   Blocks: each source record carries `blocks_data`, a map of
//       "#Heading#{n}" -> { lines:[start,end], size, should_embed, embedding:{…} }
//       with the SAME pointer shape. Only `should_embed` blocks have vectors.
//       This matters more than it looks: the plugin embeds a note's own body
//       truncated to floor(max_tokens * 3.7) = 1894 chars, which on this vault
//       leaves 72.8% of note bytes outside any note-level vector. It compensates
//       by embedding blocks chosen to minimise that loss, and its own semantic
//       lookup searches blocks, not sources (smart_env.json:
//       lookup_lists.results_collection_key = "smart_blocks"). Reading note
//       vectors alone therefore reproduces neither the coverage nor the ranking.
//
//   .smart-env/{smart_sources,smart_blocks}/mf_<id>
//       Packed float32[384], 1536 bytes per record, no header. `file_i` is the
//       slot index. Vectors are L2-normalised (measured: norm == 1.0 exactly),
//       so cosine similarity is a plain dot product.
//       NOTE the two directories contain DIFFERENT files that share a name:
//       smart_sources/mf_ccarbz and smart_blocks/mf_ccarbz are unrelated. A
//       buffer cache keyed on the bare name resolves block pointers against the
//       source file and returns unit-norm vectors for the wrong content, with no
//       error — hence #buffers is keyed by collection + name.
//
// This differs from Smart Connections 3.x, where vectors were inline under an
// "embeddings" key. Servers written for that format find zero vectors here.
//
// Note also that the index holds NO note text ("text": null throughout) — only
// locations. Body text is read from the markdown files on demand.
import fs from 'node:fs';
import path from 'node:path';

const DIMS = 384;
const STRIDE = DIMS * 4; // float32
const EMBED_TYPE = 'default';
const SOURCES = 'smart_sources';
const BLOCKS = 'smart_blocks';

// The index is rewritten underneath us by a running Obsidian. Compaction is the
// dangerous case: it writes a new multifile and RENUMBERS every file_i, so an
// ajson read from before it paired with a multifile read from after it yields a
// vector per note that belongs to a *different* note — all still unit-norm, so
// no norm check can detect it. #signature is therefore taken before AND after
// the read, and a mismatch retries rather than commits.
const LOAD_ATTEMPTS = 4;
const RETRY_DELAY_MS = 150;
// Caps the memoised path-resolution cache. A vault has hundreds to thousands of
// notes; anything beyond this is caller-supplied churn, not working set.
const PATH_CACHE_MAX = 10000;
// How deep index_status advertises folders, and how many it lists. Two levels
// covers the common vault shapes without turning a deeply-dated folder tree
// (Journal/2026/W27/...) into hundreds of useless entries.
const FOLDER_REPORT_DEPTH = 2;
const FOLDER_REPORT_MAX = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class VaultIndex {
  #dirCache;
  #pathCache;
  #inflight = null;
  #missingCount = null;

  constructor(vaultPath) {
    this.vault = vaultPath;
    this.envDir = path.join(vaultPath, '.smart-env');
    this.items = [];        // note-level  { key, path, vec, stale }
    this.blocks = [];       // block-level { key, path, subKey, lines, vec, stale }
    this.modelKey = null;
    this.loadedSig = null;  // mtime+size signature of the source files
    this.loadedAt = null;
    this.tombstones = 0;
    this.raced = 0;         // how many times a load had to retry
    this.unresolvable = 0;  // pointers that named a slot we could not read
    this.loaded = false;
    this.#dirCache = new Map();
    this.#pathCache = new Map();
  }

  // Signature of every input we read, so a live re-index by Obsidian is picked
  // up and a mid-read compaction is detected.
  #signature() {
    const parts = [];
    // Every regular file in both collection directories, not just mf_*: a vector
    // file this code is willing to RESOLVE but not willing to WATCH is a hole in
    // the race guard. The plugin only ever writes mf_* names, so this is
    // belt-and-braces rather than a live bug.
    for (const f of this.#allIndexFiles()) {
      try {
        const s = fs.statSync(f);
        parts.push(`${f}:${s.mtimeMs}:${s.size}`);
      } catch { /* absent — reflected by its omission */ }
    }
    return parts.join('|');
  }

  #ajsonPath() { return path.join(this.envDir, SOURCES, 'smart_sources.ajson'); }

  #allIndexFiles() {
    const out = [];
    for (const collection of [SOURCES, BLOCKS]) {
      const dir = path.join(this.envDir, collection);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) out.push(path.join(dir, n));
    }
    return out.sort();
  }

  #multifiles(collection) {
    const dir = path.join(this.envDir, collection);
    try {
      return fs.readdirSync(dir).filter((f) => f.startsWith('mf_')).map((f) => path.join(dir, f));
    } catch { return []; }
  }

  // One line of the append-only log -> { key, body } with body === 'null' for a
  // tombstone. Keys are JSON strings and may contain escapes, so the key is
  // parsed as JSON rather than stripped of quotes.
  #parseLine(line) {
    const t = line.trim();
    if (t.length < 4 || t[0] !== '"') return null;
    let i = 1;
    for (;;) {
      i = t.indexOf('": ', i);
      if (i < 0) return null;
      if (t[i - 1] !== '\\') break;
      i += 1;
    }
    let key;
    try { key = JSON.parse(t.slice(0, i + 1)); } catch { return null; }
    let body = t.slice(i + 3);
    if (body.endsWith(',')) body = body.slice(0, -1);
    return { key, body };
  }

  // Mirrors the plugin's get_embedding_ref: greatest `at` among refs that carry
  // a `file`. Tolerates the legacy single-ref + history shape.
  #pickRef(embedding) {
    const slot = embedding?.[EMBED_TYPE];
    if (!slot) return null;
    const candidates = [];
    if (typeof slot.file === 'string') {
      // Legacy: embedding.default IS the ref; embedding.history holds older ones.
      candidates.push(slot);
      const hist = Array.isArray(embedding.history) ? embedding.history : [];
      for (const h of hist) {
        if (h?.file && (h.type ?? EMBED_TYPE) === EMBED_TYPE) candidates.push(h);
      }
    } else {
      for (const ref of Object.values(slot)) if (ref?.file) candidates.push(ref);
    }
    let best = null;
    for (const ref of candidates) {
      if (!best || Number(ref.at || 0) >= Number(best.at || 0)) best = ref;
    }
    return best && typeof best.file_i === 'number' ? best : null;
  }

  // Concurrent tool calls are routine, and each one used to re-parse the whole
  // index independently — four parallel calls meant four 45MB parses. Callers
  // that arrive while a load is running now share its promise.
  async load(force = false) {
    // Only non-forced callers share. A forced reload exists to bypass the cache,
    // so handing it a load that is already in flight would silently ignore it.
    if (!force && this.#inflight) return this.#inflight;
    const p = this.#load(force).finally(() => { if (this.#inflight === p) this.#inflight = null; });
    if (!force) this.#inflight = p;
    return p;
  }

  async #load(force) {
    for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
      const before = this.#signature();
      if (!force && this.loadedSig === before && this.loaded) return;

      const parsed = this.#readAll();

      // Nothing may have moved while we were reading, or slot numbers we
      // resolved may no longer mean what they meant.
      if (this.#signature() === before) {
        this.items = parsed.items;
        this.blocks = parsed.blocks;
        this.tombstones = parsed.tombstones;
        this.unresolvable = parsed.unresolvable;
        this.modelKey = parsed.modelKey;
        this.loadedSig = before;
        this.loadedAt = new Date().toISOString();
        this.loaded = true;
        // Directory listings and the missing-file count belong to this index
        // revision, not the next one.
        this.#dirCache.clear();
        this.#pathCache.clear();
        this.#missingCount = null;
        return;
      }
      this.raced++;
      if (attempt < LOAD_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
    throw new Error(
      `Smart Connections index changed under every one of ${LOAD_ATTEMPTS} read attempts — ` +
      'Obsidian is re-indexing right now. Vectors read across a compaction belong to the ' +
      'wrong notes, so this is refused rather than served. Retry in a few seconds.',
    );
  }

  #readAll() {
    const modelKey = this.#readModelKey();

    const ajson = this.#ajsonPath();
    if (!fs.existsSync(ajson)) {
      throw new Error(`no Smart Connections index at ${ajson} — open the vault in Obsidian and let it index`);
    }

    // 1. Parse the append-only log, last-wins, honouring deletion tombstones.
    const latest = new Map();
    let tombstones = 0;
    for (const line of fs.readFileSync(ajson, 'utf8').split('\n')) {
      const rec = this.#parseLine(line);
      if (!rec) continue;
      if (rec.body === 'null') { // deletion — drop any earlier record for this key
        if (latest.delete(rec.key)) tombstones++;
        continue;
      }
      latest.set(rec.key, rec.body); // later line overwrites earlier
    }

    // 2. Resolve each pointer into its multifile.
    //    Keyed by COLLECTION + name: the two directories hold different files
    //    that share the name mf_ccarbz.
    const buffers = new Map();
    const readVec = (collection, ref) => {
      const cacheKey = `${collection}/${ref.file}`;
      if (!buffers.has(cacheKey)) {
        const p = path.join(this.envDir, collection, ref.file);
        buffers.set(cacheKey, fs.existsSync(p) ? fs.readFileSync(p) : null);
      }
      const buf = buffers.get(cacheKey);
      if (!buf) return null;
      const off = ref.file_i * STRIDE;
      if (off < 0 || off + STRIDE > buf.length) return null; // stale pointer, pre-compaction
      const vec = new Float32Array(DIMS);
      for (let d = 0; d < DIMS; d++) vec[d] = buf.readFloatLE(off + d * 4);
      return vec;
    };

    const items = [];
    const blocks = [];
    let unresolvable = 0;
    for (const [key, body] of latest) {
      if (!key.startsWith(`${SOURCES}:`)) continue;
      let rec;
      try { rec = JSON.parse(body); } catch { continue; }
      const rel = rec.path;
      if (!rel) continue;

      // `read_hash` vs `last_read.hash` says whether the vector was computed
      // from the file's current content. Both are already on disk and cost
      // nothing to compare; a stale vector is still usable, so it is flagged
      // rather than dropped.
      const currentHash = rec.last_read?.hash ?? null;

      const ref = this.#pickRef(rec.embedding);
      if (ref) {
        const vec = readVec(SOURCES, ref);
        // A pointer we cannot resolve (slot past the end of the multifile, file
        // absent) silently removes the note from the index. Counting it is the
        // difference between "search never finds that note" being diagnosable
        // and being a mystery.
        if (!vec) unresolvable++;
        if (vec) {
          items.push({
            key, path: rel, vec, file: ref.file,
            stale: Boolean(currentHash && ref.read_hash && ref.read_hash !== currentHash),
          });
        }
      }

      for (const [subKey, bd] of Object.entries(rec.blocks_data ?? {})) {
        if (!bd?.should_embed) continue;
        const bref = this.#pickRef(bd.embedding);
        if (!bref) continue;
        const vec = readVec(BLOCKS, bref);
        if (!vec) { unresolvable++; continue; }
        blocks.push({
          key: bd.key ?? `${rel}${subKey}`,
          path: rel,
          file: bref.file,
          subKey,
          lines: Array.isArray(bd.lines) ? bd.lines : null,
          vec,
          stale: Boolean(bd.last_read?.hash && bref.read_hash && bref.read_hash !== bd.last_read.hash),
        });
      }
    }

    return { items, blocks, tombstones, unresolvable, modelKey };
  }

  #readModelKey() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(this.envDir, 'smart_env.json'), 'utf8'));
      return cfg?.smart_sources?.embed_model?.transformers?.model_key ?? null;
    } catch { return null; }
  }

  // Both sides are unit vectors, so cosine === dot product. No normalisation here;
  // doing it again would be wasted work, and doing it on a non-unit vector would
  // silently mask an index we failed to read correctly.
  #rank(queryVec, pool, minScore) {
    const out = [];
    for (const it of pool) {
      let dot = 0;
      for (let d = 0; d < DIMS; d++) dot += queryVec[d] * it.vec[d];
      // An Infinity in a stored vector otherwise sorts to the top and serialises
      // as JSON `null`; a NaN silently drops the note. Neither should reach a
      // caller as a result.
      if (Number.isFinite(dot) && dot >= minScore) out.push({ it, score: dot });
    }
    return out;
  }

  // Does a vault-relative path sit inside one of `folders`? Segment-aware, so
  // "Project" does not match "ProjectArchive/..." — pass an array to
  // cover several. Case-insensitive, because callers type folder names from
  // memory.
  #inFolders(notePath, folders) {
    const p = notePath.toLowerCase();
    for (const f of folders) {
      const needle = f.toLowerCase().replace(/\/+$/, '');
      if (!needle) return true;
      if (p === needle || p.startsWith(needle + '/')) return true;
    }
    return false;
  }

  // scope 'auto' ranks notes AND blocks, then collapses to one row per note
  // keeping its best-scoring match. That is what recovers the note bytes which
  // live only in block vectors: a note whose relevant passage sits well past the
  // 1894-character cap scores near zero note-level and near the top block-level.
  //
  // `folder` restricts the candidate pool BEFORE ranking, not after, so `limit`
  // means "the best N inside this folder" rather than "whatever survives of the
  // best N overall". On a vault where one project holds most of the notes, a
  // post-filter would routinely return nothing for the smaller projects.
  search(queryVec, opts = {}) {
    return this.searchDetailed(queryVec, opts).results;
  }

  // Returns { results, outside }. `outside` is non-null only when a folder filter
  // was applied, and describes what the filter HID: how many notes would have
  // matched, and the best of them.
  //
  // Without that, a scoped search is indistinguishable from a thin vault. A
  // caller narrowing to a small project gets low scores back and concludes "we
  // never wrote about this", when the answer may be sitting at a higher score one
  // folder over. The filter restricts the pool; it must not also hide the
  // evidence that it did so.
  //
  // Ranking the full pool to compute this is nearly free — it is a dot product
  // per vector, and per-file excerpt reads dominate a search by orders of
  // magnitude.
  searchDetailed(queryVec, { limit = 10, minScore = 0, scope = 'auto', folder = null } = {}) {
    const folders = folder == null ? null : (Array.isArray(folder) ? folder : [folder]).filter((f) => typeof f === 'string');

    const pools = [];
    if (scope === 'auto' || scope === 'notes') pools.push(['note', this.items]);
    if (scope === 'auto' || scope === 'blocks') pools.push(['block', this.blocks]);

    const best = new Map();          // in-scope: note path -> row
    const hidden = new Map();        // filtered out, but would have matched
    for (const [kind, pool] of pools) {
      for (const { it, score } of this.#rank(queryVec, pool, minScore)) {
        const target = (folders === null || this.#inFolders(it.path, folders)) ? best : hidden;
        const prev = target.get(it.path);
        if (prev && prev.score >= score) continue;
        target.set(it.path, {
          path: it.path,
          score,
          matched: kind,
          stale: it.stale,
          ...(kind === 'block' ? { block: it.subKey, lines: it.lines } : {}),
        });
      }
    }

    const results = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    if (folders === null) return { results, outside: null };

    const hiddenRows = [...hidden.values()].sort((a, b) => b.score - a.score);
    const topInside = results[0]?.score ?? -Infinity;
    return {
      results,
      outside: {
        notes_hidden_by_folder: hiddenRows.length,
        best_hidden: hiddenRows.length
          ? { path: hiddenRows[0].path, score: hiddenRows[0].score }
          : null,
        // The one case worth interrupting the caller over: the filter removed
        // something that scored better than anything it was shown.
        better_match_outside_folder: hiddenRows.length > 0 && hiddenRows[0].score > topInside,
      },
    };
  }

  byPath(rel) {
    if (!rel) return null;
    const norm = rel.replace(/\\/g, '/');
    return this.items.find((i) => i.path === norm)
        ?? this.items.find((i) => i.path.toLowerCase() === norm.toLowerCase())
        ?? null;
  }

  #inside(abs) {
    const root = path.resolve(this.vault);
    if (abs !== root && !abs.startsWith(root + path.sep)) return false;
    // .obsidian/plugins/*/data.json is where Obsidian plugins keep API keys and
    // .smart-env is index internals. Neither is note content, and neither should
    // be reachable through a tool that exists to read notes.
    return !abs.slice(root.length + 1).split(path.sep).some((seg) => seg.startsWith('.'));
  }

  // Lexical resolve only — no syscall. Safe for counting paths that came out of
  // the index itself; NOT sufficient for returning content, because it cannot
  // see symlinks. Use #resolveReal for anything that reads bytes.
  #resolve(rel) {
    if (!rel || typeof rel !== 'string') return null;
    const abs = path.resolve(path.resolve(this.vault), rel);
    return this.#inside(abs) ? abs : null;
  }

  // Directory listings, cached. Cleared on every successful load so a listing
  // cannot outlive the index it was read alongside.
  #listing(dir) {
    let names = this.#dirCache.get(dir);
    if (names === undefined) {
      try { names = new Set(fs.readdirSync(dir)); } catch { names = new Set(); }
      this.#dirCache.set(dir, names);
    }
    return names;
  }

  // Every component of `abs` must appear VERBATIM in its parent's directory
  // listing. This is what closes the 8.3 short-name hole: on drvfs (/mnt/c —
  // the filesystem this server exists to serve), `fs.realpathSync` does NOT
  // canonicalise short names, so ".obsidian" reached as "OBSIDI~1" comes back
  // as "OBSIDI~1", sails past a leading-dot check, and hands out whatever the
  // dot-folder holds — plugin API keys included. Short names are generated by
  // the filesystem and never appear in a readdir listing, so requiring an exact
  // listing match rejects them (and any other aliasing drvfs invents) without
  // this code having to know the 8.3 mangling rules.
  #componentsAreReal(abs) {
    const root = path.resolve(this.vault);
    const rel = abs.slice(root.length + 1);
    if (!rel) return true;
    let dir = root;
    for (const seg of rel.split(path.sep)) {
      if (!this.#listing(dir).has(seg)) {
        // Could be a note created since the listing was cached — re-read once
        // before rejecting, so a fresh file is not mistaken for an alias.
        this.#dirCache.delete(dir);
        if (!this.#listing(dir).has(seg)) return false;
      }
      dir = path.join(dir, seg);
    }
    return true;
  }

  // The real thing, for any path whose CONTENT will be returned. A path from a
  // tool call is untrusted input, so this must survive "../../.ssh/id_rsa", an
  // absolute path, symlinks, and filesystem-level name aliasing.
  //
  // realpathSync has to run on the FULL path: checking whether the final
  // component is a symlink is not enough, because a symlinked *directory*
  // ("escapedir" -> /tmp) leaves the leaf a perfectly ordinary file. A
  // lstat-only version of this shipped for one commit and leaked a file outside
  // the vault through exactly that hole.
  //
  // It is still not sufficient on its own — see #componentsAreReal.
  #resolveReal(rel) {
    // realpathSync costs ~15ms per call on a Windows-hosted vault — measured as
    // the dominant cost of a search that returns excerpts, ahead of actually
    // reading the notes. Validated results are memoised for the life of one
    // index revision (cleared on load, alongside the directory listings).
    //
    // The cache stores failures too, so a hostile path is rejected once rather
    // than re-walked, and it is capped so a caller cannot grow it without bound.
    const hit = this.#pathCache.get(rel);
    if (hit !== undefined) return hit;

    const abs = this.#resolve(rel);
    let out = null;
    if (abs !== null) {
      let real;
      try { real = fs.realpathSync(abs); } catch { real = null; }
      if (real !== null && this.#inside(real) && this.#componentsAreReal(real)) out = real;
    }
    if (this.#pathCache.size >= PATH_CACHE_MAX) this.#pathCache.clear();
    this.#pathCache.set(rel, out);
    return out;
  }

  // Bounded read: opens the file and pulls at most the bytes needed. The old
  // version read the whole file and then sliced, so a 1,200-char excerpt of a
  // 39MB note read 39MB.
  #read(abs, maxChars) {
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    // UTF-8 is at most 4 bytes per code point, so this cannot under-read.
    const cap = Number.isFinite(maxChars) ? Math.min(st.size, maxChars * 4 + 64) : st.size;
    let fd;
    try {
      fd = fs.openSync(abs, 'r');
      const buf = Buffer.allocUnsafe(cap);
      const n = fs.readSync(fd, buf, 0, cap, 0);
      return { text: buf.subarray(0, n).toString('utf8'), size: st.size, complete: n >= st.size };
    } catch { return null; } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }

  readNote(rel, maxChars = 1200) {
    const abs = this.#resolveReal(rel);
    if (!abs) return null;
    const r = this.#read(abs, maxChars);
    if (!r) return null;
    if (r.complete && r.text.length <= maxChars) return r.text;
    // The marker counts against the budget. Appending it on top made max_chars
    // a target rather than a ceiling, so get_note's real ceiling was 400,033.
    const marker = `\n…[truncated — ${r.size} bytes total]`;
    const keep = Math.max(0, maxChars - marker.length);
    return r.text.slice(0, keep) + marker;
  }

  // Excerpt a block by its line range, so a block hit shows the passage that
  // actually matched instead of the top of the note.
  //
  // `lines` is [line_start, line_end], ONE-BASED and inclusive. The plugin's own
  // extractor is lines.slice(line_start - 1, line_end) (get_line_range2), and
  // matching it exactly is not cosmetic: reading these as 0-based shifts every
  // block by one line, which drops its heading, and measured self-similarity
  // against the stored vector fell to 0.81 on heading-led blocks.
  readLines(rel, lines, maxChars = 1200) {
    if (!Array.isArray(lines) || lines.length !== 2) return this.readNote(rel, maxChars);
    const abs = this.#resolveReal(rel);
    if (!abs) return null;
    const [start, end] = lines;
    // Read forward only until `end` newlines have been seen, rather than pulling
    // the whole note in. This is the DEFAULT excerpt path — blocks outnumber
    // notes in the index roughly 7:1 — so reading each note in full to quote
    // 1,200 characters of it dominated the cost of a search with a large limit.
    const r = this.#readThroughLine(abs, end);
    if (!r) return null;
    const text = r.split('\n').slice(Math.max(0, start - 1), end).join('\n');
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…[truncated]' : text;
  }

  // Read in chunks until `line` newlines have been seen (or EOF). Returns the
  // decoded prefix, which is guaranteed to contain lines 1..line.
  #readThroughLine(abs, line) {
    const CHUNK = 64 * 1024;
    let fd;
    try {
      fd = fs.openSync(abs, 'r');
      const chunks = [];
      let newlines = 0;
      let pos = 0;
      for (;;) {
        const buf = Buffer.allocUnsafe(CHUNK);
        const n = fs.readSync(fd, buf, 0, CHUNK, pos);
        if (n <= 0) break;
        pos += n;
        const slice = buf.subarray(0, n);
        chunks.push(slice);
        for (let i = 0; i < n; i++) if (slice[i] === 0x0a) newlines++;
        if (newlines >= line) break;
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch { return null; } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }

  // One existence check per note — cheap per call, but on a Windows-hosted
  // vault 600 of them dominate index_status, which is the tool users are told
  // to reach for first. The answer can only change when the index does, so it
  // is computed once per index revision and cached.
  #countMissing() {
    if (this.#missingCount !== null) return this.#missingCount;
    let missing = 0;
    for (const i of this.items) {
      const abs = this.#resolve(i.path);
      if (abs === null || !fs.existsSync(abs)) missing++;
    }
    this.#missingCount = missing;
    return missing;
  }

  // Which multifiles the resolved vectors actually came from. More than one per
  // collection means the index carries refs from more than one embedding run —
  // worth knowing, because this server picks the most recent ref rather than
  // pinning a model fingerprint the way the plugin does.
  #filesInUse() {
    const src = new Set(), blk = new Set();
    for (const i of this.items) if (i.file) src.add(i.file);
    for (const b of this.blocks) if (b.file) blk.add(b.file);
    return { smart_sources: [...src].sort(), smart_blocks: [...blk].sort() };
  }

  // Folders with their note and block counts, so a caller can discover what it may
  // scope a search to.
  //
  // Reported to two levels, not one. Vaults are organised in at least two common
  // shapes: projects at the top ("ProjectA/...") and everything under a single
  // root ("Notes/Work/ProjectA/..."). Reporting only the top level makes the
  // second shape undiscoverable — every note lives under one entry, and nothing
  // tells the caller what the real groupings are. `folder` itself accepts any
  // depth; this only governs what gets advertised.
  #folders() {
    const counts = new Map();
    const bump = (p, key) => {
      const parts = p.split('/');
      for (let depth = 1; depth <= Math.min(FOLDER_REPORT_DEPTH, parts.length - 1); depth++) {
        const prefix = parts.slice(0, depth).join('/');
        if (!counts.has(prefix)) counts.set(prefix, { notes: 0, blocks: 0 });
        counts.get(prefix)[key]++;
      }
    };
    for (const i of this.items) bump(i.path, 'notes');
    for (const b of this.blocks) bump(b.path, 'blocks');
    return Object.fromEntries(
      [...counts.entries()]
        .sort((a, b) => b[1].notes - a[1].notes || a[0].localeCompare(b[0]))
        .slice(0, FOLDER_REPORT_MAX),
    );
  }

  status() {
    return {
      vault: this.vault,
      embedded_notes: this.items.length,
      embedded_blocks: this.blocks.length,
      stale_notes: this.items.filter((i) => i.stale).length,
      stale_blocks: this.blocks.filter((b) => b.stale).length,
      deletion_tombstones_applied: this.tombstones,
      unresolvable_pointers: this.unresolvable,
      load_retries_from_concurrent_reindex: this.raced,
      embedding_files_in_use: this.#filesInUse(),
      model: this.modelKey,
      dims: DIMS,
      multifiles: {
        smart_sources: this.#multifiles(SOURCES).map((f) => path.basename(f)),
        smart_blocks: this.#multifiles(BLOCKS).map((f) => path.basename(f)),
      },
      index_loaded_at: this.loadedAt,
      notes_missing_on_disk: this.#countMissing(),
      folders: this.#folders(),
      note: 'Vectors are written only while Obsidian is running. Notes edited with Obsidian closed keep their old vector until it reopens and re-indexes; those are counted as stale above.',
      coverage_note: 'Note-level vectors cover only the first 1894 chars of a note. Block-level vectors cover the rest, chosen by the plugin to minimise uncovered text. Searching both (the default) is what makes long notes findable by their middles and ends.',
    };
  }
}
