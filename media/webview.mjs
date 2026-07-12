import {
  DEFAULT_EDITOR_SETTINGS,
  getDoubleClickEditMode,
  getEffectiveRowWindow,
  getInstantCommitAction,
  normalizeEditorSettings,
} from './editor/settings.mjs';
import { createElement, clear } from './utilities/dom.mjs';
import { getErrorMessage } from './utilities/errors.mjs';
import { applyTextEditingShortcut } from './utilities/text-control.mjs';
import { createExportWorkflow } from './dialogs/export-workflow.mjs';
import {
  createRowCountCache,
  createRowCountFilterKey,
  getUnknownCountRowWindow,
  loadTableCountsInBackground,
  resolveUnknownCountRows,
} from './database/metadata.mjs';
import { createDatabaseHealthWorkflow } from './database/health.mjs';
import { showConfirmation } from './dialogs/workflows.mjs';
import { showFormDialog } from './dialogs/form.mjs';
import {
  getCellClipboardText,
  getInfiniteRowWindow,
  getInfiniteScrollState,
  getRefreshButtonState,
  getTextEditingShortcutAction,
} from './grid/ui.mjs';
import {
  createDocumentController,
  getDirtyStatusText,
  getSaveButtonState,
} from './editor/save-state.mjs';
import { createEditorControls, createEditorShell } from './editor/shell.mjs';
import { createClipboardBridge } from './editor/clipboard.mjs';
import { createGridView } from './grid/view.mjs';
import { createGridSelection } from './grid/selection.mjs';
import { createRowWorkflows } from './grid/row-workflows.mjs';
import { createSchemaSelection } from './schema/object-ui.mjs';
import { createSchemaView } from './schema/view.mjs';
import { createSchemaWorkflows } from './schema/workflows.mjs';
import { createCsvImportWorkflow } from './csv/workflow.mjs';
import {
  configureDatabase,
  countTableRows,
  getSchemaObjects,
  queryGridRows,
  readTableMetadata,
  runSqlScript,
  runWrite,
} from './database/client.mjs';
import {
  buildRowCopyContent,
  buildTableSelect,
} from './sql/statements.mjs';
import { createSqlWorkspace } from './sql/workspace.mjs';

const ROW_COPY_FORMATS = [
  { value: 'tsv', label: 'TSV' },
  { value: 'csv', label: 'CSV' },
  { value: 'sqlite-inserts', label: 'SQLite inserts' },
  { value: 'json-objects', label: 'JSON objects' },
  { value: 'json-arrays', label: 'JSON arrays' },
  { value: 'html', label: 'HTML' },
  { value: 'markdown', label: 'Markdown' },
];

const vscode = acquireVsCodeApi();
const webviewState = vscode.getState?.() ?? {};
const app = document.querySelector('#app');
const wasmUri = app.dataset.wasmUri;
console.info('[SQLite Database Editor] loaded webview', {
  extensionUri: app.dataset.extensionUri,
  resourceVersion: app.dataset.resourceVersion,
});

let SQL = null;
let db = null;
let databaseName = 'SQLite database';
let tables = [];
const rowCountCache = createRowCountCache();
let metadataLoadGeneration = 0;
let activeView = 'data';
let filter = '';
let columnFilters = {};
let objectFilter = '';
let sortColumn = null;
let sortDirection = 'asc';
let page = 1;
let editorSettings = normalizeEditorSettings(DEFAULT_EDITOR_SETTINGS);
let pageSize = editorSettings.defaultPageSize;
let totalRows = 0;
let visibleRows = [];
let rowResultScope = 0;
let schemaObjects = [];
let activeSchemaView = 'graph';
let databaseLoadQueue = Promise.resolve();
let pinnedColumns = new Set();
let columnWidths = {};

let pinnedRows = new Set();
let isRefreshingRows = false;
let isLoadingMoreRows = false;
let infiniteScrollCheckFrame = 0;
let lastGridScrollTop = 0;
let isScrollingTowardBottom = true;


let refreshRowsDebounceTimer = null;

