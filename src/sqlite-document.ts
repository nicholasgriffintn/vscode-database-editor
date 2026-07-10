import * as vscode from 'vscode';

import { SqliteDocumentState } from './sqlite-document-state';

export class SqliteDocument implements vscode.CustomDocument {
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly state: SqliteDocumentState;

  readonly onDidDispose = this.disposeEmitter.event;

  private constructor(
    readonly uri: vscode.Uri,
    initialData: Uint8Array,
    savedData: Uint8Array | null = initialData,
  ) {
    this.state = new SqliteDocumentState(initialData, savedData);
  }

  static async create(uri: vscode.Uri, backupUri?: vscode.Uri): Promise<SqliteDocument> {
    if (!backupUri) {
      return new SqliteDocument(uri, await vscode.workspace.fs.readFile(uri));
    }

    const backupData = await vscode.workspace.fs.readFile(backupUri);
    let savedData: Uint8Array | null = null;
    try {
      savedData = await vscode.workspace.fs.readFile(uri);
    } catch {
      // A hot-exit backup must remain recoverable even if the original was removed or became inaccessible.
    }
    return new SqliteDocument(uri, backupData, savedData);
  }

  getData(): Uint8Array {
    return this.state.getData();
  }

  updateData(data: Uint8Array): void {
    this.state.updateData(data);
  }

  isDirty(data?: Uint8Array, options?: { isNewEdit?: boolean }): boolean {
    return this.state.isDirty(data, options);
  }

  markSaved(data?: Uint8Array): void {
    this.state.markSaved(data);
  }

  async reload(): Promise<void> {
    this.state.replaceWithSavedData(await vscode.workspace.fs.readFile(this.uri));
  }

  dispose(): void {
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }
}
