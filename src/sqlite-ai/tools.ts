import type * as vscode from 'vscode';

import type { SqlJsDatabase, SqlJsStatic } from './sqljs-host';
import type { OpenDatabaseSummary, SqliteSelectionContext } from './sqlite-document-registry';
import { capRows, isAllowedModification, isReadOnlyQuery, quoteIdentifier } from './sql-safety';

export type SqliteToolDocument = {
  readonly uri: { toString(): string };
  getData(): Uint8Array;
};

export type SqliteToolRegistry<TDocument extends SqliteToolDocument = SqliteToolDocument> = {
  listOpenDatabases(): OpenDatabaseSummary[];
  resolveDocument(uri?: string): TDocument | undefined;
  getSelectionContext(uri?: string): SqliteSelectionContext | undefined;
  applyCopilotDatabaseChange(document: TDocument, data: Uint8Array, label: string): Promise<void>;
};

export type SqliteTools = {
  listOpenDatabases: vscode.LanguageModelTool<Record<string, never>>;
  dbContext: vscode.LanguageModelTool<DbContextInput>;
  query: vscode.LanguageModelTool<QueryInput>;
  explain: vscode.LanguageModelTool<ExplainInput>;
  profile: vscode.LanguageModelTool<ProfileInput>;
  modify: vscode.LanguageModelTool<ModifyInput>;
  migrate: vscode.LanguageModelTool<MigrationInput>;
};

type VscodeToolApi = Pick<typeof vscode, 'LanguageModelTextPart' | 'LanguageModelToolResult' | 'MarkdownString'>;

type CreateSqliteToolsOptions<TDocument extends SqliteToolDocument> = {
  vscode: VscodeToolApi;
  registry: SqliteToolRegistry<TDocument>;
  extensionUri: vscode.Uri;
  loadSqlJs(extensionUri: vscode.Uri): Promise<SqlJsStatic>;
  getAccessMode(): 'ro' | 'rw';
  getCopilotEnabled(): boolean;
  getQueryOptions(): {
    maxResultRows: number;
    timeoutMs: number;
    sensitiveColumnPatterns: string[];
  };
};

type DbContextInput = {
  databaseUri?: string;
  objectName?: string;
  offset?: number;
  limit?: number;
};

type QueryInput = {
  databaseUri?: string;
  query: string;
  queryName: string;
  queryDescription: string;
};

type ExplainInput = { databaseUri?: string; query: string; queryName: string };
type ProfileInput = { databaseUri?: string; objectName: string };

type ModifyInput = {
  databaseUri?: string;
  statement: string;
  statementName: string;
  statementDescription: string;
};

type MigrationInput = {
  databaseUri?: string;
  statements: string[];
  migrationName: string;
  migrationDescription: string;
};

export const SQLITE_TOOL_NAMES = [
  'databaseEditor_list_open_databases',
  'databaseEditor_db_context',
  'databaseEditor_query',
  'databaseEditor_explain',
  'databaseEditor_profile',
  'databaseEditor_modify',
  'databaseEditor_migrate',
] as const;

const QUERY_ROW_LIMIT = 200;

