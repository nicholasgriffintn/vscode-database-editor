import type * as vscode from 'vscode';

import { getErrorMessage } from '../utilities/errors';
import { escapeMarkdown, formatSqlCodeBlock } from '../utilities/markdown';
import type { SqlJsDatabase, SqlJsStatic } from './sqljs-host';
import type { OpenDatabaseSummary, SqliteSelectionContext } from './sqlite-document-registry';
import { capRows, isAllowedModification, isReadOnlyQuery, quoteIdentifier } from './sql-safety';
import { compileSensitivePatterns, getColumns, inferRedactedOutputColumns, throwIfCancelled } from './tools/query-redaction';
import {
  DbContextInput,
  describeDatabaseTarget,
  getDatabaseContext,
  sanitizeSelectionContext,
} from './tools/database-context';
import {
  executeRows,
  getColumnsInfo,
  getRowCount,
  getSchemaObjects,
} from './tools/schema-helpers';

export type SqliteToolDocument = {
  readonly uri: { toString(): string };
  getData(): Uint8Array;
  getRevision(): number;
  getSnapshot(): { data: Uint8Array; revision: number };
};

export type SqliteToolRegistry<TDocument extends SqliteToolDocument = SqliteToolDocument> = {
  listOpenDatabases(): OpenDatabaseSummary[];
  resolveDocument(uri?: string): TDocument | undefined;
  getSelectionContext(uri?: string): SqliteSelectionContext | undefined;
  getDatabaseHandle(uri: string): string | undefined;
  applyCopilotDatabaseChange(document: TDocument, data: Uint8Array, label: string, baseRevision: number): Promise<void>;
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

export function configureDatabase(db: SqlJsDatabase): void {
  db.run('PRAGMA foreign_keys = ON');
  const value = db.exec('PRAGMA foreign_keys')[0]?.values?.[0]?.[0];
  if (Number(value) !== 1) {
    throw new Error('Could not enable SQLite foreign key enforcement for this database session.');
  }
}

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
    revision?: number;
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
    const snapshot = document.getSnapshot();
    const db = new SQL.Database(snapshot.data);
    configureDatabase(db);
    return {
      document,
      db,
      revision: snapshot.revision,
      close: () => db.close(),
    };
  }

  return {
    listOpenDatabases: {
      invoke: () => disabledError() ?? result({
        databases: options.registry.listOpenDatabases(),
        selection: sanitizeSelectionContext(options.registry.getSelectionContext()),
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
          const selection = sanitizeSelectionContext(options.registry.getSelectionContext(opened.document.uri.toString()));
          const contextInput = {
            ...(input ?? {}),
            databaseUri: input?.databaseUri ?? selection?.databaseUri,
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
          const redactedOutputColumns = inferRedactedOutputColumns(input.query, columns, sensitivePatterns, opened.db);
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
        if (opened.error || !opened.document || !opened.db || opened.revision === undefined) {
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
            opened.revision,
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
        if (opened.error || !opened.document || !opened.db || opened.revision === undefined) return opened.error;
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
            opened.revision,
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
