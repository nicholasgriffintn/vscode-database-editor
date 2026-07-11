import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

import { createSqliteTools } from '../dist/sqlite-ai/tools.js';

const SQL = await initSqlJs({
  locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
});

test('list-open-databases tool returns registry databases', async () => {
  const harness = createToolHarness();
  const result = await invokeJson(harness.tools.listOpenDatabases, {});

  assert.deepEqual(result.databases, [{
    uri: 'file:///fixture.sqlite',
    name: 'fixture.sqlite',
    active: true,
  }]);
});

test('database tools omit raw filter values from Copilot selection context', async () => {
  const harness = createToolHarness({
    selectionContext: {
      objectName: 'people',
      objectType: 'table',
      filter: 'secret@example.com',
      columnFilters: { token: 'abc123', team_id: '1' },
      sortColumn: 'name',
      sortDirection: 'asc',
    },
  });

  const listResult = await invokeJson(harness.tools.listOpenDatabases, {});
  const schemaResult = await invokeJson(harness.tools.dbContext, {});
  const serialized = JSON.stringify({ listResult, schemaResult });

  assert.equal(serialized.includes('secret@example.com'), false);
  assert.equal(serialized.includes('abc123'), false);
  assert.equal(listResult.selection.hasFilter, true);
  assert.deepEqual(listResult.selection.filteredColumns, ['team_id', 'token']);
  assert.equal(schemaResult.selection.hasFilter, true);
  assert.deepEqual(schemaResult.selection.filteredColumns, ['team_id', 'token']);
});

test('schema context describes tables, columns, indexes, triggers, and row counts', async () => {
  const harness = createToolHarness();
  const result = await invokeJson(harness.tools.dbContext, { objectName: 'people' });

  assert.equal(result.database.uri, 'file:///fixture.sqlite');
  const people = result.objects.find((object) => object.name === 'people');
  assert.equal(people.type, 'table');
  assert.equal(people.rowCount, 2);
  assert.deepEqual(people.columns.map((column) => column.name), ['id', 'name', 'team_id']);
  assert.equal(people.columns[0].primaryKey, true);
  assert.equal(people.foreignKeys[0].table, 'teams');
  assert.equal(people.indexes[0].name, 'people_name_idx');
  assert.equal(people.triggers[0].name, 'people_audit');
});

test('schema summary is paginated and omits expensive object details', async () => {
  const harness = createToolHarness();
  const result = await invokeJson(harness.tools.dbContext, { limit: 1, offset: 0 });

  assert.equal(result.totalObjects, 2);
  assert.equal(result.objects.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.nextOffset, 1);
  assert.deepEqual(Object.keys(result.objects[0]).sort(), ['name', 'type']);
});

test('schema context defaults to the table selected in the editor', async () => {
  const harness = createToolHarness({ selectedObject: 'people' });
  const result = await invokeJson(harness.tools.dbContext, {});

  assert.equal(result.selection.objectName, 'people');
  assert.equal(result.objects.length, 1);
  assert.equal(result.objects[0].name, 'people');
  assert.deepEqual(result.objects[0].columns.map((column) => column.name), ['id', 'name', 'team_id']);
});

test('read-only query returns capped rows without mutating database bytes', async () => {
  const harness = createToolHarness();
  const before = [...harness.document.getData()];
  const result = await invokeJson(harness.tools.query, {
    query: 'SELECT name FROM people ORDER BY id',
    queryName: 'people',
    queryDescription: 'List people',
  });

  assert.deepEqual(result, {
    queryName: 'people',
    columns: ['name'],
    rows: [{ name: 'Ada' }, { name: 'Grace' }],
    rowCount: 2,
    truncated: false,
  });
  assert.deepEqual([...harness.document.getData()], before);
});

test('read-only query returns the configured response cap and truncation state', async () => {
  const harness = createToolHarness();
  const result = await invokeJson(harness.tools.query, {
    query: 'WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 500) SELECT value FROM sequence',
    queryName: 'sequence',
    queryDescription: 'Generate more rows than the response cap',
  });

  assert.equal(result.rows.length, 200);
  assert.equal(result.rowCount, 200);
  assert.equal(result.truncated, true);
});

