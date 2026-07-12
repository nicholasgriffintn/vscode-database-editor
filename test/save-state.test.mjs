import assert from 'node:assert/strict';
import test from 'node:test';

import { getDirtyStatusText, getSaveButtonState } from '../media/editor/save-state.mjs';

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