const schemaSelection = createSchemaSelection({
  getTables: () => tables,
  getObjects: () => schemaObjects,
});
const elements = buildShell();
const clipboard = createClipboardBridge({ vscode });
const documentController = createDocumentController({
  getDatabase: () => db,
  shouldAutoSave: () => getInstantCommitAction({
    strategy: editorSettings.instantCommit,
    isRemote: editorSettings.isRemote,
  }) === 'save',
  postMessage: (message) => vscode.postMessage(message),
  render: ({ hasDatabase, isDirty, isSaving }) => {
    const saveState = getSaveButtonState({ hasDatabase, isDirty, isSaving });
    elements.saveButton.disabled = saveState.disabled;
    elements.saveButton.textContent = saveState.label;
    elements.status.textContent = getDirtyStatusText({ hasDatabase, isDirty, isSaving });
  },
  setStatus: (message) => { elements.status.textContent = message; },
  defer: (callback) => window.setTimeout(callback, 0),
});
const gridSelection = createGridSelection({
  elements,
  vscode,
  getState: () => ({
    table: schemaSelection.activeTable,
    visibleRows,
    visibleRowOffset: getVisibleRowOffset(),
    filter,
    columnFilters,
    sortColumn,
    sortDirection,
  }),
});
const editorControls = createEditorControls({
  elements,
  getState: () => ({
    table: schemaSelection.activeTable,
    selectedSchemaObject: schemaSelection.selectedObject,
    page,
    pageSize,
    totalRows,
    loadedRows: visibleRows.length,
    autoPagination: editorSettings.autoPagination,
    maxRows: editorSettings.maxRows,
    selectedRowCount: gridSelection.selectedRows.length,
    sqlExportUi: exportWorkflow.getUiState(),
  }),
});
const exportWorkflow = createExportWorkflow({
  vscode,
  getState: () => ({
    hasDatabase: Boolean(db),
    databaseName,
    table: schemaSelection.activeTable,
    visibleRows,
    revision: documentController.revision,
    hasTables: tables.length > 0,
  }),
  setStatus: (message) => { elements.status.textContent = message; },
  onStateChanged: () => editorControls.render(),
});
const databaseHealthWorkflow = createDatabaseHealthWorkflow({
  getDatabase: () => db,
  showReport: (text) => {
    elements.schema.textContent = text;
    setActiveView('schema');
    setActiveSchemaView('ddl');
  },
  setStatus: (message) => { elements.status.textContent = message; },
});
const gridView = createGridView({
  elements,
  getState: () => ({
    table: schemaSelection.activeTable,
    visibleRows,
    visibleRowOffset: getVisibleRowOffset(),
    pinnedColumns,
    pinnedRows,
    columnWidths,
    columnFilters,
    sortColumn,
    sortDirection,
    selectedRowKeys: gridSelection.selectedRowKeys,
    selectedRow: gridSelection.selectedRow,
    selectedCell: gridSelection.selectedCell,
  }),
  updateSelectionUi: gridSelection.updateUi,
});
gridView.bindColumnResizing();
const rowWorkflows = createRowWorkflows({
  elements,
  vscode,
  getState: () => ({
    database: db,
    databaseName,
    settings: editorSettings,
    table: schemaSelection.activeTable,
    editableTable: schemaSelection.editableTable,
    visibleRows,
    visibleRowOffset: getVisibleRowOffset(),
  }),
  selectGridCell: gridSelection.selectCell,
  renderGrid: () => gridView.render(),
  refreshRows,
  refreshTables,
  markChanged: documentController.markChanged,
  clearSelectedRows: gridSelection.clearSelectedRows,
  getSelectedRows: () => gridSelection.selectedRows,
  confirm: confirmDestructiveAction,
  reportError: documentController.reportError,
  setStatus: (message) => { elements.status.textContent = message; },
});
const schemaView = createSchemaView({
  elements,
  getState: () => ({
    tables,
    schemaObjects,
    selectedSchemaObject: schemaSelection.selectedObject,
    activeTableName: schemaSelection.activeTableName,
    activeTable: schemaSelection.activeTable,
    objectFilter,
    activeSchemaView,
  }),
  activateSchemaView: setActiveSchemaView,
});
const sqlWorkspace = createSqlWorkspace({
  elements,
  vscode,
  initialHistory: webviewState.queryHistory,
  executeScript: runSqlScript,
  getDatabase: () => db,
  getSettings: () => editorSettings,
  confirm: confirmDestructiveAction,
  markChanged: documentController.markChanged,
  refreshTables,
});
const schemaWorkflows = createSchemaWorkflows({
  getTables: () => tables,
  getEditableTable: () => schemaSelection.editableTable,
  getSelectedSchemaObject: () => schemaSelection.selectedObject,
  showDialog: showSchemaDialog,
  confirm: confirmDestructiveAction,
  applyChange: applySchemaChange,
  setStatus: (message) => { elements.status.textContent = message; },
});
const csvImportWorkflow = createCsvImportWorkflow({
  vscode,
  getEditableTable: () => schemaSelection.editableTable,
  getDatabase: () => db,
  showDialog: showSchemaDialog,
  markChanged: documentController.markChanged,
  refreshTables,
  setStatus: (message) => { elements.status.textContent = message; },
});
vscode.postMessage({ type: 'ready' });

