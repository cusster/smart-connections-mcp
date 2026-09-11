// The vault records which model wrote its vectors. If that is not the model this
// server embeds queries with, every search returns ranked, confident, unrelated
// results and nothing throws — so it must be refused.
//
// This runs against a FIXTURE rather than a real vault because the guard fires
// before any embedding happens: no model download, no vault required, and the
// mutation harness can therefore see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './helpers/fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'index.js');

function server(root, env = {}) {
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SMART_VAULT_PATH: root, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  let id = 0;
  srv.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); } catch { /* ignore */ }
    }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, res);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => rej(new Error('timeout: ' + method)), 30000);
  });
  return {
    srv,
    async start() {
      await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    async call(name, args) {
      const r = await send('tools/call', { name, arguments: args });
      const raw = r.result?.content?.[0]?.text ?? '';
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* ignore */ }
      return { isError: Boolean(r.result?.isError), raw, parsed };
    },
  };
}

const root = path.join(os.tmpdir(), 'sc-mcp-test-modelguard');
makeFixture(root);
// declare a model the query embedder is not configured for
const envPath = path.join(root, '.smart-env', 'smart_env.json');
fs.writeFileSync(envPath, JSON.stringify({
  smart_sources: { embed_model: { transformers: { model_key: 'Snowflake/snowflake-arctic-embed-xs' } } },
}));

test('search is refused when the vault model and query embedder disagree', async () => {
  const s = server(root);
  await s.start();
  try {
    const r = await s.call('search_notes', { query: 'anything', limit: 2 });
    assert.ok(r.isError, 'a mismatched embedder must not be served');
    assert.match(r.raw, /embedding model mismatch/);
    assert.match(r.raw, /SMART_EMBED_MODEL/, 'the error must say how to fix it');

    const rel = await s.call('related_notes', { path: 'alive.md', limit: 2 });
    assert.ok(rel.isError && /embedding model mismatch/.test(rel.raw), 'related_notes must refuse too');
  } finally { s.srv.kill(); }
});

test('index_status stays usable and reports the mismatch', async () => {
  const s = server(root);
  await s.start();
  try {
    const r = await s.call('index_status', {});
    assert.ok(!r.isError, 'the diagnostic tool must keep working');
    assert.equal(r.parsed.model_matches_query_embedder, false);
    assert.ok(r.parsed.warnings?.some((w) => /embedding model mismatch/.test(w)));
    assert.ok(r.parsed.warnings?.some((w) => /not searchable/.test(w)),
      'the fixture has an unresolvable pointer; that should be surfaced too');
  } finally { s.srv.kill(); }
});

test('get_note is not gated on the embedder', async () => {
  const s = server(root);
  await s.start();
  try {
    const r = await s.call('get_note', { path: 'alive.md' });
    assert.ok(!r.isError, r.raw);
    assert.match(r.parsed.text, /line two of alive/);
  } finally { s.srv.kill(); }
});

test('a matching model reports agreement', async () => {
  fs.writeFileSync(envPath, JSON.stringify({
    smart_sources: { embed_model: { transformers: { model_key: 'TaylorAI/bge-micro-v2' } } },
  }));
  const s = server(root);
  await s.start();
  try {
    const r = await s.call('index_status', {});
    assert.equal(r.parsed.model_matches_query_embedder, true);
    assert.ok(!r.parsed.warnings?.some((w) => /model mismatch/.test(w)));
  } finally { s.srv.kill(); }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
