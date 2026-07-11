import * as path from 'node:path';
import type * as vscode from 'vscode';

export type SqlJsStatic = {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
};

export type SqlJsDatabase = {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): SqlJsStatement;
  run(sql: string, params?: unknown[]): void;
  export(): Uint8Array;
  close(): void;
  getRowsModified?(): number;
};

export type SqlJsStatement = {
  bind(params?: unknown[]): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  getColumnNames(): string[];
  free(): void;
};

let sqlPromise: Promise<SqlJsStatic> | undefined;

export async function loadSqlJs(extensionUri: vscode.Uri): Promise<SqlJsStatic> {
  const cached = sqlPromise;
  if (cached) {
    return await cached;
  }

  const loading = initializeSqlJs(extensionUri.fsPath);
  sqlPromise = loading;
  try {
    return await loading;
  } catch (error) {
    if (sqlPromise === loading) {
      sqlPromise = undefined;
    }
    throw error;
  }
}

export function initializeSqlJs(extensionPath: string): Promise<SqlJsStatic> {
  const sqlJsPath = path.join(extensionPath, 'media', 'vendor', 'sqljs', 'sql-wasm.js');
  const wasmDirectory = path.dirname(sqlJsPath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require(sqlJsPath);
  return initSqlJs({
    locateFile: (file: string) => path.join(wasmDirectory, file),
  }) as Promise<SqlJsStatic>;
}

export function configureDatabase(db: SqlJsDatabase): void {
  db.run('PRAGMA foreign_keys = ON');
  const value = db.exec('PRAGMA foreign_keys')[0]?.values?.[0]?.[0];
  if (Number(value) !== 1) {
    throw new Error('Could not enable SQLite foreign key enforcement for this database session.');
  }
}