window.addEventListener('message', async (event) => {
  const message = event.data;
  if (message.type === 'loadDatabase') {
    applyEditorSettings(message.settings, { resetPageSize: message.resetViewState !== false });
    const load = () => openDatabase(message.name, message.data, {
      dirty: message.dirty,
      revision: message.revision,
      resetViewState: message.resetViewState,
      walWarning: message.walWarning,
    });
    databaseLoadQueue = databaseLoadQueue.then(load, load);
    await databaseLoadQueue;
  } else if (message.type === 'loadError') {
    handleLoadError(message.message, message.settings);
  } else if (message.type === 'settingsChanged') {
    const oldMaxRows = editorSettings.maxRows;
    const oldAutoPagination = editorSettings.autoPagination;
    applyEditorSettings(message.settings);
    if (db && (oldMaxRows !== editorSettings.maxRows || oldAutoPagination !== editorSettings.autoPagination)) {
      page = 1;
      await refreshRows();
    }
  } else if (message.type === 'databaseSaved') {
    documentController.handleSaved(message.dirty, message.revision, message.requestId);
  } else if (message.type === 'databaseSaveFailed') {
    documentController.handleSaveFailed(message.message, message.requestId);
  } else if (message.type === 'documentStateChanged') {
    documentController.applyExternalState(message);
  } else if (message.type === 'clipboardText') {
    clipboard.handleMessage(message);
  } else if (message.type === 'sqlExportFinished') {
    exportWorkflow.handleFinished(message);
  } else if (message.type === 'csvFileRead') {
    csvImportWorkflow.handleFileRead(message);
  }
});

function buildShell() {
  const shell = createEditorShell({
    app,
    pageSizes: getPageSizes(),
    pageSize,
    rowCopyFormats: ROW_COPY_FORMATS,
  });
  const { filterInput, pageSizeSelect, grid, copyRowsFormat, queryInput, queryHistorySelect, schemaGraph } = shell;

  app.addEventListener('click', handleClick);
  app.addEventListener('dblclick', handleDoubleClick);
  app.addEventListener('input', handleInput);
  filterInput.addEventListener('input', () => {
    filter = filterInput.value;
    page = 1;
    scheduleRefreshRows();
  });
  pageSizeSelect.addEventListener('change', async () => {
    pageSize = Number(pageSizeSelect.value);
    page = 1;
    await refreshRows();
  });
  grid.addEventListener('scroll', () => {
    const nextScrollTop = grid.scrollTop;
    if (nextScrollTop > lastGridScrollTop) {
      isScrollingTowardBottom = true;
      gridView.schedule();
      scheduleInfiniteScrollCheck();
    } else if (nextScrollTop < lastGridScrollTop) {
      isScrollingTowardBottom = false;
      gridView.schedule();
    }
    lastGridScrollTop = nextScrollTop;
  });
  copyRowsFormat.addEventListener('change', async () => {
    const format = copyRowsFormat.value;
    copyRowsFormat.value = '';
    if (format) {
      await copyRows(format);
    }
  });
  queryInput.addEventListener('input', () => {
    sqlWorkspace.captureInput();
  });
  queryHistorySelect.addEventListener('change', () => {
    const selectedIndex = Number(queryHistorySelect.value);
    sqlWorkspace.loadHistory(selectedIndex);
    queryHistorySelect.value = '';
  });
  window.addEventListener('keydown', handleGlobalKeyDown, true);

  schemaGraph.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const graphTable = event.target.closest?.('[data-schema-graph-table]');
    if (!graphTable) {
      return;
    }
    event.preventDefault();
    await selectTable(graphTable.dataset.schemaGraphTable);
  });

  return shell;
}

function handleGlobalKeyDown(event) {
  const textAction = getTextEditingShortcutAction({
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    targetTagName: event.target?.tagName,
  });
  if (textAction) {
    event.stopPropagation();
    if (textAction === 'nativeUndo' || textAction === 'nativeRedo') {
      return;
    }
    event.preventDefault();
    void applyTextEditingShortcut(event.target, textAction, {
      writeClipboardText: clipboard.writeText,
      readClipboardText: clipboard.readText,
    });
    return;
  }

  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    event.stopPropagation();
    gridSelection.reset({ updateRendered: true });
    return;
  }

  if (!event.metaKey && !event.ctrlKey) {
    return;
  }

  const key = event.key.toLowerCase();
  if ((key === 'delete' || key === 'backspace') && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    event.stopPropagation();
    void smartDeleteSelection();
    return;
  }

  if (key === 'c' && !document.querySelector('dialog[open]')) {
    const selectedText = window.getSelection?.().toString() ?? '';
    if (!selectedText) {
      const targetCell = event.target.closest?.('[data-grid-cell-row]');
      const rowIndex = targetCell ? Number(targetCell.dataset.gridCellRow) : gridSelection.selectedCell?.rowIndex;
      const columnName = targetCell?.dataset.gridCellColumn ?? gridSelection.selectedCell?.columnName;
      if (Number.isInteger(rowIndex) && columnName) {
        event.preventDefault();
        event.stopPropagation();
        gridSelection.selectCell(rowIndex, columnName);
        void copyGridCell(rowIndex, columnName);
        return;
      }
    }
  }

  if (key === 'z' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: event.shiftKey ? 'redo' : 'undo' });
    return;
  }

  if (key === 'y' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: 'redo' });
    return;
  }

  if (key === 's') {
    if (document.querySelector('dialog[open]')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    documentController.requestSave();
  }
}

