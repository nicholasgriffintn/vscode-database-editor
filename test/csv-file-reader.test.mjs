import assert from 'node:assert/strict';
import test from 'node:test';

import { readCsvFile } from '../dist/csv-file-reader.js';

const documentUri = { path: '/workspace/database.sqlite', with(change) { return { ...this, ...change }; } };

test('CSV file reader handles cancellation and decodes selected files through workspace FS', async () => {
  assert.deepEqual(await readCsvFile({ documentUri, showOpenDialog: async () => undefined, readFile: async () => assert.fail() }), { status: 'cancelled' });
  const selected = { path: '/workspace/people.csv' };
  const result = await readCsvFile({
    documentUri,
    showOpenDialog: async (options) => {
      assert.equal(options.defaultUri.path, '/workspace');
      assert.deepEqual(options.filters['CSV files'], ['csv']);
      return [selected];
    },
    readFile: async (uri) => {
      assert.equal(uri, selected);
      return new TextEncoder().encode('id,name\n1,Ada');
    },
  });
  assert.deepEqual(result, { status: 'completed', name: 'people.csv', content: 'id,name\n1,Ada' });
});

test('CSV file reader propagates workspace read failures', async () => {
  await assert.rejects(readCsvFile({
    documentUri,
    showOpenDialog: async () => [{ path: '/workspace/broken.csv' }],
    readFile: async () => { throw new Error('read failed'); },
  }), /read failed/);
});
