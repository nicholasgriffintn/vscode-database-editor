import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDatabaseSaveFailedMessage,
  createDatabaseSavedMessage,
  decideSaveAcknowledgement,
} from '../dist/custom-editor-protocol.js';

test('current save acknowledgements can clear the webview dirty state', () => {
  assert.deepEqual(decideSaveAcknowledgement({
    savedRevision: 4,
    currentRevision: 4,
    dirty: false,
  }), {
    acknowledgedRevision: 4,
    clearDirty: true,
    dirty: false,
    shouldRetry: false,
  });
});

test('stale save acknowledgements keep newer edits dirty and request another save', () => {
  assert.deepEqual(decideSaveAcknowledgement({
    savedRevision: 4,
    currentRevision: 5,
    dirty: false,
  }), {
    acknowledgedRevision: 4,
    clearDirty: false,
    dirty: true,
    shouldRetry: true,
  });
});

test('current acknowledgements preserve dirty state when newer bytes are already known', () => {
  assert.deepEqual(decideSaveAcknowledgement({
    savedRevision: 4,
    currentRevision: 4,
    dirty: true,
  }), {
    acknowledgedRevision: 4,
    clearDirty: false,
    dirty: true,
    shouldRetry: false,
  });
});

test('revision decisions remain backward compatible until both revisions are available', () => {
  assert.deepEqual(decideSaveAcknowledgement({
    savedRevision: 4,
    dirty: false,
  }), {
    acknowledgedRevision: 4,
    clearDirty: true,
    dirty: false,
    shouldRetry: false,
  });
  assert.deepEqual(decideSaveAcknowledgement({
    currentRevision: 5,
    dirty: false,
  }), {
    clearDirty: true,
    dirty: false,
    shouldRetry: false,
  });
});

test('save acknowledgement messages preserve current dirty-state behavior before revisions are wired', () => {
  assert.deepEqual(createDatabaseSavedMessage({ dirty: false }), {
    type: 'databaseSaved',
    dirty: false,
  });
  assert.deepEqual(createDatabaseSavedMessage({ dirty: true }), {
    type: 'databaseSaved',
    dirty: true,
  });
});

test('save failure messages normalize thrown and non-Error values', () => {
  assert.deepEqual(createDatabaseSaveFailedMessage(new Error('disk full')), {
    type: 'databaseSaveFailed',
    message: 'disk full',
  });
  assert.deepEqual(createDatabaseSaveFailedMessage('cancelled'), {
    type: 'databaseSaveFailed',
    message: 'cancelled',
  });
});

test('revision-aware save acknowledgement messages include the saved revision', () => {
  assert.deepEqual(createDatabaseSavedMessage({
    dirty: false,
    savedRevision: 7,
    currentRevision: 7,
  }), {
    type: 'databaseSaved',
    dirty: false,
    revision: 7,
  });
});