test('query tool honors configured row limits and sensitive-column redaction', async () => {
  const harness = createToolHarness({ maxResultRows: 1, sensitiveColumnPatterns: ['name'] });
  const result = await invokeJson(harness.tools.query, {
    query: 'SELECT id, name FROM people ORDER BY id',
    queryName: 'people',
    queryDescription: 'List people',
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows[0], { id: 1, name: '[REDACTED]' });
});

test('query tool redacts sensitive source columns even when aliased', async () => {
  const harness = createToolHarness({ sensitiveColumnPatterns: ['name'] });
  const result = await invokeJson(harness.tools.query, {
    query: 'SELECT name AS value FROM people ORDER BY id',
    queryName: 'aliased names',
    queryDescription: 'Attempt to alias a sensitive source column',
  });

  assert.deepEqual(result.rows, [{ value: '[REDACTED]' }, { value: '[REDACTED]' }]);
});

test('query tool redacts aliased sensitive columns in WITH queries', async () => {
  const harness = createToolHarness({ sensitiveColumnPatterns: ['name'] });
  const result = await invokeJson(harness.tools.query, {
    query: 'WITH selected_people AS (SELECT name FROM people) SELECT name AS value FROM selected_people ORDER BY value',
    queryName: 'aliased CTE names',
    queryDescription: 'Attempt to alias a sensitive source column through a CTE',
  });

  assert.deepEqual(result.rows, [{ value: '[REDACTED]' }, { value: '[REDACTED]' }]);
});

test('query tool conservatively redacts nested projections that rename sensitive columns', async () => {
  const harness = createToolHarness({ sensitiveColumnPatterns: ['name'] });
  const result = await invokeJson(harness.tools.query, {
    query: 'WITH selected_people AS (SELECT name AS hidden FROM people) SELECT hidden AS value FROM selected_people ORDER BY value',
    queryName: 'nested aliased names',
    queryDescription: 'Attempt to rename a sensitive source column before the outer projection',
  });

  assert.deepEqual(result.rows, [{ value: '[REDACTED]' }, { value: '[REDACTED]' }]);
});

test('query tool redacts quoted sensitive source columns when aliased', async () => {
  const harness = createToolHarness({ sensitiveColumnPatterns: ['name'] });
  const result = await invokeJson(harness.tools.query, {
    query: 'SELECT "name" AS value FROM people ORDER BY id',
    queryName: 'quoted sensitive names',
    queryDescription: 'Attempt to hide a sensitive source column with quoting and an alias',
  });

  assert.deepEqual(result.rows, [{ value: '[REDACTED]' }, { value: '[REDACTED]' }]);
});

test.todo('query tool follows sensitive lineage through persisted and nested views', async () => {
  const harness = createToolHarness({ sensitiveColumnPatterns: ['name'] });
  const db = new SQL.Database(harness.document.getData());
  db.run('CREATE VIEW public_people AS SELECT name AS value FROM people');
  db.run('CREATE VIEW nested_people AS SELECT value AS renamed_value FROM public_people');
  harness.document.updateData(db.export());
  db.close();

  const direct = await invokeJson(harness.tools.query, {
    query: 'SELECT value FROM public_people ORDER BY value',
    queryName: 'persisted sensitive view',
    queryDescription: 'Read a persisted view that renames a sensitive column',
  });
  const nested = await invokeJson(harness.tools.query, {
    query: 'SELECT renamed_value FROM nested_people ORDER BY renamed_value',
    queryName: 'nested sensitive view',
    queryDescription: 'Read a nested persisted view that renames a sensitive column',
  });

  assert.deepEqual(direct.rows, [{ value: '[REDACTED]' }, { value: '[REDACTED]' }]);
  assert.deepEqual(nested.rows, [
    { renamed_value: '[REDACTED]' },
    { renamed_value: '[REDACTED]' },
  ]);
});

test('query tool does not treat sensitive words inside string literals as column references', async () => {
  const harness = createToolHarness({ sensitiveColumnPatterns: ['name'] });
  const result = await invokeJson(harness.tools.query, {
    query: "SELECT 'name' AS value",
    queryName: 'literal value',
    queryDescription: 'Return a non-sensitive string literal',
  });

  assert.deepEqual(result.rows, [{ value: 'name' }]);
});

test('query tool redacts a compound-query output when a later branch selects sensitive data', async () => {
  const harness = createToolHarness({ sensitiveColumnPatterns: ['name'] });
  const result = await invokeJson(harness.tools.query, {
    query: 'SELECT id AS value FROM people UNION ALL SELECT name FROM people ORDER BY value',
    queryName: 'mixed identifier values',
    queryDescription: 'Attempt to place sensitive values in a compound query output',
  });

  assert.equal(result.rows.length, 4);
  assert.equal(result.rows.every((row) => row.value === '[REDACTED]'), true);
});

test('query tool stops when its cancellation token is requested', async () => {
  const harness = createToolHarness();
  let cancelled = false;
  const result = await invokeJson(harness.tools.query, {
    query: 'WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence) SELECT sum(value) FROM sequence',
    queryName: 'sequence',
    queryDescription: 'Generate rows until cancelled',
  }, {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      const timer = setTimeout(() => {
        cancelled = true;
        listener();
      }, 20);
      return { dispose: () => clearTimeout(timer) };
    },
  });

  assert.match(result.error, /cancelled/i);
  assert.equal(cancelled, true);
});

