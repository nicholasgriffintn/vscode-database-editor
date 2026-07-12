import type * as vscode from 'vscode';

import { basename, dirname } from './utilities/path';

export type CsvFileReadResult =
  | { status: 'completed'; name: string; content: string }
  | { status: 'cancelled' };

export async function readCsvFile({
  documentUri,
  showOpenDialog,
  readFile,
}: {
  documentUri: vscode.Uri;
  showOpenDialog: typeof vscode.window.showOpenDialog;
  readFile: typeof vscode.workspace.fs.readFile;
}): Promise<CsvFileReadResult> {
  const [source] = await showOpenDialog({
    defaultUri: documentUri.with({ path: dirname(documentUri.path) }),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'CSV files': ['csv'], 'All files': ['*'] },
    title: 'Import CSV into SQLite table',
  }) ?? [];
  if (!source) return { status: 'cancelled' };
  const bytes = await readFile(source);
  return { status: 'completed', name: basename(source.path), content: new TextDecoder().decode(bytes) };
}