async function handleInput(event) {
  const columnFilter = event.target.closest?.('[data-column-filter]');
  if (columnFilter) {
    const columnName = columnFilter.dataset.columnFilter;
    const value = columnFilter.value.trim();
    if (value) {
      columnFilters[columnName] = value;
    } else {
      delete columnFilters[columnName];
    }
    page = 1;
    scheduleRefreshRows();
    focusColumnFilter(columnName);
    return;
  }

  const objectSearch = event.target.closest?.('[data-object-search]');
  if (objectSearch) {
    objectFilter = objectSearch.value;
    schemaView.renderSidebar();
    schemaView.focusObjectSearch();
  }
}

async function openDatabase(name, data, {
  dirty = false,
  revision = 0,
  resetViewState = true,
  walWarning = '',
} = {}) {
  try {
    elements.status.textContent = 'Opening database...';
    SQL ??= await initSqlJs({ locateFile: () => wasmUri });
    const nextDatabase = new SQL.Database(new Uint8Array(data));
    configureDatabase(nextDatabase);
    gridView.clearResources();
    db?.close();
    db = nextDatabase;
    rowCountCache.clear();
    databaseName = name;
    elements.title.textContent = name;
    renderWalWarning(walWarning);
    if (resetViewState) {
      gridSelection.reset();
      page = 1;
      filter = '';
      pinnedRows.clear();
      pinnedColumns.clear();
      columnFilters = {};
      objectFilter = '';
      elements.filterInput.value = '';
      sortColumn = null;
      sortDirection = 'asc';
    }
    documentController.load({ dirty, revision });
    await refreshTables();
  } catch (error) {
    documentController.reportError(error);
  }
}

function renderPageSizeOptions(select = elements?.pageSizeSelect) {
  if (!select) {
    return;
  }
  const sizes = getPageSizes();
  select.replaceChildren(...sizes.map((size) => createElement('option', {
    text: `${size.toLocaleString()} rows`,
    attributes: { value: String(size), selected: size === pageSize ? 'selected' : undefined },
  })));
  select.value = String(pageSize);
}

function getPageSizes() {
  return [...new Set([50, 100, 250, 500, 1000, editorSettings.defaultPageSize])]
    .filter((size) => Number.isInteger(size) && size > 0)
    .sort((left, right) => left - right);
}

function applyEditorSettings(settings, { resetPageSize = false } = {}) {
  const previousDefaultPageSize = editorSettings.defaultPageSize;
  editorSettings = normalizeEditorSettings(settings);
  if (resetPageSize || pageSize === previousDefaultPageSize) {
    pageSize = editorSettings.defaultPageSize;
    page = 1;
  }
  renderPageSizeOptions();
}

function handleLoadError(message, settings) {
  applyEditorSettings(settings, { resetPageSize: true });
  db?.close();
  db = null;
  tables = [];
  schemaObjects = [];
  schemaSelection.clear();
  visibleRows = [];
  totalRows = 0;
  documentController.close();
  elements.title.textContent = 'SQLite database not opened';
  renderWalWarning('');
  elements.status.textContent = message;
  elements.grid.replaceChildren(createElement('div', { className: 'error-state', text: message }));
  schemaView.renderSidebar();
  schemaView.renderSchema();
  editorControls.render();
}

function getQueryOptions() {
  return { timeoutMs: editorSettings.queryTimeoutMs };
}

function scheduleRefreshRows() {
  if (refreshRowsDebounceTimer) {
    window.clearTimeout(refreshRowsDebounceTimer);
  }

  refreshRowsDebounceTimer = window.setTimeout(() => {
    refreshRowsDebounceTimer = null;
    void refreshRows();
  }, 120);
}

function updateRefreshUi() {
  const hasDatabase = Boolean(db);
  const hasActiveTable = Boolean(schemaSelection.activeTable);
  const objectState = getRefreshButtonState({
    target: 'objects',
    hasDatabase,
    hasActiveTable,
  });
  const dataState = getRefreshButtonState({
    target: 'table-data',
    hasDatabase,
    hasActiveTable,
  });
  elements.objectRefresh.disabled = objectState.disabled;
  elements.dataRefresh.disabled = dataState.disabled;
}

