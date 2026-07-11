import type * as vscode from 'vscode';

import type { SqlJsDatabase } from '../sqljs-host';
import { sqlLiteral } from '../../utilities/sql';
import { quoteIdentifier } from '../sql-safety';

export function executeRows(
  db: SqlJsDatabase,
  sql: string,
  rowLimit?: number,
  token?: vscode.CancellationToken,
  deadline?: number,
): Record<string, unknown>[] {
  const statement = db.prepare(sql);
  const rows: Record<string, unknown>[] = [];
  try {
    while (statement.step()) {
      if (token?.isCancellationRequested) {
        throw new Error('SQLite query was cancelled.');
      }
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
  token?: vscode.CancellationToken,
  deadline?: number,
): number | null {
  try {
    const rows = executeRows(db, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(objectName)}`, 1, token, deadline);
    return Number(rows[0]?.count ?? 0);
  } catch {
    return null;
  }
}
