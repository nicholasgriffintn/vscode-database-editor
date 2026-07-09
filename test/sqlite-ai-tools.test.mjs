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

test('read-only query stops stepping after the response cap plus one truncation row', async () => {
  let stepCount = 0;
  const harness = createToolHarness({
    sqlStatic: createTrackingSqlStatic(() => {
      stepCount += 1;
    }),
  });
  const result = await invokeJson(harness.tools.query, {
    query: 'WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 500) SELECT value FROM sequence',
    queryName: 'sequence',
    queryDescription: 'Generate more rows than the response cap',
  });

  assert.equal(result.rows.length, 200);
  assert.equal(result.rowCount, 200);
  assert.equal(result.truncated, true);
  assert.equal(stepCount, 201);
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

test('query tool stops when its cancellation token is requested', async () => {
  let stepCount = 0;
  const harness = createToolHarness({
    sqlStatic: createTrackingSqlStatic(() => {
      stepCount += 1;
    }),
  });
  const result = await invokeJson(harness.tools.query, {
    query: 'WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence) SELECT value FROM sequence',
    queryName: 'sequence',
    queryDescription: 'Generate rows until cancelled',
  }, {
    get isCancellationRequested() {
      return stepCount >= 1;
    },
  });

  assert.match(result.error, /cancelled/i);
  assert.equal(stepCount, 1);
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
  const rows = selectRows(harness.document.getData(), 'SELECT name FROM people ORDER BY id');
  assert.deepEqual(rows.map((row) => row.name), ['Ada', 'Grace', 'Katherine']);
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
  maxResultRows = 200,
  sensitiveColumnPatterns = [],
} = {}) {
  const document = createFixtureDocument();
  const secondDocument = additionalDatabase
    ? { ...createFixtureDocument(), uri: { toString: () => 'file:///second.sqlite' } }
    : undefined;
  const appliedLabels = [];
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
      return selectedObject ? { databaseUri, objectName: selectedObject, objectType: 'table' } : { databaseUri };
    },
    async applyCopilotDatabaseChange(target, data, label) {
      target.updateData(data);
      appliedLabels.push(label);
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

  return { document, appliedLabels, tools };
}

function createTrackingSqlStatic(onStep) {
  return {
    Database: class {
      constructor(data) {
        const db = new SQL.Database(data);
        const prepare = db.prepare.bind(db);
        db.prepare = (sql) => {
          const statement = prepare(sql);
          const step = statement.step.bind(statement);
          statement.step = () => {
            onStep();
            return step();
          };
          return statement;
        };
        return db;
      }
    },
  };
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
    getData() {
      return this.data;
    },
    updateData(nextData) {
      this.data = nextData;
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
