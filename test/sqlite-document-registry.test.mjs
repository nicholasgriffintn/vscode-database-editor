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
    filter: 'Ada',
    columnFilters: { team: 'Computing' },
    sortColumn: 'name',
    sortDirection: 'asc',
  });

  assert.deepEqual(registry.getSelectionContext(), {
    databaseUri: 'file:///fixture.sqlite',
    objectName: 'people',
    objectType: 'table',
    filter: 'Ada',
    columnFilters: { team: 'Computing' },
    sortColumn: 'name',
    sortDirection: 'asc',
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