test('query tool rejects updates and leaves bytes unchanged', async () => {
  const harness = createToolHarness();
  const before = [...harness.document.getData()];
  const result = await invokeJson(harness.tools.query, {
    query: 'UPDATE people SET name = "Changed"',
    queryName: 'bad update',
    queryDescription: 'Attempt mutation',
  });

  assert.equal(result.error, 'Only one read-only SELECT or safe WITH query is allowed.');
  assert.deepEqual([...harness.document.getData()], before);
});

test('explain tool returns the actual SQLite query plan', async () => {
  const harness = createToolHarness();
  const result = await invokeJson(harness.tools.explain, {
    query: "SELECT * FROM people WHERE name = 'Ada'",
    queryName: 'person lookup',
  });

  assert.equal(result.queryName, 'person lookup');
  assert.match(result.plan.map((row) => row.detail).join(' '), /people_name_idx/);
});

test('profile tool returns focused aggregate statistics without sample rows', async () => {
  const harness = createToolHarness();
  const result = await invokeJson(harness.tools.profile, { objectName: 'people' });

  assert.equal(result.rowCount, 2);
  const name = result.columns.find((column) => column.name === 'name');
  assert.equal(name.nullCount, 0);
  assert.equal(name.distinctCount, 2);
  assert.equal('rows' in result, false);
});

test('database tools require an explicit URI when multiple databases are open', async () => {
  const harness = createToolHarness({ additionalDatabase: true });
  const result = await invokeJson(harness.tools.query, {
    query: 'SELECT name FROM people',
    queryName: 'people',
    queryDescription: 'List people',
  });

  assert.match(result.error, /Multiple SQLite databases are open/);
  assert.match(result.error, /databaseUri/);
});

