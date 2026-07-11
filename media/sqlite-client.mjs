import {
  analyzeSqlScript,
  assertSqlScriptCanExport,
  buildTableCount,
  quoteIdentifier,
} from './sql-utils.mjs';
import { executeSqlScript } from './sql-workspace.mjs';

export function configureDatabase(db) {
  db.run('PRAGMA foreign_keys = ON');
  const result = db.exec('PRAGMA foreign_keys');
  const value = result[0]?.values?.[0]?.[0];
  if (Number(value) !== 1) {
    throw new Error('Could not enable SQLite foreign key enforcement for this database session.');
  }
}

export function getSchemaObjects(db) {
  return queryAll(db, `
    SELECT name, type, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY
      CASE type
        WHEN 'table' THEN 1
        WHEN 'view' THEN 2
        WHEN 'index' THEN 3
        WHEN 'trigger' THEN 4
        ELSE 5
      END,
      name
  `);
}

export function readTableMetadata(db, schemaObjects) {
  return queryAll(db, `
    SELECT name, type, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).map((row) => {
    const foreignKeys = row.type === 'table' ? queryAll(db, `PRAGMA foreign_key_list(${quoteIdentifier(row.name)})`) : [];
    const indexedColumns = row.type === 'table' ? readIndexedColumns(db, row.name) : new Set();
    const allColumns = readColumns(db, row.name)
      .map((column) => normalizeColumnMetadata(column, foreignKeys, indexedColumns));
    const columns = allColumns.filter((column) => !column.hidden);
    const rowidAlias = row.type === 'table' ? getRowidAlias(db, row.name, allColumns, row.sql) : null;

    return {
      name: row.name,
      type: row.type,
      sql: row.sql ?? '',
      columns,
      hiddenColumns: allColumns.filter((column) => column.hidden),
      primaryKeyColumns: columns
        .filter((column) => column.primaryKeyOrder > 0)
        .sort((a, b) => a.primaryKeyOrder - b.primaryKeyOrder)
        .map((column) => column.name),
      hasRowid: Boolean(rowidAlias),
      rowidAlias,
      rowCount: null,
      foreignKeys,
      indexes: schemaObjects.filter((object) => object.type === 'index' && object.tableName === row.name),
      triggers: schemaObjects.filter((object) => object.type === 'trigger' && object.tableName === row.name),
    };
  });
}

function readColumns(db, tableName) {
  try {
    const extendedColumns = queryAll(db, `PRAGMA table_xinfo(${quoteIdentifier(tableName)})`);
    if (extendedColumns.length > 0) {
      return extendedColumns;
    }
  } catch {
    // Fall through to table_info for older SQLite runtimes.
  }
  return queryAll(db, `PRAGMA table_info(${quoteIdentifier(tableName)})`);
}

export function normalizeColumnMetadata(column, foreignKeys = [], indexedColumns = new Set()) {
  const hiddenCode = Number(column.hidden ?? 0);
  const generated = hiddenCode === 2 ? 'virtual' : hiddenCode === 3 ? 'stored' : false;
  const hidden = hiddenCode === 1;
  return {
    name: column.name,
    type: column.type || '',
    affinity: getTypeAffinity(column.type || ''),
    nullable: column.notnull === 0,
    defaultValue: column.dflt_value,
    primaryKeyOrder: column.pk,
    keyKind: getColumnKeyKind(column, foreignKeys),
    indexed: indexedColumns.has(column.name),
    foreignKeyTarget: getForeignKeyTarget(column.name, foreignKeys),
    hidden,
    generated,
    readOnly: hidden || Boolean(generated),
    canInsert: !hidden && !generated,
    canUpdate: !hidden && !generated && Number(column.pk) === 0,
  };
}

function getRowidAlias(db, tableName, columns, createSql = '') {
  if (/\bwithout\s+rowid\b/i.test(String(createSql))) {
    return null;
  }

  const declaredNames = new Set(columns.map((column) => String(column.name).toLowerCase()));
  for (const alias of ['_rowid_', 'oid', 'rowid']) {
    if (declaredNames.has(alias)) {
      continue;
    }
    try {
      db.exec(`SELECT ${quoteIdentifier(tableName)}.${alias} FROM ${quoteIdentifier(tableName)} LIMIT 0`);
      return alias;
    } catch {
      // Try the next SQLite hidden-rowid alias.
    }
  }
  return null;
}

export function queryAll(db, sql, params = [], options = {}) {
  const statement = db.prepare(sql);
  const timeoutMs = Number(options.timeoutMs ?? 0);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const start = timeoutMs > 0 ? now() : 0;
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) {
      if (timeoutMs > 0 && now() - start > timeoutMs) {
        throw new Error(`SQLite query timed out after ${timeoutMs} ms.`);
      }
      rows.push(statement.getAsObject());
    }
    return rows;
  } finally {
    statement.free();
  }
}

export function queryGridRows(db, { table, query, resultScope, offset = 0, options = {} }) {
  const statement = db.prepare(query.sql);
  const timeoutMs = Number(options.timeoutMs ?? 0);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const start = timeoutMs > 0 ? now() : 0;
  try {
    statement.bind(query.params ?? []);
    const rows = [];
    while (statement.step()) {
      if (timeoutMs > 0 && now() - start > timeoutMs) {
        throw new Error(`SQLite query timed out after ${timeoutMs} ms.`);
      }
      const exact = statement.get(null, { useBigInt: true });
      const displayed = statement.get();
      const valueOffset = query.hasIdentityColumn ? 1 : 0;
      const values = Object.fromEntries(table.columns.map((column, index) => [
        column.name,
        displayed[valueOffset + index],
      ]));
      rows.push({
        identity: buildGridRowIdentity({
          table,
          exact,
          valueOffset,
          resultScope,
          position: offset + rows.length,
        }),
        values,
      });
    }
    return rows;
  } finally {
    statement.free();
  }
}

function buildGridRowIdentity({ table, exact, valueOffset, resultScope, position }) {
  if (table.rowidAlias) {
    return { kind: 'rowid', value: exact[0] };
  }
  if (table.primaryKeyColumns.length > 0) {
    const columnIndexes = new Map(table.columns.map((column, index) => [column.name, index]));
    return {
      kind: 'primaryKey',
      values: Object.fromEntries(table.primaryKeyColumns.map((column) => [
        column,
        exact[valueOffset + columnIndexes.get(column)],
      ])),
    };
  }
  return {
    kind: 'visiblePosition',
    resultId: resultScope,
    position,
  };
}

export function runStatement(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    statement.step();
  } finally {
    statement.free();
  }
}

export function runWrite(db, sql, params = [], options = {}) {
  db.run('BEGIN IMMEDIATE');
  try {
    runStatement(db, sql, params);
    assertExpectedRowsModified(db, options.expectedRowsModified);
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

export function runWriteBatch(db, statements = []) {
  if (statements.length === 0) {
    return;
  }

  db.run('BEGIN IMMEDIATE');
  try {
    for (const statement of statements) {
      runStatement(db, statement.sql, statement.params ?? []);
      assertExpectedRowsModified(db, statement.expectedRowsModified);
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

function assertExpectedRowsModified(db, expected) {
  if (expected === undefined || expected === null) {
    return;
  }
  const actual = db.getRowsModified();
  if (actual !== expected) {
    throw new Error(`Expected SQLite write to affect ${expected} row${expected === 1 ? '' : 's'}, but it affected ${actual}.`);
  }
}

export function runSqlScript(db, sql, analysis = analyzeSqlScript(sql), options = {}) {
  if (analysis.isEmpty) {
    return { results: [], changed: false };
  }

  assertSqlScriptCanExport(analysis);

  if (!analysis.mutates) {
    return { results: executeSqlScript(db, sql, options), changed: false };
  }

  if (analysis.hasTransactionControl) {
    try {
      const results = executeSqlScript(db, sql, options);
      assertSqlScriptCanExport(analysis);
      return { results, changed: true };
    } catch (error) {
      rollbackBestEffort(db);
      markDatabaseChanged(error);
      throw error;
    }
  }

  db.run('BEGIN IMMEDIATE');
  try {
    const results = executeSqlScript(db, sql, options);
    db.run('COMMIT');
    return { results, changed: true };
  } catch (error) {
    rollbackBestEffort(db);
    throw error;
  }
}

function markDatabaseChanged(error) {
  if (error && typeof error === 'object') {
    error.databaseChanged = true;
  }
}

function rollbackBestEffort(db) {
  try {
    db.run('ROLLBACK');
  } catch {
    // The script may already have ended the transaction; preserve the original SQLite error.
  }
}

export function hasRowid(db, tableName) {
  const createSql = queryAll(
    db,
    'SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?',
    ['table', tableName],
  )[0]?.sql ?? '';
  return Boolean(getRowidAlias(db, tableName, readColumns(db, tableName), createSql));
}

export function getRowCount(db, tableName, columns) {
  try {
    return countTableRows(db, { tableName, columns });
  } catch {
    return 0;
  }
}

export function countTableRows(db, {
  tableName,
  columns,
  filter = '',
  columnFilters = {},
  options = {},
}) {
  const query = buildTableCount({ tableName, columns, filter, columnFilters });
  return queryAll(db, query.sql, query.params, options)[0]?.count ?? 0;
}

function readIndexedColumns(db, tableName) {
  const columns = new Set();
  for (const index of queryAll(db, `PRAGMA index_list(${quoteIdentifier(tableName)})`)) {
    if (index.origin === 'pk') {
      continue;
    }

    for (const indexedColumn of queryAll(db, `PRAGMA index_info(${quoteIdentifier(index.name)})`)) {
      if (indexedColumn.name) {
        columns.add(indexedColumn.name);
      }
    }
  }
  return columns;
}

function getTypeAffinity(type) {
  const normalized = String(type).toUpperCase();
  if (normalized.includes('INT')) {
    return 'INTEGER';
  }
  if (normalized.includes('CHAR') || normalized.includes('CLOB') || normalized.includes('TEXT')) {
    return 'TEXT';
  }
  if (normalized.includes('BLOB') || normalized === '') {
    return 'BLOB';
  }
  if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB')) {
    return 'REAL';
  }
  return 'NUMERIC';
}

function getColumnKeyKind(column, foreignKeys) {
  if (column.pk > 0) {
    return 'PK';
  }

  return foreignKeys.some((key) => key.from === column.name) ? 'FK' : null;
}

function getForeignKeyTarget(columnName, foreignKeys) {
  const foreignKey = foreignKeys.find((key) => key.from === columnName);
  return foreignKey ? `${foreignKey.table}.${foreignKey.to}` : null;
}
