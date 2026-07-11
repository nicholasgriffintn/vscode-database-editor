import assert from 'node:assert/strict';
import test from 'node:test';

import { arraysEqual } from '../media/array-utils.mjs';
import { getErrorMessage } from '../media/error-utils.mjs';

test('shared media utilities compare ordered collections and normalize errors', () => {
  assert.equal(arraysEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(arraysEqual(['a', 'b'], ['b', 'a']), false);
  assert.equal(arraysEqual(['a'], ['a', 'b']), false);
  assert.equal(getErrorMessage(new Error('failed')), 'failed');
  assert.equal(getErrorMessage('failed'), 'failed');
});
