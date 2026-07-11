import * as vscode from 'vscode';

import { applySnapshotDocumentChange } from './custom-document-history';
import type { SnapshotApplyResult, SnapshotChangeEvent } from './custom-document-history';
import {
  createDatabaseSaveFailedMessage,
  createDatabaseSavedMessage,
} from './custom-editor-protocol';
import type {
  ExportSqlMessage,
  ExtensionMessage,
  SaveBinaryMessage,
  SaveTextMessage,
  WebviewMessage,
} from './custom-editor-protocol';
import { readEditorSettings } from './editor-settings';
import type { EditorSettings } from './editor-settings';
import {
  SqlExportCancelledError,
  createBufferedSqlExportSink,
  createFileSqlExportSink,
  exportSqlDatabase,
} from './sql-export';
import { SqliteDocument } from './sqlite-document';
import { createSqliteChatParticipant, createSqliteFollowupProvider } from './sqlite-ai/chat-participant';
import { SqliteDocumentRegistry } from './sqlite-ai/sqlite-document-registry';
import type { SqliteSelectionContext, SqliteSelectionUpdate } from './sqlite-ai/sqlite-document-registry';
import { loadSqlJs } from './sqlite-ai/sqljs-host';
import { createSqliteTools } from './sqlite-ai/tools';
import { toArrayBuffer } from './utilities/binary';
import { createCopilotConfigurationReaders } from './utilities/copilot-configuration';
import { getErrorMessage } from './utilities/errors';
import { dirname } from './utilities/path';
import { createEditorWebviewHtml } from './utilities/webview-html';

const viewType = 'databaseEditor.sqlite';

export interface SqliteExtensionTestApi {
  readonly onDidPostWebviewMessage: vscode.Event<{ uri: string; message: ExtensionMessage }>;
  waitForDocument(uri: string): Promise<void>;
  waitForDocumentClosed(uri: string): Promise<void>;
  getDocumentSnapshot(uri: string): { data: Uint8Array; revision: number };
  sendWebviewMessage(uri: string, message: WebviewMessage): Promise<void>;
  saveAs(uri: string, destination: vscode.Uri): Promise<void>;
  restoreFromBackup(uri: string, destination: vscode.Uri): Promise<{ data: Uint8Array; revision: number; dirty: boolean }>;
}

export function activate(context: vscode.ExtensionContext): SqliteExtensionTestApi {
  const provider = new SqliteEditorProvider(context);
  const {
    getCopilotEnabled,
    getAccessMode,
    getQueryOptions,
  } = createCopilotConfigurationReaders(vscode.workspace);
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

      const databaseHandle = provider.getActiveDocumentHandle();
      const databaseHint = databaseHandle ? ` Use database handle "${databaseHandle}".` : '';
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

  return provider.createTestApi();
}

export function deactivate(): void {
  // VS Code disposes registered providers through the extension context.
}

