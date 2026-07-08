import type * as vscode from 'vscode';

import type { SqlJsDatabase, SqlJsStatic } from './sqljs-host';
import type { OpenDatabaseSummary } from './sqlite-document-registry';
import { capRows, isAllowedModification, isReadOnlyQuery, quoteIdentifier } from './sql-safety';

export type SqliteToolDocument = {
  readonly uri: { toString(): string };
  getData(): Uint8Array;
};

export type SqliteToolRegistry<TDocument extends SqliteToolDocument = SqliteToolDocument> = {
  listOpenDatabases(): OpenDatabaseSummary[];
  resolveDocument(uri?: string): TDocument | undefined;
  applyCopilotDatabaseChange(document: TDocument, data: Uint8Array, label: string): Promise<void>;
};

export type SqliteTools = {
  listOpenDatabases: vscode.LanguageModelTool<Record<string, never>>;
  dbContext: vscode.LanguageModelTool<DbContextInput>;
  query: vscode.LanguageModelTool<QueryInput>;
  modify: vscode.LanguageModelTool<ModifyInput>;
};

type VscodeToolApi = Pick<typeof vscode, 'LanguageModelTextPart' | 'LanguageModelToolResult' | 'MarkdownString'>;

type CreateSqliteToolsOptions<TDocument extends SqliteToolDocument> = {
  vscode: VscodeToolApi;
  registry: SqliteToolRegistry<TDocument>;
  extensionUri: vscode.Uri;
  loadSqlJs(extensionUri: vscode.Uri): Promise<SqlJsStatic>;
  getAccessMode(): 'ro' | 'rw';
};

type DbContextInput = {
  databaseUri?: string;
  objectName?: string;
};

type QueryInput = {
  databaseUri?: string;
  query: string;
  queryName: string;
  queryDescription: string;
};

type ModifyInput = {
  databaseUri?: string;
  statement: string;
  statementName: string;
  statementDescription: string;
};

export const SQLITE_TOOL_NAMES = [
  'databaseEditor_list_open_databases',
  'databaseEditor_db_context',
  'databaseEditor_query',
  'databaseEditor_modify',
] as const;

export function createSqliteTools<TDocument extends SqliteToolDocument>(
  options: CreateSqliteToolsOptions<TDocument>,
): SqliteTools {
  const result = (value: unknown) => new options.vscode.LanguageModelToolResult([
    new options.vscode.LanguageModelTextPart(JSON.stringify(value)),
  ]);

  const error = (message: string) => result({ error: message });

  async function openDatabase(input: { databaseUri?: string }): Promise<{
    document?: TDocument;
    db?: SqlJsDatabase;
    close(): void;
    error?: vscode.LanguageModelToolResult;
  }> {
    const document = options.registry.resolveDocument(input.databaseUri);
    if (!document) {
      return {
        close: () => {},
        error: error('Open a SQLite database with SQLite Database Editor first.'),
      };
    }

    const SQL = await options.loadSqlJs(options.extensionUri);
    const db = new SQL.Database(document.getData());
    return {
      document,
      db,
      close: () => db.close(),
    };
  }

  return {
    listOpenDatabases: {
      invoke: () => result({ databases: options.registry.listOpenDatabases() }),
      prepareInvocation: () => ({ invocationMessage: 'Listing open SQLite databases' }),
    },
    dbContext: {
      invoke: async ({ input }) => {
        const opened = await openDatabase(input ?? {});
        if (opened.error || !opened.document || !opened.db) {
          return opened.error;
        }

        try {
          return result(getDatabaseContext(opened.document, opened.db, input?.objectName));
        } catch (caught) {
          return error(getErrorMessage(caught));
        } finally {
          opened.close();
        }
      },
      prepareInvocation: () => ({ invocationMessage: 'Reading SQLite schema context' }),
    },
    query: {
      invoke: async ({ input }) => {
        if (!input?.query || !isReadOnlyQuery(input.query)) {
          return error('Only one read-only SELECT or safe WITH query is allowed.');
        }

        const opened = await openDatabase(input);
        if (opened.error || !opened.db) {
          return opened.error;
        }

        try {
          const rows = executeRows(opened.db, input.query);
          const capped = capRows(rows);
          return result({
            queryName: input.queryName,
            columns: rows.length > 0 ? Object.keys(rows[0]) : getColumns(opened.db, input.query),
            ...capped,
          });
        } catch (caught) {
          return error(getErrorMessage(caught));
        } finally {
          opened.close();
        }
      },
      prepareInvocation: ({ input }) => ({
        invocationMessage: `Running read-only SQLite query '${input.queryName}'`,
      }),
    },
    modify: {
      invoke: async ({ input }) => {
        if (options.getAccessMode() !== 'rw') {
          return error('Read/write Copilot tools are disabled. Set databaseEditor.copilot.accessMode to "rw" to enable confirmed modifications.');
        }
        if (!input?.statement || !isAllowedModification(input.statement)) {
          return error('Only one INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, or DROP statement is allowed.');
        }

        const opened = await openDatabase(input);
        if (opened.error || !opened.document || !opened.db) {
          return opened.error;
        }

        try {
          opened.db.run('BEGIN IMMEDIATE');
          opened.db.run(input.statement);
          const changes = opened.db.getRowsModified?.();
          opened.db.run('COMMIT');
          const data = opened.db.export();
          await options.registry.applyCopilotDatabaseChange(
            opened.document,
            data,
            `Copilot: ${input.statementName}`,
          );
          return result({
            success: true,
            changes,
            message: `Applied SQLite modification: ${input.statementName}`,
          });
        } catch (caught) {
          try {
            opened.db.run('ROLLBACK');
          } catch {
            // The original error is more useful than a best-effort rollback failure.
          }
          return error(getErrorMessage(caught));
        } finally {
          opened.close();
        }
      },
      prepareInvocation: ({ input }) => ({
        invocationMessage: `Executing SQLite modification '${input.statementName}'`,
        confirmationMessages: {
          title: 'SQLite: Modify Database',
          message: new options.vscode.MarkdownString(
            `Execute modification **${input.statementName}**?\n\n`
            + `${input.statementDescription}\n\n`
            + '```sql\n'
            + `${previewSql(input.statement)}\n`
            + '```',
          ),
        },
      }),
    },
  };
}

