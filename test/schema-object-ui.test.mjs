import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSchemaObjectDdl, resolveSchemaSelection } from '../media/schema/object-ui.mjs';

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
