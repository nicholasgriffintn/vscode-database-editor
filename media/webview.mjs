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
import {
  createSqlExportState,
  getSqlExportUiState,
  transitionSqlExport,
} from './dialogs/export-workflow.mjs';
import {
  createRowCountCache,
  createRowCountFilterKey,
  formatRowCount,
  getUnknownCountRowWindow,
  loadTableCountsInBackground,
  resolveUnknownCountRows,
} from './database/metadata.mjs';
import {
  createConfirmationModel,
  showConfirmation,
} from './dialogs/workflows.mjs';
import { safeFileName } from './utilities/file.mjs';
import { showFormDialog } from './dialogs/form.mjs';
import {
  getCellClipboardText,
  getCopilotSelectionContext,
  getInfiniteRowWindow,
  getInfiniteScrollState,
  getPagerState,
  getRefreshButtonState,
  getRowSelectionKey,
  getShiftedPinnedColumnLeft,
  getSelectedVisibleRows,
  getSelectAllRowsState,
  getTextEditingShortcutAction,
} from './grid/ui.mjs';
import { getDirtyStatusText, getSaveButtonState } from './editor/save-state.mjs';
import { createEditorShell } from './editor/shell.mjs';
import { createGridView } from './grid/view.mjs';
import { createRowWorkflows } from './grid/row-workflows.mjs';
import { resolveSchemaSelection } from './schema/object-ui.mjs';
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
  toCsv,
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
let activeTableName = null;
let selectedSchemaObject = null;
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
let selectedRow = null;
let selectedCell = null;
let lastSelectedRowIndex = null;
let selectedRowKeys = new Set();
let schemaObjects = [];
let activeSchemaView = 'graph';
let isDirty = false;
let isSaving = false;
let currentRevision = 0;
let databaseLoadQueue = Promise.resolve();
let saveRequestCounter = 0;
let pendingSaveRequestIds = new Set();
let shouldSaveAfterCompletion = false;
let sqlExportState = createSqlExportState();
let pinnedColumns = new Set();
let columnWidths = {};

let pinnedRows = new Set();
let clipboardRequestId = 0;
const pendingClipboardReads = new Map();
let isRefreshingRows = false;
let isLoadingMoreRows = false;
let infiniteScrollCheckFrame = 0;
let lastGridScrollTop = 0;
let isScrollingTowardBottom = true;


let refreshRowsDebounceTimer = null;

