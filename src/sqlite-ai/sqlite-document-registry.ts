import type * as vscode from 'vscode';

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
  filter?: string;
  columnFilters?: Record<string, string>;
  sortColumn?: string;
  sortDirection?: 'asc' | 'desc';
  selectedColumns?: string[];
};

export type SqliteSelectionUpdate = Omit<SqliteSelectionContext, 'databaseUri'>;

type OpenSqliteDocument<TDocument extends RegistrySqliteDocument> = {
  document: TDocument;
  panels: Set<vscode.WebviewPanel>;
  lastActiveAt: number;
  selection?: SqliteSelectionUpdate;
};

export class SqliteDocumentRegistry<TDocument extends RegistrySqliteDocument> {
  private readonly openDocuments = new Map<string, OpenSqliteDocument<TDocument>>();

  registerPanel(document: TDocument, panel: vscode.WebviewPanel): void {
    const key = document.uri.toString();
    const entry = this.openDocuments.get(key) ?? {
      document,
      panels: new Set<vscode.WebviewPanel>(),
      lastActiveAt: Date.now(),
    };

    entry.document = document;
    entry.panels.add(panel);
    if (panel.active || panel.visible) {
      entry.lastActiveAt = Date.now();
    }
    this.openDocuments.set(key, entry);

    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active || event.webviewPanel.visible) {
        entry.lastActiveAt = Date.now();
      }
    });

    panel.onDidDispose(() => {
      entry.panels.delete(panel);
      if (entry.panels.size === 0) {
        this.openDocuments.delete(key);
      }
    });
  }

  listOpenDatabases(): OpenDatabaseSummary[] {
    const activeDocument = this.getActiveDocument();
    return [...this.openDocuments.values()]
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .map((entry) => ({
        uri: entry.document.uri.toString(),
        name: basename(entry.document.uri.path),
        active: entry.document === activeDocument,
      }));
  }

  resolveDocument(uri?: string): TDocument | undefined {
    if (uri) {
      return this.openDocuments.get(uri)?.document;
    }

    return this.getActiveDocument();
  }

  getActiveDocument(): TDocument | undefined {
    return [...this.openDocuments.values()]
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)[0]?.document;
  }

  getActiveDocumentUri(): string | undefined {
    return this.getActiveDocument()?.uri.toString();
  }

  updateSelectionContext(document: TDocument, selection: SqliteSelectionUpdate): void {
    const entry = this.openDocuments.get(document.uri.toString());
    if (entry) {
      entry.selection = {
        ...selection,
        columnFilters: selection.columnFilters ? { ...selection.columnFilters } : undefined,
      };
    }
  }

  getSelectionContext(uri?: string): SqliteSelectionContext | undefined {
    const document = this.resolveDocument(uri);
    if (!document) {
      return undefined;
    }

    const selection = this.openDocuments.get(document.uri.toString())?.selection;
    return {
      databaseUri: document.uri.toString(),
      ...selection,
      columnFilters: selection?.columnFilters ? { ...selection.columnFilters } : undefined,
    };
  }

  getPanels(document: TDocument): vscode.WebviewPanel[] {
    return [...(this.openDocuments.get(document.uri.toString())?.panels ?? [])];
  }
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}
