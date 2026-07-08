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

type OpenSqliteDocument<TDocument extends RegistrySqliteDocument> = {
  document: TDocument;
  panels: Set<vscode.WebviewPanel>;
  lastActiveAt: number;
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

  getPanels(document: TDocument): vscode.WebviewPanel[] {
    return [...(this.openDocuments.get(document.uri.toString())?.panels ?? [])];
  }
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}
