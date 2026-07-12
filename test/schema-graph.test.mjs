import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSchemaGraphModel,
  getSchemaGraphEmptyState,
  layoutSchemaGraph,
} from '../media/schema/graph.mjs';

function table(name, options = {}) {
  return {
    name,
    type: options.type ?? 'table',
    rowCount: Object.hasOwn(options, 'rowCount') ? options.rowCount : 0,
    columns: options.columns ?? [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKeyOrder: 1, foreignKeyTarget: null },
    ],
    foreignKeys: options.foreignKeys ?? [],
  };
}

test('schema graph model builds nodes with column metadata', () => {
  const model = buildSchemaGraphModel([
    table('teams', {
      rowCount: 3,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKeyOrder: 1, foreignKeyTarget: null },
        { name: 'name', type: 'TEXT', nullable: false, primaryKeyOrder: 0, foreignKeyTarget: null },
      ],
    }),
  ]);

  assert.deepEqual(model.nodes.map((node) => ({
    id: node.id,
    tableName: node.tableName,
    tableType: node.tableType,
    rowCount: node.rowCount,
    columns: node.columns,
  })), [
    {
      id: 'teams',
      tableName: 'teams',
      tableType: 'table',
      rowCount: 3,
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, foreignKey: false, nullable: false },
        { name: 'name', type: 'TEXT', primaryKey: false, foreignKey: false, nullable: false },
      ],
    },
  ]);
});

test('schema graph preserves unknown row counts instead of presenting zero rows', () => {
  const model = buildSchemaGraphModel([table('expensive_view', { type: 'view', rowCount: null })]);
  assert.equal(model.nodes[0].rowCount, null);
});

test('schema graph model builds directed foreign-key edges from child to parent columns', () => {
  const model = buildSchemaGraphModel([
    table('teams'),
    table('people', {
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKeyOrder: 1, foreignKeyTarget: null },
        { name: 'team_id', type: 'INTEGER', nullable: true, primaryKeyOrder: 0, foreignKeyTarget: 'teams.id' },
      ],
      foreignKeys: [{ id: 0, seq: 0, from: 'team_id', table: 'teams', to: 'id', on_update: 'CASCADE', on_delete: 'SET NULL' }],
    }),
  ]);

  assert.deepEqual(model.edges, [
    {
      id: 'people.0:0:team_id->teams.id',
      sourceTable: 'people',
      sourceColumn: 'team_id',
      targetTable: 'teams',
      targetColumn: 'id',
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
  ]);
});

test('schema graph model keeps composite foreign-key edge ids unique and stable', () => {
  const model = buildSchemaGraphModel([
    table('parent', {
      columns: [
        { name: 'tenant_id', type: 'INTEGER', nullable: false, primaryKeyOrder: 1, foreignKeyTarget: null },
        { name: 'id', type: 'INTEGER', nullable: false, primaryKeyOrder: 2, foreignKeyTarget: null },
      ],
    }),
    table('child', {
      columns: [
        { name: 'tenant_id', type: 'INTEGER', nullable: false, primaryKeyOrder: 0, foreignKeyTarget: 'parent.tenant_id' },
        { name: 'parent_id', type: 'INTEGER', nullable: false, primaryKeyOrder: 0, foreignKeyTarget: 'parent.id' },
      ],
      foreignKeys: [
        { id: 2, seq: 0, from: 'tenant_id', table: 'parent', to: 'tenant_id' },
        { id: 2, seq: 1, from: 'parent_id', table: 'parent', to: 'id' },
      ],
    }),
  ]);

  assert.deepEqual(model.edges.map((edge) => edge.id), [
    'child.2:0:tenant_id->parent.tenant_id',
    'child.2:1:parent_id->parent.id',
  ]);
  assert.equal(new Set(model.edges.map((edge) => edge.id)).size, 2);
});

test('schema graph model skips foreign keys to missing target tables', () => {
  const model = buildSchemaGraphModel([
    table('orphaned_child', {
      foreignKeys: [{ id: 0, seq: 0, from: 'missing_id', table: 'missing_parent', to: 'id' }],
    }),
  ]);

  assert.deepEqual(model.edges, []);
  assert.equal(model.skippedEdgeCount, 1);
});

test('schema graph layout is deterministic and assigns finite geometry', () => {
  const source = buildSchemaGraphModel([
    table('teams'),
    table('people', {
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKeyOrder: 1, foreignKeyTarget: null },
        { name: 'team_id', type: 'INTEGER', nullable: true, primaryKeyOrder: 0, foreignKeyTarget: 'teams.id' },
      ],
      foreignKeys: [{ id: 0, seq: 0, from: 'team_id', table: 'teams', to: 'id' }],
    }),
    table('audit_log'),
  ]);

  const first = layoutSchemaGraph(source);
  const second = layoutSchemaGraph(source);

  assert.deepEqual(first, second);
  for (const node of first.nodes) {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.equal(Number.isFinite(node[key]), true, `${node.id}.${key} should be finite`);
    }
  }
  assert.equal(Number.isFinite(first.bounds.width), true);
  assert.equal(Number.isFinite(first.bounds.height), true);
  assert.ok(first.nodes.find((node) => node.id === 'people').x > first.nodes.find((node) => node.id === 'teams').x);
});

test('schema graph layout handles self-referential foreign keys without crashing', () => {
  const model = buildSchemaGraphModel([
    table('employees', {
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKeyOrder: 1, foreignKeyTarget: null },
        { name: 'manager_id', type: 'INTEGER', nullable: true, primaryKeyOrder: 0, foreignKeyTarget: 'employees.id' },
      ],
      foreignKeys: [{ id: 0, seq: 0, from: 'manager_id', table: 'employees', to: 'id' }],
    }),
  ]);

  const laidOut = layoutSchemaGraph(model);
  assert.equal(laidOut.edges[0].sourceTable, 'employees');
  assert.equal(laidOut.edges[0].targetTable, 'employees');
  assert.equal(Number.isFinite(laidOut.nodes[0].x), true);
});

test('schema graph empty state distinguishes empty and relationship-free schemas', () => {
  assert.deepEqual(getSchemaGraphEmptyState([]), {
    kind: 'no-tables',
    title: 'No tables found',
    description: 'Create a table to start visualizing this database schema.',
  });
  assert.deepEqual(getSchemaGraphEmptyState([table('standalone')]), {
    kind: 'no-relationships',
    title: 'No foreign-key relationships found',
    description: 'Standalone tables are still shown so the schema stays browsable.',
  });
  assert.equal(getSchemaGraphEmptyState([
    table('parent'),
    table('child', { foreignKeys: [{ from: 'parent_id', table: 'parent', to: 'id' }] }),
  ]), null);
});
