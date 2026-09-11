#!/usr/bin/env node
// smart-connections-mcp — read-only semantic search over an Obsidian vault's
// Smart Connections embeddings, exposed over MCP.
//
// It does NOT talk to Obsidian. The plugin owns writing the index; this reads
// what the plugin produced, straight off disk. That is what makes it work across
// the WSL/Windows boundary with no networking: /mnt/c is just a path.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { VaultIndex } from './vault.js';
import { embedQuery, embedInfo } from './embed.js';

const VAULT = process.env.SMART_VAULT_PATH;
if (!VAULT) {
  console.error('SMART_VAULT_PATH is required (absolute path to the Obsidian vault root)');
  process.exit(1);
}

// get_note used to pass Infinity, which happily returned a 39MB payload in 59s
// as a successful result. An MCP response is a context window's worth of text,
// so it is capped; the caller can raise it up to the ceiling deliberately.
const NOTE_CHARS_DEFAULT = 100_000;
const NOTE_CHARS_CEILING = 400_000;
const EXCERPT_CHARS = 1200;
const MAX_QUERY_CHARS = 8192;

const index = new VaultIndex(VAULT);

const server = new Server(
  { name: 'smart-connections', version: '1.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_notes',
      description:
        'Semantic search across the Obsidian vault using Smart Connections embeddings. ' +
        'Matches on MEANING, not keywords — describe the idea in natural language rather than ' +
        'guessing search terms. Searches both whole-note and per-section (block) vectors, so a ' +
        'passage buried in the middle of a long note is findable; each hit reports which one ' +
        'matched. Complements grep rather than replacing it: grep for exact strings, this for concepts.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language description of what you are looking for' },
          limit: { type: 'number', description: 'Max results, 1-100 (default 10)' },
          min_score: {
            type: 'number',
            description:
              'Minimum cosine similarity (default 0.5). Measured calibration on this model: ' +
              '<0.60 is usually noise, 0.65+ is a real match, 0.80+ is strong. Caveat: the plugin ' +
              'prefixes each embedding with the note\'s path as breadcrumbs, so a query that is ' +
              'merely a path fragment (a folder name plus a year, say) scores 0.72-0.75 on ' +
              'folder structure ' +
              'alone without matching any content. Judge those by the excerpt, not the score.',
          },
          scope: {
            type: 'string',
            enum: ['auto', 'notes', 'blocks'],
            description:
              'auto (default) ranks note and block vectors together, one row per note. ' +
              'notes = whole-note vectors only, which cover just the first 1894 chars of each note. ' +
              'blocks = section vectors only, for pinpointing passages.',
          },
          folder: {
            description:
              'Restrict the search to one or more top-level folders or subfolders, e.g. "ProjectA" or '
              + '["ProjectA/Planning", "ProjectB"]. Matching is on whole path segments and is '
              + 'case-insensitive. Use this when a vault holds several projects: without it, whichever '
              + 'project has the most notes dominates every generic query. Call index_status to see the '
              + 'available folders and their note counts.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          include_text: { type: 'boolean', description: 'Include the matching text, truncated (default true)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'related_notes',
      description:
        'Find notes semantically related to an existing note — the Smart Connections sidebar, ' +
        'as a tool. Takes a vault-relative path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path, e.g. "Projects/Deucalion.md"' },
          limit: { type: 'number', description: 'Max results, 1-100 (default 10)' },
          folder: {
            description: 'Restrict related notes to these folders — same matching as search_notes.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'get_note',
      description:
        'Read a note by vault-relative path. Truncates very large notes; raise max_chars if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path' },
          max_chars: {
            type: 'number',
            description: `Max characters to return (default ${NOTE_CHARS_DEFAULT}, ceiling ${NOTE_CHARS_CEILING})`,
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'index_status',
      description:
        'Report index health: note and block counts, embedding model, stale-vector counts, ' +
        'and how stale the index is. Use this when results look wrong — vectors only update ' +
        'while Obsidian is running.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

// The vault records which model wrote its vectors. If that is not the model this
// server embeds queries with, every search still returns ranked, confident,
// entirely unrelated results — the one failure mode with no symptom. verify.js
// has always checked this, but only when a human runs it; nothing checked it at
// request time, which is when it matters.
//
// This is also the practical half of a subtler issue: #pickRef takes the ref with
// the greatest `at`, while the plugin pins the configured model's fingerprint.
// Those agree on a single-model vault and diverge during a model switch — which
// is exactly when this guard fires.
const modelMismatch = () => {
  const vaultModel = index.modelKey;
  if (!vaultModel || vaultModel === embedInfo.model) return null;
  return `embedding model mismatch: the vault was indexed with "${vaultModel}" but this server embeds queries with "${embedInfo.model}". `
    + 'Searching across two vector spaces returns confident nonsense rather than an error, so it is refused. '
    + `Set SMART_EMBED_MODEL="${vaultModel}" (and restart), or re-index the vault with "${embedInfo.model}".`;
};

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = (msg) => ({ content: [{ type: 'text', text: JSON.stringify({ error: msg }, null, 2) }], isError: true });

// Arguments arrive from a model and are frequently not what the schema says.
// `limit: -1` used to reach Array.slice and return the entire vault.
//
// Coercion is the trap here, not rejection. An earlier version ran everything
// through Number(), which maps "" and [] to 0 and true to 1 — so `limit: ""`
// silently returned ONE result instead of the documented ten, and a caller
// reasonably concluded the vault held one match. Only a real number, or a string
// that round-trips as one, is accepted; anything else is an explicit error.
const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const clampInt = (v, def, lo, hi) => {
  if (v === undefined || v === null) return def;
  const n = toNumber(v);
  if (n === null) return null;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};
// `folder` is either a string or an array of strings. Anything else is a caller
// error worth naming, not something to coerce into a filter that quietly matches
// nothing.
const normFolders = (v) => {
  if (v === undefined || v === null) return { value: null };
  const arr = Array.isArray(v) ? v : [v];
  if (!arr.length || !arr.every((f) => typeof f === 'string' && f.trim() !== '')) {
    return { error: `folder must be a non-empty string or array of strings, got ${JSON.stringify(v)}` };
  }
  return { value: arr.map((f) => f.trim().replace(/^\/+|\/+$/g, '')) };
};
const clampNum = (v, def, lo, hi) => {
  if (v === undefined || v === null) return def;
  const n = toNumber(v);
  if (n === null) return null;
  return Math.min(hi, Math.max(lo, n));
};

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    await index.load();

    if (name === 'search_notes') {
      const { query, include_text = true, scope = 'auto' } = args;
      if (typeof query !== 'string' || !query.trim()) return err('query is required and must be a non-empty string');
      // The embedder truncates to 512 tokens anyway, so anything beyond a few KB
      // is tokenised at cost and then thrown away.
      if (query.length > MAX_QUERY_CHARS) {
        return err(`query is ${query.length} chars; maximum is ${MAX_QUERY_CHARS} (it is truncated to 512 tokens before embedding anyway)`);
      }
      const limit = clampInt(args.limit, 10, 1, 100);
      if (limit === null) return err(`limit must be a number, got ${JSON.stringify(args.limit)}`);
      const minScore = clampNum(args.min_score, 0.5, -1, 1);
      if (minScore === null) return err(`min_score must be a number, got ${JSON.stringify(args.min_score)}`);
      if (!['auto', 'notes', 'blocks'].includes(scope)) return err(`scope must be auto, notes or blocks, got ${JSON.stringify(scope)}`);
      const mismatch = modelMismatch();
      if (mismatch) return err(mismatch);
      const folders = normFolders(args.folder);
      if (folders.error) return err(folders.error);

      // Same library, same model, same pooling/normalize as the plugin — so the
      // query vector lands in the same space as the stored document vectors.
      const qv = await embedQuery(query);
      const { results: hits, outside } = index.searchDetailed(qv, { limit, minScore, scope, folder: folders.value });
      if (!hits.length && folders.value) {
        const known = Object.keys(index.status().folders);
        const unknown = folders.value.filter((f) => !known.some((k) => k.toLowerCase() === f.split('/')[0].toLowerCase()));
        if (unknown.length) {
          return err(`no notes under ${JSON.stringify(unknown)}. Top-level folders in this vault: ${known.join(', ')}`);
        }
      }
      return ok({
        query,
        mode: 'semantic',
        model: index.modelKey,
        scope,
        ...(folders.value ? { folder: folders.value } : {}),
        // Say what the filter hid. A scoped search that returns thin results
        // otherwise looks identical to a vault that has nothing on the topic.
        ...(outside ? {
          scoped_out: {
            ...outside,
            ...(outside.better_match_outside_folder ? {
              hint: 'A better match exists outside this folder. Re-run without `folder` if the question is not project-specific.',
            } : {}),
          },
        } : {}),
        results: hits.map((h) => ({
          path: h.path,
          score: Number(h.score.toFixed(4)),
          matched: h.matched,
          ...(h.block ? { section: h.block, lines: h.lines } : {}),
          ...(h.stale ? { stale: true } : {}),
          ...(include_text
            ? { excerpt: h.matched === 'block' ? index.readLines(h.path, h.lines, EXCERPT_CHARS) : index.readNote(h.path, EXCERPT_CHARS) }
            : {}),
        })),
      });
    }

    if (name === 'related_notes') {
      const { path: p } = args;
      const limit = clampInt(args.limit, 10, 1, 100);
      if (limit === null) return err(`limit must be a number, got ${JSON.stringify(args.limit)}`);
      const mismatch = modelMismatch();
      if (mismatch) return err(mismatch);
      const folders = normFolders(args.folder);
      if (folders.error) return err(folders.error);
      const self = index.byPath(p);
      if (!self) return err(`no embedded note at "${p}". Use index_status to see what is indexed.`);
      const hits = index.search(self.vec, { limit: limit + 1, minScore: 0, folder: folders.value })
        .filter((h) => h.path !== self.path)
        .slice(0, limit);
      return ok({
        path: self.path,
        related: hits.map((h) => ({
          path: h.path,
          score: Number(h.score.toFixed(4)),
          matched: h.matched,
          ...(h.block ? { section: h.block } : {}),
        })),
      });
    }

    if (name === 'get_note') {
      const maxChars = clampInt(args.max_chars, NOTE_CHARS_DEFAULT, 1, NOTE_CHARS_CEILING);
      if (maxChars === null) return err(`max_chars must be a number, got ${JSON.stringify(args.max_chars)}`);
      const text = index.readNote(args.path, maxChars);
      return text == null
        ? err(`cannot read "${args.path}" — not a readable file inside the vault (dot-folders such as .obsidian are excluded)`)
        : ok({ path: args.path, text });
    }

    if (name === 'index_status') {
      const st = index.status();
      const warnings = [];
      const mismatch = modelMismatch();
      if (mismatch) warnings.push(mismatch);
      // Vectors resolved from more than one multifile in a collection mean the
      // index holds refs from more than one embedding run. Benign if that is just
      // an older compaction generation of the same model; a mixed vector space if
      // a model switch is partway through.
      for (const [collection, files] of Object.entries(st.embedding_files_in_use)) {
        if (files.length > 1) {
          warnings.push(`${collection} vectors resolved from ${files.length} different multifiles (${files.join(', ')}). `
            + 'If an embedding-model change is in progress, results mix two vector spaces — re-index before trusting them.');
        }
      }
      if (st.unresolvable_pointers > 0) {
        warnings.push(`${st.unresolvable_pointers} index entries point at vectors that could not be read; those notes are not searchable.`);
      }
      return ok({
        ...st,
        query_embedder: embedInfo.model,
        model_matches_query_embedder: !mismatch,
        ...(warnings.length ? { warnings } : {}),
      });
    }

    return err(`unknown tool: ${name}`);
  } catch (e) {
    // An internal TypeError is a bug here, not a caller error. Say so, rather
    // than handing back a bare "Cannot read properties of undefined".
    const msg = e?.message ?? String(e);
    console.error(`[smart-connections-mcp] ${name} failed:`, e);
    return err(e instanceof TypeError || e instanceof RangeError
      ? `internal error in smart-connections-mcp while handling ${name}: ${msg}`
      : msg);
  }
});

await server.connect(new StdioServerTransport());
console.error(`[smart-connections-mcp] ready — vault: ${VAULT}`);
