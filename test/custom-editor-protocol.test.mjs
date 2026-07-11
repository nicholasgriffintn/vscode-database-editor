import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDatabaseSaveFailedMessage,
  createDatabaseSavedMessage,
  decideIncomingDatabaseChange,
  decideSaveAcknowledgement,
} from '../dist/custom-editor-protocol.js';

test('current incoming database changes are accepted without rehydration', () => {
  assert.deepEqual(decideIncomingDatabaseChange({
    baseRevision: 4,
    currentRevision: 4,
  }), {
    accepted: true,
    shouldRehydrate: false,
  });
});

test('stale incoming database changes are rejected and rehydrated', () => {
  assert.deepEqual(decideIncomingDatabaseChange({
    baseRevision: 3,
    currentRevision: 4,
  }), {
    accepted: false,
    shouldRehydrate: true,
  });
});

test('incoming database changes without a base revision are rejected once the host is revision-aware', () => {
  assert.deepEqual(decideIncomingDatabaseChange({ currentRevision: 4 }), {
    accepted: false,
    shouldRehydrate: true,
  });
});

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

test('save acknowledgement messages require and preserve the saved revision', () => {
  assert.deepEqual(createDatabaseSavedMessage({
    dirty: false,
    savedRevision: 4,
    currentRevision: 4,
    requestId: 'webview-1',
  }), {
    type: 'databaseSaved',
    dirty: false,
    revision: 4,
    requestId: 'webview-1',
  });
  assert.deepEqual(createDatabaseSavedMessage({
    dirty: true,
    savedRevision: 4,
    currentRevision: 5,
    requestId: 'webview-2',
  }), {
    type: 'databaseSaved',
    dirty: true,
    revision: 4,
    requestId: 'webview-2',
  });
});

test('save failure messages normalize thrown and non-Error values', () => {
  assert.deepEqual(createDatabaseSaveFailedMessage(new Error('disk full'), 7, 'webview-3'), {
    type: 'databaseSaveFailed',
    message: 'disk full',
    revision: 7,
    requestId: 'webview-3',
  });
  assert.deepEqual(createDatabaseSaveFailedMessage('cancelled', 8, 'webview-4'), {
    type: 'databaseSaveFailed',
    message: 'cancelled',
    revision: 8,
    requestId: 'webview-4',
  });
});

test('revision-aware save acknowledgement messages include the saved revision', () => {
  assert.deepEqual(createDatabaseSavedMessage({
    dirty: false,
    savedRevision: 7,
    currentRevision: 7,
    requestId: 'webview-5',
  }), {
    type: 'databaseSaved',
    dirty: false,
    revision: 7,
    requestId: 'webview-5',
  });
});
