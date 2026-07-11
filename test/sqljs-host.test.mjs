import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadSqlJs } from '../dist/sqljs-host.js';

test('a rejected sql.js initialization can be retried', async () => {
  const extensionPath = path.join(process.cwd(), '.tmp', 'sqljs-host-retry');
  const vendorPath = path.join(extensionPath, 'media', 'vendor', 'sqljs');
  await mkdir(vendorPath, { recursive: true });
  await writeFile(path.join(vendorPath, 'sql-wasm.js'), `
    let attempts = 0;
    module.exports = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('simulated initialization failure');
      return { Database: class {} };
    };
  `);

  const extensionUri = { fsPath: extensionPath };
  await assert.rejects(loadSqlJs(extensionUri), /simulated initialization failure/);
  const SQL = await loadSqlJs(extensionUri);

  assert.equal(typeof SQL.Database, 'function');
});
