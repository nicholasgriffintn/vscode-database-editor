import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

import {
  createDatabaseHealthWorkflow,
  formatDatabaseHealthReport,
  runDatabaseHealthChecks,
} from '../media/database/health.mjs';

const SQL = await initSqlJs({
  locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
});

test('healthy database passes bounded integrity and foreign-key checks without changing bytes', () => {
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  db.run('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
  db.run('CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))');
  db.run('INSERT INTO parent VALUES (1)');
  db.run('INSERT INTO child VALUES (1)');
  const before = db.export();

  assert.deepEqual(runDatabaseHealthChecks(db, { limit: 10 }), {
    ok: true,
    quickCheck: { ok: true, issues: [], truncated: false },
    foreignKeyCheck: { ok: true, issues: [], truncated: false },
  });
  assert.deepEqual([...db.export()], [...before]);
  db.close();
});

test('foreign-key violations retain bounded details and report truncation', () => {
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = OFF');
  db.run('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
  db.run('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))');
  db.run('INSERT INTO child VALUES (1, 91), (2, 92), (3, 93)');

  const report = runDatabaseHealthChecks(db, { limit: 2 });
  assert.equal(report.ok, false);
  assert.deepEqual(report.quickCheck, { ok: true, issues: [], truncated: false });
  assert.equal(report.foreignKeyCheck.ok, false);
  assert.equal(report.foreignKeyCheck.issues.length, 2);
  assert.equal(report.foreignKeyCheck.truncated, true);
  assert.deepEqual(report.foreignKeyCheck.issues.map(({ table, rowid, parent }) => ({ table, rowid, parent })), [
    { table: 'child', rowid: 1, parent: 'parent' },
    { table: 'child', rowid: 2, parent: 'parent' },
  ]);
  assert.match(formatDatabaseHealthReport(report), /Foreign-key check: 2 issues shown \(additional issues omitted\)/);
  assert.match(formatDatabaseHealthReport(report), /child · rowid 1 · parent parent · constraint 0/);
  db.close();
});

test('health workflow publishes one report and a result status through its public interface', () => {
  const db = new SQL.Database();
  db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)');
  const reports = [];
  const statuses = [];
  const workflow = createDatabaseHealthWorkflow({
    getDatabase: () => db,
    showReport: (text, report) => reports.push({ text, report }),
    setStatus: (status) => statuses.push(status),
  });

  const report = workflow.run();
  assert.equal(report.ok, true);
  assert.equal(reports.length, 1);
  assert.match(reports[0].text, /No integrity or foreign-key issues found/);
  assert.deepEqual(statuses, ['Database health check passed.']);
  db.close();
});
