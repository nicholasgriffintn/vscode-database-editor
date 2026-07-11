import assert from 'node:assert/strict';

import * as vscode from 'vscode';

const extensionId = 'NicholasGriffin.vscode-database-editor';
const viewType = 'databaseEditor.sqlite';

export async function run() {
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `Expected ${extensionId} to be installed in the Extension Development Host`);

  const api = await extension.activate();
  const fixtureBytes = await readFixtures(extension.extensionUri);
  const fileSystem = new ControlledFileSystem(fixtureBytes[0]);
  const fileSystemRegistration = vscode.workspace.registerFileSystemProvider(
    'database-editor-test',
    fileSystem,
    { isCaseSensitive: true },
  );
  const documentUri = vscode.Uri.parse('database-editor-test:/lifecycle.sqlite');

  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('vscode.openWith', documentUri, viewType);
    await api.waitForDocument(documentUri.toString());

    await testSaveWithInterveningEdit(api, fileSystem, documentUri, fixtureBytes);
    await testUndoRedoAndRevert(api, documentUri, fixtureBytes);
    await testSchemaIndexIsOneUndoStep(api, documentUri, fixtureBytes);
    await testSaveAsAndBackupRestore(api, fileSystem, documentUri, fixtureBytes);
    await testFailedWriteAndDisposal(api, fileSystem, documentUri, fixtureBytes[4]);
  } finally {
    fileSystemRegistration.dispose();
  }
}

async function testSchemaIndexIsOneUndoStep(api, documentUri, fixtures) {
  const before = api.getDocumentSnapshot(documentUri.toString());
  assert.deepEqual([...before.data], [...fixtures[2]]);

  await applyEdit(api, documentUri, fixtures[5], before.revision, 'Create SQLite index');
  assert.deepEqual([...api.getDocumentSnapshot(documentUri.toString()).data], [...fixtures[5]]);

  await vscode.commands.executeCommand('undo');
  await waitForRevision(api, documentUri, before.revision + 2);
  assert.deepEqual([...api.getDocumentSnapshot(documentUri.toString()).data], [...fixtures[2]], 'index creation should undo in one step');

  await vscode.commands.executeCommand('redo');
  await waitForRevision(api, documentUri, before.revision + 3);
  assert.deepEqual([...api.getDocumentSnapshot(documentUri.toString()).data], [...fixtures[5]], 'index creation should redo in one step');

  await vscode.commands.executeCommand('undo');
  await waitForRevision(api, documentUri, before.revision + 4);
}

async function testSaveWithInterveningEdit(api, fileSystem, documentUri, fixtures) {
  const initial = api.getDocumentSnapshot(documentUri.toString());
  await applyEdit(api, documentUri, fixtures[1], initial.revision, 'First integration edit');
  assert.equal(activeTab()?.isDirty, true, 'webview edits should mark the custom editor dirty');

  const delayedWrite = fileSystem.delayNextWrite();
  const firstAcknowledgement = waitForMessage(api, (message) => (
    message.type === 'databaseSaved' && message.requestId === 'integration-save-1'
  ));
  const firstSave = api.sendWebviewMessage(documentUri.toString(), {
    type: 'requestSave',
    requestId: 'integration-save-1',
    revision: initial.revision + 1,
  });

  await delayedWrite.started;
  await applyEdit(api, documentUri, fixtures[2], initial.revision + 1, 'Edit during save');
  delayedWrite.release();
  await firstSave;

  assert.deepEqual(await firstAcknowledgement, {
    type: 'databaseSaved',
    dirty: true,
    revision: initial.revision + 1,
    requestId: 'integration-save-1',
  });
  await waitFor(() => activeTab()?.isDirty === true, 'intervening edit to remain dirty after save');

  const retryAcknowledgement = waitForMessage(api, (message) => (
    message.type === 'databaseSaved' && message.requestId === 'integration-save-2'
  ));
  await api.sendWebviewMessage(documentUri.toString(), {
    type: 'requestSave',
    requestId: 'integration-save-2',
    revision: initial.revision + 2,
  });
  assert.equal((await retryAcknowledgement).dirty, false);
  await waitFor(() => activeTab()?.isDirty === false, 'retry save to clear dirty state');
}

async function testUndoRedoAndRevert(api, documentUri, fixtures) {
  const beforeEdit = api.getDocumentSnapshot(documentUri.toString());
  await applyEdit(api, documentUri, fixtures[3], beforeEdit.revision, 'Undoable integration edit');

  await vscode.commands.executeCommand('undo');
  await waitForRevision(api, documentUri, beforeEdit.revision + 2);
  assert.deepEqual([...api.getDocumentSnapshot(documentUri.toString()).data], [...fixtures[2]]);

  await vscode.commands.executeCommand('redo');
  await waitForRevision(api, documentUri, beforeEdit.revision + 3);
  assert.deepEqual([...api.getDocumentSnapshot(documentUri.toString()).data], [...fixtures[3]]);

  await vscode.commands.executeCommand('workbench.action.files.revert');
  await waitForRevision(api, documentUri, beforeEdit.revision + 4);
  assert.deepEqual([...api.getDocumentSnapshot(documentUri.toString()).data], [...fixtures[2]]);
  assert.equal(activeTab()?.isDirty, false);
}

