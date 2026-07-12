import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSchemaSelection,
  formatSchemaObjectDdl,
  resolveSchemaSelection,
} from '../media/schema/object-ui.mjs';

const objects = [
  { type: 'table', name: 'people', tableName: 'people', sql: 'CREATE TABLE people (id)' },
  { type: 'index', name: 'people_name', tableName: 'people', sql: 'CREATE INDEX people_name ON people(name)' },
  { type: 'trigger', name: 'people_audit', tableName: 'people', sql: 'CREATE TRIGGER people_audit AFTER UPDATE ON people BEGIN SELECT 1; END' },
];

test('schema selection preserves an existing object and falls back to the active table', () => {
  assert.equal(resolveSchemaSelection(objects, { type: 'index', name: 'people_name' }, 'people'), objects[1]);
  assert.equal(resolveSchemaSelection(objects, { type: 'index', name: 'missing' }, 'people'), objects[0]);
  assert.equal(resolveSchemaSelection([], { type: 'index', name: 'missing' }, 'people'), null);
});

test('schema selection owns active, editable, and inspected object state', () => {
  const tables = [
    { type: 'table', name: 'people' },
    { type: 'view', name: 'people_summary' },
  ];
  const availableObjects = [
    ...tables,
    { type: 'index', name: 'people_name', tableName: 'people' },
  ];
  const selection = createSchemaSelection({
    getTables: () => tables,
    getObjects: () => availableObjects,
  });

  selection.reconcile();
  assert.equal(selection.activeTable, tables[0]);
  assert.equal(selection.editableTable, tables[0]);
  assert.equal(selection.selectedObject, availableObjects[0]);

  assert.equal(selection.selectTable('people_summary'), true);
  assert.equal(selection.activeTable, tables[1]);
  assert.equal(selection.editableTable, null);

  assert.equal(selection.selectObject('index', 'people_name'), true);
  assert.equal(selection.selectedObject, availableObjects[2]);
  assert.equal(selection.selectTable('missing'), false);
});

test('index and trigger DDL inspection names the owning table', () => {
  assert.equal(formatSchemaObjectDdl(objects[1]), [
    'INDEX people_name',
    '',
    'CREATE INDEX people_name ON people(name)',
    '',
    'Defined on',
    '- people',
  ].join('\n'));
  assert.match(formatSchemaObjectDdl(objects[2]), /TRIGGER people_audit[\s\S]*Defined on\n- people/);
  assert.equal(formatSchemaObjectDdl(objects[0]), null);
});
