import type * as vscode from 'vscode';

import { basename } from '../utilities/path';

export interface RegistrySqliteDocument {
  readonly uri: vscode.Uri;
  getData(): Uint8Array;
}

export type OpenDatabaseSummary = {
  uri: string;
  name: string;
  active: boolean;
};

export type SqliteSelectionContext = {
  databaseUri: string;
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
};

export type SqliteSelectionUpdate = Omit<SqliteSelectionContext, 'databaseUri'>;

type OpenSqliteDocument<TDocument extends RegistrySqliteDocument> = {
  document: TDocument;
  panels: Set<vscode.WebviewPanel>;
  lastActivationSequence: number;
  selection?: SqliteSelectionUpdate;
  handle: string;
};

export class SqliteDocumentRegistry<TDocument extends RegistrySqliteDocument> {
  private readonly openDocuments = new Map<string, OpenSqliteDocument<TDocument>>();
  private readonly uriToHandle = new Map<string, string>();
  private readonly handleToUri = new Map<string, string>();
  private nextActivationSequence = 0;
  private nextHandleSequence = 0;
  private activePanel?: vscode.WebviewPanel;

  registerPanel(document: TDocument, panel: vscode.WebviewPanel): void {
    const key = document.uri.toString();
    const existingHandle = this.uriToHandle.get(key);
    const handle = existingHandle ?? this.createDocumentHandle();

    const entry = this.openDocuments.get(key) ?? {
      document,
      panels: new Set<vscode.WebviewPanel>(),
      lastActivationSequence: this.allocateActivationSequence(),
      handle,
    };

    entry.document = document;
    entry.panels.add(panel);
    entry.lastActivationSequence = this.allocateActivationSequence();

    if (!this.uriToHandle.has(key)) {
      this.uriToHandle.set(key, handle);
      this.handleToUri.set(handle, key);
    }

    this.openDocuments.set(key, entry);

    if (panel.active) {
      this.updateActivePanel(panel, entry);
    }

    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        this.updateActivePanel(event.webviewPanel, entry);
      } else if (this.activePanel === event.webviewPanel) {
        this.activePanel = undefined;
      }
    });

    panel.onDidDispose(() => {
      entry.panels.delete(panel);
      if (this.activePanel === panel) {
        this.activePanel = undefined;
      }
      if (entry.panels.size === 0) {
        this.openDocuments.delete(key);
        if (entry.handle) {
          this.uriToHandle.delete(key);
          this.handleToUri.delete(entry.handle);
        }
      }
    });
  }

  listOpenDatabases(): OpenDatabaseSummary[] {
    const activeDocument = this.getActiveDocument();
    return [...this.openDocuments.values()]
      .sort((left, right) => {
        if (left.document === activeDocument) {
          return -1;
        }
        if (right.document === activeDocument) {
          return 1;
        }
        return right.lastActivationSequence - left.lastActivationSequence;
      })
      .map((entry) => ({
        uri: entry.document.uri.toString(),
        name: basename(entry.document.uri.path),
        active: entry.document === activeDocument,
      }));
  }

  resolveDocument(uri?: string): TDocument | undefined {
    if (!uri) {
      return this.getActiveDocument();
    }

    const key = this.openDocuments.get(uri)
      ? uri
      : this.handleToUri.get(uri);
    return key ? this.openDocuments.get(key)?.document : undefined;
  }

  getActiveDocument(): TDocument | undefined {
    if (this.activePanel) {
      const activeEntry = this.findEntryByPanel(this.activePanel);
      if (activeEntry) {
        return activeEntry.document;
      }
      this.activePanel = undefined;
    }

    return [...this.openDocuments.values()]
      .sort((left, right) => right.lastActivationSequence - left.lastActivationSequence)[0]?.document;
  }

  getActiveDocumentUri(): string | undefined {
    return this.getActiveDocument()?.uri.toString();
  }

  getActiveDocumentHandle(): string | undefined {
    return this.getActiveDocumentUri() ? this.getDatabaseHandle(this.getActiveDocumentUri()!) : undefined;
  }

  getDatabaseHandle(uri: string): string | undefined {
    return this.uriToHandle.get(uri);
  }

  getDatabaseHandleBySummaryUri(uriOrHandle: string): string | undefined {
    if (this.uriToHandle.has(uriOrHandle)) {
      return this.uriToHandle.get(uriOrHandle);
    }
    const uri = this.handleToUri.get(uriOrHandle);
    return uri ? this.uriToHandle.get(uri) : undefined;
  }

  updateSelectionContext(document: TDocument, selection: SqliteSelectionUpdate): void {
    const key = document.uri.toString();
    const entry = this.openDocuments.get(key);
    if (entry) {
      entry.selection = {
        ...selection,
        ...(selection.filteredColumns ? { filteredColumns: [...selection.filteredColumns] } : {}),
        ...(selection.selectedColumns ? { selectedColumns: [...selection.selectedColumns] } : {}),
        ...(selection.selectedRowNumbers ? { selectedRowNumbers: [...selection.selectedRowNumbers] } : {}),
      };
    }
  }

  getSelectionContext(uri?: string): SqliteSelectionContext | undefined {
    const document = this.resolveDocument(uri);
    if (!document) {
      return undefined;
    }

    const documentUri = document.uri.toString();
    const selection = this.openDocuments.get(documentUri)?.selection;
    const filteredColumns = selection?.filteredColumns;
    const selectedColumns = selection?.selectedColumns;
    const selectedRowNumbers = selection?.selectedRowNumbers;
    return {
      databaseUri: documentUri,
      ...selection,
      ...(filteredColumns
        ? { filteredColumns: [...filteredColumns] }
        : {}),
      ...(selectedColumns
        ? { selectedColumns: [...selectedColumns] }
        : {}),
      ...(selectedRowNumbers
        ? { selectedRowNumbers: [...selectedRowNumbers] }
        : {}),
    };
  }

  getPanels(document: TDocument): vscode.WebviewPanel[] {
    return [...(this.openDocuments.get(document.uri.toString())?.panels ?? [])];
  }

  private updateActivePanel(panel: vscode.WebviewPanel, entry: OpenSqliteDocument<TDocument>): void {
    this.activePanel = panel;
    entry.lastActivationSequence = this.allocateActivationSequence();
  }

  private findEntryByPanel(panel: vscode.WebviewPanel): OpenSqliteDocument<TDocument> | undefined {
    for (const entry of this.openDocuments.values()) {
      if (entry.panels.has(panel)) {
        return entry;
      }
    }
    return undefined;
  }

  private allocateActivationSequence(): number {
    this.nextActivationSequence += 1;
    return this.nextActivationSequence;
  }

  private createDocumentHandle(): string {
    this.nextHandleSequence += 1;
    return `db-${this.nextHandleSequence}`;
  }
}
