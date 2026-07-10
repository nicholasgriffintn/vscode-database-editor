import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteDocumentRegistry } from '../dist/sqlite-ai/sqlite-document-registry.js';

test('registry stores privacy-safe selection context for the active database', () => {
  const registry = new SqliteDocumentRegistry();
  const document = {
    uri: createUri('file:///fixture.sqlite'),
    getData: () => new Uint8Array(),
  };
  registry.registerPanel(document, createPanel());

  registry.updateSelectionContext(document, {
    objectName: 'people',
    objectType: 'table',
    hasFilter: true,
    filteredColumns: ['team'],
    sortColumn: 'name',
    sortDirection: 'asc',
    selectedRowCount: 2,
    selectedRowNumbers: [1, 3],
    selectedRowScope: 'visibleRows',
  });

  assert.deepEqual(registry.getSelectionContext(), {
    databaseUri: 'file:///fixture.sqlite',
    objectName: 'people',
    objectType: 'table',
    hasFilter: true,
    filteredColumns: ['team'],
    sortColumn: 'name',
    sortDirection: 'asc',
    selectedRowCount: 2,
    selectedRowNumbers: [1, 3],
    selectedRowScope: 'visibleRows',
  });
});

function createUri(value) {
  const parsed = new URL(value);
  return {
    path: parsed.pathname,
    toString: () => value,
  };
}

function createPanel() {
  return {
    active: true,
    visible: true,
    onDidChangeViewState() {},
    onDidDispose() {},
  };
}
