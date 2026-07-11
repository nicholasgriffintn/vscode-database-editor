import type * as vscode from 'vscode';

import { escapeMarkdown } from '../../utilities/markdown';
import { basenameFromUri } from '../../utilities/path';
import type { SqlJsDatabase } from '../../sqljs-host';
import { quoteIdentifier } from '../../sql-safety';
import type { SqliteSelectionContext } from '../../sqlite-document-registry';
import {
  executeRows,
  getColumnsInfo,
  getIndexes,
  getRowCount,
  getSchemaObjects,
  getTriggers,
} from '../../sqlite-schema';

export type DbContextInput = {
  databaseUri?: string;
  objectName?: string;
  offset?: number;
  limit?: number;
};

export type ToolDocument = {
  readonly uri: { toString(): string };
};

type ToolSelectionContext = SqliteSelectionContext | {
  databaseUri?: string;
  objectName?: string;
  objectType?: 'table' | 'view';
  hasFilter?: boolean;
  filteredColumns?: string[];
  sortColumn?: string;
  sortDirection?: 'asc' | 'desc';
  selectedColumns?: string[];
  selectedRowCount?: number;
  selectedRowNumbers?: number[];
  selectedRowScope?: 'visibleRows';
  filter?: unknown;
  columnFilters?: Record<string, unknown>;
};

export function sanitizeSelectionContext(selection: ToolSelectionContext | undefined): ToolSelectionContext | undefined {
  if (!selection) {
    return undefined;
  }

  const legacySelection = selection as ToolSelectionContext & {
    filter?: unknown;
    columnFilters?: Record<string, unknown>;
  };
  const filteredColumns = selection.filteredColumns
    ?? (legacySelection.columnFilters
      ? Object.entries(legacySelection.columnFilters)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([column]) => column)
        .sort((left, right) => left.localeCompare(right))
      : undefined);

  const result: ToolSelectionContext = {
    ...(selection.databaseUri !== undefined ? { databaseUri: selection.databaseUri } : {}),
    ...(selection.objectName ? { objectName: selection.objectName } : {}),
    ...(selection.objectType ? { objectType: selection.objectType } : {}),
    ...(selection.hasFilter || legacySelection.filter ? { hasFilter: true } : {}),
    ...(filteredColumns?.length ? { filteredColumns: [...filteredColumns] } : {}),
    ...(selection.sortColumn ? { sortColumn: selection.sortColumn, sortDirection: selection.sortDirection } : {}),
    ...(selection.selectedColumns?.length ? { selectedColumns: [...selection.selectedColumns] } : {}),
    ...(selection.selectedRowCount ? { selectedRowCount: selection.selectedRowCount } : {}),
    ...(selection.selectedRowNumbers?.length ? { selectedRowNumbers: [...selection.selectedRowNumbers] } : {}),
    ...(selection.selectedRowScope ? { selectedRowScope: selection.selectedRowScope } : {}),
  };

  return result;
}

export function getDatabaseContext(
  document: ToolDocument,
  db: SqlJsDatabase,
  input: DbContextInput,
): unknown {
  return {
    database: {
      uri: input.databaseUri ?? document.uri.toString(),
      name: basenameFromUri(document.uri.toString()),
    },
    ...getDatabaseMetadataContext(db, input),
  };
}

export function getDatabaseMetadataContext(
  db: SqlJsDatabase,
  input: Omit<DbContextInput, 'databaseUri'>,
): Record<string, unknown> {
  const objects = getSchemaObjects(db, input.objectName);

  if (!input.objectName) {
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const page = objects.slice(offset, offset + limit).map(({ name, type }) => ({ name, type }));
    const nextOffset = offset + page.length;
    return {
      totalObjects: objects.length,
      offset,
      limit,
      truncated: nextOffset < objects.length,
      nextOffset: nextOffset < objects.length ? nextOffset : undefined,
      objects: page,
    };
  }

  return {
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

export type OpenDatabaseSummaryLite = {
  uri: string;
  name: string;
};

export interface DatabaseRegistry {
  listOpenDatabases(): OpenDatabaseSummaryLite[];
}

export function describeDatabaseTarget(registry: DatabaseRegistry, requestedUri?: string): string {
  const databases = registry.listOpenDatabases();
  const database = requestedUri
    ? databases.find((candidate) => candidate.uri === requestedUri)
    : databases.length === 1 ? databases[0] : undefined;
  const uri = database?.uri ?? requestedUri ?? 'an explicitly selected database';
  return database
    ? `**${escapeMarkdown(database.name)}** (\`${escapeMarkdown(uri)}\`)`
    : `\`${escapeMarkdown(uri)}\``;
}
