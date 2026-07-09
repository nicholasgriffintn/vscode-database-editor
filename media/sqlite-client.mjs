import { analyzeSqlScript, buildTableCount, quoteIdentifier } from './sql-utils.mjs';

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
    const columns = queryAll(db, `PRAGMA table_info(${quoteIdentifier(row.name)})`)
      .map((column) => ({
        name: column.name,
        type: column.type || '',
        affinity: getTypeAffinity(column.type || ''),
        nullable: column.notnull === 0,
        defaultValue: column.dflt_value,
        primaryKeyOrder: column.pk,
        keyKind: getColumnKeyKind(column, foreignKeys),
        indexed: indexedColumns.has(column.name),
        foreignKeyTarget: getForeignKeyTarget(column.name, foreignKeys),
      }));

    return {
      name: row.name,
      type: row.type,
      sql: row.sql ?? '',
      columns,
      primaryKeyColumns: columns
        .filter((column) => column.primaryKeyOrder > 0)
        .sort((a, b) => a.primaryKeyOrder - b.primaryKeyOrder)
        .map((column) => column.name),
      hasRowid: row.type === 'table' && hasRowid(db, row.name),
      rowCount: getRowCount(db, row.name, columns),
      foreignKeys,
      indexes: schemaObjects.filter((object) => object.type === 'index' && object.tableName === row.name),
      triggers: schemaObjects.filter((object) => object.type === 'trigger' && object.tableName === row.name),
    };
  });
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

export function runStatement(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    statement.step();
  } finally {
    statement.free();
  }
}

export function runWrite(db, sql, params = []) {
  db.run('BEGIN IMMEDIATE');
  try {
    runStatement(db, sql, params);
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
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

export function runSqlScript(db, sql, analysis = analyzeSqlScript(sql)) {
  if (analysis.isEmpty) {
    return { results: [], changed: false };
  }

  if (!analysis.mutates) {
    return { results: db.exec(sql), changed: false };
  }

  if (analysis.hasTransactionControl) {
    try {
      return { results: db.exec(sql), changed: true };
    } catch (error) {
      rollbackBestEffort(db);
      markDatabaseChanged(error);
      throw error;
    }
  }

  db.run('BEGIN IMMEDIATE');
  try {
    const results = db.exec(sql);
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
  try {
    db.exec(`SELECT rowid FROM ${quoteIdentifier(tableName)} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

export function getRowCount(db, tableName, columns) {
  try {
    return queryAll(db, buildTableCount({ tableName, columns, filter: '' }).sql)[0]?.count ?? 0;
  } catch {
    return 0;
  }
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
