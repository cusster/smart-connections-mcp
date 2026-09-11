// Path safety. The tool reads files by a caller-supplied path, so this is the
// whole security surface of the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultIndex } from '../src/vault.js';
import { makeFixture } from './helpers/fixture.mjs';

const root = path.join(os.tmpdir(), 'sc-mcp-test-paths');
makeFixture(root);

const SECRET = path.join(os.tmpdir(), 'sc-mcp-outside-secret.txt');
fs.writeFileSync(SECRET, 'TOPSECRET');
let symlinks = true;
for (const [name, target] of [['escape.md', SECRET], ['sub/escape.md', '/etc/passwd'], ['escapedir', os.tmpdir()]]) {
  try { fs.symlinkSync(target, path.join(root, name)); } catch { symlinks = false; }
}

const idx = new VaultIndex(root);
await idx.load();

test('symlinks out of the vault are blocked', { skip: symlinks ? false : 'symlinks unsupported here' }, () => {
  assert.equal(idx.readNote('escape.md'), null);
  assert.equal(idx.readNote('sub/escape.md'), null);
  // A symlinked DIRECTORY leaves the leaf a plain file, so checking only whether
  // the final component is a symlink misses this. It leaked once; it stays tested.
  assert.equal(idx.readNote('escapedir/sc-mcp-outside-secret.txt'), null);
});

test('traversal and absolute paths are blocked', () => {
  for (const p of [
    '../../../etc/passwd', '..\\..\\windows\\system32', '/etc/passwd',
    'sub/../../etc/passwd', './../.ssh/id_rsa', 'sub/./../../etc/hosts',
    '....//....//etc/passwd', '', '   ',
  ]) assert.equal(idx.readNote(p), null, `leaked: ${p}`);
});

test('dot-folders are unreachable (M3: plugins keep API keys there)', () => {
  for (const p of [
    '.obsidian/plugins/somePlugin/data.json', '.obsidian/workspace.json',
    '.smart-env/smart_env.json', 'sub/../.obsidian/plugins/somePlugin/data.json',
  ]) assert.equal(idx.readNote(p), null, `leaked: ${p}`);
});

// The 8.3 short-name bypass (C1) only exists on drvfs, where fs.realpathSync
// returns "OBSIDI~1" unchanged so a leading-dot check never fires. That cannot be
// reproduced on ext4, but the GUARD can: the defence is that every resolved
// component must appear verbatim in its parent's directory listing, and a
// filesystem-generated alias never does. Stubbing readdirSync to omit an entry
// reproduces exactly that condition. The real 8.3 case is covered by
// test/mcp.test.mjs against a Windows-hosted vault.
test('a path component that does not appear in its parent listing is refused', () => {
  const idx2 = new VaultIndex(root);
  const real = fs.readdirSync;
  fs.readdirSync = (dir, ...rest) => real.call(fs, dir, ...rest).filter((n) => n !== 'sub');
  try {
    // the file exists and resolves; only the listing disagrees
    assert.ok(fs.existsSync(path.join(root, 'sub', 'ok.md')));
    assert.equal(idx2.readNote('sub/ok.md'), null, 'alias-style component was accepted');
  } finally { fs.readdirSync = real; }
  // and with the listing intact it reads normally
  const idx3 = new VaultIndex(root);
  assert.match(idx3.readNote('sub/ok.md'), /real content here/);
});

test('non-string input does not throw', () => {
  for (const p of [null, undefined, 42, {}, [], true]) assert.equal(idx.readNote(p), null);
});

test('legitimate notes are still readable', () => {
  assert.match(idx.readNote('sub/ok.md'), /real content here/);
  assert.match(idx.readNote('alive.md'), /line two of alive/);
  assert.equal(idx.readNote('does-not-exist.md'), null);
});

test.after(() => fs.rmSync(SECRET, { force: true }));