async function refreshTables() {
  const generation = ++metadataLoadGeneration;
  const revision = documentController.revision;
  schemaObjects = getSchemaObjects(db);
  tables = readTableMetadata(db, schemaObjects);

  schemaSelection.reconcile();
  schemaView.renderSidebar();
  schemaView.renderSchema();
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await refreshRows();
  void loadTableCountsInBackground({
    objects: tables,
    schedule: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
    isCurrent: () => generation === metadataLoadGeneration && revision === documentController.revision,
    load: (table) => rowCountCache.get({
      revision,
      objectName: table.name,
      filterKey: createRowCountFilterKey(),
      load: () => countTableRows(db, {
        tableName: table.name,
        columns: table.columns,
        options: getQueryOptions(),
      }),
    }),
    onLoaded: () => schemaView.renderSidebar(),
    onError: (table) => {
      table.rowCount = undefined;
      schemaView.renderSidebar();
    },
  }).then(() => {
    if (generation === metadataLoadGeneration && revision === documentController.revision) {
      schemaView.renderGraph();
    }
  });
}

async function refreshRows() {
  const table = schemaSelection.activeTable;
  isRefreshingRows = true;
  isLoadingMoreRows = false;
  gridSelection.reset();

  if (!table) {
    totalRows = 0;
    visibleRows = [];
    elements.grid.replaceChildren(createElement('div', { className: 'empty-state', text: 'No tables found.' }));
    editorControls.render();
    updateRefreshUi();
    gridSelection.updateUi();
    gridSelection.postContext();
    isRefreshingRows = false;
    return;
  }

  try {
    if (table.type === 'view') {
      await refreshUnknownCountRows(table);
      return;
    }

    const filterKey = createRowCountFilterKey(filter, columnFilters);
    const actualTotalRows = rowCountCache.get({
      revision: documentController.revision,
      objectName: table.name,
      filterKey,
      load: () => countTableRows(db, {
        tableName: table.name,
        columns: table.columns,
        filter,
        columnFilters,
        options: getQueryOptions(),
      }),
    });
    if (!hasActiveGridFilters()) {
      table.rowCount = actualTotalRows;
      schemaView.renderSidebar();
      schemaView.renderGraph();
    }
    if (editorSettings.autoPagination) {
      page = 1;
    }
    const rowWindow = getEffectiveRowWindow({
      totalRows: actualTotalRows,
      page,
      pageSize,
      maxRows: editorSettings.maxRows,
    });
    totalRows = rowWindow.effectiveTotalRows;
    page = rowWindow.page;
    rowResultScope += 1;
    visibleRows = readGridRows(table, {
      limit: rowWindow.limit,
      offset: rowWindow.offset,
    });
    gridView.render();
    elements.grid.scrollTop = 0;
    lastGridScrollTop = 0;
    isScrollingTowardBottom = true;
    editorControls.render();
  } catch (error) {
    visibleRows = [];
    elements.grid.replaceChildren(createElement('div', { className: 'error-state', text: getErrorMessage(error) }));
  } finally {
    isRefreshingRows = false;
    updateRefreshUi();
    gridSelection.updateUi();
    gridSelection.postContext();
    scheduleInfiniteScrollCheck();
  }
}

async function refreshUnknownCountRows(table) {
  if (editorSettings.autoPagination) {
    page = 1;
  }
  const rowWindow = getUnknownCountRowWindow({
    page,
    pageSize,
    autoPagination: editorSettings.autoPagination,
    loadedRows: 0,
    maxRows: editorSettings.maxRows,
  });
  rowResultScope += 1;
  const result = resolveUnknownCountRows(readGridRows(table, rowWindow), rowWindow);
  visibleRows = result.rows;
  totalRows = result.totalRows;
  gridView.render();
  elements.grid.scrollTop = 0;
  lastGridScrollTop = 0;
  isScrollingTowardBottom = true;
  editorControls.render();
}

function hasActiveGridFilters() {
  return Boolean(String(filter ?? '').trim())
    || Object.values(columnFilters).some((value) => Boolean(String(value ?? '').trim()));
}

function readGridRows(table, { limit, offset }) {
  const selectQuery = buildTableSelect({
    tableName: table.name,
    columns: table.columns,
    filter,
    columnFilters,
    sortColumn,
    sortDirection,
    limit,
    offset,
    includeRowid: table.hasRowid,
    rowidAlias: table.rowidAlias,
  });
  return queryGridRows(db, {
    table,
    query: selectQuery,
    resultScope: rowResultScope,
    offset,
    options: getQueryOptions(),
  });
}

async function maybeLoadMoreRows() {
  if (!db || refreshRowsDebounceTimer) {
    return;
  }

  const scrollState = getInfiniteScrollState({
    autoPagination: editorSettings.autoPagination,
    loadedRows: visibleRows.length,
    totalRows,
    isLoading: isRefreshingRows || isLoadingMoreRows,
    isScrollingTowardBottom,
    scrollTop: elements.grid.scrollTop,
    clientHeight: elements.grid.clientHeight,
    scrollHeight: elements.grid.scrollHeight,
  });

  if (!scrollState.shouldLoadMore) {
    return;
  }

  await loadMoreRows();
}

