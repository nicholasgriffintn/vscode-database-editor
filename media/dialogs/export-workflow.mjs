import { safeFileName } from '../utilities/file.mjs';
import { toCsv } from '../sql/statements.mjs';

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

export function createExportWorkflow({ vscode, getState, setStatus, onStateChanged }) {
  let sqlExportState = createSqlExportState();

  function exportCsv() {
    const state = getState();
    if (!state.table) return;
    vscode.postMessage({
      type: 'saveText',
      kind: 'csv',
      fileName: `${safeFileName(`${state.databaseName}-${state.table.name}`)}.csv`,
      content: toCsv(
        state.table.columns.map((column) => column.name),
        state.visibleRows.map((row) => row.values),
      ),
    });
  }

  function exportSql() {
    const state = getState();
    if (!state.hasDatabase) return;
    const transition = transitionSqlExport(sqlExportState, {
      type: 'start',
      databaseName: state.databaseName,
      revision: state.revision,
    });
    sqlExportState = transition.state;
    if (!transition.handled) return;
    vscode.postMessage(transition.message);
    onStateChanged();
  }

  function handleFinished(message) {
    const transition = transitionSqlExport(sqlExportState, { ...message, type: 'finish' });
    if (!transition.handled) return false;
    sqlExportState = transition.state;
    if (transition.statusMessage) setStatus(transition.statusMessage);
    onStateChanged();
    return true;
  }

  return {
    exportCsv,
    exportSql,
    handleFinished,
    getUiState: () => getSqlExportUiState(sqlExportState, { hasTables: getState().hasTables }),
  };
}
