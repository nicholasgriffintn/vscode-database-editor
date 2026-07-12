import assert from 'node:assert/strict';
import test from 'node:test';

import { arraysEqual, getRovingIndex } from '../media/utilities/array.mjs';
import { getErrorMessage } from '../media/utilities/errors.mjs';

test('shared media utilities compare ordered collections and normalize errors', () => {
  assert.equal(arraysEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(arraysEqual(['a', 'b'], ['b', 'a']), false);
  assert.equal(arraysEqual(['a'], ['a', 'b']), false);
  assert.equal(getErrorMessage(new Error('failed')), 'failed');
  assert.equal(getErrorMessage('failed'), 'failed');
});

test('roving indexes wrap and support Home and End navigation', () => {
  assert.equal(getRovingIndex({ key: 'ArrowRight', currentIndex: 2, itemCount: 3 }), 0);
  assert.equal(getRovingIndex({ key: 'ArrowLeft', currentIndex: 0, itemCount: 3 }), 2);
  assert.equal(getRovingIndex({ key: 'Home', currentIndex: 2, itemCount: 3 }), 0);
  assert.equal(getRovingIndex({ key: 'End', currentIndex: 0, itemCount: 3 }), 2);
});
