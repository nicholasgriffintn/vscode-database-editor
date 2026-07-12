import assert from 'node:assert/strict';
import test from 'node:test';

import { detectWalSidecar } from '../dist/sqlite-wal.js';

test('detects a non-empty WAL beside a file database without modifying it', async () => {
  const databaseUri = createUri('file', '/workspace/live.sqlite');
  const stats = [];
  const result = await detectWalSidecar({
    databaseUri,
    stat: async (uri) => {
      stats.push(uri.path);
      return { size: 8192 };
    },
  });

  assert.deepEqual(stats, ['/workspace/live.sqlite-wal']);
  assert.deepEqual(result, {
    detected: true,
    size: 8192,
    warning: 'A non-empty SQLite WAL sidecar (8 KB) exists. The main database file may not include uncheckpointed changes from another connection.',
  });
});

test('skips non-file databases and treats missing, unreadable, or empty WAL files as undetected', async () => {
  let probes = 0;
  assert.deepEqual(await detectWalSidecar({
    databaseUri: createUri('database-test', '/workspace/remote.sqlite'),
    stat: async () => { probes += 1; throw new Error('must not probe'); },
  }), { detected: false });
  assert.equal(probes, 0);

  for (const stat of [
    async () => ({ size: 0 }),
    async () => { throw new Error('not found'); },
    async () => { throw new Error('permission denied'); },
  ]) {
    assert.deepEqual(await detectWalSidecar({
      databaseUri: createUri('file', '/workspace/local.sqlite'),
      stat,
    }), { detected: false });
  }
});

function createUri(scheme, path) {
  return { scheme, path, with(change) { return createUri(change.scheme ?? scheme, change.path ?? path); } };
}
