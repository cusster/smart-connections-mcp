// Protocol-level tests against the REAL vault, over real stdio JSON-RPC.
// Skipped unless SMART_VAULT_PATH is set, since it needs an indexed vault and
// downloads the embedding model on first run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VAULT = process.env.SMART_VAULT_PATH;
const skip = VAULT ? false : 'set SMART_VAULT_PATH to run vault-backed tests';
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

let srv, rpc, stderr = '', badStdout = [];

before(async () => {
  if (skip) return;
  srv = spawn(process.execPath, [SERVER], { env: { ...process.env, SMART_VAULT_PATH: VAULT }, stdio: ['pipe', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => { stderr += d; });
  let buf = '';
  const pending = new Map();
  let id = 0;
  srv.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      } catch { badStdout.push(line.slice(0, 120)); }
    }
  });
  rpc = (method, params) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, res);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => rej(new Error('timeout: ' + method)), 240000);
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(() => srv?.kill());

const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const raw = r.result?.content?.[0]?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* error bodies are JSON too, but be safe */ }
  return { isError: Boolean(r.result?.isError), parsed, raw };
};

test('lists its four tools', { skip }, async () => {
  const r = await rpc('tools/list');
  assert.deepEqual(r.result.tools.map((t) => t.name).sort(),
    ['get_note', 'index_status', 'related_notes', 'search_notes']);
});

test('bad arguments fail loudly instead of returning nothing (M1)', { skip }, async () => {
  let r = await call('search_notes', { query: 'valkey', limit: 'abc' });
  assert.ok(r.isError && /limit must be a number/.test(r.raw));
  r = await call('search_notes', { query: 'valkey', min_score: 'high' });
  assert.ok(r.isError && /min_score must be a number/.test(r.raw));
  r = await call('search_notes', { query: '   ' });
  assert.ok(r.isError, 'blank query should be rejected');
  r = await call('search_notes', { query: 'valkey', scope: 'bogus' });
  assert.ok(r.isError && /scope must be/.test(r.raw));
});

test('limit is clamped, never unbounded (M1)', { skip }, async () => {
  let r = await call('search_notes', { query: 'valkey cache eviction', limit: -1 });
  assert.ok(!r.isError);
  assert.equal(r.parsed.results.length, 1, 'limit:-1 must not mean "everything"');
  r = await call('search_notes', { query: 'valkey cache eviction', limit: 9999, min_score: 0 });
  assert.ok(r.parsed.results.length <= 100);
});

test('get_note refuses paths outside note content', { skip }, async () => {
  for (const p of ['.obsidian/plugins/smart-connections/data.json', '.smart-env/smart_env.json',
                   '../../../etc/passwd', '.obsidian/workspace.json']) {
    const r = await call('get_note', { path: p });
    assert.ok(r.isError, `leaked: ${p}`);
  }
});

// On drvfs (/mnt/c) — the filesystem this server exists to serve —
// fs.realpathSync does NOT canonicalise Windows 8.3 short names, so ".obsidian"
// reached as "OBSIDI~1" comes back unchanged and sails past a leading-dot check.
// This needs a real Windows-backed vault; it cannot be reproduced on ext4.
test('8.3 short names cannot reach dot-folders', { skip }, async () => {
  for (const p of ['OBSIDI~1/plugins/smart-connections/data.json',
                   'OBSIDI~1/workspace.json',
                   'SMART-~1/smart_env.json',
                   'SMART-~1/smart_sources/smart_sources.ajson']) {
    const r = await call('get_note', { path: p });
    assert.ok(r.isError, `8.3 short name leaked a dot-folder: ${p}`);
  }
});

test('numeric arguments are not silently coerced', { skip }, async () => {
  // Number("") === 0 and Number([]) === 0, so an earlier version turned
  // `limit: ""` into 1 result and a caller concluded the vault held one match.
  for (const bad of ['', [], true, {}, '  ']) {
    const r = await call('search_notes', { query: 'valkey', limit: bad });
    assert.ok(r.isError, `limit:${JSON.stringify(bad)} was accepted`);
  }
  for (const bad of ['', [], true]) {
    const r = await call('search_notes', { query: 'valkey', min_score: bad });
    assert.ok(r.isError, `min_score:${JSON.stringify(bad)} was accepted`);
  }
  // a numeric string is still fine
  const okr = await call('search_notes', { query: 'valkey', limit: '3', min_score: '0' });
  assert.ok(!okr.isError && okr.parsed.results.length === 3, okr.raw.slice(0, 80));
});

test('an oversized query is refused rather than tokenised and discarded', { skip }, async () => {
  const r = await call('search_notes', { query: 'x'.repeat(20000) });
  assert.ok(r.isError && /maximum is \d+/.test(r.raw), r.raw.slice(0, 100));
});

