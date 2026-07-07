import * as vscode from 'vscode';

import { cloneData, createSnapshotEditEvent } from './custom-document-history';

const viewType = 'databaseEditor.sqlite';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SqliteEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('databaseEditor.openAsSqlite', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        await vscode.window.showWarningMessage('Select a SQLite database file first.');
        return;
      }

      await vscode.commands.executeCommand('vscode.openWith', target, viewType);
    }),
    vscode.commands.registerCommand('databaseEditor.save', async () => {
      await vscode.commands.executeCommand('workbench.action.files.save');
    }),
  );
}

export function deactivate(): void {
  // VS Code disposes registered providers through the extension context.
}

class SqliteDocument implements vscode.CustomDocument {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private data: Uint8Array;

  readonly onDidDispose = this.changeEmitter.event;

  private constructor(
    readonly uri: vscode.Uri,
    initialData: Uint8Array,
  ) {
    this.data = initialData;
  }

  static async create(uri: vscode.Uri, backupUri?: vscode.Uri): Promise<SqliteDocument> {
    return new SqliteDocument(uri, await vscode.workspace.fs.readFile(backupUri ?? uri));
  }

  getData(): Uint8Array {
    return this.data;
  }

  updateData(data: Uint8Array): void {
    this.data = data;
  }

  async reload(): Promise<void> {
    this.data = await vscode.workspace.fs.readFile(this.uri);
  }

  dispose(): void {
    this.changeEmitter.fire();
    this.changeEmitter.dispose();
  }
}

class SqliteEditorProvider implements vscode.CustomEditorProvider<SqliteDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SqliteDocument>>();
  private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();

  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
  ): Promise<SqliteDocument> {
    return SqliteDocument.create(uri, openContext.backupId ? vscode.Uri.parse(openContext.backupId) : undefined);
  }

  async resolveCustomEditor(
    document: SqliteDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    webview.html = this.getHtml(webview);
    this.trackPanel(document, webviewPanel);

    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'ready':
          await this.postDocument(webviewPanel, document);
          break;
        case 'databaseChanged':
          await this.applyDatabaseChange(document, new Uint8Array(message.data), message.label);
          break;
        case 'requestSave':
          await vscode.commands.executeCommand('workbench.action.files.save');
          break;
        case 'error':
          await vscode.window.showErrorMessage(message.message);
          break;
        case 'saveText':
          await this.saveTextDocument(document, message);
          break;
        case 'saveBinary':
          await this.saveBinaryDocument(document, message);
          break;
      }
    });
  }

  async saveCustomDocument(document: SqliteDocument, cancellation?: vscode.CancellationToken): Promise<void> {
    await vscode.workspace.fs.writeFile(document.uri, document.getData());
    await this.postToDocumentPanels(document, { type: 'databaseSaved' });
  }

  async saveCustomDocumentAs(document: SqliteDocument, destination: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.writeFile(destination, document.getData());
    await this.postToDocumentPanels(document, { type: 'databaseSaved' });
  }

  async revertCustomDocument(document: SqliteDocument): Promise<void> {
    await document.reload();
    await this.postToDocumentPanels(document, {
      type: 'loadDatabase',
      name: vscode.workspace.asRelativePath(document.uri),
      data: toArrayBuffer(document.getData()),
    });
  }

  async backupCustomDocument(
    document: SqliteDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(context.destination, document.getData());
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // Backups are best-effort; VS Code may already have removed the file.
        }
      },
    };
  }

  private trackPanel(document: SqliteDocument, panel: vscode.WebviewPanel): void {
    const key = document.uri.toString();
    const panels = this.panels.get(key) ?? new Set<vscode.WebviewPanel>();
    panels.add(panel);
    this.panels.set(key, panels);

    panel.onDidDispose(() => {
      panels.delete(panel);
      if (panels.size === 0) {
        this.panels.delete(key);
      }
    });
  }

  private async postDocument(panel: vscode.WebviewPanel, document: SqliteDocument): Promise<void> {
    await panel.webview.postMessage({
      type: 'loadDatabase',
      name: vscode.workspace.asRelativePath(document.uri),
      data: toArrayBuffer(document.getData()),
    });
  }

  private async applyDatabaseChange(document: SqliteDocument, data: Uint8Array, label?: string): Promise<void> {
    const before = cloneData(document.getData());
    document.updateData(data);
    this.changeEmitter.fire(createSnapshotEditEvent({
      document,
      before,
      after: data,
      label: label ?? 'Edit SQLite database',
      postSnapshot: async (snapshot) => {
        await this.postToDocumentPanels(document, {
          type: 'loadDatabase',
          name: vscode.workspace.asRelativePath(document.uri),
          data: toArrayBuffer(snapshot),
        });
      },
    }));
  }

  private async postToDocumentPanels(document: SqliteDocument, message: ExtensionMessage): Promise<void> {
    const panels = this.panels.get(document.uri.toString());
    if (!panels) {
      return;
    }

    await Promise.all([...panels].map((panel) => panel.webview.postMessage(message)));
  }

  private async saveTextDocument(document: SqliteDocument, message: SaveTextMessage): Promise<void> {
    const defaultUri = document.uri.with({ path: `${dirname(document.uri.path)}/${message.fileName}` });
    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      filters: message.kind === 'csv'
        ? { 'CSV files': ['csv'], 'All files': ['*'] }
        : { 'SQL files': ['sql'], 'All files': ['*'] },
    });

    if (!destination) {
      return;
    }

    await vscode.workspace.fs.writeFile(destination, Buffer.from(message.content, 'utf8'));
    await vscode.window.showInformationMessage(`Exported ${message.fileName}.`);
  }

  private async saveBinaryDocument(document: SqliteDocument, message: SaveBinaryMessage): Promise<void> {
    const defaultUri = document.uri.with({ path: `${dirname(document.uri.path)}/${message.fileName}` });
    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'All files': ['*'] },
    });

    if (!destination) {
      return;
    }

    await vscode.workspace.fs.writeFile(destination, new Uint8Array(message.content));
    await vscode.window.showInformationMessage(`Exported ${message.fileName}.`);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const sqlJsUri = webview.asWebviewUri(vscode.Uri.joinPath(
      this.context.extensionUri,
      'media',
      'vendor',
      'sqljs',
      'sql-wasm.js',
    ));
    const wasmUri = webview.asWebviewUri(vscode.Uri.joinPath(
      this.context.extensionUri,
      'media',
      'vendor',
      'sqljs',
      'sql-wasm.wasm',
    ));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.mjs'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource}`,
      `img-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
  <title>SQLite Database Editor</title>
</head>
<body>
  <div id="app" data-wasm-uri="${wasmUri}"></div>
  <script nonce="${nonce}" src="${sqlJsUri}"></script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'databaseChanged'; data: ArrayBuffer; label?: string }
  | { type: 'requestSave' }
  | { type: 'error'; message: string }
  | SaveTextMessage
  | SaveBinaryMessage;

type ExtensionMessage =
  | { type: 'loadDatabase'; name: string; data: ArrayBuffer }
  | { type: 'databaseSaved' };

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

type SaveTextMessage = {
  type: 'saveText';
  kind: 'csv' | 'sql';
  fileName: string;
  content: string;
};

type SaveBinaryMessage = {
  type: 'saveBinary';
  kind: 'blob';
  fileName: string;
  content: ArrayBuffer;
};

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}
