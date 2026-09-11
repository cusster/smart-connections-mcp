// C3: Obsidian rewrites the index while this runs. Compaction renumbers every
// file_i, so an ajson read from before it paired with a multifile read from
// after it gives each note a vector belonging to a DIFFERENT note — all
// unit-norm, all real, no error. Only a signature re-check can catch it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VaultIndex } from '../src/vault.js';
import { makeFixture, padAjson } from './helpers/fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(os.tmpdir(), `sc-mcp-test-concurrency-${process.pid}`);
const { SRC } = makeFixture(root);
// The read has to take long enough to be interruptible at all.
padAjson(SRC, 40000);
const MF = path.join(SRC, 'mf_old');
const STOP = path.join(root, 'STOP');
const original = fs.readFileSync(MF);

// Derived, not hardcoded: the fixture's own record count changes as cases are
// added to it, and a literal here fails for reasons that have nothing to do with
// concurrency.
let EXPECTED = 0;

test('loads cleanly when the index is quiet', async () => {
  const idx = new VaultIndex(root);
  await idx.load();
  EXPECTED = idx.items.length;
  assert.ok(EXPECTED > 40000, `expected the padded index, got ${EXPECTED} items`);
  assert.equal(idx.raced, 0);
});

test('refuses to serve a read the index changed underneath', async () => {
  fs.rmSync(STOP, { force: true });
  // A SEPARATE process: load() reads synchronously, so nothing in this process
  // can interleave with it.
  const churn = spawn(process.execPath, [path.join(HERE, 'helpers', 'churn.mjs'), MF, STOP], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));

  const idx = new VaultIndex(root);
  await assert.rejects(() => idx.load(), /changed under every one of \d+ read attempts/);
  assert.ok(idx.raced >= 1, 'should have retried');
  assert.equal(idx.items.length, 0, 'must not leave half-loaded state');

  fs.writeFileSync(STOP, '');
  await new Promise((r) => churn.on('exit', r));
  fs.writeFileSync(MF, original);

  // and recovers once things settle
  await idx.load();
  assert.equal(idx.items.length, EXPECTED);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
