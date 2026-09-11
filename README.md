# smart-connections-mcp

Read-only MCP server giving Claude Code semantic search over an Obsidian vault,
using the embeddings the [Smart Connections](https://smartconnections.app) plugin
already builds.

It does **not** talk to Obsidian. The plugin owns indexing; this reads its output
files directly — which is why it works across the WSL↔Windows boundary with no
networking, and why it is read-only by construction.

```
  you ── Claude Code ── MCP stdio ── this server ──┬── .smart-env/*.ajson   (pointers)
                                                   ├── .smart-env/**/mf_*   (float32 vectors)
                                                   └── your *.md files      (body text, on demand)
        Obsidian + Smart Connections ── writes ────┘
```

---

## Requirements

- **Node ≥ 20** (tested on 22.2.0).
- **Obsidian with the Smart Connections plugin v4** (smart-env 3.x), which must
  have indexed the vault at least once. Check that `.smart-env/smart_sources/`
  contains `smart_sources.ajson` and at least one `mf_*` file.
- **Block embeddings enabled** — the default, and worth confirming, because block
  vectors are where most of the vault's text actually lives (see
  [Coverage](#notes-are-only-embedded-to-1894-characters--blocks-carry-the-rest)).
  In `.smart-env/smart_env.json`: `smart_blocks.embed_blocks: true`.
- ~70MB of disk for the embedding model, downloaded on first use.

No API key, no network at query time: embedding runs locally.

## Install

```bash
git clone https://github.com/cusster/smart-connections-mcp.git ~/workspace/smart-connections-mcp
cd ~/workspace/smart-connections-mcp
npm install

claude mcp add smart-connections --scope user \
  -e SMART_VAULT_PATH="/mnt/c/Users/you/Documents/YourVault" \
  -- node ~/workspace/smart-connections-mcp/src/index.js
```

`--scope user` makes it available in every project. Drop it to register for the
current project only.

**Then restart Claude Code.** MCP servers are initialised at start-up, so a newly
added server is not available in the session that added it. This is the single
most common reason it appears to do nothing.

Confirm it came up:

```bash
claude mcp list      # smart-connections: ... - ✔ Connected
```

Then, in Claude Code, call `index_status` first — it reports what was actually
loaded, and a healthy vault shows a non-zero count for **both** notes and blocks.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SMART_VAULT_PATH` | *(required)* | Absolute path to the vault root — the folder containing `.obsidian/`, not `.smart-env/` |
| `SMART_MODEL_CACHE` | `~/.cache/smart-connections-mcp` | Where the ONNX weights live |
| `SMART_EMBED_MODEL` | `TaylorAI/bge-micro-v2` | Only change this if the plugin is configured for a different model — it must match, or every result is confident nonsense |
| `SMART_VERIFY_SAMPLE` | `12` | Sample size per collection for `npm run verify` |

WSL note: use the `/mnt/c/...` form, not `C:\...`.

## Tools

### `search_notes`

Semantic search by meaning. Ranks note-level and block-level vectors together and
returns one row per note, tagged with which one matched.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `query` | string | *(required)* | Natural language, max 8192 chars. Phrasing close to how the note puts it works best |
| `limit` | number | `10` | Clamped to 1–100 |
| `min_score` | number | `0.5` | Cosine similarity, clamped to −1–1 |
| `scope` | `auto` \| `notes` \| `blocks` | `auto` | `notes` covers only each note's first 1894 chars; `blocks` pinpoints passages |
| `folder` | string \| string[] | *(all)* | Restrict to one or more folders, e.g. `"ProjectA"` or `["ProjectA/Planning", "ProjectB"]` |
| `include_text` | boolean | `true` | For a block hit the excerpt is the matched section, not the top of the note |

**Scoping a multi-project vault.** If one project holds most of the notes it
dominates every generic query, and the smaller projects become effectively
unreachable. `folder` filters the candidate pool *before* ranking, so `limit`
means "the best N inside this folder" rather than "whatever survives of the best
N overall" — a post-filter would routinely return nothing for a small project.
Matching is on whole path segments and case-insensitive, so `"projecta"` works
and `"Project"` does not silently match `ProjectA` and `ProjectB`. `index_status`
lists the folders with their note and block counts, which is how a caller
discovers what it may scope to.

Scoping removes competition; it does not create relevance. Narrowing to a project
that never discussed the topic returns its least-irrelevant notes at low scores —
read the scores, not just the ordering.

**A scoped response says what the filter hid.** Otherwise a narrow search is
indistinguishable from a vault with nothing on the subject, which is the same
class of silent-wrong-answer this server works to avoid everywhere else:

```json
"folder": ["ProjectB"],
"scoped_out": {
  "notes_hidden_by_folder": 233,
  "best_hidden": { "path": "Notes/2026/incident-review.md", "score": 0.6546 },
  "better_match_outside_folder": true,
  "hint": "A better match exists outside this folder. Re-run without `folder` if the question is not project-specific."
}
```

`better_match_outside_folder` is true only when the filter removed something that
scored higher than anything it returned — a warning on every scoped search would
just train the caller to ignore it. `scoped_out` is absent entirely when no
folder was passed.

Example response — this shows the *shape*. Scores and paths depend entirely on
your vault.

```json
{
  "query": "why did we split the cache into two instances",
  "mode": "semantic",
  "model": "TaylorAI/bge-micro-v2",
  "scope": "auto",
  "results": [
    {
      "path": "Notes/2026/infrastructure-journal.md",
      "score": 0.661,
      "matched": "note",
      "excerpt": "# Infrastructure journal\n\n## Cache topology …"
    },
    {
      "path": "Notes/2026/incident-review.md",
      "score": 0.6594,
      "matched": "block",
      "section": "#Incident review#Root cause#{3}",
      "lines": [23, 23],
      "excerpt": "- **Resolution:** separate instances, because one eviction policy cannot serve both …"
    }
  ]
}
```

Note `matched`: the first hit came from a whole-note vector, the second from a
single section, with the line range it occupies. A block hit's excerpt is that
section rather than the head of the note.

**Score calibration** (measured on this model): `<0.60` usually noise, `0.65+` a
real match, `0.80+` strong. One caveat — the plugin prefixes every embedding with
the note's path as breadcrumbs, so a query that is really just a path fragment
("Briefings 2026") scores 0.72–0.75 on folder structure alone without matching any
content. Judge those by the excerpt, not the score.

### `related_notes`

Notes related to an existing note — the Smart Connections sidebar, as a tool.

| Parameter | Type | Default |
|---|---|---|
| `path` | string | *(required)* vault-relative, e.g. `Projects/Deucalion.md` |
| `limit` | number | `10` (1–100) |
| `folder` | string \| string[] | *(all)* — same matching as `search_notes` |

### `get_note`

Read a note by vault-relative path.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `path` | string | *(required)* | |
| `max_chars` | number | `100000` | Ceiling 400,000; longer notes are truncated with a marker |

Paths are validated: traversal, absolute paths, symlinks pointing out of the
vault, and **dot-folders** are all refused. That last one matters —
`.obsidian/plugins/*/data.json` is where Obsidian plugins keep API keys, and it
is not note content.

### `index_status`

Index health. Call this first when results look wrong. Field meanings:
`stale_*` counts vectors whose source file has changed since they were written;
`unresolvable_pointers` counts index entries whose vector could not be read, each
of which is a note that silently will not be findable; `embedding_files_in_use`
shows which multifiles the loaded vectors actually came from — more than one per
collection means the index carries refs from more than one embedding run;
`model_matches_query_embedder` is the one to check first when results look wrong.
Any problem it detects is also spelled out in a `warnings` array.

Example response — shape, not a benchmark:

```json
{
  "vault": "/mnt/c/Users/you/Documents/YourVault",
  "embedded_notes": 586,
  "embedded_blocks": 4005,
  "stale_notes": 0,
  "stale_blocks": 0,
  "deletion_tombstones_applied": 1280,
  "unresolvable_pointers": 0,
  "load_retries_from_concurrent_reindex": 0,
  "embedding_files_in_use": { "smart_sources": ["mf_ccarbz"], "smart_blocks": ["mf_ccarbz"] },
  "model": "TaylorAI/bge-micro-v2",
  "dims": 384,
  "multifiles": { "smart_sources": ["mf_ccarbz"], "smart_blocks": ["mf_ccarbz"] },
  "index_loaded_at": "2026-09-11T07:30:08.014Z",
  "notes_missing_on_disk": 0,
  "note": "...",
  "coverage_note": "..."
}
```

## Performance

Timings depend heavily on where the vault lives. On a Windows-hosted vault
reached through `/mnt/c`, cost is dominated by per-file syscalls —
`realpathSync` alone runs to double-digit milliseconds per call — not by vector
maths. A native-filesystem vault is far quicker.

Rather than quote figures that will not match your setup:

```bash
SMART_VAULT_PATH=/path/to/vault npm run measure
```

Section 4 of its output times a cold load, a warm load, a search with and
without excerpts, and `index_status`.

What the code does to keep that bearable: the parsed index is reused until the
underlying files' mtime/size change; concurrent tool calls share one parse rather
than each re-reading the index; resolved paths and directory listings are
memoised for the life of an index revision; the missing-file count is computed
once per revision; excerpts read only as far into a note as the quoted lines
require. A vault that Obsidian is actively re-indexing invalidates the signature
frequently, so expect more full reloads while it works.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Tool not available at all | Claude Code wasn't restarted after `claude mcp add`. Servers load at start-up |
| `SMART_VAULT_PATH is required` | Env var missing from the MCP registration; check `claude mcp get smart-connections` |
| `no Smart Connections index at …/smart_sources.ajson` | Wrong vault root (point at the folder containing `.obsidian/`), or the plugin has never indexed. Open the vault in Obsidian and wait |
| `embedded_blocks: 0` | `smart_blocks.embed_blocks` is off, or the plugin hasn't embedded blocks yet. Expect ~73% worse coverage on long notes until it has |
| `embedding model mismatch … refused` | The vault was indexed with one model and this server embeds queries with another. Searching across two vector spaces returns confident nonsense, so it is refused. Set `SMART_EMBED_MODEL` to the vault's model, or re-index the vault |
| Results are confidently irrelevant | Check `index_status.model_matches_query_embedder`, then run `npm run verify`, which measures the vector-space agreement directly |
| Recently edited notes rank on their old content | Vectors are written only while Obsidian runs. `stale_notes` counts them |
| `index changed under every one of 4 read attempts` | Obsidian is re-indexing right now. Deliberate refusal — vectors read across a compaction belong to the wrong notes. Retry in a few seconds |
| First call is slow, then fine | One-off model download/load. Cached in `SMART_MODEL_CACHE` |

---

# How it works

## Why this exists rather than an off-the-shelf server

Smart Connections v4 (smart-env 3.x) changed its storage format. Vectors used to
live inline in `.ajson`:

```json
"embeddings": { "TaylorAI/bge-micro-v2": { "vec": [ ... ] } }
```

They now live in a packed binary, with the `.ajson` holding only a pointer:

```json
"embedding": { "default": { "mf_ccarbz": { "file": "mf_ccarbz", "file_i": 18, "at": 1789035930404 } } }
```

Community servers written for the old shape don't degrade — they return nothing,
or fall back to keyword matching, which looks like working RAG and is not.
Checked against one such server (`dan6684/smart-connections-mcp`) on a real v4
vault, three independent blockers:

- it reads `.smart-env/multi/`, which v4 does not create — the loader returns
  early with **zero vectors** and searches then come back empty, with no error;
- its vector lookup wants `item['embeddings']['TaylorAI/bge-micro-v2']['vec']`,
  and the string `"embeddings"` appears **0 times** in a v4 index;
- its `get_context_blocks` returns `item['text']`, but v4 stores no text at all
  — every `"text"` field in the index is `null`. Body text has to be read from
  the markdown files.

Its three tools map onto this server as `semantic_search` → `search_notes`,
`find_related` → `related_notes`, `get_context_blocks` → `search_notes` with
`scope: "blocks"`.

## Format notes (measured against a live vault, not documented)

- `.smart-env/smart_sources/smart_sources.ajson` is an **append-only log**. A key
  may recur; the **last** occurrence wins. Treating it as a plain map serves stale
  vectors.
- A line whose value is `null` is a **deletion tombstone**. Skipping those leaves
  the previous record standing as "last-wins", so deleted and renamed notes keep
  ranking forever with an empty excerpt.
- `embedding.default` is a **map keyed by model fingerprint** (which defaults to
  the multifile name), so a note can carry several refs — different models, or a
  pre- and post-compaction file. The right one is the greatest `at` among refs
  that have a `file`, and the multifile name comes from `ref.file`, **not** from
  the map key. This mirrors the plugin's own `get_embedding_ref`.
- `.smart-env/{smart_sources,smart_blocks}/mf_<id>` is packed `float32[384]`,
  **1536 bytes per record, no header**. `file_i` is the slot index.
- The two directories hold **different files that share a name**:
  `smart_sources/mf_ccarbz` and `smart_blocks/mf_ccarbz` are unrelated. A buffer
  cache keyed on the bare filename resolves block pointers against the source
  file and returns unit-norm vectors for the wrong content, with no error.
- Vectors are **L2-normalised** (measured norm 1.0), so cosine similarity is a
  plain dot product.
- The index stores **no note text** (`"text": null` throughout) — only locations.
- Block line ranges (`blocks_data[...].lines`) are **1-based and inclusive**,
  matching the plugin's `lines.slice(line_start - 1, line_end)`.
- The multifile **name is not stable** and the index **grows and is rewritten
  while Obsidian runs**.

## Notes are only embedded to 1894 characters — blocks carry the rest

This is the most important thing about retrieval quality here, and it is not a
defect in the plugin.

The plugin embeds a note as `${breadcrumbs}:\n${content}` truncated to
`floor(max_tokens * 3.7)` = **1894 characters** (`max_tokens: 512` for
bge-micro-v2 — both constants come from the plugin bundle, so they do not drift).
Most notes of any length exceed that, which leaves the bulk of a vault's text
outside any *note-level* vector.

The plugin compensates deliberately: `select_block_embedding_plan` computes a
*loss* term and descends into child blocks precisely when a parent would
overflow, and the plugin's own semantic lookup searches blocks rather than
sources (`smart_env.json` → `lookup_lists.results_collection_key: "smart_blocks"`).

So reading note vectors alone reproduces neither the coverage nor the ranking of
the plugin itself. That is why `scope: auto` searches both.

**How much this matters on your vault is a question with a real answer — measure
it rather than trust a number from someone else's:**

```bash
SMART_VAULT_PATH=/path/to/vault npm run measure
```

That reports coverage under one stated method, and a recall comparison across a
strided sample of every note long enough to have text past the cap. Two things
worth knowing before you read the output:

- The gain is a **blocks** gain, not an `auto` gain. `scope: "blocks"` alone
  performs about as well as `auto`; `auto` mostly adds safety on short notes.
- Adding blocks is **not free** — it regresses a minority of queries, where a
  short block outranks the note that actually holds the answer. `measure` prints
  that count explicitly rather than hiding it.

The residual is a genuine ceiling, not a bug: blocks larger than the cap with no
sub-headings to descend into get truncated, and blocks under `min_chars` (200 by
default) are never embedded at all.

## Matching the vector space

The load-bearing correctness requirement is that a query is embedded exactly as
the documents were. A mismatch produces no error — just confident nonsense. So
this uses the same library, settings **and truncation algorithm** as the plugin:

| | |
|---|---|
| Library | `@huggingface/transformers` 4.2.0 (same as the plugin) |
| Model | `TaylorAI/bge-micro-v2`, 384 dims |
| Pooling / normalize | `mean` / `true` |
| Query prefix | **none** (BGE retrieval prefixes would shift the query out of the document space) |
| Max tokens | 512 |
| Long-input handling | the plugin's own `prepare_input`, replicated |

Two traps:

⚠️ `transformers.js` truncates against `tokenizer.model_max_length`, which ships
as `1e+30` for this model — so `truncation: true` never fires and any input over
512 tokens **throws** inside onnxruntime. The property is a getter with no
backing field, so it is shadowed via `Object.defineProperty`.

⚠️ The plugin does not rely on the tokenizer for that. It truncates the text
itself first: count tokens, then while over budget, cut to 90% of the
proportional character estimate and back up to the last space. Its stored vector
is therefore built from text that is *shorter* than a 512-token cut and ends on a
word boundary. Replicating that closes a real gap on long blocks — but a modest
one; letting the tokenizer truncate instead still lands close, because both cuts
keep the same leading text. `npm run verify` reports where your vault sits.

(An earlier version of this file claimed the gap was far larger. That figure was
measured while a separate off-by-one bug was shifting every block excerpt by a
line, so it described the wrong cause. Corrected.)

## Verify it actually works

```bash
SMART_VAULT_PATH=/mnt/c/Users/you/Documents/YourVault npm run verify
```

Rebuilds each sampled note's and block's embed input **exactly as the plugin
does**, re-embeds it, and compares to the stored vector. Shared vector space
means ~1.0; drift collapses it. Passes at 0.95, samples randomly each run so a
problem anywhere in the vault can surface, and exits non-zero on failure. It
prints the worst similarity it found — read that, rather than taking a number
from this file.

It cannot detect slot misalignment from a mid-read compaction — those vectors are
all unit-norm and all real, just attached to the wrong notes. That is prevented in
`vault.js` by re-checking the file signature after the read, and covered by
`test/concurrency.test.mjs`.

Pass a query to see live ranking:

```bash
SMART_VAULT_PATH=... node src/verify.js "cache serving stale data after a config change"
```

## Tests

```bash
npm test             # fixture-based; no vault or model download needed
npm run test:vault   # protocol-level against a real vault (needs SMART_VAULT_PATH)
npm run measure      # coverage, recall and timings on YOUR vault
npm run verify       # proves the query embedder matches the index
```

The fixture builds a synthetic vault whose slot *i* holds the unit vector *e_i*,
so a resolved vector proves which slot of which file it came from. That is the
only way to catch this format's characteristic failure: the wrong vector, still
unit-norm, with no error. `test/concurrency.test.mjs` races a real second process
against the loader, because `load()` reads synchronously and nothing in-process
can interleave with it.

The suite is checked by mutation: each fix is reverted in a copy of the source
and the suite must go red. That is not ceremony — three tests in an earlier
round passed with their fix removed, including the one guarding the defect this
README calls out most loudly. A green suite that survives its own mutants is the
only kind worth quoting.

## Known limits

- **Coverage is not total.** Oversized indivisible blocks are truncated by the
  plugin, and sub-`min_chars` blocks are never embedded. `npm run measure`
  reports where your vault lands.
- **Path breadcrumbs inflate some scores.** See the calibration note under
  `search_notes`.
- **Small model.** bge-micro-v2 handles close paraphrase well and heavy
  abstraction poorly: a query using entirely different vocabulary from the note
  can fall into the noise band. Worth separating from the coverage issue above —
  misses on text that *is* in the vault were mostly the 1894-char cap, which
  block search fixes, not something a bigger model would have solved.
- **Staleness is inherent.** Only Obsidian writes vectors; no MCP server can fix
  this. `index_status` reports how many are stale.
- **Concurrent re-indexing can make a load fail**, by design. Retry.
- **Embedding-ref selection differs from the plugin's.** When a note carries refs
  from more than one embedding run, this server takes the most recently written
  one, while the plugin pins the ref matching its configured model's fingerprint.
  On a single-model vault the two always agree. They can diverge mid-migration,
  when some notes have been re-embedded and others have not — so rather than
  reimplement the plugin's fingerprint hash (a private, undocumented key schema
  that would fail silently if it ever changed), the server guards the outcome:
  it refuses to search when the vault's model and the query embedder disagree,
  and `index_status` warns when vectors resolve from more than one multifile.

## License

MIT — see [LICENSE](LICENSE).
