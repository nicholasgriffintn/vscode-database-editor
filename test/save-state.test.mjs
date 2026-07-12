import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDocumentController,
  getDirtyStatusText,
  getSaveButtonState,
} from '../media/editor/save-state.mjs';

test('save button is disabled until a database is open and dirty', () => {
  assert.deepEqual(getSaveButtonState({ hasDatabase: false, isDirty: false, isSaving: false }), {
    disabled: true,
    label: 'Save',
  });
  assert.deepEqual(getSaveButtonState({ hasDatabase: true, isDirty: false, isSaving: false }), {
    disabled: true,
    label: 'Save',
  });
  assert.deepEqual(getSaveButtonState({ hasDatabase: true, isDirty: true, isSaving: false }), {
    disabled: false,
    label: 'Save',
  });
});

test('save button shows a saving label and stays disabled mid-save', () => {
  assert.deepEqual(getSaveButtonState({ hasDatabase: true, isDirty: true, isSaving: true }), {
    disabled: true,
    label: 'Saving…',
  });
});

test('dirty status text reflects load, dirty, saving, and saved states', () => {
  assert.equal(getDirtyStatusText({ hasDatabase: false, isDirty: false, isSaving: false }), 'Waiting for file');
  assert.equal(getDirtyStatusText({ hasDatabase: true, isDirty: false, isSaving: false }), 'All changes saved');
  assert.equal(getDirtyStatusText({ hasDatabase: true, isDirty: true, isSaving: false }), 'Unsaved changes');
  assert.equal(getDirtyStatusText({ hasDatabase: true, isDirty: true, isSaving: true }), 'Saving…');
});

test('document controller owns mutation, save acknowledgement, and retry state', () => {
  const messages = [];
  const renders = [];
  const deferred = [];
  const controller = createDocumentController({
    getDatabase: () => ({ export: () => Uint8Array.from([1, 2, 3]) }),
    shouldAutoSave: () => false,
    postMessage: (message) => messages.push(message),
    render: (state) => renders.push({ ...state }),
    setStatus: () => {},
    defer: (callback) => deferred.push(callback),
  });

  controller.load({ dirty: false, revision: 4 });
  controller.markChanged();
  controller.requestSave();
  controller.markChanged();
  controller.requestSave();

  assert.equal(controller.revision, 6);
  assert.equal(controller.isDirty, true);
  assert.equal(controller.isSaving, true);
  assert.deepEqual(messages.map((message) => message.type), ['databaseChanged', 'requestSave', 'databaseChanged']);
  assert.equal(messages[0].baseRevision, 4);
  assert.equal(messages[1].revision, 5);

  controller.handleSaved(false, 5, messages[1].requestId);
  assert.equal(controller.isDirty, true);
  assert.equal(controller.isSaving, false);
  assert.equal(deferred.length, 1);
  deferred.shift()();
  assert.equal(messages.at(-1).type, 'requestSave');
  assert.equal(messages.at(-1).revision, 6);
  assert.equal(renders.at(-1).isSaving, true);
});

test('document controller reports errors through the host and status surface', () => {
  const messages = [];
  const statuses = [];
  const controller = createDocumentController({
    getDatabase: () => null,
    shouldAutoSave: () => false,
    postMessage: (message) => messages.push(message),
    render: () => {},
    setStatus: (message) => statuses.push(message),
  });

  controller.reportError(new Error('Database is unavailable'));

  assert.deepEqual(statuses, ['Database is unavailable']);
  assert.deepEqual(messages, [{ type: 'error', message: 'Database is unavailable' }]);
});
