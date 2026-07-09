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

export function loadSqlJs(extensionUri: vscode.Uri): Promise<SqlJsStatic> {
  const cached = sqlPromise;
  if (cached) {
    return cached;
  }

  const sqlJsPath = path.join(extensionUri.fsPath, 'media', 'vendor', 'sqljs', 'sql-wasm.js');
  const wasmDirectory = path.join(extensionUri.fsPath, 'media', 'vendor', 'sqljs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require(sqlJsPath);
  const loading = initSqlJs({
    locateFile: (file: string) => path.join(wasmDirectory, file),
  }) as Promise<SqlJsStatic>;
  sqlPromise = loading;
  return loading;
}
