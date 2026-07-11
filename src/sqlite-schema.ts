import type { SqlJsDatabase, SqlJsStatement } from './sqljs-host';
import { throwIfCancellationRequested, type CancellationState } from './utilities/cancellation';
import { quoteIdentifier, sqlLiteral } from './utilities/sql';

export function executeRows(
  db: SqlJsDatabase,
  sql: string,
  rowLimit?: number,
  token?: CancellationState,
  deadline?: number,
): Record<string, unknown>[] {
  const statement = db.prepare(sql);
  const rows: Record<string, unknown>[] = [];
  try {
    while (statement.step()) {
      throwIfCancellationRequested(token, () => new Error('SQLite query was cancelled.'));
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error('SQLite query exceeded its execution time limit.');
      }
      rows.push(statement.getAsObject());
      if (rowLimit !== undefined && rows.length >= rowLimit) {
        break;
      }
    }
  } finally {
    statement.free();
  }
  return rows;
}

export type SchemaObjectSummary = {
  name: string;
  type: string;
  sql: string | null;
};

export type SchemaObjectType = 'table' | 'view';

export type SqliteDumpSchemaObject = {
  type: 'table' | 'index' | 'trigger' | 'view';
  name: string;
  tableName: string;
  sql: string;
};

export function getDumpSchemaObjects(database: SqlJsDatabase): SqliteDumpSchemaObject[] {
  const shadowTables = getShadowTableNames(database);
  const statement = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND type IN ('table', 'index', 'trigger', 'view')
    ORDER BY rowid
  `);
  const objects: SqliteDumpSchemaObject[] = [];
  try {
    while (statement.step()) {
      const row = statement.getAsObject();
      const name = String(row.name);
      const tableName = String(row.tbl_name);
      if (isDumpSchemaObjectType(row.type) && !shadowTables.has(name) && !shadowTables.has(tableName)) {
        objects.push({ type: row.type, name, tableName, sql: String(row.sql) });
      }
    }
  } finally {
    statement.free();
  }
  return objects;
}

export function getInsertableColumnNames(database: SqlJsDatabase, tableName: string): string[] {
  const statement = database.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`);
  const columns: string[] = [];
  try {
    while (statement.step()) {
      const row = statement.getAsObject();
      if (Number(row.hidden ?? 0) === 0) {
        columns.push(String(row.name));
      }
    }
  } finally {
    statement.free();
  }
  return columns;
}

export function getSchemaObjects(db: SqlJsDatabase, objectName?: string): SchemaObjectSummary[] {
  const rows = executeRows(
    db,
    'SELECT name, type, sql FROM sqlite_schema WHERE type IN (\'table\', \'view\') AND name NOT LIKE \'sqlite_%\' ORDER BY type, name',
  ).map((row) => ({
    name: String(row.name),
    type: String(row.type),
    sql: row.sql === null || row.sql === undefined ? null : String(row.sql),
  }));

  if (!objectName) {
    return rows;
  }

  return rows.filter((row) => row.name === objectName);
}

export function getSchemaObjectType(db: SqlJsDatabase, objectName: string): SchemaObjectType | undefined {
  const rows = executeRows(
    db,
    `SELECT type FROM sqlite_schema WHERE name = ${sqlLiteral(objectName)} AND type IN ('table', 'view')`,
  );

  const rowType = rows[0]?.type;
  return rowType === 'table' || rowType === 'view' ? (rowType as SchemaObjectType) : undefined;
}

export function getViewDefinition(db: SqlJsDatabase, viewName: string): string | undefined {
  const rows = executeRows(
    db,
    `SELECT sql FROM sqlite_schema WHERE name = ${sqlLiteral(viewName)} AND type = 'view'`,
  );
  const row = rows[0];
  if (!row || typeof row.sql !== 'string') {
    return undefined;
  }
  return row.sql;
}

export function getColumnsInfo(db: SqlJsDatabase, objectName: string): unknown[] {
  return executeRows(db, `PRAGMA table_info(${quoteIdentifier(objectName)})`).map((row) => ({
    name: row.name,
    type: row.type,
    primaryKey: Number(row.pk) > 0,
    nullable: Number(row.notnull) === 0,
    defaultValue: row.dflt_value,
  }));
}

export function getIndexes(db: SqlJsDatabase, tableName: string): unknown[] {
  return executeRows(db, `PRAGMA index_list(${quoteIdentifier(tableName)})`).map((index) => ({
    ...index,
    columns: executeRows(db, `PRAGMA index_info(${quoteIdentifier(String(index.name))})`),
  }));
}

export function getTriggers(db: SqlJsDatabase, tableName: string): unknown[] {
  return executeRows(
    db,
    `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ${sqlLiteral(tableName)} ORDER BY name`,
  );
}

export function getRowCount(
  db: SqlJsDatabase,
  objectName: string,
  token?: CancellationState,
  deadline?: number,
): number | null {
  try {
    const rows = executeRows(db, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(objectName)}`, 1, token, deadline);
    return Number(rows[0]?.count ?? 0);
  } catch {
    return null;
  }
}

function getShadowTableNames(database: SqlJsDatabase): Set<string> {
  const names = new Set<string>();
  let statement: SqlJsStatement | undefined;
  try {
    statement = database.prepare('PRAGMA table_list');
    while (statement.step()) {
      const row = statement.getAsObject();
      if (row.type === 'shadow') {
        names.add(String(row.name));
      }
    }
  } catch {
    // Older SQLite builds do not expose table_list; their virtual-table handling remains unchanged.
  } finally {
    statement?.free();
  }
  return names;
}

function isDumpSchemaObjectType(value: unknown): value is SqliteDumpSchemaObject['type'] {
  return value === 'table' || value === 'index' || value === 'trigger' || value === 'view';
}