async function testSaveAsAndBackupRestore(api, fileSystem, documentUri, fixtures) {
  const snapshot = api.getDocumentSnapshot(documentUri.toString());
  await applyEdit(api, documentUri, fixtures[3], snapshot.revision, 'Save As integration edit');

  const destination = documentUri.with({ path: '/saved-as.sqlite' });
  await api.saveAs(documentUri.toString(), destination);
  assert.deepEqual([...fileSystem.readFile(destination)], [...fixtures[3]]);

  const afterSaveAs = api.getDocumentSnapshot(documentUri.toString());
  await applyEdit(api, documentUri, fixtures[4], afterSaveAs.revision, 'Backup integration edit');
  const restored = await api.restoreFromBackup(
    documentUri.toString(),
    documentUri.with({ path: '/lifecycle.backup' }),
  );
  assert.deepEqual([...restored.data], [...fixtures[4]]);
  assert.equal(restored.dirty, true, 'backup bytes should restore as dirty against the original file');
}

async function testFailedWriteAndDisposal(api, fileSystem, documentUri, savedBytes) {
  fileSystem.failNextWrite();
  const failure = waitForMessage(api, (message) => (
    message.type === 'databaseSaveFailed' && message.requestId === 'integration-save-failure'
  ));
  await api.sendWebviewMessage(documentUri.toString(), {
    type: 'requestSave',
    requestId: 'integration-save-failure',
    revision: api.getDocumentSnapshot(documentUri.toString()).revision,
  });
  assert.match((await failure).message, /simulated write failure/i);
  assert.equal(activeTab()?.isDirty, true);

  const finalSave = waitForMessage(api, (message) => (
    message.type === 'databaseSaved' && message.requestId === 'integration-save-final'
  ));
  await api.sendWebviewMessage(documentUri.toString(), {
    type: 'requestSave',
    requestId: 'integration-save-final',
    revision: api.getDocumentSnapshot(documentUri.toString()).revision,
  });
  await finalSave;
  assert.deepEqual([...fileSystem.readFile(documentUri)], [...savedBytes]);

  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await api.waitForDocumentClosed(documentUri.toString());
}

async function readFixtures(extensionUri) {
  return Promise.all(Array.from({ length: 6 }, (_, index) => {
    const name = index === 0 ? 'sample.sqlite' : index === 5 ? 'sample-index.sqlite' : `sample-edit-${index}.sqlite`;
    return vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, '.tmp', name));
  }));
}

async function applyEdit(api, uri, data, baseRevision, label) {
  await api.sendWebviewMessage(uri.toString(), {
    type: 'databaseChanged',
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    label,
    baseRevision,
  });
}

function activeTab() {
  return vscode.window.tabGroups.activeTabGroup.activeTab;
}

async function waitForRevision(api, uri, revision) {
  await waitFor(
    () => api.getDocumentSnapshot(uri.toString()).revision >= revision,
    `document revision ${revision}`,
  );
}

async function waitFor(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForMessage(api, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error('Timed out waiting for an extension-to-webview message'));
    }, timeoutMs);
    const subscription = api.onDidPostWebviewMessage(({ message }) => {
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timeout);
      subscription.dispose();
      resolve(message);
    });
  });
}

class ControlledFileSystem {
  #data = new Map();
  #failurePending = false;
  #delayedWrite;
  #events = new vscode.EventEmitter();

  constructor(initialData) {
    this.#data.set('/lifecycle.sqlite', new Uint8Array(initialData));
  }

  onDidChangeFile = this.#events.event;

  watch() { return new vscode.Disposable(() => {}); }
  stat(uri) {
    if (!this.#data.has(uri.path)) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: this.#data.get(uri.path).byteLength };
  }
  readDirectory() { return []; }
  createDirectory() {}
  readFile(uri) {
    const data = this.#data.get(uri.path);
    if (!data) throw vscode.FileSystemError.FileNotFound(uri);
    return new Uint8Array(data);
  }
  async writeFile(uri, content) {
    if (this.#failurePending) {
      this.#failurePending = false;
      throw vscode.FileSystemError.Unavailable('Simulated write failure');
    }
    if (this.#delayedWrite) {
      const delayedWrite = this.#delayedWrite;
      this.#delayedWrite = undefined;
      delayedWrite.markStarted();
      await delayedWrite.waitForRelease;
    }
    this.#data.set(uri.path, new Uint8Array(content));
    this.#events.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
  delete(uri) { this.#data.delete(uri.path); }
  rename(oldUri, newUri) {
    const data = this.readFile(oldUri);
    this.#data.delete(oldUri.path);
    this.#data.set(newUri.path, data);
  }

  failNextWrite() { this.#failurePending = true; }

  delayNextWrite() {
    let markStarted;
    let release;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const waitForRelease = new Promise((resolve) => { release = resolve; });
    this.#delayedWrite = { markStarted, waitForRelease };
    return { started, release };
  }
}