test('all Copilot tools refuse invocation when the integration is disabled', async () => {
  const harness = createToolHarness({ copilotEnabled: false, accessMode: 'rw' });
  const invocations = [
    invokeJson(harness.tools.listOpenDatabases, {}),
    invokeJson(harness.tools.dbContext, {}),
    invokeJson(harness.tools.query, {
      query: 'SELECT * FROM people',
      queryName: 'people',
      queryDescription: 'List people',
    }),
    invokeJson(harness.tools.explain, {
      query: 'SELECT * FROM people',
      queryName: 'people plan',
    }),
    invokeJson(harness.tools.profile, { objectName: 'people' }),
    invokeJson(harness.tools.modify, {
      statement: 'INSERT INTO people (name) VALUES ("Katherine")',
      statementName: 'add person',
      statementDescription: 'Adds a person',
    }),
    invokeJson(harness.tools.migrate, {
      statements: ['INSERT INTO people (name) VALUES ("Katherine")'],
      migrationName: 'add person',
      migrationDescription: 'Adds a person',
    }),
  ];

  for (const result of await Promise.all(invocations)) {
    assert.equal(result.error, 'Copilot integration is disabled in Database Editor settings.');
  }
  assert.deepEqual(harness.appliedLabels, []);
});

test('modify tool refuses writes when access mode is read-only', async () => {
  const harness = createToolHarness({ accessMode: 'ro' });
  const result = await invokeJson(harness.tools.modify, {
    statement: 'INSERT INTO people (name) VALUES ("Katherine")',
    statementName: 'add person',
    statementDescription: 'Adds a person',
  });

  assert.match(result.error, /Read\/write Copilot tools are disabled/);
});

test('modify tool prepares confirmation and applies changes through registry', async () => {
  const harness = createToolHarness({ accessMode: 'rw' });
  const prepared = await harness.tools.modify.prepareInvocation({
    input: {
      statement: 'INSERT INTO people (name) VALUES ("Katherine")',
      statementName: 'add person',
      statementDescription: 'Adds a person',
    },
  }, {});

  assert.equal(prepared.confirmationMessages.title, 'SQLite: Modify Database');
  assert.match(String(prepared.confirmationMessages.message.value), /fixture\.sqlite/);
  assert.match(String(prepared.confirmationMessages.message.value), /file:\/\/\/fixture\.sqlite/);
  assert.match(String(prepared.confirmationMessages.message.value), /INSERT INTO people/);

  const result = await invokeJson(harness.tools.modify, {
    statement: 'INSERT INTO people (name) VALUES ("Katherine")',
    statementName: 'add person',
    statementDescription: 'Adds a person',
  });

  assert.equal(result.success, true);
  assert.equal(harness.appliedLabels.at(-1), 'Copilot: add person');
  assert.deepEqual(harness.appliedBaseRevisions, [0]);
  const rows = selectRows(harness.document.getData(), 'SELECT name FROM people ORDER BY id');
  assert.deepEqual(rows.map((row) => row.name), ['Ada', 'Grace', 'Katherine']);
});

test('Copilot write rejects a stale private snapshot after an intervening edit', async () => {
  const harness = createToolHarness({
    accessMode: 'rw',
    beforeApply(target) {
      const db = new SQL.Database(target.getData());
      db.run('INSERT INTO people (name) VALUES ("External")');
      target.updateData(db.export());
      db.close();
    },
  });

  const result = await invokeJson(harness.tools.modify, {
    statement: 'INSERT INTO people (name) VALUES ("Copilot")',
    statementName: 'add Copilot person',
    statementDescription: 'Adds a person',
  });

  assert.match(result.error, /changed while Copilot was working/i);
  assert.deepEqual(
    selectRows(harness.document.getData(), 'SELECT name FROM people ORDER BY id').map((row) => row.name),
    ['Ada', 'Grace', 'External'],
  );
});

test('write confirmations escape Markdown and show full SQL', async () => {
  const harness = createToolHarness({ accessMode: 'rw' });
  const longSql = `INSERT INTO people (name) VALUES ("${'x'.repeat(1600)} ` + '``` fence")';
  const prepared = await harness.tools.modify.prepareInvocation({
    input: {
      statement: longSql,
      statementName: '**not bold**',
      statementDescription: '[click me](https://example.com)',
    },
  }, {});
  const message = String(prepared.confirmationMessages.message.value);

  assert.equal(message.includes('\\*\\*not bold\\*\\*'), true);
  assert.equal(message.includes('\\[click me\\]\\(https://example.com\\)'), true);
  assert.match(message, /````sql/);
  assert.match(message, new RegExp(`${'x'.repeat(100)}.*fence`, 's'));
  assert.doesNotMatch(message, /\.\.\.\n````/);
});