function getDatabaseContext(document: SqliteToolDocument, db: SqlJsDatabase, objectName?: string): unknown {
  const objects = getSchemaObjects(db, objectName);
  return {
    database: {
      uri: document.uri.toString(),
      name: basename(document.uri.toString()),
    },
    objects: objects.map((object) => ({
      ...object,
      rowCount: object.type === 'table' || object.type === 'view'
        ? getRowCount(db, object.name)
        : undefined,
      columns: object.type === 'table' || object.type === 'view'
        ? getColumnsInfo(db, object.name)
        : [],
      foreignKeys: object.type === 'table'
        ? executeRows(db, `PRAGMA foreign_key_list(${quoteIdentifier(object.name)})`)
        : [],
      indexes: object.type === 'table'
        ? getIndexes(db, object.name)
        : [],
      triggers: getTriggers(db, object.name),
    })),
  };
}

function getSchemaObjects(db: SqlJsDatabase, objectName?: string): Array<{ name: string; type: string; sql: string | null }> {
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

function getColumnsInfo(db: SqlJsDatabase, objectName: string): unknown[] {
  return executeRows(db, `PRAGMA table_info(${quoteIdentifier(objectName)})`).map((row) => ({
    name: row.name,
    type: row.type,
    primaryKey: Number(row.pk) > 0,
    nullable: Number(row.notnull) === 0,
    defaultValue: row.dflt_value,
  }));
}

function getIndexes(db: SqlJsDatabase, tableName: string): unknown[] {
  return executeRows(db, `PRAGMA index_list(${quoteIdentifier(tableName)})`).map((index) => ({
    ...index,
    columns: executeRows(db, `PRAGMA index_info(${quoteIdentifier(String(index.name))})`),
  }));
}

function getTriggers(db: SqlJsDatabase, tableName: string): unknown[] {
  return executeRows(
    db,
    `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ${sqlLiteral(tableName)} ORDER BY name`,
  );
}

function getRowCount(db: SqlJsDatabase, objectName: string): number | null {
  try {
    const rows = executeRows(db, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(objectName)}`);
    return Number(rows[0]?.count ?? 0);
  } catch {
    return null;
  }
}

function executeRows(db: SqlJsDatabase, sql: string): Record<string, unknown>[] {
  const statement = db.prepare(sql);
  const rows: Record<string, unknown>[] = [];
  try {
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }
  return rows;
}

function getColumns(db: SqlJsDatabase, sql: string): string[] {
  return db.exec(sql)[0]?.columns ?? [];
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function previewSql(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.length > 1_500 ? `${trimmed.slice(0, 1_500)}...` : trimmed;
}

function basename(uri: string): string {
  const slashIndex = uri.lastIndexOf('/');
  return slashIndex === -1 ? uri : decodeURIComponent(uri.slice(slashIndex + 1));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