const elements = buildShell();
const gridView = createGridView({
  elements,
  getState: () => ({
    table: getActiveTable(),
    visibleRows,
    visibleRowOffset: getVisibleRowOffset(),
    pinnedColumns,
    pinnedRows,
    columnWidths,
    columnFilters,
    sortColumn,
    sortDirection,
    selectedRowKeys,
    selectedRow,
    selectedCell,
  }),
  updateSelectionUi,
});
const rowWorkflows = createRowWorkflows({
  elements,
  vscode,
  getState: () => ({
    database: db,
    databaseName,
    settings: editorSettings,
    table: getActiveTable(),
    editableTable: getEditableTable(),
    visibleRows,
    visibleRowOffset: getVisibleRowOffset(),
  }),
  selectGridCell,
  renderGrid: () => gridView.render(),
  refreshRows,
  refreshTables,
  markChanged,
  clearSelectedRows,
  getSelectedRows: getVisibleSelectedRows,
  confirm: confirmDestructiveAction,
  reportError,
  setStatus: (message) => { elements.status.textContent = message; },
});
const schemaView = createSchemaView({
  elements,
  getState: () => ({
    tables,
    schemaObjects,
    selectedSchemaObject: getSelectedSchemaObject(),
    activeTableName,
    activeTable: getActiveTable(),
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
  markChanged,
  refreshTables,
});
const schemaWorkflows = createSchemaWorkflows({
  getTables: () => tables,
  getEditableTable,
  getSelectedSchemaObject,
  showDialog: showSchemaDialog,
  confirm: confirmDestructiveAction,
  applyChange: applySchemaChange,
  setStatus: (message) => { elements.status.textContent = message; },
});
const csvImportWorkflow = createCsvImportWorkflow({
  vscode,
  getEditableTable,
  getDatabase: () => db,
  showDialog: showSchemaDialog,
  markChanged,
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
    handleDatabaseSaved(message.dirty, message.revision, message.requestId);
  } else if (message.type === 'databaseSaveFailed') {
    handleDatabaseSaveFailed(message.message, message.requestId);
  } else if (message.type === 'documentStateChanged') {
    currentRevision = Math.max(currentRevision, Number(message.revision) || 0);
    isDirty = Boolean(message.dirty);
    updateSaveUi();
  } else if (message.type === 'clipboardText') {
    const pending = pendingClipboardReads.get(message.requestId);
    if (pending) {
      pendingClipboardReads.delete(message.requestId);
      pending.resolve(message.text ?? '');
    }
  } else if (message.type === 'sqlExportFinished') {
    handleSqlExportFinished(message);
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

  let resizeData = null;
  grid.addEventListener('mousedown', (event) => {
    const handle = event.target.closest('.col-resize-handle');
    if (!handle) return;
    const columnName = handle.dataset.resizeColumn;
    if (!columnName) return;
    event.preventDefault();
    const gridEl = grid.querySelector('.data-grid');
    if (!gridEl) return;
    const colIndex = Array.from(gridEl.querySelectorAll('.column-heading-row th')).findIndex((th) =>
      th.querySelector(`[data-resize-column="${columnName}"]`)
    );
    if (colIndex === -1) return;
    const startX = event.clientX;
    const th = handle.closest('th');
    const startWidth = th?.offsetWidth || 120;
    const gridRows = Array.from(gridEl.querySelectorAll('tr'));
    const pinnedColumnCells = columnName === '__rowNumber'
      ? Array.from(gridEl.querySelectorAll('th.pinned, td.pinned')).map((cell) => ({
          cell,
          startLeft: Number.parseFloat(cell.style.left) || 0,
        }))
      : [];
    let rafHandle = 0;

    handle.classList.add('active');
    resizeData = {
      columnName,
      startX,
      startWidth,
      newWidth: startWidth,
      handle,
      colIndex,
      gridRows,
      pinnedColumnCells,
    };

    function applyColumnWidth() {
      const activeResize = resizeData;
      if (!activeResize) {
        return;
      }
      const width = activeResize.newWidth;
      for (const row of activeResize.gridRows) {
        const cell = row.children[activeResize.colIndex];
        if (cell) {
          cell.style.width = `${width}px`;
          cell.style.minWidth = `${width}px`;
          cell.style.maxWidth = `${width}px`;
        }
      }
      for (const pinnedColumn of activeResize.pinnedColumnCells) {
        pinnedColumn.cell.style.left = `${getShiftedPinnedColumnLeft({
          startLeft: pinnedColumn.startLeft,
          startWidth: activeResize.startWidth,
          newWidth: width,
        })}px`;
      }
      rafHandle = 0;
    }

    function onMouseMove(e) {
      if (!resizeData) return;
      const diff = e.clientX - resizeData.startX;
      const newWidth = Math.max(60, resizeData.startWidth + diff);
      if (newWidth === resizeData.newWidth) {
        return;
      }
      resizeData.newWidth = newWidth;
      columnWidths[resizeData.columnName] = newWidth;

      if (!rafHandle) {
        rafHandle = window.requestAnimationFrame(applyColumnWidth);
      }
    }

    function onMouseUp() {
      if (rafHandle) {
        window.cancelAnimationFrame(rafHandle);
        applyColumnWidth();
        rafHandle = 0;
      }
      if (resizeData) {
        resizeData.handle?.classList.remove('active');
      }
      resizeData = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

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
    void applyTextEditingShortcut(event.target, textAction, { writeClipboardText, readClipboardText });
    return;
  }

  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    event.stopPropagation();
    clearGridSelection();
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
      const rowIndex = targetCell ? Number(targetCell.dataset.gridCellRow) : selectedCell?.rowIndex;
      const columnName = targetCell?.dataset.gridCellColumn ?? selectedCell?.columnName;
      if (Number.isInteger(rowIndex) && columnName) {
        event.preventDefault();
        event.stopPropagation();
        selectGridCell(rowIndex, columnName);
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
    requestSave();
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

async function openDatabase(name, data, { dirty = false, revision = 0, resetViewState = true } = {}) {
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
    if (resetViewState) {
      selectedRow = null;
      selectedCell = null;
      selectedRowKeys.clear();
      lastSelectedRowIndex = null;
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
    isDirty = Boolean(dirty);
    currentRevision = Number.isInteger(revision) ? revision : 0;
    isSaving = false;
    pendingSaveRequestIds.clear();
    shouldSaveAfterCompletion = false;
    await refreshTables();
    updateSaveUi();
  } catch (error) {
    reportError(error);
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
  activeTableName = null;
  selectedSchemaObject = null;
  visibleRows = [];
  totalRows = 0;
  isDirty = false;
  isSaving = false;
  elements.title.textContent = 'SQLite database not opened';
  elements.status.textContent = message;
  elements.grid.replaceChildren(createElement('div', { className: 'error-state', text: message }));
  schemaView.renderSidebar();
  schemaView.renderSchema();
  updatePager();
  updateSaveUi();
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

function buildAutoCommitStatusSuffix() {
  return getInstantCommitAction({
    strategy: editorSettings.instantCommit,
    isRemote: editorSettings.isRemote,
  }) === 'save'
    ? ' · saving automatically'
    : '';
}

function maybeAutoCommit() {
  if (getInstantCommitAction({ strategy: editorSettings.instantCommit, isRemote: editorSettings.isRemote }) === 'save') {
    window.setTimeout(() => requestSave(), 0);
  }
}

function handleDatabaseSaved(dirty = false, revision = currentRevision, requestId = '') {
  if (requestId.startsWith('ui-save-') && !pendingSaveRequestIds.has(requestId)) {
    return;
  }
  pendingSaveRequestIds.delete(requestId);
  const acknowledgedRevision = Number(revision);
  isDirty = Boolean(dirty) || acknowledgedRevision !== currentRevision;
  isSaving = false;
  const shouldRetry = shouldSaveAfterCompletion && isDirty;
  shouldSaveAfterCompletion = false;
  updateSaveUi();
  if (shouldRetry) {
    window.setTimeout(() => requestSave(), 0);
  }
}

function handleDatabaseSaveFailed(message, requestId = '') {
  if (requestId.startsWith('ui-save-') && !pendingSaveRequestIds.has(requestId)) {
    return;
  }
  pendingSaveRequestIds.delete(requestId);
  shouldSaveAfterCompletion = false;
  isDirty = true;
  isSaving = false;
  updateSaveUi();
  elements.status.textContent = `Save failed: ${message}`;
}

function requestSave() {
  if (!db || !isDirty) {
    return;
  }
  if (isSaving) {
    shouldSaveAfterCompletion = true;
    return;
  }

  isSaving = true;
  shouldSaveAfterCompletion = false;
  const requestId = `ui-save-${++saveRequestCounter}`;
  pendingSaveRequestIds.add(requestId);
  updateSaveUi();
  vscode.postMessage({
    type: 'requestSave',
    requestId,
    revision: currentRevision,
  });
}

function updateSaveUi() {
  const hasDatabase = Boolean(db);
  const saveState = getSaveButtonState({ hasDatabase, isDirty, isSaving });
  elements.saveButton.disabled = saveState.disabled;
  elements.saveButton.textContent = saveState.label;
  elements.status.textContent = getDirtyStatusText({ hasDatabase, isDirty, isSaving });
}

function updateRefreshUi() {
  const hasDatabase = Boolean(db);
  const hasActiveTable = Boolean(getActiveTable());
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
  const revision = currentRevision;
  schemaObjects = getSchemaObjects(db);
  tables = readTableMetadata(db, schemaObjects);

  activeTableName = activeTableName && tables.some((table) => table.name === activeTableName)
    ? activeTableName
    : tables[0]?.name ?? null;
  selectedSchemaObject = resolveSchemaSelection(schemaObjects, selectedSchemaObject, activeTableName);
  schemaView.renderSidebar();
  schemaView.renderSchema();
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await refreshRows();
  void loadTableCountsInBackground({
    objects: tables,
    schedule: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
    isCurrent: () => generation === metadataLoadGeneration && revision === currentRevision,
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
    if (generation === metadataLoadGeneration && revision === currentRevision) {
      schemaView.renderGraph();
    }
  });
}

async function refreshRows() {
  const table = getActiveTable();
  isRefreshingRows = true;
  isLoadingMoreRows = false;
  selectedRow = null;
  selectedCell = null;
  selectedRowKeys.clear();
  lastSelectedRowIndex = null;

  if (!table) {
    totalRows = 0;
    visibleRows = [];
    elements.grid.replaceChildren(createElement('div', { className: 'empty-state', text: 'No tables found.' }));
    updatePager();
    updateRefreshUi();
    updateSelectionUi();
    postCopilotSelectionContext();
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
      revision: currentRevision,
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
    updatePager();
  } catch (error) {
    visibleRows = [];
    elements.grid.replaceChildren(createElement('div', { className: 'error-state', text: getErrorMessage(error) }));
  } finally {
    isRefreshingRows = false;
    updateRefreshUi();
    updateSelectionUi();
    postCopilotSelectionContext();
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
  updatePager();
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
  const table = getActiveTable();
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
      updatePager();
      if (result.hasMore) {
        scheduleInfiniteScrollCheck();
      }
      return;
    }
    const nextRows = readGridRows(table, rowWindow);
    if (nextRows.length === 0) {
      totalRows = visibleRows.length;
      updatePager();
      return;
    }

    visibleRows.push(...nextRows);
    gridView.render({ bodyOnly: true });
    if (nextRows.length < rowWindow.limit) {
      totalRows = visibleRows.length;
    }
    updatePager();
    scheduleInfiniteScrollCheck();
  } catch (error) {
    visibleRows.length = startIndex;
    gridView.render();
    reportError(error);
  } finally {
    isLoadingMoreRows = false;
  }
}

function postCopilotSelectionContext() {
  const visibleRowOffset = getVisibleRowOffset();
  const selectedRowNumbers = [];
  for (let rowIndex = 0; rowIndex < visibleRows.length; rowIndex += 1) {
    if (selectedRowKeys.has(getRowSelectionKey(visibleRows[rowIndex].identity))) {
      selectedRowNumbers.push(visibleRowOffset + rowIndex + 1);
    }
  }
  vscode.postMessage({
    type: 'copilotSelectionChanged',
    context: getCopilotSelectionContext({
      table: getActiveTable(),
      filter,
      columnFilters,
      sortColumn,
      sortDirection,
      selectedColumns: selectedCell?.columnName ? [selectedCell.columnName] : [],
      selectedRowCount: selectedRowNumbers.length,
      selectedRowNumbers,
    }),
  });
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

function toggleRowSelection(rowIndex, { range = false, additive = true } = {}) {
  if (!Number.isInteger(rowIndex) || !visibleRows[rowIndex]) {
    return;
  }

  if (range && Number.isInteger(lastSelectedRowIndex) && visibleRows[lastSelectedRowIndex]) {
    const start = Math.min(lastSelectedRowIndex, rowIndex);
    const end = Math.max(lastSelectedRowIndex, rowIndex);
    if (!additive) {
      selectedRowKeys.clear();
    }
    for (let index = start; index <= end; index += 1) {
      selectedRowKeys.add(getRowSelectionKey(visibleRows[index].identity));
    }
  } else {
    const key = getRowSelectionKey(visibleRows[rowIndex].identity);
    if (selectedRowKeys.has(key)) {
      selectedRowKeys.delete(key);
    } else {
      if (!additive) {
        selectedRowKeys.clear();
      }
      selectedRowKeys.add(key);
    }
  }
  lastSelectedRowIndex = rowIndex;
  postCopilotSelectionContext();
}

function selectGridRow(rowIndex) {
  selectedRow = rowIndex;
  selectedCell = null;
  const gridEl = elements.grid.querySelector('.data-grid');
  gridEl?.querySelectorAll('.selected-row').forEach((row) => row.classList.remove('selected-row'));
  gridEl?.querySelectorAll('.selected-cell').forEach((cell) => cell.classList.remove('selected-cell'));
  gridEl?.querySelector(`tr[data-row="${CSS.escape(String(rowIndex))}"]`)?.classList.add('selected-row');
  postCopilotSelectionContext();
}

function selectGridCell(rowIndex, columnName) {
  selectedRow = rowIndex;
  selectedCell = { rowIndex, columnName };
  const gridEl = elements.grid.querySelector('.data-grid');
  gridEl?.querySelectorAll('.selected-row').forEach((row) => row.classList.remove('selected-row'));
  gridEl?.querySelectorAll('.selected-cell').forEach((cell) => cell.classList.remove('selected-cell'));
  const row = gridEl?.querySelector(`tr[data-row="${CSS.escape(String(rowIndex))}"]`);
  row?.classList.add('selected-row');
  row?.querySelector(`[data-grid-cell-column="${CSS.escape(columnName)}"]`)?.classList.add('selected-cell');
  postCopilotSelectionContext();
}

function clearSelectedRows() {
  selectedRowKeys.clear();
  updateSelectionUi();
}

function clearGridSelection() {
  selectedRow = null;
  selectedCell = null;
  selectedRowKeys.clear();
  lastSelectedRowIndex = null;
  const gridEl = elements.grid.querySelector('.data-grid');
  gridEl?.querySelectorAll('.selected-row, .selected-cell, .multi-selected-row').forEach((element) => {
    element.classList.remove('selected-row', 'selected-cell', 'multi-selected-row');
  });
  syncRenderedSelectionState();
  postCopilotSelectionContext();
}

function syncRenderedSelectionState() {
  const gridEl = elements.grid.querySelector('.data-grid');
  if (!gridEl) {
    return;
  }

  for (const renderedRow of gridEl.querySelectorAll('tr[data-row]')) {
    const rowIndex = Number(renderedRow.dataset.row);
    const row = visibleRows[rowIndex];
    const selected = Boolean(row && selectedRowKeys.has(getRowSelectionKey(row.identity)));
    renderedRow.classList.toggle('multi-selected-row', selected);
    const checkbox = renderedRow.querySelector('[data-select-row]');
    if (checkbox) {
      checkbox.checked = selected;
      checkbox.title = selected ? 'Deselect row' : 'Select row';
    }
  }

  const selectAllState = getSelectAllRowsState({ visibleRows, selectedRowKeys });
  const selectAll = gridEl.querySelector('[data-select-all-rows]');
  if (selectAll) {
    selectAll.checked = selectAllState.checked;
    selectAll.indeterminate = selectAllState.indeterminate;
    selectAll.title = selectAllState.checked ? 'Deselect visible rows' : 'Select visible rows';
  }
  updateSelectionUi();
}

async function smartDeleteSelection() {
  const selectedRows = getVisibleSelectedRows();
  if (selectedRows.length > 0) {
    await deleteRows(selectedRows, { invoker: document.activeElement });
    return;
  }

  const table = getEditableTable();
  if (!table) {
    return;
  }

  if (selectedCell) {
    const row = visibleRows[selectedCell.rowIndex];
    const column = table.columns.find((candidate) => candidate.name === selectedCell.columnName);
    if (row && column && column.canUpdate !== false && !column.readOnly && !(row.values[column.name] instanceof Uint8Array)) {
      const confirmed = await confirmDestructiveAction(createConfirmationModel({
        kind: 'cell',
        tableName: table.name,
        columnName: column.name,
        rowNumber: getVisibleRowOffset() + selectedCell.rowIndex + 1,
      }), document.activeElement);
      if (confirmed) {
        await updateCell(table, row, column, null, row.values[column.name]);
        elements.status.textContent = `Cleared ${column.name}${buildAutoCommitStatusSuffix()}`;
      }
    }
    return;
  }

  if (selectedRow !== null) {
    await deleteRows([visibleRows[selectedRow]].filter(Boolean), { invoker: document.activeElement });
  }
}

function getVisibleSelectedRows() {
  return getSelectedVisibleRows({ visibleRows, selectedRowKeys });
}

function updateSelectionUi() {
  const selectedCount = getVisibleSelectedRows().length;
  const table = getActiveTable();
  if (elements.deleteSelectedRows) {
    elements.deleteSelectedRows.disabled = !table || table.type !== 'table' || selectedCount === 0;
    elements.deleteSelectedRows.textContent = selectedCount > 0
      ? `Delete selected (${selectedCount.toLocaleString()})`
      : 'Delete selected';
  }
}

async function copyGridCell(rowIndex, columnName) {
  const row = visibleRows[rowIndex];
  if (!row) {
    return;
  }

  const value = row.values[columnName];
  await writeClipboardText(getCellClipboardText(value));
  elements.status.textContent = `Copied ${columnName}`;
}

async function copyRows(format) {
  const table = getActiveTable();
  if (!table || visibleRows.length === 0) {
    return;
  }

  const selectedVisibleRows = getVisibleSelectedRows();
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
  await writeClipboardText(content);
  const label = ROW_COPY_FORMATS.find((item) => item.value === format)?.label ?? format;
  elements.status.textContent = usedSelection
    ? `Copied ${rows.length.toLocaleString()} selected ${rows.length === 1 ? 'row' : 'rows'} as ${label}`
    : `Copied ${rows.length.toLocaleString()} ${rows.length === 1 ? 'row' : 'rows'} as ${label}`;
}

async function writeClipboardText(text) {
  vscode.postMessage({ type: 'clipboardWrite', text });
}

async function readClipboardText() {
  const requestId = String(++clipboardRequestId);
  vscode.postMessage({ type: 'clipboardRead', requestId });
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      pendingClipboardReads.delete(requestId);
      resolve('');
    }, 2000);
    pendingClipboardReads.set(requestId, {
      resolve: (text) => {
        window.clearTimeout(timeout);
        resolve(text);
      },
    });
  });
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
    const state = getSelectAllRowsState({ visibleRows, selectedRowKeys });
    if (state.checked || state.indeterminate) {
      for (const row of visibleRows) {
        selectedRowKeys.delete(getRowSelectionKey(row.identity));
      }
    } else {
      for (const row of visibleRows) {
        selectedRowKeys.add(getRowSelectionKey(row.identity));
      }
    }
    syncRenderedSelectionState();
    postCopilotSelectionContext();
    return;
  }

  const selectRow = event.target.closest('[data-select-row]');
  if (selectRow) {
    event.stopPropagation();
    const rowIndex = Number(selectRow.dataset.selectRow);
    const row = visibleRows[rowIndex];
    if (row) {
      toggleRowSelection(rowIndex, { range: event.shiftKey, additive: true });
      selectGridRow(rowIndex);
      syncRenderedSelectionState();
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
    selectGridRow(rowIndex);
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
      toggleRowSelection(rowIndex, { range: event.shiftKey, additive: event.metaKey || event.ctrlKey || event.shiftKey });
      selectGridRow(rowIndex);
      syncRenderedSelectionState();
      return;
    }
    selectGridCell(rowIndex, gridCell.dataset.gridCellColumn);
    return;
  }

  const row = event.target.closest('tr[data-row]');
  if (row) {
    const rowIndex = Number(row.dataset.row);
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      toggleRowSelection(rowIndex, { range: event.shiftKey, additive: event.metaKey || event.ctrlKey || event.shiftKey });
      selectGridRow(rowIndex);
      syncRenderedSelectionState();
      return;
    }
    selectGridRow(rowIndex);
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
  const table = getActiveTable();
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
  if (!tableName || !tables.some((table) => table.name === tableName)) {
    return;
  }
  activeTableName = tableName;
  selectedSchemaObject = schemaObjects.find((object) => object.name === tableName) ?? null;
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
  const object = schemaObjects.find((candidate) => candidate.type === type && candidate.name === name);
  if (!object) {
    return;
  }
  selectedSchemaObject = object;
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
      exportVisibleCsv();
      break;
    case 'import-csv':
      await csvImportWorkflow.requestImport();
      break;
    case 'export-sql':
      exportSqlDump();
      break;
    case 'save-database':
      requestSave();
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

function confirmDestructiveAction(model, invoker = document.activeElement) {
  return showConfirmation({
    model,
    invoker,
    fallbackFocus: () => elements.grid.querySelector("[data-row], [data-action]") ?? elements.dataRefresh,
  });
}

async function applySchemaChange(sql, {
  nextActiveTableName = activeTableName,
  nextSchemaObject = selectedSchemaObject,
} = {}) {
  try {
    runWrite(db, sql);
    activeTableName = nextActiveTableName;
    selectedSchemaObject = nextSchemaObject;
    markChanged();
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

function exportVisibleCsv() {
  const table = getActiveTable();
  if (!table) {
    return;
  }

  const columns = table.columns.map((column) => column.name);
  const rows = visibleRows.map((row) => row.values);
  vscode.postMessage({
    type: 'saveText',
    kind: 'csv',
    fileName: `${safeFileName(`${databaseName}-${table.name}`)}.csv`,
    content: toCsv(columns, rows),
  });
}

function exportSqlDump() {
  if (!db) {
    return;
  }
  const transition = transitionSqlExport(sqlExportState, {
    type: 'start',
    databaseName,
    revision: currentRevision,
  });
  sqlExportState = transition.state;
  if (!transition.handled) {
    return;
  }
  vscode.postMessage(transition.message);
  updatePager();
}

function handleSqlExportFinished(message) {
  const transition = transitionSqlExport(sqlExportState, {
    ...message,
    type: 'finish',
  });
  if (!transition.handled) {
    return;
  }
  sqlExportState = transition.state;
  if (transition.statusMessage) {
    elements.status.textContent = transition.statusMessage;
  }
  updatePager();
}

function updatePager() {
  const table = getActiveTable();
  const pager = getPagerState({
    page,
    pageSize,
    filteredRows: totalRows,
    totalRows: table?.rowCount ?? totalRows,
    autoPagination: editorSettings.autoPagination,
    loadedRows: visibleRows.length,
  });
  elements.pageLabel.textContent = `${pager.label}`;
  elements.pageRowCount.textContent = table
    ? table.rowCount === null
      ? `${formatRowCount(null)} · ${visibleRows.length.toLocaleString()} loaded`
      : editorSettings.maxRows > 0 && table.rowCount > totalRows
      ? `${totalRows.toLocaleString()} of ${table.rowCount.toLocaleString()} rows shown`
      : `${table.rowCount.toLocaleString()} row${table.rowCount !== 1 ? 's' : ''} total`
    : '';
  elements.previousPage.disabled = !pager.canGoPrevious;
  elements.nextPage.disabled = !pager.canGoNext;
  elements.previousPage.classList.toggle('hidden', editorSettings.autoPagination);
  elements.nextPage.classList.toggle('hidden', editorSettings.autoPagination);
  const editable = table?.type === 'table';
  const selectedSchemaTable = getSelectedSchemaObject()?.type === 'table' ? table : null;
  const schemaEditable = selectedSchemaTable?.name === table?.name && editable;
  elements.addRow.disabled = !editable;
  elements.importCsv.disabled = !editable;
  elements.deleteSelectedRows.disabled = !editable || getVisibleSelectedRows().length === 0;
  elements.renameTable.disabled = !schemaEditable;
  elements.addColumn.disabled = !schemaEditable;
  elements.dropColumn.disabled = !schemaEditable || table.columns.length === 0;
  elements.dropTable.disabled = !schemaEditable;
  elements.exportCsv.disabled = !table;
  const sqlExportUi = getSqlExportUiState(sqlExportState, { hasTables: tables.length > 0 });
  elements.exportSql.disabled = sqlExportUi.disabled;
  elements.exportSql.textContent = sqlExportUi.label;
}

function getActiveTable() {
  return tables.find((table) => table.name === activeTableName) ?? null;
}

function getSelectedSchemaObject() {
  return schemaObjects.find((object) => (
    object.type === selectedSchemaObject?.type && object.name === selectedSchemaObject?.name
  )) ?? null;
}

function getEditableTable() {
  const table = getActiveTable();
  return table?.type === 'table' ? table : null;
}

function markChanged() {
  const exported = db.export();
  const baseRevision = currentRevision;
  currentRevision += 1;
  isDirty = true;
  updateSaveUi();
  vscode.postMessage({
    type: 'databaseChanged',
    label: 'Edit SQLite database',
    baseRevision,
    data: exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength),
  });
  maybeAutoCommit();
}

function reportError(error) {
  const message = getErrorMessage(error);
  elements.status.textContent = message;
  vscode.postMessage({ type: 'error', message });
}
