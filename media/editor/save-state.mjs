import { getErrorMessage } from '../utilities/errors.mjs';

export function getSaveButtonState({ hasDatabase, isDirty, isSaving }) {
  return {
    disabled: !hasDatabase || isSaving || !isDirty,
    label: isSaving ? 'Saving…' : 'Save',
  };
}

export function getDirtyStatusText({ hasDatabase, isDirty, isSaving }) {
  if (!hasDatabase) {
    return 'Waiting for file';
  }
  if (isSaving) {
    return 'Saving…';
  }
  return isDirty ? 'Unsaved changes' : 'All changes saved';
}

export function createDocumentController({
  getDatabase,
  shouldAutoSave,
  postMessage,
  render,
  setStatus,
  defer = (callback) => globalThis.setTimeout(callback, 0),
}) {
  let revision = 0;
  let dirty = false;
  let saving = false;
  let saveRequestCounter = 0;
  let shouldSaveAfterCompletion = false;
  const pendingSaveRequestIds = new Set();

  function renderState() {
    render({
      hasDatabase: Boolean(getDatabase()),
      isDirty: dirty,
      isSaving: saving,
      revision,
    });
  }

  function load({ dirty: nextDirty = false, revision: nextRevision = 0 } = {}) {
    revision = Number.isInteger(nextRevision) ? nextRevision : 0;
    dirty = Boolean(nextDirty);
    saving = false;
    pendingSaveRequestIds.clear();
    shouldSaveAfterCompletion = false;
    renderState();
  }

  function close() {
    revision = 0;
    dirty = false;
    saving = false;
    pendingSaveRequestIds.clear();
    shouldSaveAfterCompletion = false;
    renderState();
  }

  function applyExternalState({ dirty: nextDirty, revision: nextRevision }) {
    revision = Math.max(revision, Number(nextRevision) || 0);
    dirty = Boolean(nextDirty);
    renderState();
  }

  function requestSave() {
    if (!getDatabase() || !dirty) {
      return;
    }
    if (saving) {
      shouldSaveAfterCompletion = true;
      return;
    }

    saving = true;
    shouldSaveAfterCompletion = false;
    const requestId = `ui-save-${++saveRequestCounter}`;
    pendingSaveRequestIds.add(requestId);
    renderState();
    postMessage({ type: 'requestSave', requestId, revision });
  }

  function handleSaved(nextDirty = false, acknowledgedRevision = revision, requestId = '') {
    if (requestId.startsWith('ui-save-') && !pendingSaveRequestIds.has(requestId)) {
      return;
    }
    pendingSaveRequestIds.delete(requestId);
    dirty = Boolean(nextDirty) || Number(acknowledgedRevision) !== revision;
    saving = false;
    const shouldRetry = shouldSaveAfterCompletion && dirty;
    shouldSaveAfterCompletion = false;
    renderState();
    if (shouldRetry) {
      defer(requestSave);
    }
  }

  function handleSaveFailed(message, requestId = '') {
    if (requestId.startsWith('ui-save-') && !pendingSaveRequestIds.has(requestId)) {
      return;
    }
    pendingSaveRequestIds.delete(requestId);
    shouldSaveAfterCompletion = false;
    dirty = true;
    saving = false;
    renderState();
    setStatus(`Save failed: ${message}`);
  }

  function markChanged() {
    const database = getDatabase();
    if (!database) {
      return;
    }
    const exported = database.export();
    const baseRevision = revision;
    revision += 1;
    dirty = true;
    renderState();
    postMessage({
      type: 'databaseChanged',
      label: 'Edit SQLite database',
      baseRevision,
      data: exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength),
    });
    if (shouldAutoSave()) {
      defer(requestSave);
    }
  }

  function reportError(error) {
    const message = getErrorMessage(error);
    setStatus(message);
    postMessage({ type: 'error', message });
  }

  return {
    applyExternalState,
    close,
    handleSaved,
    handleSaveFailed,
    load,
    markChanged,
    reportError,
    requestSave,
    get isDirty() { return dirty; },
    get isSaving() { return saving; },
    get revision() { return revision; },
  };
}