function scheduleInfiniteScrollCheck() {
  if (infiniteScrollCheckFrame) {
    return;
  }

  infiniteScrollCheckFrame = window.requestAnimationFrame(() => {
    infiniteScrollCheckFrame = 0;
    void maybeLoadMoreRows();
  });
}

async function loadMoreRows() {
  const table = schemaSelection.activeTable;
  if (!table || isRefreshingRows || isLoadingMoreRows || !editorSettings.autoPagination) {
    return;
  }

  const rowWindow = getInfiniteRowWindow({
    loadedRows: visibleRows.length,
    pageSize,
    totalRows,
  });
  if (!rowWindow.hasMore) {
    return;
  }

  isLoadingMoreRows = true;
  const startIndex = visibleRows.length;
  try {
    if (table.type === 'view') {
      const unknownWindow = getUnknownCountRowWindow({
        page,
        pageSize,
        autoPagination: true,
        loadedRows: visibleRows.length,
        maxRows: editorSettings.maxRows,
      });
      const result = resolveUnknownCountRows(readGridRows(table, unknownWindow), unknownWindow);
      visibleRows.push(...result.rows);
      totalRows = result.totalRows;
      gridView.render({ bodyOnly: true });
      editorControls.render();
      if (result.hasMore) {
        scheduleInfiniteScrollCheck();
      }
      return;
    }
    const nextRows = readGridRows(table, rowWindow);
    if (nextRows.length === 0) {
      totalRows = visibleRows.length;
      editorControls.render();
      return;
    }

    visibleRows.push(...nextRows);
    gridView.render({ bodyOnly: true });
    if (nextRows.length < rowWindow.limit) {
      totalRows = visibleRows.length;
    }
    editorControls.render();
    scheduleInfiniteScrollCheck();
  } catch (error) {
    visibleRows.length = startIndex;
    gridView.render();
    documentController.reportError(error);
  } finally {
    isLoadingMoreRows = false;
  }
}

function focusColumnFilter(columnName) {
  const input = elements.grid.querySelector(`[data-column-filter="${CSS.escape(columnName)}"]`);
  const valueLength = input?.value.length ?? 0;
  input?.focus();
  input?.setSelectionRange?.(valueLength, valueLength);
}

function getVisibleRowOffset() {
  return editorSettings.autoPagination ? 0 : (page - 1) * pageSize;
}

async function smartDeleteSelection() {
  if (gridSelection.selectedRows.length > 0) {
    await rowWorkflows.deleteSelected(document.activeElement);
    return;
  }

  if (gridSelection.selectedCell) {
    await rowWorkflows.clearCell(
      gridSelection.selectedCell.rowIndex,
      gridSelection.selectedCell.columnName,
      document.activeElement,
    );
    return;
  }

  if (gridSelection.selectedRow !== null) {
    await rowWorkflows.deleteAt(gridSelection.selectedRow, document.activeElement);
  }
}

async function copyGridCell(rowIndex, columnName) {
  const row = visibleRows[rowIndex];
  if (!row) {
    return;
  }

  const value = row.values[columnName];
  await clipboard.writeText(getCellClipboardText(value));
  elements.status.textContent = `Copied ${columnName}`;
}

async function copyRows(format) {
  const table = schemaSelection.activeTable;
  if (!table || visibleRows.length === 0) {
    return;
  }

  const selectedVisibleRows = gridSelection.selectedRows;
  const usedSelection = selectedVisibleRows.length > 0;
  const sourceRows = usedSelection ? selectedVisibleRows : visibleRows;
  const rows = sourceRows.map((row) => row.values);
  const columns = table.columns.map((column) => column.name);
  const content = buildRowCopyContent({
    format,
    tableName: table.name,
    columns,
    rows,
  });
  await clipboard.writeText(content);
  const label = ROW_COPY_FORMATS.find((item) => item.value === format)?.label ?? format;
  elements.status.textContent = usedSelection
    ? `Copied ${rows.length.toLocaleString()} selected ${rows.length === 1 ? 'row' : 'rows'} as ${label}`
    : `Copied ${rows.length.toLocaleString()} ${rows.length === 1 ? 'row' : 'rows'} as ${label}`;
}

