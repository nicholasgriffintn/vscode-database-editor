import type { EditorSettings } from './editor-settings';
import { getErrorMessage } from './utilities/errors';
import type { SqliteSelectionUpdate } from './sqlite-document-registry';

export type SaveTextMessage = {
  type: 'saveText';
  kind: 'csv' | 'sql';
  fileName: string;
  content: string;
};

export type SaveBinaryMessage = {
  type: 'saveBinary';
  kind: 'blob';
  fileName: string;
  content: ArrayBuffer;
};

export type ExportSqlMessage = {
  type: 'exportSql';
  fileName: string;
  revision: number;
  requestId: string;
};

export type DatabaseChangedMessage = {
  type: 'databaseChanged';
  data: ArrayBuffer;
  label?: string;
  baseRevision: number;
};

export type SaveRequestMessage = {
  type: 'requestSave';
  requestId: string;
  revision: number;
};

export type WebviewMessage =
  | { type: 'ready' }
  | DatabaseChangedMessage
  | { type: 'copilotSelectionChanged'; context: SqliteSelectionUpdate }
  | SaveRequestMessage
  | { type: 'error'; message: string }
  | { type: 'clipboardWrite'; text: string }
  | { type: 'clipboardRead'; requestId: string }
  | { type: 'readCsv'; requestId: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | ExportSqlMessage
  | SaveTextMessage
  | SaveBinaryMessage;

export type DatabaseSavedMessage = {
  type: 'databaseSaved';
  dirty: boolean;
  revision: number;
  requestId: string;
};

export type ExtensionMessage =
  | { type: 'loadDatabase'; name: string; data: ArrayBuffer; settings: EditorSettings; dirty: boolean; revision: number; resetViewState: boolean }
  | { type: 'loadError'; message: string; settings: EditorSettings }
  | { type: 'settingsChanged'; settings: EditorSettings }
  | DatabaseSavedMessage
  | { type: 'databaseSaveFailed'; message: string; revision: number; requestId: string }
  | { type: 'documentStateChanged'; dirty: boolean; revision: number }
  | { type: 'clipboardText'; requestId: string; text: string }
  | { type: 'csvFileRead'; requestId: string; status: 'completed' | 'cancelled' | 'failed'; name?: string; content?: string; message?: string }
  | { type: 'sqlExportFinished'; requestId: string; status: 'completed' | 'cancelled' | 'failed'; message?: string };


export type IncomingDatabaseChangeDecision = {
  accepted: boolean;
  shouldRehydrate: boolean;
};

export function decideIncomingDatabaseChange({
  baseRevision,
  currentRevision,
}: {
  baseRevision?: number;
  currentRevision?: number;
}): IncomingDatabaseChangeDecision {
  const accepted = baseRevision !== undefined && baseRevision === currentRevision;
  return {
    accepted,
    shouldRehydrate: !accepted,
  };
}

export type SaveAcknowledgementDecision = {
  acknowledgedRevision?: number;
  clearDirty: boolean;
  dirty: boolean;
  shouldRetry: boolean;
};

export function decideSaveAcknowledgement({
  dirty,
  savedRevision,
  currentRevision,
}: {
  dirty: boolean;
  savedRevision?: number;
  currentRevision?: number;
}): SaveAcknowledgementDecision {
  const revisionAware = savedRevision !== undefined && currentRevision !== undefined;
  const isCurrent = !revisionAware || savedRevision === currentRevision;
  const effectiveDirty = dirty || !isCurrent;

  return {
    ...(savedRevision === undefined ? {} : { acknowledgedRevision: savedRevision }),
    clearDirty: isCurrent && !effectiveDirty,
    dirty: effectiveDirty,
    shouldRetry: !isCurrent,
  };
}

export function createDatabaseSavedMessage({
  dirty,
  savedRevision,
  currentRevision,
  requestId,
}: {
  dirty: boolean;
  savedRevision: number;
  currentRevision: number;
  requestId: string;
}): DatabaseSavedMessage {
  const decision = decideSaveAcknowledgement({ dirty, savedRevision, currentRevision });
  return {
    type: 'databaseSaved',
    dirty: decision.dirty,
    revision: savedRevision,
    requestId,
  };
}

export function createDatabaseSaveFailedMessage(
  error: unknown,
  revision: number,
  requestId: string,
): Extract<ExtensionMessage, { type: 'databaseSaveFailed' }> {
  return {
    type: 'databaseSaveFailed',
    message: getErrorMessage(error),
    revision,
    requestId,
  };
}