test('modify tool enforces SQLite foreign keys after reopening database bytes', async () => {
  const harness = createToolHarness({ accessMode: 'rw' });
  const result = await invokeJson(harness.tools.modify, {
    statement: 'INSERT INTO people (name, team_id) VALUES ("Orphan", 999)',
    statementName: 'add invalid person',
    statementDescription: 'Should fail because team 999 does not exist',
  });

  assert.match(result.error, /foreign key/i);
  assert.deepEqual(selectRows(harness.document.getData(), 'SELECT name FROM people ORDER BY id').map((row) => row.name), ['Ada', 'Grace']);
  assert.deepEqual(harness.appliedLabels, []);
});

test('migration tool applies several statements atomically as one undoable change', async () => {
  const harness = createToolHarness({ accessMode: 'rw' });
  const result = await invokeJson(harness.tools.migrate, {
    statements: [
      'INSERT INTO teams (name) VALUES ("Mathematics")',
      'INSERT INTO people (name, team_id) VALUES ("Emmy", 2)',
    ],
    migrationName: 'add mathematician',
    migrationDescription: 'Adds a team and person together',
  });

  assert.equal(result.success, true);
  assert.equal(result.statementCount, 2);
  assert.deepEqual(harness.appliedLabels, ['Copilot migration: add mathematician']);
  assert.deepEqual(selectRows(harness.document.getData(), 'SELECT name FROM people ORDER BY id').map((row) => row.name), ['Ada', 'Grace', 'Emmy']);
});

test('migration tool rolls back every statement when one statement fails', async () => {
  const harness = createToolHarness({ accessMode: 'rw' });
  const before = [...harness.document.getData()];
  const result = await invokeJson(harness.tools.migrate, {
    statements: ['INSERT INTO teams (name) VALUES ("Physics")', 'INSERT INTO missing_table VALUES (1)'],
    migrationName: 'broken migration',
    migrationDescription: 'Must roll back',
  });

  assert.match(result.error, /no such table/);
  assert.deepEqual([...harness.document.getData()], before);
  assert.deepEqual(harness.appliedLabels, []);
});

test('modify tool rolls back invalid statements without altering bytes', async () => {
  const harness = createToolHarness({ accessMode: 'rw' });
  const before = [...harness.document.getData()];
  const result = await invokeJson(harness.tools.modify, {
    statement: 'INSERT INTO missing_table VALUES (1)',
    statementName: 'bad insert',
    statementDescription: 'Fails',
  });

  assert.match(result.error, /no such table/);
  assert.deepEqual([...harness.document.getData()], before);
  assert.deepEqual(harness.appliedLabels, []);
});

test('modify and migration tools honor pre-cancelled tokens before applying changes', async () => {
  const modifyHarness = createToolHarness({ accessMode: 'rw' });
  const cancelledToken = { isCancellationRequested: true };
  const modifyResult = await invokeJson(modifyHarness.tools.modify, {
    statement: 'INSERT INTO people (name) VALUES ("Cancelled")',
    statementName: 'cancelled insert',
    statementDescription: 'Must not apply',
  }, cancelledToken);

  assert.match(modifyResult.error, /cancelled/i);
  assert.deepEqual(selectRows(modifyHarness.document.getData(), 'SELECT name FROM people ORDER BY id').map((row) => row.name), ['Ada', 'Grace']);
  assert.deepEqual(modifyHarness.appliedLabels, []);

  const migrationHarness = createToolHarness({ accessMode: 'rw' });
  const migrationResult = await invokeJson(migrationHarness.tools.migrate, {
    statements: ['INSERT INTO people (name) VALUES ("Cancelled")'],
    migrationName: 'cancelled migration',
    migrationDescription: 'Must not apply',
  }, cancelledToken);

  assert.match(migrationResult.error, /cancelled/i);
  assert.deepEqual(selectRows(migrationHarness.document.getData(), 'SELECT name FROM people ORDER BY id').map((row) => row.name), ['Ada', 'Grace']);
  assert.deepEqual(migrationHarness.appliedLabels, []);
});

