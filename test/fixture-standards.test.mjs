import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import initSqlJs from 'sql.js';

import {
  getSchemaObjects,
  queryGridRows,
  readTableMetadata,
  runWrite,
} from '../media/sqlite-client.mjs';
import { buildDelete, buildTableSelect, buildUpdate } from '../media/sql.mjs';
import { assertFixtureStandards } from '../scripts/fixture-standards.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');

function readGridPage(database, table, { limit = 500, offset = 0, resultScope = table.name } = {}) {
  const query = buildTableSelect({
    tableName: table.name,
    columns: table.columns,
    includeRowid: table.hasRowid,
    rowidAlias: table.rowidAlias,
    limit,
    offset,
  });
  return queryGridRows(database, { table, query, resultScope, offset });
}

test('generated fixture satisfies general editor-safety standards without release-specific objects', async () => {
  await execFileAsync(process.execPath, ['scripts/create-fixture.mjs'], { cwd: projectRoot });

  const SQL = await initSqlJs({
    locateFile: (file) => path.join(projectRoot, 'node_modules', 'sql.js', 'dist', file),
  });
  const database = new SQL.Database(await readFile(path.join(projectRoot, '.tmp', 'sample.sqlite')));

  try {
    database.run('PRAGMA foreign_keys = ON');
    const report = assertFixtureStandards(database, { requireForeignKeysEnabled: true });
    assert.deepEqual(report.generatedColumns, [
      { name: 'normalized_name', hidden: 2 },
      { name: 'name_length', hidden: 3 },
    ]);
    assert.equal(report.membershipRows, 1005);
    assert.equal(report.releasePrefixedObjects, 0);

    database.run('SAVEPOINT fixture_fk_update');
    database.run('UPDATE teams SET id = 11 WHERE id = 1');
    assert.equal(database.exec('SELECT team_id FROM people WHERE id = 1')[0].values[0][0], 11);
    database.run('ROLLBACK TO fixture_fk_update');
    database.run('RELEASE fixture_fk_update');

    database.run('SAVEPOINT fixture_fk_delete');
    database.run('DELETE FROM teams WHERE id = 3');
    assert.equal(database.exec('SELECT COUNT(*) FROM team_projects')[0].values[0][0], 0);
    database.run('ROLLBACK TO fixture_fk_delete');
    database.run('RELEASE fixture_fk_delete');

    assert.throws(() => database.run('DELETE FROM teams WHERE id = 1'), /FOREIGN KEY constraint failed/i);
    assert.throws(() => database.run("INSERT INTO teams (name) VALUES ('Engineering')"), /UNIQUE constraint failed/i);
    assert.throws(() => database.run('CREATE TABLE people (id INTEGER)'), /table people already exists/i);

    const tables = readTableMetadata(database, getSchemaObjects(database));
    const table = (name) => tables.find((candidate) => candidate.name === name);

    const people = table('people');
    const normalizedName = people.columns.find((column) => column.name === 'normalized_name');
    const nameLength = people.columns.find((column) => column.name === 'name_length');
    assert.equal(normalizedName.generated, 'virtual');
    assert.equal(nameLength.generated, 'stored');
    assert.throws(() => buildUpdate({
      tableName: people.name,
      columnName: normalizedName.name,
      column: normalizedName,
      identity: { kind: 'rowid', value: 1n },
      primaryKeyColumns: people.primaryKeyColumns,
      rowidAlias: people.rowidAlias,
    }), /generated columns are read-only/i);

    const importedRecords = table('imported_records');
    const [importedRow] = readGridPage(database, importedRecords, { limit: 10 });
    assert.deepEqual(importedRow.identity, { kind: 'rowid', value: 1n });
    assert.equal(importedRow.values.__database_editor_identity, 'displayed identity');
    const importedUpdate = buildUpdate({
      tableName: importedRecords.name,
      columnName: 'value',
      column: importedRecords.columns.find((column) => column.name === 'value'),
      identity: importedRow.identity,
      primaryKeyColumns: importedRecords.primaryKeyColumns,
      rowidAlias: importedRecords.rowidAlias,
    });
    runWrite(database, importedUpdate.sql, ['updated import', ...importedUpdate.identityParams], { expectedRowsModified: 1 });
    assert.equal(readGridPage(database, importedRecords, { limit: 10 })[0].values.value, 'updated import');

    const legacyRecords = table('legacy_records');
    const [legacyRow] = readGridPage(database, legacyRecords, { limit: 10 });
    assert.equal(legacyRecords.rowidAlias, '_rowid_');
    assert.deepEqual(legacyRow.identity, { kind: 'rowid', value: 1n });
    assert.equal(legacyRow.values.rowid, 'declared rowid');

    const archiveEntries = table('archive_entries');
    const archiveRows = readGridPage(database, archiveEntries, { limit: 10 });
    assert.deepEqual(archiveRows.map((row) => row.identity.value), [9007199254740992n, 9007199254740993n]);
    const archiveUpdate = buildUpdate({
      tableName: archiveEntries.name,
      columnName: 'value',
      column: archiveEntries.columns[0],
      identity: archiveRows[1].identity,
      primaryKeyColumns: archiveEntries.primaryKeyColumns,
      rowidAlias: archiveEntries.rowidAlias,
    });
    runWrite(database, archiveUpdate.sql, ['updated exact row', ...archiveUpdate.identityParams], { expectedRowsModified: 1 });
    const archiveDelete = buildDelete({
      tableName: archiveEntries.name,
      identity: archiveRows[0].identity,
      primaryKeyColumns: archiveEntries.primaryKeyColumns,
      rowidAlias: archiveEntries.rowidAlias,
    });
    runWrite(database, archiveDelete.sql, archiveDelete.params, { expectedRowsModified: 1 });
    const [remainingArchiveRow] = readGridPage(database, archiveEntries, { limit: 10 });
    assert.deepEqual(remainingArchiveRow.identity, { kind: 'rowid', value: 9007199254740993n });
    assert.equal(remainingArchiveRow.values.value, 'updated exact row');

    const memberships = table('memberships');
    const membershipPages = [0, 500, 1000].map((offset) => readGridPage(database, memberships, { offset }));
    assert.deepEqual(membershipPages.map((page) => page.length), [500, 500, 5]);
    const membershipKeys = membershipPages.flat().map((row) => (
      `${row.identity.values.organization_id}:${row.identity.values.member_id}`
    ));
    assert.equal(new Set(membershipKeys).size, 1005);

    const eventCategories = table('query_event_categories');
    const duplicateRows = readGridPage(database, eventCategories, { limit: 10, resultScope: 'query_event_categories:fixture' });
    assert.deepEqual(duplicateRows.map((row) => row.values.category), ['query', 'query']);
    assert.deepEqual(duplicateRows.map((row) => row.identity), [
      { kind: 'visiblePosition', resultId: 'query_event_categories:fixture', position: 0 },
      { kind: 'visiblePosition', resultId: 'query_event_categories:fixture', position: 1 },
    ]);

    const accountExport = getSchemaObjects(database).find((object) => object.name === 'account_export');
    const accountExportSummary = getSchemaObjects(database).find((object) => object.name === 'account_export_summary');
    assert.match(accountExport.sql, /password AS value/i);
    assert.match(accountExportSummary.sql, /FROM account_export/i);

    const auditRowsBeforeInsert = database.exec('SELECT COUNT(*) FROM people_audit_log')[0].values[0][0];
    database.run("INSERT INTO people (name) VALUES ('Audit behavior')");
    const latestAudit = database.exec('SELECT action, name FROM people_audit_log ORDER BY rowid DESC LIMIT 1')[0].values[0];
    assert.deepEqual(latestAudit, ['insert', 'Audit behavior']);
    assert.equal(database.exec('SELECT COUNT(*) FROM people_audit_log')[0].values[0][0], auditRowsBeforeInsert + 1);
  } finally {
    database.close();
  }
});
