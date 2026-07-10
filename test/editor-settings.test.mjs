import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_EDITOR_SETTINGS,
  getBlobExportStrategy,
  getDoubleClickEditMode,
  getEffectiveRowWindow,
  getInstantCommitAction,
  normalizeEditorSettings,
  shouldRejectWasmFile,
} from '../media/editor-settings.mjs';
import hostSettingsModule from '../dist/editor-settings.js';

const { readEditorSettings } = hostSettingsModule;

test('extension host and webview share the same editor setting defaults', () => {
  const settings = readEditorSettings({
    get(_section, defaultValue) {
      return defaultValue;
    },
  }, false);

  assert.deepEqual(settings, DEFAULT_EDITOR_SETTINGS);
  assert.equal(readEditorSettings({ get: (_section, defaultValue) => defaultValue }, true).isRemote, true);
});

test('normalizes editor settings with safe defaults and bounds', () => {
  assert.deepEqual(normalizeEditorSettings({}), DEFAULT_EDITOR_SETTINGS);
  assert.deepEqual(normalizeEditorSettings({
    defaultPageSize: 0,
    maxRows: -12,
    maxFileSizeMb: -1,
    instantCommit: 'sometimes',
    doubleClickBehavior: 'unknown',
    blobExportMode: 'other',
    queryTimeoutMs: 20,
    maxUndoMemoryBytes: 5,
  }), DEFAULT_EDITOR_SETTINGS);
  assert.equal(normalizeEditorSettings({ defaultPageSize: 250 }).defaultPageSize, 250);
  assert.equal(normalizeEditorSettings({ defaultPageSize: 333 }).defaultPageSize, 333);
  assert.equal(normalizeEditorSettings({ maxRows: 1000 }).maxRows, 1000);
  assert.equal(normalizeEditorSettings({ maxFileSizeMb: 0 }).maxFileSizeMb, 0);
});

test('max file size rejects only oversized WASM-loaded databases', () => {
  assert.equal(shouldRejectWasmFile({ fileSizeBytes: 200 * 1024 * 1024, maxFileSizeMb: 200 }), false);
  assert.equal(shouldRejectWasmFile({ fileSizeBytes: (200 * 1024 * 1024) + 1, maxFileSizeMb: 200 }), true);
  assert.equal(shouldRejectWasmFile({ fileSizeBytes: 500 * 1024 * 1024, maxFileSizeMb: 0 }), false);
});

test('row windows honor max rows while preserving page offsets', () => {
  assert.deepEqual(getEffectiveRowWindow({ totalRows: 1000, page: 2, pageSize: 100, maxRows: 0 }), {
    effectiveTotalRows: 1000,
    page: 2,
    limit: 100,
    offset: 100,
  });
  assert.deepEqual(getEffectiveRowWindow({ totalRows: 1000, page: 6, pageSize: 100, maxRows: 250 }), {
    effectiveTotalRows: 250,
    page: 3,
    limit: 50,
    offset: 200,
  });
  assert.deepEqual(getEffectiveRowWindow({ totalRows: 1000, page: 5, pageSize: 100, maxRows: 200 }), {
    effectiveTotalRows: 200,
    page: 2,
    limit: 100,
    offset: 100,
  });
});

test('instant commit is scoped to the configured strategy', () => {
  assert.equal(getInstantCommitAction({ strategy: 'never', isRemote: false }), 'manual');
  assert.equal(getInstantCommitAction({ strategy: 'always', isRemote: false }), 'save');
  assert.equal(getInstantCommitAction({ strategy: 'remote-only', isRemote: false }), 'manual');
  assert.equal(getInstantCommitAction({ strategy: 'remote-only', isRemote: true }), 'save');
});

test('double-click and blob settings only expose supported editor behavior', () => {
  assert.equal(getDoubleClickEditMode({ behavior: 'inline', canInlineEdit: true }), 'inline');
  assert.equal(getDoubleClickEditMode({ behavior: 'inline', canInlineEdit: false }), 'modal');
  assert.equal(getDoubleClickEditMode({ behavior: 'modal', canInlineEdit: true }), 'modal');
  assert.equal(getBlobExportStrategy({ configured: 'native' }), 'native');
  assert.equal(getBlobExportStrategy({ configured: 'web' }), 'web');
  assert.equal(getBlobExportStrategy({ configured: 'invalid' }), 'native');
});
