import * as vscode from 'vscode';

import { applySnapshotDocumentChange } from './custom-document-history';
import type { SnapshotChangeEvent } from './custom-document-history';
import { readEditorSettings } from './editor-settings';
import type { EditorSettings } from './editor-settings';
import { SqliteDocument } from './sqlite-document';
import { createSqliteChatParticipant, createSqliteFollowupProvider } from './sqlite-ai/chat-participant';
import { SqliteDocumentRegistry } from './sqlite-ai/sqlite-document-registry';
import type { SqliteSelectionContext, SqliteSelectionUpdate } from './sqlite-ai/sqlite-document-registry';
import { loadSqlJs } from './sqlite-ai/sqljs-host';
import { createSqliteTools } from './sqlite-ai/tools';

const viewType = 'databaseEditor.sqlite';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SqliteEditorProvider(context);
  const getCopilotEnabled = () => vscode.workspace
    .getConfiguration('databaseEditor.copilot')
    .get('enable', true);
  const getAccessMode = () => vscode.workspace
    .getConfiguration('databaseEditor.copilot')
    .get<'ro' | 'rw'>('accessMode', 'ro');
  const getQueryOptions = () => {
    const configuration = vscode.workspace.getConfiguration('databaseEditor.copilot');
    return {
      maxResultRows: configuration.get('maxResultRows', 200),
      timeoutMs: configuration.get('queryTimeoutMs', 5_000),
      sensitiveColumnPatterns: configuration.get<string[]>('sensitiveColumnPatterns', [
        'password',
        'passwd',
        'token',
        'secret',
        'api[_-]?key',
        'ssn',
      ]),
    };
  };
  const tools = createSqliteTools({
    vscode,
    registry: provider,
    extensionUri: context.extensionUri,
    loadSqlJs,
    getAccessMode,
    getCopilotEnabled,
    getQueryOptions,
  });
  const sqliteParticipant = vscode.chat.createChatParticipant(
    'database-editor.sqlite-chat',
    createSqliteChatParticipant({
      vscode,
      registry: provider,
      getAccessMode,
      getCopilotEnabled,
    }),
  );
  sqliteParticipant.followupProvider = createSqliteFollowupProvider();

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
    vscode.commands.registerCommand('databaseEditor.copilot.chatWithDatabase', async () => {
      if (!getCopilotEnabled()) {
        await vscode.window.showWarningMessage('Copilot integration is disabled.');
        return;
      }

      const databaseUri = provider.getActiveDocumentUri();
      const databaseHint = databaseUri ? ` Use databaseUri "${databaseUri}".` : '';
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@sqlite /schema Inspect the active SQLite database.${databaseHint} Summarize the selected object or schema and await further instructions.`,
      });
    }),
    vscode.lm.registerTool('databaseEditor_list_open_databases', tools.listOpenDatabases),
    vscode.lm.registerTool('databaseEditor_db_context', tools.dbContext),
    vscode.lm.registerTool('databaseEditor_query', tools.query),
    vscode.lm.registerTool('databaseEditor_explain', tools.explain),
    vscode.lm.registerTool('databaseEditor_profile', tools.profile),
    vscode.lm.registerTool('databaseEditor_modify', tools.modify),
    vscode.lm.registerTool('databaseEditor_migrate', tools.migrate),
    sqliteParticipant,
  );
}

export function deactivate(): void {
  // VS Code disposes registered providers through the extension context.
}

class SqliteEditorProvider implements vscode.CustomEditorProvider<SqliteDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<SnapshotChangeEvent<SqliteDocument>>();
  private readonly registry = new SqliteDocumentRegistry<SqliteDocument>();

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
    this.registry.registerPanel(document, webviewPanel);

    const configurationSubscription = vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('databaseEditor', document.uri)) {
        await webview.postMessage({
          type: 'settingsChanged',
          settings: this.getEditorSettings(document.uri),
        });
      }
    });
    webviewPanel.onDidDispose(() => configurationSubscription.dispose());

    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'ready':
          await this.postDocument(webviewPanel, document);
          break;
        case 'databaseChanged':
          await this.applyDatabaseChange(document, new Uint8Array(message.data), message.label);
          break;
        case 'copilotSelectionChanged':
          this.registry.updateSelectionContext(document, message.context);
          break;
        case 'requestSave':
          try {
            await vscode.commands.executeCommand('workbench.action.files.save');
          } catch (error) {
            const message = getErrorMessage(error);
            await webview.postMessage({ type: 'databaseSaveFailed', message });
            await vscode.window.showErrorMessage(message);
          }
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
        case 'clipboardWrite':
          await vscode.env.clipboard.writeText(message.text);
          break;
        case 'clipboardRead':
          await webview.postMessage({
            type: 'clipboardText',
            requestId: message.requestId,
            text: await vscode.env.clipboard.readText(),
          });
          break;
        case 'undo':
          await vscode.commands.executeCommand('undo');
          break;
        case 'redo':
          await vscode.commands.executeCommand('redo');
          break;
      }
    });
  }

  async saveCustomDocument(document: SqliteDocument, cancellation?: vscode.CancellationToken): Promise<void> {
    if (cancellation?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const savedData = document.getData();
    await vscode.workspace.fs.writeFile(document.uri, savedData);
    document.markSaved(savedData);
    await this.postToDocumentPanels(document, {
      type: 'databaseSaved',
      dirty: document.isDirty(),
    });
  }

  async saveCustomDocumentAs(
    document: SqliteDocument,
    destination: vscode.Uri,
    cancellation?: vscode.CancellationToken,
  ): Promise<void> {
    if (cancellation?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const savedData = document.getData();
    await vscode.workspace.fs.writeFile(destination, savedData);
    document.markSaved(savedData);
    await this.postToDocumentPanels(document, {
      type: 'databaseSaved',
      dirty: document.isDirty(),
    });
  }

  async revertCustomDocument(document: SqliteDocument): Promise<void> {
    await document.reload();
    await this.postToDocumentPanels(document, {
      type: 'loadDatabase',
      name: vscode.workspace.asRelativePath(document.uri),
      data: toArrayBuffer(document.getData()),
      settings: this.getEditorSettings(document.uri),
      dirty: false,
      resetViewState: false,
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

  listOpenDatabases() {
    return this.registry.listOpenDatabases();
  }

  resolveDocument(uri?: string): SqliteDocument | undefined {
    return this.registry.resolveDocument(uri);
  }

  getActiveDocumentUri(): string | undefined {
    return this.registry.getActiveDocumentUri();
  }

  getSelectionContext(uri?: string): SqliteSelectionContext | undefined {
    return this.registry.getSelectionContext(uri);
  }

  async applyCopilotDatabaseChange(document: SqliteDocument, data: Uint8Array, label: string): Promise<void> {
    await this.applyDatabaseChange(document, data, label, true);
  }

  private async postDocument(panel: vscode.WebviewPanel, document: SqliteDocument): Promise<void> {
    const settings = this.getEditorSettings(document.uri);
    const data = document.getData();
    if (settings.maxFileSizeMb > 0 && data.byteLength > settings.maxFileSizeMb * 1024 * 1024) {
      await panel.webview.postMessage({
        type: 'loadError',
        message: `Database is ${(data.byteLength / 1024 / 1024).toFixed(1)} MB, above the configured ${settings.maxFileSizeMb} MB WebAssembly load limit. Raise databaseEditor.maxFileSizeMb or set it to 0 to open this file.`,
        settings,
      });
      return;
    }

    await panel.webview.postMessage({
      type: 'loadDatabase',
      name: vscode.workspace.asRelativePath(document.uri),
      data: toArrayBuffer(data),
      settings,
      dirty: document.isDirty(),
      resetViewState: true,
    });
  }

  private async applyDatabaseChange(
    document: SqliteDocument,
    data: Uint8Array,
    label?: string,
    refreshPanels = false,
  ): Promise<void> {
    let isRegisteringNewEdit = refreshPanels;
    const postSnapshot = async (snapshot: Uint8Array): Promise<void> => {
      await this.postToDocumentPanels(document, {
        type: 'loadDatabase',
        name: vscode.workspace.asRelativePath(document.uri),
        data: toArrayBuffer(snapshot),
        settings: this.getEditorSettings(document.uri),
        dirty: document.isDirty(snapshot, { isNewEdit: isRegisteringNewEdit }),
        resetViewState: false,
      });
    };
    await applySnapshotDocumentChange({
      document,
      data,
      label: label ?? 'Edit SQLite database',
      emitEdit: (event) => this.changeEmitter.fire(event),
      postSnapshot,
      postAfterApply: refreshPanels,
      maxUndoMemoryBytes: this.getEditorSettings(document.uri).maxUndoMemoryBytes,
    });
    isRegisteringNewEdit = false;
    await this.postToDocumentPanels(document, {
      type: 'documentStateChanged',
      dirty: document.isDirty(undefined, { isNewEdit: true }),
    });
  }

  private getEditorSettings(uri: vscode.Uri): EditorSettings {
    return readEditorSettings(
      vscode.workspace.getConfiguration('databaseEditor', uri),
      uri.scheme !== 'file',
    );
  }

  private async postToDocumentPanels(document: SqliteDocument, message: ExtensionMessage): Promise<void> {
    await Promise.all(this.registry.getPanels(document).map((panel) => panel.webview.postMessage(message)));
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
    const resourceVersion = Date.now().toString(36);
    const extensionUri = this.context.extensionUri.toString();
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
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.mjs'))
      .with({ query: `v=${resourceVersion}` });
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css'))
      .with({ query: `v=${resourceVersion}` });
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
  <div id="app" data-wasm-uri="${wasmUri}" data-extension-uri="${escapeAttribute(extensionUri)}" data-resource-version="${resourceVersion}"></div>
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

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'databaseChanged'; data: ArrayBuffer; label?: string }
  | { type: 'copilotSelectionChanged'; context: SqliteSelectionUpdate }
  | { type: 'requestSave' }
  | { type: 'error'; message: string }
  | { type: 'clipboardWrite'; text: string }
  | { type: 'clipboardRead'; requestId: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | SaveTextMessage
  | SaveBinaryMessage;

type ExtensionMessage =
  | { type: 'loadDatabase'; name: string; data: ArrayBuffer; settings: EditorSettings; dirty: boolean; resetViewState: boolean }
  | { type: 'loadError'; message: string; settings: EditorSettings }
  | { type: 'settingsChanged'; settings: EditorSettings }
  | { type: 'databaseSaved'; dirty: boolean }
  | { type: 'databaseSaveFailed'; message: string }
  | { type: 'documentStateChanged'; dirty: boolean }
  | { type: 'clipboardText'; requestId: string; text: string };

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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
