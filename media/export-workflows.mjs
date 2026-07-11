import { safeFileName } from './utilities/file.mjs';

export function createSqlExportState() {
  return { requestCounter: 0, activeRequestId: null };
}

export function transitionSqlExport(state, event) {
  if (event.type === 'start') {
    if (state.activeRequestId) {
      return { state, handled: false, message: null };
    }
    const requestCounter = state.requestCounter + 1;
    const activeRequestId = `sql-export-${requestCounter}`;
    return {
      state: { requestCounter, activeRequestId },
      handled: true,
      message: {
        type: 'exportSql',
        fileName: `${safeFileName(event.databaseName)}.sql`,
        revision: event.revision,
        requestId: activeRequestId,
      },
    };
  }

  if (event.type === 'finish' && event.requestId === state.activeRequestId) {
    return {
      state: { ...state, activeRequestId: null },
      handled: true,
      statusMessage: event.status === 'failed'
        ? `SQL export failed: ${event.message || 'Unknown error'}`
        : null,
    };
  }

  return { state, handled: false, statusMessage: null };
}

export function getSqlExportUiState(state, { hasTables }) {
  const exporting = Boolean(state.activeRequestId);
  return {
    disabled: !hasTables || exporting,
    label: exporting ? 'Exporting SQL…' : 'Export SQL',
  };
}
