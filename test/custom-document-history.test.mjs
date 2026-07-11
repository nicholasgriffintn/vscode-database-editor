import assert from 'node:assert/strict';
import test from 'node:test';

import historyModule from '../dist/custom-document-history.js';

const { applySnapshotDocumentChange, cloneData, createSnapshotEditEvent } = historyModule;

test('host-originated snapshot changes post updated bytes after registering the edit', async () => {
  const events = [];
  const posted = [];
  const document = {
    data: new Uint8Array([1, 1]),
    getData() {
      return this.data;
    },
    updateData(data) {
      this.data = data;
    },
  };

  await applySnapshotDocumentChange({
    document,
    data: new Uint8Array([2, 2]),
    label: 'Copilot: add person',
    emitEdit: (event) => events.push(event),
    postSnapshot: (data) => posted.push([...data]),
    postAfterApply: true,
  });

  assert.deepEqual([...document.getData()], [2, 2]);
  assert.equal(events.at(-1).label, 'Copilot: add person');
  assert.deepEqual(posted, [[2, 2]]);
});

test('host-originated snapshot changes commit even when a disposed webview cannot refresh', async () => {
  const events = [];
  const document = createRevisionedDocument([1, 2, 3]);

  const result = await applySnapshotDocumentChange({
    document,
    data: new Uint8Array([4, 5, 6]),
    label: 'Copilot migration',
    emitEdit: (event) => events.push(event),
    postSnapshot: async () => {
      throw new Error('webview disposed');
    },
    postAfterApply: true,
    expectedRevision: 0,
  });

  assert.deepEqual(result, { accepted: true, revision: 1 });
  assert.deepEqual([...document.getData()], [4, 5, 6]);
  assert.equal(events.length, 1);
});

test('stale snapshot changes leave bytes, revision, and edit history unchanged', async () => {
  const events = [];
  const document = createRevisionedDocument([1, 2, 3], 2);

  const result = await applySnapshotDocumentChange({
    document,
    data: new Uint8Array([9, 9, 9]),
    expectedRevision: 1,
    emitEdit: (event) => events.push(event),
    postSnapshot: () => {},
  });

  assert.deepEqual(result, { accepted: false, currentRevision: 2 });
  assert.deepEqual([...document.getData()], [1, 2, 3]);
  assert.equal(document.getRevision(), 2);
  assert.deepEqual(events, []);
});

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

test('oversized snapshot changes fall back to content changes without retaining undo snapshots', async () => {
  const events = [];
  const posted = [];
  const cloneLog = [];
  const before = new Uint8Array([1, 2, 3]);
  const document = {
    data: before,
    getData() {
      return this.data;
    },
    updateData(data) {
      this.data = data;
    },
  };

  await applySnapshotDocumentChange({
    document,
    data: new Uint8Array([4, 5, 6, 7]),
    label: 'Large edit',
    emitEdit: (event) => events.push(event),
    postSnapshot: (data) => posted.push([...data]),
    maxUndoMemoryBytes: 6,
    cloneData: (data) => {
      cloneLog.push(data === before ? 'before' : 'after');
      return new Uint8Array(data);
    },
  });

  assert.deepEqual([...document.getData()], [4, 5, 6, 7]);
  assert.equal(events.length, 1);
  assert.equal(events[0].document, document);
  assert.equal(typeof events[0].undo, 'undefined');
  assert.deepEqual(posted, []);
  // Over-budget path should copy only incoming bytes once and never clone the existing document bytes.
  assert.deepEqual(cloneLog, ['after']);
});

test('in-budget snapshot updates keep exactly one clone of current and incoming bytes', async () => {
  const cloneLog = [];
  const document = {
    data: new Uint8Array([1, 2]),
    getData() {
      return this.data;
    },
    updateData(data) {
      this.data = data;
    },
  };

  await applySnapshotDocumentChange({
    document,
    data: new Uint8Array([3, 4]),
    label: 'Small edit',
    emitEdit: () => {},
    postSnapshot: () => {},
    maxUndoMemoryBytes: 20,
    cloneData: (data) => {
      cloneLog.push(data === document.data ? 'before' : 'incoming');
      return new Uint8Array(data);
    },
  });

  // Keep-undo path should clone exactly these two buffers before update: one for current state and one for incoming data.
  assert.deepEqual(cloneLog, ['before', 'incoming']);
});

function createRevisionedDocument(values, revision = 0) {
  return {
    data: new Uint8Array(values),
    revision,
    queue: Promise.resolve(),
    getData() {
      return this.data;
    },
    getRevision() {
      return this.revision;
    },
    updateData(data) {
      this.data = data;
      this.revision += 1;
    },
    enqueueMutation(operation) {
      const result = this.queue.then(operation, operation);
      this.queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