function createToolHarness({
  accessMode = 'rw',
  copilotEnabled = true,
  sqlStatic = SQL,
  additionalDatabase = false,
  selectedObject,
  selectionContext,
  maxResultRows = 200,
  sensitiveColumnPatterns = [],
  beforeApply,
} = {}) {
  const document = createFixtureDocument();
  const secondDocument = additionalDatabase
    ? { ...createFixtureDocument(), uri: { toString: () => 'file:///second.sqlite' } }
    : undefined;
  const appliedLabels = [];
  const appliedBaseRevisions = [];
  const registry = {
    listOpenDatabases() {
      return [
        { uri: document.uri.toString(), name: 'fixture.sqlite', active: true },
        ...(secondDocument ? [{ uri: secondDocument.uri.toString(), name: 'second.sqlite', active: false }] : []),
      ];
    },
    resolveDocument(uri) {
      if (secondDocument && uri === secondDocument.uri.toString()) {
        return secondDocument;
      }
      return uri && uri !== document.uri.toString() ? undefined : document;
    },
    getSelectionContext(uri) {
      const databaseUri = uri ?? document.uri.toString();
      if (selectionContext) {
        return { databaseUri, ...selectionContext };
      }
      return selectedObject ? { databaseUri, objectName: selectedObject, objectType: 'table' } : { databaseUri };
    },
    async applyCopilotDatabaseChange(target, data, label, baseRevision) {
      beforeApply?.(target);
      if (target.getRevision() !== baseRevision) {
        throw new Error('The database changed while Copilot was working. Rerun the tool against the latest revision.');
      }
      target.updateData(data);
      appliedLabels.push(label);
      appliedBaseRevisions.push(baseRevision);
    },
  };
  const tools = createSqliteTools({
    vscode: createVscodeStub(),
    registry,
    loadSqlJs: async () => sqlStatic,
    extensionUri: { fsPath: process.cwd() },
    getAccessMode: () => accessMode,
    getCopilotEnabled: () => copilotEnabled,
    getQueryOptions: () => ({ maxResultRows, timeoutMs: 5_000, sensitiveColumnPatterns }),
  });

  return { document, appliedBaseRevisions, appliedLabels, tools };
}

function createFixtureDocument() {
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  db.run('CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.run('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, team_id INTEGER REFERENCES teams(id))');
  db.run('CREATE INDEX people_name_idx ON people (name)');
  db.run('CREATE TRIGGER people_audit AFTER INSERT ON people BEGIN SELECT 1; END');
  db.run('INSERT INTO teams (name) VALUES ("Computing")');
  db.run('INSERT INTO people (name, team_id) VALUES ("Ada", 1), ("Grace", 1)');
  const data = db.export();
  db.close();

  return {
    uri: { toString: () => 'file:///fixture.sqlite' },
    data,
    revision: 0,
    getData() {
      return this.data;
    },
    getRevision() {
      return this.revision;
    },
    getSnapshot() {
      return { data: new Uint8Array(this.data), revision: this.revision };
    },
    updateData(nextData) {
      this.data = nextData;
      this.revision += 1;
    },
  };
}

function selectRows(data, sql) {
  const db = new SQL.Database(data);
  const statement = db.prepare(sql);
  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();
  db.close();
  return rows;
}

async function invokeJson(tool, input, token = {}) {
  const result = await tool.invoke({ input, toolInvocationToken: undefined }, token);
  return JSON.parse(result.content[0].value);
}

function createVscodeStub() {
  class LanguageModelTextPart {
    constructor(value) {
      this.value = value;
    }
  }

  class LanguageModelToolResult {
    constructor(content) {
      this.content = content;
    }
  }

  class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  }

  return {
    LanguageModelTextPart,
    LanguageModelToolResult,
    MarkdownString,
  };
}