export function createSqliteTools<TDocument extends SqliteToolDocument>(
  options: CreateSqliteToolsOptions<TDocument>,
): SqliteTools {
  const result = (value: unknown) => new options.vscode.LanguageModelToolResult([
    new options.vscode.LanguageModelTextPart(JSON.stringify(value)),
  ]);

  const error = (message: string) => result({ error: message });

  const disabledError = () => options.getCopilotEnabled()
    ? undefined
    : error('Copilot integration is disabled in Database Editor settings.');

  async function openDatabase(input: { databaseUri?: string }): Promise<{
    document?: TDocument;
    db?: SqlJsDatabase;
    close(): void;
    error?: vscode.LanguageModelToolResult;
  }> {
    if (!input.databaseUri && options.registry.listOpenDatabases().length > 1) {
      return {
        close: () => {},
        error: error('Multiple SQLite databases are open. Call databaseEditor_list_open_databases and provide databaseUri explicitly.'),
      };
    }

    const document = options.registry.resolveDocument(input.databaseUri);
    if (!document) {
      return {
        close: () => {},
        error: error('Open a SQLite database with SQLite Database Editor first.'),
      };
    }

    const SQL = await options.loadSqlJs(options.extensionUri);
    const db = new SQL.Database(document.getData());
    db.run('PRAGMA foreign_keys = ON');
    return {
      document,
      db,
      close: () => db.close(),
    };
  }

  return {
    listOpenDatabases: {
      invoke: () => disabledError() ?? result({
        databases: options.registry.listOpenDatabases(),
        selection: options.registry.getSelectionContext(),
      }),
      prepareInvocation: () => ({ invocationMessage: 'Listing open SQLite databases' }),
    },
    dbContext: {
      invoke: async ({ input }) => {
        const disabled = disabledError();
        if (disabled) {
          return disabled;
        }
        const opened = await openDatabase(input ?? {});
        if (opened.error || !opened.document || !opened.db) {
          return opened.error;
        }

        try {
          const selection = options.registry.getSelectionContext(opened.document.uri.toString());
          const contextInput = {
            ...(input ?? {}),
            objectName: input?.objectName ?? selection?.objectName,
          };
          return result({
            ...getDatabaseContext(opened.document, opened.db, contextInput) as object,
            selection,
          });
        } catch (caught) {
          return error(getErrorMessage(caught));
        } finally {
          opened.close();
        }
      },
      prepareInvocation: () => ({ invocationMessage: 'Reading SQLite schema context' }),
    },
    query: {
      invoke: async ({ input }, token) => {
        const disabled = disabledError();
        if (disabled) {
          return disabled;
        }
        if (!input?.query || !isReadOnlyQuery(input.query)) {
          return error('Only one read-only SELECT or safe WITH query is allowed.');
        }

        const opened = await openDatabase(input);
        if (opened.error || !opened.db) {
          return opened.error;
        }

        try {
          const queryOptions = options.getQueryOptions();
          const rowLimit = Math.max(1, Math.min(500, Math.floor(queryOptions.maxResultRows || QUERY_ROW_LIMIT)));
          const timeoutMs = Math.max(100, Math.min(30_000, Math.floor(queryOptions.timeoutMs || 5_000)));
          const sensitivePatterns = compileSensitivePatterns(queryOptions.sensitiveColumnPatterns);
          const rows = executeRows(opened.db, input.query, rowLimit + 1, token, Date.now() + timeoutMs);
          const columns = rows.length > 0 ? Object.keys(rows[0]) : getColumns(opened.db, input.query);
          const redactedOutputColumns = inferRedactedOutputColumns(input.query, columns, sensitivePatterns);
          const capped = capRows(rows, rowLimit, sensitivePatterns, redactedOutputColumns);
          return result({
            queryName: input.queryName,
            columns,
            ...capped,
            rowCount: capped.rows.length,
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
    explain: {
      invoke: async ({ input }, token) => {
        const disabled = disabledError();
        if (disabled) return disabled;
        if (!input?.query || !isReadOnlyQuery(input.query)) {
          return error('Only one read-only SELECT or safe WITH query can be explained.');
        }
        const opened = await openDatabase(input);
        if (opened.error || !opened.db) return opened.error;
        try {
          const timeoutMs = Math.max(100, options.getQueryOptions().timeoutMs);
          return result({
            queryName: input.queryName,
            plan: executeRows(opened.db, `EXPLAIN QUERY PLAN ${input.query}`, undefined, token, Date.now() + timeoutMs),
          });
        } catch (caught) {
          return error(getErrorMessage(caught));
        } finally {
          opened.close();
        }
      },
      prepareInvocation: ({ input }) => ({ invocationMessage: `Explaining SQLite query '${input.queryName}'` }),
    },
    profile: {
      invoke: async ({ input }, token) => {
        const disabled = disabledError();
        if (disabled) return disabled;
        if (!input?.objectName) return error('objectName is required.');
        const opened = await openDatabase(input);
        if (opened.error || !opened.db) return opened.error;
        try {
          if (!getSchemaObjects(opened.db, input.objectName)[0]) {
            return error(`SQLite object '${input.objectName}' was not found.`);
          }
          const deadline = Date.now() + Math.max(100, options.getQueryOptions().timeoutMs);
          const rowCount = getRowCount(opened.db, input.objectName, token, deadline);
          const columns = getColumnsInfo(opened.db, input.objectName).map((column) => {
            const name = String((column as { name: unknown }).name);
            const quoted = quoteIdentifier(name);
            const stats = executeRows(
              opened.db!,
              `SELECT COUNT(*) - COUNT(${quoted}) AS nullCount, COUNT(DISTINCT ${quoted}) AS distinctCount FROM ${quoteIdentifier(input.objectName)}`,
              1,
              token,
              deadline,
            )[0] ?? {};
            return { name, nullCount: Number(stats.nullCount ?? 0), distinctCount: Number(stats.distinctCount ?? 0) };
          });
          return result({ databaseUri: opened.document?.uri.toString(), objectName: input.objectName, rowCount, columns });
        } catch (caught) {
          return error(getErrorMessage(caught));
        } finally {
          opened.close();
        }
      },
      prepareInvocation: ({ input }) => ({ invocationMessage: `Profiling SQLite object '${input.objectName}'` }),
    },
    modify: {
      invoke: async ({ input }, token) => {
        const disabled = disabledError();
        if (disabled) {
          return disabled;
        }
        if (options.getAccessMode() !== 'rw') {
          return error('Read/write Copilot tools are disabled. Set databaseEditor.copilot.accessMode to "rw" to enable confirmed modifications.');
        }
        if (!input?.statement || !isAllowedModification(input.statement)) {
          return error('Only one INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, or DROP statement is allowed.');
        }
        if (token?.isCancellationRequested) {
          return error('SQLite operation was cancelled.');
        }

        const opened = await openDatabase(input);
        if (opened.error || !opened.document || !opened.db) {
          return opened.error;
        }

        let transactionStarted = false;
        try {
          throwIfCancelled(token);
          opened.db.run('BEGIN IMMEDIATE');
          transactionStarted = true;
          throwIfCancelled(token);
          opened.db.run(input.statement);
          const changes = opened.db.getRowsModified?.();
          throwIfCancelled(token);
          opened.db.run('COMMIT');
          transactionStarted = false;
          throwIfCancelled(token);
          const data = opened.db.export();
          throwIfCancelled(token);
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
          if (transactionStarted) {
            try {
              opened.db.run('ROLLBACK');
            } catch {
              // The original error is more useful than a best-effort rollback failure.
            }
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
            `Execute modification **${escapeMarkdown(input.statementName)}**?\n\n`
            + `**Database:** ${describeDatabaseTarget(options.registry, input.databaseUri)}\n\n`
            + `${escapeMarkdown(input.statementDescription)}\n\n`
            + formatSqlCodeBlock(input.statement),
          ),
        },
      }),
    },
    migrate: {
      invoke: async ({ input }, token) => {
        const disabled = disabledError();
        if (disabled) return disabled;
        if (options.getAccessMode() !== 'rw') {
          return error('Read/write Copilot tools are disabled. Set databaseEditor.copilot.accessMode to "rw" to enable confirmed migrations.');
        }
        if (!Array.isArray(input?.statements) || input.statements.length === 0 || input.statements.length > 50
          || input.statements.some((statement) => !isAllowedModification(statement))) {
          return error('A migration requires 1-50 individually valid modification statements. Transaction statements are not allowed.');
        }
        if (token?.isCancellationRequested) {
          return error('SQLite operation was cancelled.');
        }
        const opened = await openDatabase(input);
        if (opened.error || !opened.document || !opened.db) return opened.error;
        let transactionStarted = false;
        try {
          throwIfCancelled(token);
          opened.db.run('BEGIN IMMEDIATE');
          transactionStarted = true;
          for (const statement of input.statements) {
            throwIfCancelled(token);
            opened.db.run(statement);
          }
          throwIfCancelled(token);
          opened.db.run('COMMIT');
          transactionStarted = false;
          throwIfCancelled(token);
          const data = opened.db.export();
          throwIfCancelled(token);
          await options.registry.applyCopilotDatabaseChange(
            opened.document,
            data,
            `Copilot migration: ${input.migrationName}`,
          );
          return result({ success: true, statementCount: input.statements.length, databaseUri: opened.document.uri.toString() });
        } catch (caught) {
          if (transactionStarted) {
            try { opened.db.run('ROLLBACK'); } catch { /* Preserve the original error. */ }
          }
          return error(getErrorMessage(caught));
        } finally {
          opened.close();
        }
      },
      prepareInvocation: ({ input }) => ({
        invocationMessage: `Running SQLite migration '${input.migrationName}'`,
        confirmationMessages: {
          title: 'SQLite: Apply Migration',
          message: new options.vscode.MarkdownString(
            `Apply migration **${escapeMarkdown(input.migrationName)}** to ${describeDatabaseTarget(options.registry, input.databaseUri)}?\n\n`
            + `${escapeMarkdown(input.migrationDescription)}\n\n`
            + input.statements.map((statement, index) => `**${index + 1}.**\n\n${formatSqlCodeBlock(statement)}`).join('\n\n'),
          ),
        },
      }),
    },
  };
}

function getDatabaseContext(document: SqliteToolDocument, db: SqlJsDatabase, input: DbContextInput): unknown {
  const objects = getSchemaObjects(db, input.objectName);
  const database = {
    uri: document.uri.toString(),
    name: basename(document.uri.toString()),
  };
  if (!input.objectName) {
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const page = objects.slice(offset, offset + limit).map(({ name, type }) => ({ name, type }));
    const nextOffset = offset + page.length;
    return {
      database,
      totalObjects: objects.length,
      offset,
      limit,
      truncated: nextOffset < objects.length,
      nextOffset: nextOffset < objects.length ? nextOffset : undefined,
      objects: page,
    };
  }

  return {
    database,
    totalObjects: objects.length,
    truncated: false,
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

function getRowCount(
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

function executeRows(
  db: SqlJsDatabase,
  sql: string,
  rowLimit?: number,
  token?: vscode.CancellationToken,
  deadline?: number,
): Record<string, unknown>[] {
  const statement = db.prepare(sql);
  const rows: Record<string, unknown>[] = [];
  try {
    while (true) {
      if (token?.isCancellationRequested) {
        throw new Error('SQLite query was cancelled.');
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error('SQLite query exceeded its execution time limit.');
      }
      if (!statement.step()) {
        break;
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

function inferRedactedOutputColumns(sql: string, columns: string[], sensitivePatterns: RegExp[]): Set<string> {
  const redacted = new Set<string>();
  const selectList = extractSelectList(sql);
  if (!selectList) {
    return redacted;
  }

  const expressions = splitTopLevelComma(selectList);
  columns.forEach((column, index) => {
    const expression = expressions[index];
    if (expression && expressionReferencesSensitiveColumn(expression, sensitivePatterns)) {
      redacted.add(column);
    }
  });
  return redacted;
}

function extractSelectList(sql: string): string | undefined {
  const match = /^\s*select\s+([\s\S]+?)\s+from\b/i.exec(sql);
  return match?.[1];
}

function splitTopLevelComma(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote) {
        if (value[index + 1] === quote) {
          current += value[index + 1];
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (character === '\'' || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function expressionReferencesSensitiveColumn(expression: string, sensitivePatterns: RegExp[]): boolean {
  const sourceExpression = expression
    .replace(/\s+as\s+[^\s]+$/i, '')
    .replace(/\s+[^\s]+$/i, '');
  const withoutStrings = sourceExpression.replace(/'([^']|'')*'|"([^"]|"")*"/g, ' ');
  return sensitivePatterns.some((pattern) => pattern.test(withoutStrings));
}

function throwIfCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) {
    throw new Error('SQLite operation was cancelled.');
  }
}

function compileSensitivePatterns(patterns: string[]): RegExp[] {
  return patterns.flatMap((pattern) => {
    try {
      return [new RegExp(pattern, 'i')];
    } catch {
      return [];
    }
  });
}

function getColumns(db: SqlJsDatabase, sql: string): string[] {
  const statement = db.prepare(sql);
  try {
    return statement.getColumnNames();
  } finally {
    statement.free();
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function formatSqlCodeBlock(sql: string): string {
  const trimmed = sql.trim();
  const longestBacktickRun = Math.max(0, ...trimmed.match(/`+/g)?.map((match) => match.length) ?? []);
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}sql\n${trimmed}\n${fence}`;
}

function escapeMarkdown(value: string): string {
  return String(value).replace(/[\\`*_{}\[\]()#+\-!|>]/g, '\\$&');
}

function describeDatabaseTarget(registry: SqliteToolRegistry, requestedUri?: string): string {
  const databases = registry.listOpenDatabases();
  const database = requestedUri
    ? databases.find((candidate) => candidate.uri === requestedUri)
    : databases.length === 1 ? databases[0] : undefined;
  const uri = database?.uri ?? requestedUri ?? 'an explicitly selected database';
  return database
    ? `**${escapeMarkdown(database.name)}** (\`${escapeMarkdown(uri)}\`)`
    : `\`${escapeMarkdown(uri)}\``;
}

function basename(uri: string): string {
  const slashIndex = uri.lastIndexOf('/');
  return slashIndex === -1 ? uri : decodeURIComponent(uri.slice(slashIndex + 1));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