test('get_note honours max_chars and its ceiling (H3)', { skip }, async () => {
  const st = await call('index_status', {});
  const some = st.parsed.embedded_notes > 0;
  assert.ok(some, 'vault has no embedded notes');
  const hit = (await call('search_notes', { query: 'anything', limit: 1, min_score: 0 })).parsed.results[0];
  const r = await call('get_note', { path: hit.path, max_chars: 500 });
  assert.ok(!r.isError && r.parsed.text.length < 700, `${r.parsed?.text?.length} chars`);
  const capped = await call('get_note', { path: hit.path, max_chars: 99_999_999 });
  assert.ok(!capped.isError && capped.parsed.text.length <= 400_100);
});

test('search returns hits that say which vector matched', { skip }, async () => {
  const r = await call('search_notes', { query: 'how do we ship logs to graylog over GELF', limit: 5 });
  assert.ok(!r.isError && r.parsed.results.length > 0, 'no results');
  for (const h of r.parsed.results) {
    assert.ok(['note', 'block'].includes(h.matched), `bad matched: ${h.matched}`);
    assert.equal(typeof h.excerpt, 'string');
    assert.ok(h.score <= 1.0001 && h.score >= -1.0001, `score out of range: ${h.score}`);
  }
});

test('index_status reports both collections and its diagnostics', { skip }, async () => {
  const r = await call('index_status', {});
  assert.ok(!r.isError);
  assert.ok(r.parsed.embedded_notes > 0);
  assert.ok(r.parsed.embedded_blocks > 0, 'block vectors are the bulk of vault coverage');
  assert.equal(typeof r.parsed.deletion_tombstones_applied, 'number');
  assert.equal(typeof r.parsed.unresolvable_pointers, 'number');
  assert.ok(r.parsed.embedding_files_in_use, 'must report which multifiles vectors came from');
  assert.equal(r.parsed.query_embedder, 'TaylorAI/bge-micro-v2');
  assert.equal(r.parsed.model_matches_query_embedder, true,
    'a healthy vault must report that its vectors and the query embedder agree');
});

test('related_notes resolves a real path', { skip }, async () => {
  const hit = (await call('search_notes', { query: 'anything', limit: 1, min_score: 0 })).parsed.results[0];
  const r = await call('related_notes', { path: hit.path, limit: 3 });
  assert.ok(!r.isError, r.raw);
  assert.ok(r.parsed.related.length <= 3);
  assert.ok(!r.parsed.related.some((x) => x.path === hit.path), 'must not return itself');
});

// A model switch is the case where #pickRef's greatest-`at` rule diverges from
// the plugin's fingerprint pinning — and, more importantly, where the query
// embedder stops matching the vectors. Searching across two vector spaces
// returns ranked, confident, unrelated results with no error, so it must be
// refused rather than served. Spawns its own server with the embedder overridden.
test('a model mismatch is refused, not silently served', { skip }, async () => {
  const alt = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SMART_VAULT_PATH: VAULT, SMART_EMBED_MODEL: 'Snowflake/snowflake-arctic-embed-xs' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    let b = '';
    const pend = new Map();
    let n = 0;
    alt.stdout.on('data', (d) => {
      b += d;
      let nl;
      while ((nl = b.indexOf('\n')) >= 0) {
        const line = b.slice(0, nl); b = b.slice(nl + 1);
        if (!line.trim()) continue;
        try { const m = JSON.parse(line); pend.get(m.id)?.(m); pend.delete(m.id); } catch { /* ignore */ }
      }
    });
    const send = (method, params) => new Promise((res, rej) => {
      const id = ++n;
      pend.set(id, res);
      alt.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => rej(new Error('timeout: ' + method)), 120000);
    });
    await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    alt.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const body = async (name, args) => {
      const r = await send('tools/call', { name, arguments: args });
      return { isError: Boolean(r.result?.isError), raw: r.result?.content?.[0]?.text ?? '' };
    };

    const s1 = await body('search_notes', { query: 'anything', limit: 2 });
    assert.ok(s1.isError, 'search must refuse a mismatched embedder');
    assert.match(s1.raw, /embedding model mismatch/);
    assert.match(s1.raw, /SMART_EMBED_MODEL/, 'the error must say how to fix it');

    const s2 = await body('related_notes', { path: 'whatever.md', limit: 2 });
    assert.ok(s2.isError && /embedding model mismatch/.test(s2.raw), 'related_notes must refuse too');

    // index_status is the diagnostic — it must stay usable and say what is wrong
    const s3 = await body('index_status', {});
    assert.ok(!s3.isError);
    const st = JSON.parse(s3.raw);
    assert.equal(st.model_matches_query_embedder, false);
    assert.ok(st.warnings?.some((w) => /embedding model mismatch/.test(w)));

    // get_note does not embed anything, so it must keep working
    const hit = await body('get_note', { path: 'definitely-not-here.md' });
    assert.ok(!/embedding model mismatch/.test(hit.raw), 'get_note must not be gated on the embedder');
  } finally { alt.kill(); }
});

test('unknown tool is an error, not a crash', { skip }, async () => {
  const r = await call('nope', {});
  assert.ok(r.isError && /unknown tool/.test(r.raw));
});

test('stdout carries only JSON-RPC; the banner goes to stderr', { skip }, () => {
  assert.deepEqual(badStdout, [], `non-JSON on stdout: ${badStdout.join(' | ')}`);
  assert.match(stderr, /ready — vault/);
});