async function handleClick(event) {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action) {
    await runAction(action, event.target.closest('[data-action]'));
    return;
  }

  const graphTable = event.target.closest('[data-schema-graph-table]');
  if (graphTable) {
    await selectTable(graphTable.dataset.schemaGraphTable);
    return;
  }

  const selectAllRows = event.target.closest('[data-select-all-rows]');
  if (selectAllRows) {
    event.stopPropagation();
    gridSelection.toggleAll();
    return;
  }

  const selectRow = event.target.closest('[data-select-row]');
  if (selectRow) {
    event.stopPropagation();
    const rowIndex = Number(selectRow.dataset.selectRow);
    const row = visibleRows[rowIndex];
    if (row) {
      gridSelection.toggle(rowIndex, { range: event.shiftKey, additive: true });
      gridSelection.selectRow(rowIndex);
      gridSelection.syncRendered();
    }
    return;
  }

  const pinButton = event.target.closest('[data-pin-column]');
  if (pinButton) {
    gridView.rememberWidths();
    const columnName = pinButton.dataset.pinColumn;
    if (pinnedColumns.has(columnName)) {
      pinnedColumns.delete(columnName);
    } else {
      pinnedColumns.add(columnName);
    }
    gridView.render();
    return;
  }

  const pinRowIcon = event.target.closest('[data-pin-row]');
  if (pinRowIcon) {
    const rowIndex = Number(pinRowIcon.dataset.pinRow);
    const realRowIndex = getVisibleRowOffset() + rowIndex;
    if (pinnedRows.has(realRowIndex)) {
      pinnedRows.delete(realRowIndex);
    } else {
      pinnedRows.add(realRowIndex);
    }
    gridSelection.selectRow(rowIndex);
    gridView.render({ bodyOnly: true });
    return;
  }

  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    setActiveView(viewButton.dataset.view);
    return;
  }

  const tableButton = event.target.closest('[data-table]');
  if (tableButton) {
    await selectTable(tableButton.dataset.table);
    return;
  }

  const schemaObjectButton = event.target.closest('[data-schema-object]');
  if (schemaObjectButton) {
    selectSchemaObject(schemaObjectButton.dataset.schemaObjectType, schemaObjectButton.dataset.schemaObject);
    return;
  }

  const sortButton = event.target.closest('[data-sort-column]');
  if (sortButton) {
    const column = sortButton.dataset.sortColumn;
    sortDirection = sortColumn === column && sortDirection === 'asc' ? 'desc' : 'asc';
    sortColumn = column;
    page = 1;
    await refreshRows();
    return;
  }

  const gridCell = event.target.closest('[data-grid-cell-row]');
  if (gridCell) {
    const rowIndex = Number(gridCell.dataset.gridCellRow);
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      gridSelection.toggle(rowIndex, { range: event.shiftKey, additive: event.metaKey || event.ctrlKey || event.shiftKey });
      gridSelection.selectRow(rowIndex);
      gridSelection.syncRendered();
      return;
    }
    gridSelection.selectCell(rowIndex, gridCell.dataset.gridCellColumn);
    return;
  }

  const row = event.target.closest('tr[data-row]');
  if (row) {
    const rowIndex = Number(row.dataset.row);
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      gridSelection.toggle(rowIndex, { range: event.shiftKey, additive: event.metaKey || event.ctrlKey || event.shiftKey });
      gridSelection.selectRow(rowIndex);
      gridSelection.syncRendered();
      return;
    }
    gridSelection.selectRow(rowIndex);
    return;
  }
}

function handleDoubleClick(event) {
  const gridCell = event.target.closest('[data-grid-cell-row]');
  if (!gridCell) {
    return;
  }

  const cellButton = gridCell.querySelector('[data-cell-row]');
  if (cellButton?.disabled) {
    return;
  }

  const rowIndex = Number(gridCell.dataset.gridCellRow);
  const columnName = gridCell.dataset.gridCellColumn;
  const table = schemaSelection.activeTable;
  const row = visibleRows[rowIndex];
  const column = table?.columns.find((candidate) => candidate.name === columnName);
  const canInlineEdit = Boolean(table?.type === 'table' && row && column && column.canUpdate !== false && !column.readOnly && !(row.values[column.name] instanceof Uint8Array));
  const editMode = getDoubleClickEditMode({
    behavior: editorSettings.doubleClickBehavior,
    canInlineEdit,
  });
  if (editMode === 'inline') {
    rowWorkflows.showInlineEditor(rowIndex, columnName);
    return;
  }

  rowWorkflows.showDetails(rowIndex, columnName);
}

async function selectTable(tableName) {
  if (!schemaSelection.selectTable(tableName)) {
    return;
  }
  page = 1;
  columnFilters = {};
  sortColumn = null;
  sortDirection = 'asc';
  pinnedRows.clear();
  pinnedColumns.clear();
  schemaView.renderSidebar();
  schemaView.renderSchema();
  await refreshRows();
}

function selectSchemaObject(type, name) {
  if (!schemaSelection.selectObject(type, name)) {
    return;
  }
  setActiveView('schema');
  setActiveSchemaView('ddl');
  schemaView.renderSidebar();
  schemaView.renderSchema();
}

