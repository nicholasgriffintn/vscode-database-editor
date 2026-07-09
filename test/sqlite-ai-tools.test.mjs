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
  const result = await invokeJson(harness.tools.dbContext, {});

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
    invokeJson(harness.tools.modify, {
      statement: 'INSERT INTO people (name) VALUES ("Katherine")',
      statementName: 'add person',
      statementDescription: 'Adds a person',
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

function createToolHarness({ accessMode = 'rw', copilotEnabled = true, sqlStatic = SQL } = {}) {
  const document = createFixtureDocument();
  const appliedLabels = [];
  const registry = {
    listOpenDatabases() {
      return [{ uri: document.uri.toString(), name: 'fixture.sqlite', active: true }];
    },
    resolveDocument(uri) {
      return uri && uri !== document.uri.toString() ? undefined : document;
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

async function invokeJson(tool, input) {
  const result = await tool.invoke({ input, toolInvocationToken: undefined }, {});
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