class SqliteEditorProvider implements vscode.CustomEditorProvider<SqliteDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<SnapshotChangeEvent<SqliteDocument>>();
  private readonly postedMessageEmitter = new vscode.EventEmitter<{ uri: string; message: ExtensionMessage }>();
  private readonly registry = new SqliteDocumentRegistry<SqliteDocument>();
  private readonly pendingSaveRequests = new WeakMap<SqliteDocument, string>();
  private saveRequestCounter = 0;

  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  createTestApi(): SqliteExtensionTestApi {
    return {
      onDidPostWebviewMessage: this.postedMessageEmitter.event,
      waitForDocument: async (uri) => {
        await this.waitForDocumentState(uri, true);
      },
      waitForDocumentClosed: async (uri) => {
        await this.waitForDocumentState(uri, false);
      },
      getDocumentSnapshot: (uri) => this.getRequiredDocument(uri).getSnapshot(),
      sendWebviewMessage: async (uri, message) => {
        const document = this.getRequiredDocument(uri);
        const panel = this.registry.getPanels(document)[0];
        if (!panel) {
          throw new Error(`No custom editor panel is open for ${uri}`);
        }
        await this.handleWebviewMessage(document, panel, message);
      },
      saveAs: async (uri, destination) => {
        await this.saveCustomDocumentAs(this.getRequiredDocument(uri), destination);
      },
      restoreFromBackup: async (uri, destination) => {
        const document = this.getRequiredDocument(uri);
        const backup = await this.backupCustomDocument(document, { destination });
        const restored = await this.openCustomDocument(document.uri, {
          backupId: backup.id,
          untitledDocumentData: undefined,
        });
        const snapshot = restored.getSnapshot();
        const result = { ...snapshot, dirty: restored.isDirty() };
        restored.dispose();
        await backup.delete();
        return result;
      },
    };
  }

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

    webview.html = createEditorWebviewHtml(webview, this.context.extensionUri);
    this.registry.registerPanel(document, webviewPanel);

    const configurationSubscription = vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('databaseEditor', document.uri)) {
        await this.postWebviewMessage(document, webviewPanel, {
          type: 'settingsChanged',
          settings: this.getEditorSettings(document.uri),
        });
      }
    });
    webviewPanel.onDidDispose(() => configurationSubscription.dispose());

    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this.handleWebviewMessage(document, webviewPanel, message);
    });
  }

  private async handleWebviewMessage(
    document: SqliteDocument,
    webviewPanel: vscode.WebviewPanel,
    message: WebviewMessage,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    switch (message.type) {
        case 'ready':
          await this.postDocument(webviewPanel, document);
          break;
        case 'databaseChanged': {
          const result = await this.applyDatabaseChange(
            document,
            new Uint8Array(message.data),
            message.label,
            false,
            message.baseRevision,
          );
          if (!result.accepted) {
            await this.postDocument(webviewPanel, document, false);
          } else {
            await this.postDocumentToSiblingPanels(document, webviewPanel);
          }
          break;
        }
        case 'copilotSelectionChanged':
          this.registry.updateSelectionContext(document, message.context);
          break;
        case 'requestSave':
          try {
            this.pendingSaveRequests.set(document, message.requestId);
            const savedUri = await vscode.workspace.save(document.uri);
            if (!savedUri && this.pendingSaveRequests.has(document)) {
              throw new Error('Save was cancelled.');
            }
          } catch (error) {
            this.pendingSaveRequests.delete(document);
            const failure = createDatabaseSaveFailedMessage(error, document.getRevision(), message.requestId);
            await this.postWebviewMessage(document, webviewPanel, failure);
            void vscode.window.showErrorMessage(failure.message);
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
        case 'exportSql':
          await this.exportSqlDocument(document, webviewPanel, message);
          break;
        case 'clipboardWrite':
          await vscode.env.clipboard.writeText(message.text);
          break;
        case 'clipboardRead':
          await this.postWebviewMessage(document, webviewPanel, {
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
  }

  async saveCustomDocument(
    document: SqliteDocument,
    cancellation?: vscode.CancellationToken,
    options: { requestId?: string } = {},
  ): Promise<void> {
    if (cancellation?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const requestId = options.requestId
      ?? this.pendingSaveRequests.get(document)
      ?? this.createSaveRequestId('save');
    this.pendingSaveRequests.delete(document);
    const snapshot = document.getSnapshot();
    await vscode.workspace.fs.writeFile(document.uri, snapshot.data);
    await document.enqueueMutation(async () => {
      document.markSaved(snapshot.data);
      const hasNewerRevision = document.getRevision() !== snapshot.revision;
      await this.postToDocumentPanels(document, createDatabaseSavedMessage({
        dirty: document.isDirty(),
        savedRevision: snapshot.revision,
        currentRevision: document.getRevision(),
        requestId,
      }));
      if (hasNewerRevision) {
        setTimeout(() => this.changeEmitter.fire({ document }), 0);
      }
    });
  }

  async saveCustomDocumentAs(
    document: SqliteDocument,
    destination: vscode.Uri,
    cancellation?: vscode.CancellationToken,
    options: { requestId?: string } = {},
  ): Promise<void> {
    if (cancellation?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const requestId = options.requestId ?? this.createSaveRequestId('saveAs');
    const snapshot = document.getSnapshot();
    await vscode.workspace.fs.writeFile(destination, snapshot.data);
    await document.enqueueMutation(async () => {
      document.markSaved(snapshot.data);
      await this.postToDocumentPanels(document, createDatabaseSavedMessage({
        dirty: document.isDirty(),
        savedRevision: snapshot.revision,
        currentRevision: document.getRevision(),
        requestId,
      }));
    });
  }


  private createSaveRequestId(kind: string): string {
    this.saveRequestCounter += 1;
    return `${kind}-${this.saveRequestCounter}`;
  }

  async revertCustomDocument(document: SqliteDocument): Promise<void> {
    await document.enqueueMutation(() => document.reload());
    await this.postToDocumentPanels(document, {
      type: 'loadDatabase',
      name: vscode.workspace.asRelativePath(document.uri),
      data: toArrayBuffer(document.getData()),
      settings: this.getEditorSettings(document.uri),
      dirty: false,
      revision: document.getRevision(),
      resetViewState: false,
    });
  }

  async backupCustomDocument(
    document: SqliteDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    const snapshot = document.getSnapshot();
    await vscode.workspace.fs.writeFile(context.destination, snapshot.data);
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

  getActiveDocumentHandle(): string | undefined {
    return this.registry.getActiveDocumentHandle();
  }

  getSelectionContext(uri?: string): SqliteSelectionContext | undefined {
    return this.registry.getSelectionContext(uri);
  }

  getDatabaseHandle(uri: string): string | undefined {
    return this.registry.getDatabaseHandle(uri);
  }

  async applyCopilotDatabaseChange(
    document: SqliteDocument,
    data: Uint8Array,
    label: string,
    baseRevision: number,
  ): Promise<void> {
    const result = await this.applyDatabaseChange(document, data, label, true, baseRevision);
    if (!result.accepted) {
      throw new Error('The database changed while Copilot was working. Rerun the tool against the latest revision.');
    }
  }

  private async postDocument(
    panel: vscode.WebviewPanel,
    document: SqliteDocument,
    resetViewState = true,
  ): Promise<void> {
    const settings = this.getEditorSettings(document.uri);
    const data = document.getData();
    if (settings.maxFileSizeMb > 0 && data.byteLength > settings.maxFileSizeMb * 1024 * 1024) {
      await this.postWebviewMessage(document, panel, {
        type: 'loadError',
        message: `Database is ${(data.byteLength / 1024 / 1024).toFixed(1)} MB, above the configured ${settings.maxFileSizeMb} MB WebAssembly load limit. Raise databaseEditor.maxFileSizeMb or set it to 0 to open this file.`,
        settings,
      });
      return;
    }

    await this.postWebviewMessage(document, panel, {
      type: 'loadDatabase',
      name: vscode.workspace.asRelativePath(document.uri),
      data: toArrayBuffer(data),
      settings,
      dirty: document.isDirty(),
      revision: document.getRevision(),
      resetViewState,
    });
  }

  private async applyDatabaseChange(
    document: SqliteDocument,
    data: Uint8Array,
    label?: string,
    refreshPanels = false,
    expectedRevision?: number,
  ): Promise<SnapshotApplyResult> {
    let isRegisteringNewEdit = refreshPanels;
    const postSnapshot = async (snapshot: Uint8Array): Promise<void> => {
      await this.postToDocumentPanels(document, {
        type: 'loadDatabase',
        name: vscode.workspace.asRelativePath(document.uri),
        data: toArrayBuffer(snapshot),
        settings: this.getEditorSettings(document.uri),
        dirty: document.isDirty(snapshot, { isNewEdit: isRegisteringNewEdit }),
        revision: document.getRevision(),
        resetViewState: false,
      });
    };
    const result = await applySnapshotDocumentChange({
      document,
      data,
      label: label ?? 'Edit SQLite database',
      emitEdit: (event) => this.changeEmitter.fire(event),
      postSnapshot,
      postAfterApply: refreshPanels,
      maxUndoMemoryBytes: this.getEditorSettings(document.uri).maxUndoMemoryBytes,
      expectedRevision,
    });
    isRegisteringNewEdit = false;
    if (!result.accepted) {
      return result;
    }
    await this.postToDocumentPanels(document, {
      type: 'documentStateChanged',
      dirty: document.isDirty(undefined, { isNewEdit: true }),
      revision: result.revision,
    });
    return result;
  }

  private getEditorSettings(uri: vscode.Uri): EditorSettings {
    return readEditorSettings(
      vscode.workspace.getConfiguration('databaseEditor', uri),
      uri.scheme !== 'file',
    );
  }

  private async postDocumentToSiblingPanels(
    document: SqliteDocument,
    sourcePanel: vscode.WebviewPanel,
  ): Promise<void> {
    await Promise.all(this.registry.getPanels(document)
      .filter((panel) => panel !== sourcePanel)
      .map((panel) => this.postDocument(panel, document, false)));
  }

  private async postToDocumentPanels(document: SqliteDocument, message: ExtensionMessage): Promise<void> {
    await Promise.allSettled(
      this.registry.getPanels(document).map((panel) => this.postWebviewMessage(document, panel, message)),
    );
  }

  private postWebviewMessage(
    document: SqliteDocument,
    panel: vscode.WebviewPanel,
    message: ExtensionMessage,
  ): Thenable<boolean> {
    this.postedMessageEmitter.fire({ uri: document.uri.toString(), message });
    return panel.webview.postMessage(message);
  }

  private getRequiredDocument(uri: string): SqliteDocument {
    const document = this.registry.resolveDocument(uri);
    if (!document) {
      throw new Error(`No open SQLite document matches ${uri}`);
    }
    return document;
  }

  private async waitForDocumentState(uri: string, expectedOpen: boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Boolean(this.registry.resolveDocument(uri)) !== expectedOpen) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for custom document ${uri} to ${expectedOpen ? 'open' : 'close'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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

  private async exportSqlDocument(
    document: SqliteDocument,
    webviewPanel: vscode.WebviewPanel,
    message: ExportSqlMessage,
  ): Promise<void> {
    const defaultUri = document.uri.with({ path: `${dirname(document.uri.path)}/${message.fileName}` });
    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'SQL files': ['sql'], 'All files': ['*'] },
    });
    if (!destination) {
      await this.postWebviewMessage(document, webviewPanel, {
        type: 'sqlExportFinished',
        requestId: message.requestId,
        status: 'cancelled',
      });
      return;
    }

    try {
      const snapshot = await document.enqueueMutation(() => {
        const current = document.getSnapshot();
        if (current.revision !== message.revision) {
          throw new Error('The database changed before the SQL export started. Retry the export from the latest revision.');
        }
        return current;
      });
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Exporting ${message.fileName}`,
        cancellable: true,
      }, async (progress, cancellation) => {
        const SQL = await loadSqlJs(this.context.extensionUri);
        const database = new SQL.Database(snapshot.data);
        const sink = destination.scheme === 'file'
          ? createFileSqlExportSink(destination.fsPath)
          : createBufferedSqlExportSink({
              maxBytes: 64 * 1024 * 1024,
              writeFile: async (content) => vscode.workspace.fs.writeFile(destination, content),
            });
        try {
          await exportSqlDatabase(database, sink, {
            cancellation,
            onProgress: ({ tableName, rowsExported }) => progress.report({
              message: `${tableName}: ${rowsExported.toLocaleString()} rows`,
            }),
          });
        } finally {
          database.close();
        }
      });
      await this.postWebviewMessage(document, webviewPanel, {
        type: 'sqlExportFinished',
        requestId: message.requestId,
        status: 'completed',
      });
      await vscode.window.showInformationMessage(`Exported ${message.fileName}.`);
    } catch (error) {
      const cancelled = error instanceof SqlExportCancelledError;
      const failureMessage = cancelled ? undefined : getErrorMessage(error);
      await this.postWebviewMessage(document, webviewPanel, {
        type: 'sqlExportFinished',
        requestId: message.requestId,
        status: cancelled ? 'cancelled' : 'failed',
        message: failureMessage,
      });
      if (failureMessage) {
        await vscode.window.showErrorMessage(failureMessage);
      }
    }
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
}