async function runAction(action, sourceElement = null) {
  switch (action) {
    case 'refresh-objects':
      await refreshTables();
      break;
    case 'refresh-data':
      await refreshRows();
      break;
    case 'previous-page':
      if (!editorSettings.autoPagination && page > 1) {
        page -= 1;
        await refreshRows();
      }
      break;
    case 'next-page':
      if (editorSettings.autoPagination) {
        await loadMoreRows();
      } else if (page < Math.ceil(totalRows / pageSize)) {
        page += 1;
        await refreshRows();
      }
      break;
    case 'edit-row':
      rowWorkflows.showDetails(Number(sourceElement?.dataset.actionRow));
      break;
    case 'delete-row':
      await rowWorkflows.deleteAt(Number(sourceElement?.dataset.actionRow), sourceElement);
      break;
    case 'delete-selected-rows':
      await rowWorkflows.deleteSelected(sourceElement);
      break;
    case 'add-row':
      rowWorkflows.showInsert();
      break;
    case 'run-query':
      await sqlWorkspace.run();
      break;
    case 'export-csv':
      exportWorkflow.exportCsv();
      break;
    case 'import-csv':
      await csvImportWorkflow.requestImport();
      break;
    case 'export-sql':
      exportWorkflow.exportSql();
      break;
    case 'save-database':
      documentController.requestSave();
      break;
    case 'schema-view-graph':
      setActiveSchemaView('graph');
      break;
    case 'schema-view-ddl':
      setActiveSchemaView('ddl');
      break;
    case 'schema-graph-fit':
      schemaView.fitGraph();
      break;
    case 'schema-graph-layout':
      schemaView.renderGraph();
      schemaView.fitGraph();
      break;
    case 'check-database-health':
      databaseHealthWorkflow.run();
      break;
    case 'new-table':
      schemaWorkflows.createTable();
      break;
    case 'rename-table':
      schemaWorkflows.renameTable();
      break;
    case 'add-column':
      schemaWorkflows.addColumn();
      break;
    case 'drop-column':
      schemaWorkflows.dropColumn();
      break;
    case 'drop-table':
      await schemaWorkflows.dropTable(sourceElement);
      break;
    case 'create-index':
      schemaWorkflows.createIndex();
      break;
    case 'drop-index':
      await schemaWorkflows.dropIndex(sourceElement);
      break;
  }
}

function setActiveView(view) {
  activeView = view;
  for (const tab of elements.tabs) {
    tab.classList.toggle('active', tab.dataset.view === view);
  }
  elements.data.classList.toggle('hidden', view !== 'data');
  elements.schemaPanel.classList.toggle('hidden', view !== 'schema');
  elements.query.classList.toggle('hidden', view !== 'query');
}

function setActiveSchemaView(view) {
  activeSchemaView = view === 'ddl' ? 'ddl' : 'graph';
  const graphActive = activeSchemaView === 'graph';
  elements.schemaGraph.classList.toggle('hidden', !graphActive);
  elements.schema.classList.toggle('hidden', graphActive);
  elements.schemaGraphButton.classList.toggle('active', graphActive);
  elements.schemaDdlButton.classList.toggle('active', !graphActive);
  elements.schemaGraphButton.setAttribute('aria-pressed', String(graphActive));
  elements.schemaDdlButton.setAttribute('aria-pressed', String(!graphActive));
  elements.schemaGraphFit.classList.toggle('hidden', !graphActive);
  elements.schemaGraphLayout.classList.toggle('hidden', !graphActive);
  elements.schemaGraphSummary.classList.toggle('hidden', !graphActive);
}

function renderWalWarning(message) {
  elements.databaseWarning.textContent = message || '';
  elements.databaseWarning.classList.toggle('hidden', !message);
}

function confirmDestructiveAction(model, invoker = document.activeElement) {
  return showConfirmation({
    model,
    invoker,
    fallbackFocus: () => elements.grid.querySelector("[data-row], [data-action]") ?? elements.dataRefresh,
  });
}

async function applySchemaChange(sql, {
  nextActiveTableName = schemaSelection.activeTableName,
  nextSchemaObject = schemaSelection.selectedObject,
} = {}) {
  try {
    runWrite(db, sql);
    schemaSelection.set({ activeTableName: nextActiveTableName, selectedObject: nextSchemaObject });
    documentController.markChanged();
    await refreshTables();
    return { ok: true };
  } catch (error) {
    const message = getErrorMessage(error);
    elements.status.textContent = message;
    return { ok: false, error: message };
  }
}

function showSchemaDialog({ title, description, submitText, fields, onSubmit }) {
  return showFormDialog({
    title,
    description,
    submitText,
    fields,
    onSubmit,
    fallbackFocus: () => elements.schemaDdlButton,
  });
}
