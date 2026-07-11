import type { EditorSettings } from './editor-settings';
import { getErrorMessage } from './utilities/errors';
import type { SqliteSelectionUpdate } from './sqlite-ai/sqlite-document-registry';

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

export type DatabaseChangedMessage = {
  type: 'databaseChanged';
  data: ArrayBuffer;
  label?: string;
  baseRevision?: number;
};

export type WebviewMessage =
  | { type: 'ready' }
  | DatabaseChangedMessage
  | { type: 'copilotSelectionChanged'; context: SqliteSelectionUpdate }
  | { type: 'requestSave' }
  | { type: 'error'; message: string }
  | { type: 'clipboardWrite'; text: string }
  | { type: 'clipboardRead'; requestId: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | SaveTextMessage
  | SaveBinaryMessage;

export type DatabaseSavedMessage = {
  type: 'databaseSaved';
  dirty: boolean;
  revision?: number;
};

export type ExtensionMessage =
  | { type: 'loadDatabase'; name: string; data: ArrayBuffer; settings: EditorSettings; dirty: boolean; resetViewState: boolean }
  | { type: 'loadError'; message: string; settings: EditorSettings }
  | { type: 'settingsChanged'; settings: EditorSettings }
  | DatabaseSavedMessage
  | { type: 'databaseSaveFailed'; message: string }
  | { type: 'documentStateChanged'; dirty: boolean }
  | { type: 'clipboardText'; requestId: string; text: string };

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
  const revisionAware = baseRevision !== undefined && currentRevision !== undefined;
  const accepted = !revisionAware || baseRevision === currentRevision;
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
}: {
  dirty: boolean;
  savedRevision?: number;
  currentRevision?: number;
}): DatabaseSavedMessage {
  const decision = decideSaveAcknowledgement({ dirty, savedRevision, currentRevision });
  return {
    type: 'databaseSaved',
    dirty: decision.dirty,
    ...(savedRevision === undefined ? {} : { revision: savedRevision }),
  };
}

export function createDatabaseSaveFailedMessage(error: unknown): Extract<ExtensionMessage, { type: 'databaseSaveFailed' }> {
  return {
    type: 'databaseSaveFailed',
    message: getErrorMessage(error),
  };
}
