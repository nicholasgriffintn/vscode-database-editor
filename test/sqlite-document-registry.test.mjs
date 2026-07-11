import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteDocumentRegistry } from '../dist/sqlite-ai/sqlite-document-registry.js';

function createUri(value) {
  const parsed = new URL(value);
  return {
    path: parsed.pathname,
    toString: () => value,
  };
}

function createDocument(value = 'file:///fixture.sqlite') {
  return {
    uri: createUri(value),
    getData: () => new Uint8Array(),
  };
}

function createPanel({ active = false, visible = false } = {}) {
  const viewStateListeners = [];
  const disposeListeners = [];
  const panel = {
    _active: active,
    _visible: visible,
    get active() {
      return panel._active;
    },
    get visible() {
      return panel._visible;
    },
    onDidChangeViewState(listener) {
      viewStateListeners.push(listener);
      return { dispose: () => {} };
    },
    onDidDispose(listener) {
      disposeListeners.push(listener);
      return { dispose: () => {} };
    },
  };

  panel.setViewState = (nextActive, nextVisible = panel._visible) => {
    panel._active = nextActive;
    panel._visible = nextVisible;
    const event = { webviewPanel: panel };
    for (const listener of viewStateListeners) {
      listener(event);
    }
  };

  panel.dispose = () => {
    const event = {};
    for (const listener of disposeListeners) {
      listener(event);
    }
  };

  return panel;
}

test('registry stores privacy-safe selection context for the active database', () => {
  const registry = new SqliteDocumentRegistry();
  const document = createDocument('file:///fixture.sqlite');
  registry.registerPanel(document, createPanel({ active: true, visible: true }));

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

test('registry resolves active custom editor from active panel, not visible panel', () => {
  const registry = new SqliteDocumentRegistry();
  const visibleDocument = createDocument('file:///visible.sqlite');
  const inactiveDocument = createDocument('file:///inactive.sqlite');

  const visiblePanel = createPanel({ active: true, visible: true });
  const inactivePanel = createPanel({ active: false, visible: true });

  registry.registerPanel(visibleDocument, visiblePanel);
  registry.registerPanel(inactiveDocument, inactivePanel);

  assert.equal(registry.getActiveDocumentUri(), visibleDocument.uri.toString());

  const openDatabases = registry.listOpenDatabases();
  assert.deepEqual(
    openDatabases,
    [
      {
        uri: 'file:///visible.sqlite',
        name: 'visible.sqlite',
        active: true,
      },
      {
        uri: 'file:///inactive.sqlite',
        name: 'inactive.sqlite',
        active: false,
      },
    ],
  );
});
test('registry updates active document when activation moves between side-by-side panels', () => {
  const registry = new SqliteDocumentRegistry();
  const firstDocument = createDocument('file:///first.sqlite');
  const secondDocument = createDocument('file:///second.sqlite');

  const firstPanel = createPanel({ active: true, visible: true });
  const secondPanel = createPanel({ active: false, visible: true });

  registry.registerPanel(firstDocument, firstPanel);
  registry.registerPanel(secondDocument, secondPanel);

  assert.equal(registry.getActiveDocumentUri(), firstDocument.uri.toString());

  secondPanel.setViewState(true, true);
  firstPanel.setViewState(false, true);

  assert.equal(registry.getActiveDocumentUri(), secondDocument.uri.toString());
  const openDatabases = registry.listOpenDatabases();
  assert.equal(openDatabases[0].uri, secondDocument.uri.toString());
  assert.equal(openDatabases[0].active, true);
  assert.equal(openDatabases[1].uri, firstDocument.uri.toString());
  assert.equal(openDatabases[1].active, false);
});

test('registry falls back deterministically when no panel is active', () => {
  const registry = new SqliteDocumentRegistry();
  const firstDocument = createDocument('file:///first.sqlite');
  const secondDocument = createDocument('file:///second.sqlite');
  const thirdDocument = createDocument('file:///third.sqlite');

  registry.registerPanel(firstDocument, createPanel({ active: false, visible: true }));
  registry.registerPanel(secondDocument, createPanel({ active: false, visible: true }));
  registry.registerPanel(thirdDocument, createPanel({ active: false, visible: true }));

  assert.equal(registry.getActiveDocumentUri(), thirdDocument.uri.toString());

  const openDatabases = registry.listOpenDatabases();
  assert.deepEqual(openDatabases.map((entry) => entry.uri), [
    thirdDocument.uri.toString(),
    secondDocument.uri.toString(),
    firstDocument.uri.toString(),
  ]);
  assert.equal(openDatabases[0].active, true);
  assert.equal(openDatabases[1].active, false);
  assert.equal(openDatabases[2].active, false);
});

test('registry clears disposed panel and falls back to remaining open database', () => {
  const registry = new SqliteDocumentRegistry();
  const firstDocument = createDocument('file:///first.sqlite');
  const secondDocument = createDocument('file:///second.sqlite');

  const firstPanel = createPanel({ active: true, visible: true });
  const secondPanel = createPanel({ active: false, visible: true });

  registry.registerPanel(firstDocument, firstPanel);
  registry.registerPanel(secondDocument, secondPanel);

  assert.equal(registry.getActiveDocumentUri(), firstDocument.uri.toString());

  firstPanel.dispose();

  assert.equal(registry.getActiveDocumentUri(), secondDocument.uri.toString());
  const openDatabases = registry.listOpenDatabases();
  assert.deepEqual(openDatabases, [
    {
      uri: secondDocument.uri.toString(),
      name: 'second.sqlite',
      active: true,
    },
  ]);
});
