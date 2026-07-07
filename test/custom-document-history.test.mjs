import assert from 'node:assert/strict';
import test from 'node:test';

import historyModule from '../dist/custom-document-history.js';

const { cloneData, createSnapshotEditEvent } = historyModule;

test('snapshot edit events restore before and after document bytes', async () => {
  const posted = [];
  const document = {
    data: new Uint8Array([2, 2, 2]),
    getData() {
      return this.data;
    },
    updateData(data) {
      this.data = data;
    },
  };

  const edit = createSnapshotEditEvent({
    document,
    before: new Uint8Array([1, 1, 1]),
    after: new Uint8Array([3, 3, 3]),
    label: 'Edit row',
    postSnapshot: (data) => posted.push([...data]),
  });

  assert.equal(edit.document, document);
  assert.equal(edit.label, 'Edit row');

  await edit.undo();
  assert.deepEqual([...document.getData()], [1, 1, 1]);
  assert.deepEqual(posted.at(-1), [1, 1, 1]);

  await edit.redo();
  assert.deepEqual([...document.getData()], [3, 3, 3]);
  assert.deepEqual(posted.at(-1), [3, 3, 3]);
});

test('snapshot edit events clone input bytes so later mutation cannot corrupt history', async () => {
  const before = new Uint8Array([1, 2]);
  const after = new Uint8Array([3, 4]);
  const document = {
    data: new Uint8Array([0]),
    getData() {
      return this.data;
    },
    updateData(data) {
      this.data = data;
    },
  };

  const edit = createSnapshotEditEvent({ document, before, after, postSnapshot: () => {} });
  before[0] = 9;
  after[0] = 8;

  await edit.undo();
  assert.deepEqual([...document.getData()], [1, 2]);

  await edit.redo();
  assert.deepEqual([...document.getData()], [3, 4]);
});

test('cloneData returns an independent Uint8Array copy', () => {
  const source = new Uint8Array([7, 8]);
  const copy = cloneData(source);
  source[0] = 0;

  assert.deepEqual([...copy], [7, 8]);
});
