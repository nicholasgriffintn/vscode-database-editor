import assert from 'node:assert/strict';
import test from 'node:test';

import { safeFileName } from '../media/file-utils.mjs';

test('normalises unsafe file name characters', () => {
  assert.equal(safeFileName('../data/main.sqlite:people'), 'data-main.sqlite-people');
  assert.equal(safeFileName('   '), 'database-export');
});
