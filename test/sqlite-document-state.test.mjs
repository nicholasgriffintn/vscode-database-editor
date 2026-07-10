import assert from 'node:assert/strict';
import test from 'node:test';

import stateModule from '../dist/sqlite-document-state.js';

const { SqliteDocumentState } = stateModule;

test('document state tracks changes against the last saved database bytes', () => {
  const state = new SqliteDocumentState(new Uint8Array([1, 2, 3]));

  assert.equal(state.isDirty(), false);
  state.updateData(new Uint8Array([1, 2, 4]));
  assert.equal(state.isDirty(), true);
  state.updateData(new Uint8Array([1, 2, 3]));
  assert.equal(state.isDirty(), false);
});

test('markSaved establishes a new clean baseline without retaining a second byte snapshot', () => {
  const state = new SqliteDocumentState(new Uint8Array([1]));
  state.updateData(new Uint8Array([2]));
  state.markSaved();

  assert.equal(state.isDirty(), false);
  state.updateData(new Uint8Array([1]));
  assert.equal(state.isDirty(), true);
});

test('markSaved uses the bytes actually written when the document changes during a save', () => {
  const savedSnapshot = new Uint8Array([1]);
  const state = new SqliteDocumentState(savedSnapshot);
  state.updateData(new Uint8Array([2]));
  state.markSaved(savedSnapshot);

  assert.equal(state.isDirty(), true);
  assert.equal(state.isDirty(savedSnapshot), false);
});

test('candidate bytes can be checked before they replace the current document', () => {
  const state = new SqliteDocumentState(new Uint8Array([5, 6]));

  assert.equal(state.isDirty(new Uint8Array([5, 6])), false);
  assert.equal(state.isDirty(new Uint8Array([5, 7])), true);
  assert.deepEqual([...state.getData()], [5, 6]);
});

test('restored backup bytes remain dirty relative to the original on-disk database', () => {
  const restored = new SqliteDocumentState(
    new Uint8Array([2, 2]),
    new Uint8Array([1, 1]),
  );

  assert.equal(restored.isDirty(), true);
  restored.updateData(new Uint8Array([1, 1]));
  assert.equal(restored.isDirty(), false);
});

test('restored backup remains dirty when its original file is unavailable', () => {
  const restored = new SqliteDocumentState(new Uint8Array([2, 2]), null);

  assert.equal(restored.isDirty(), true);
  restored.markSaved();
  assert.equal(restored.isDirty(), false);
});

test('a newly registered edit remains dirty even when its bytes match the saved baseline', () => {
  const state = new SqliteDocumentState(new Uint8Array([1, 2, 3]));

  assert.equal(state.isDirty(new Uint8Array([1, 2, 3]), { isNewEdit: true }), true);
  assert.equal(state.isDirty(new Uint8Array([1, 2, 3])), false);
});
