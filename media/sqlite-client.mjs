import { buildTableCount, quoteIdentifier } from './sql-utils.mjs';

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
    const columns = queryAll(db, `PRAGMA table_info(${quoteIdentifier(row.name)})`)
      .map((column) => ({
        name: column.name,
        type: column.type || '',
        nullable: column.notnull === 0,
        defaultValue: column.dflt_value,
        primaryKeyOrder: column.pk,
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
      foreignKeys: row.type === 'table' ? queryAll(db, `PRAGMA foreign_key_list(${quoteIdentifier(row.name)})`) : [],
      indexes: schemaObjects.filter((object) => object.type === 'index' && object.tableName === row.name),
      triggers: schemaObjects.filter((object) => object.type === 'trigger' && object.tableName === row.name),
    };
  });
}

export function queryAll(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) {
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
