import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConfirmationModel,
  createDiscardDraftModel,
  getDestructiveSqlConfirmationDetails,
  requiresDestructiveSqlConfirmation,
  runDialogMutation,
  showConfirmation,
} from '../media/dialog-workflows.mjs';

test('destructive confirmation models name the exact row, table, column, and count', () => {
  assert.deepEqual(createConfirmationModel({
    kind: 'row',
    tableName: 'people',
    rowNumber: 7,
  }), {
    title: 'Delete row',
    message: 'Delete row 7 from “people”? This cannot be undone until you use VS Code Undo.',
    confirmLabel: 'Delete row',
    destructive: true,
  });
  assert.match(createConfirmationModel({ kind: 'rows', tableName: 'people', count: 1200 }).message, /1,200 selected rows.*“people”/);
  assert.match(createConfirmationModel({ kind: 'cell', tableName: 'people', columnName: 'name', rowNumber: 2 }).message, /“people”\.name.*row 2/);
  assert.match(createConfirmationModel({ kind: 'column', tableName: 'people', columnName: 'legacy' }).message, /“people”\.legacy/);
  assert.match(createConfirmationModel({ kind: 'table', tableName: 'people' }).message, /table “people”/);
  assert.deepEqual(createConfirmationModel({ kind: 'index', target: 'people_name' }), {
    title: 'Drop index',
    message: 'Drop index “people_name”? This cannot be undone after saving.',
    confirmLabel: 'Drop index',
    destructive: true,
  });
  assert.match(createDiscardDraftModel({ tableName: 'people', rowNumber: 3, destination: 'moving to row 4' }).message, /row 3.*“people”.*moving to row 4/);
});

test('destructive SQL detection covers delete and drop statements without prompting for ordinary writes', () => {
  assert.equal(requiresDestructiveSqlConfirmation({ statements: ['DELETE FROM people'] }), true);
  assert.equal(requiresDestructiveSqlConfirmation({ statements: ['DROP TABLE people'] }), true);
  assert.equal(requiresDestructiveSqlConfirmation({ statements: ['ALTER TABLE people DROP COLUMN legacy'] }), true);
  assert.equal(requiresDestructiveSqlConfirmation({ statements: ['INSERT INTO people VALUES (1)', 'UPDATE people SET name = 1'] }), false);
  assert.deepEqual(getDestructiveSqlConfirmationDetails({ statements: ['DELETE FROM "people" WHERE id = 1'] }), {
    action: 'DELETE',
    target: '"people"',
  });
  assert.deepEqual(getDestructiveSqlConfirmationDetails({ statements: ['ALTER TABLE people DROP COLUMN legacy'] }), {
    action: 'DROP COLUMN',
    target: 'people.legacy',
  });
});

test('dialog mutations retain values, render inline errors, and guard duplicate submissions', async () => {
  const submitButton = createFakeButton();
  const errorRegion = createFakeErrorRegion();
  let resolveOperation;
  const pending = runDialogMutation({
    submitButton,
    errorRegion,
    operation: () => new Promise((resolve) => { resolveOperation = resolve; }),
  });

  assert.equal(submitButton.disabled, true);
  assert.equal(submitButton.attributes.get('aria-busy'), 'true');
  assert.deepEqual(await runDialogMutation({ submitButton, errorRegion, operation: () => ({ ok: true }) }), {
    ok: false,
    pending: true,
  });
  resolveOperation({ ok: false, error: 'UNIQUE constraint failed' });
  assert.deepEqual(await pending, { ok: false, error: 'UNIQUE constraint failed' });
  assert.equal(errorRegion.textContent, 'UNIQUE constraint failed');
  assert.equal(errorRegion.hidden, false);
  assert.equal(submitButton.disabled, false);

  const success = await runDialogMutation({
    submitButton,
    errorRegion,
    operation: async () => ({ ok: true, id: 1 }),
  });
  assert.equal(success.ok, true);
  assert.equal(errorRegion.textContent, '');
  assert.equal(errorRegion.hidden, true);
});

test('shared confirmation focuses Cancel, treats native cancel as false, and restores focus', async () => {
  const documentRef = new FakeDocument();
  const invoker = new FakeElement('button');
  const confirmation = showConfirmation({
    model: createConfirmationModel({ kind: 'table', tableName: 'people' }),
    invoker,
    documentRef,
  });
  const dialog = documentRef.body.children[0];
  const cancel = dialog.children[0].children[2].children[0];
  assert.equal(cancel.focused, true);
  dialog.dispatch('cancel', { preventDefault() {} });
  assert.equal(await confirmation, false);
  assert.equal(invoker.focused, true);
  assert.equal(dialog.removed, true);
});

function createFakeButton() {
  return {
    dataset: {},
    disabled: false,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}

function createFakeErrorRegion() {
  const region = {
    textContent: '',
    hidden: true,
    classList: null,
  };
  region.classList = {
    toggle(_name, force) { region.hidden = force; },
  };
  return region;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.isConnected = true;
  }

  append(...children) { this.children.push(...children); }
  setAttribute() {}
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type, event = {}) { this.listeners.get(type)?.(event); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  remove() { this.removed = true; this.isConnected = false; }
  focus() { this.focused = true; }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
  }

  createElement(tagName) { return new FakeElement(tagName); }
}
