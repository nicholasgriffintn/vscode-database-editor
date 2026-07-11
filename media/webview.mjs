import {
  DEFAULT_EDITOR_SETTINGS,
  getBlobExportStrategy,
  getDoubleClickEditMode,
  getEffectiveRowWindow,
  getInstantCommitAction,
  normalizeEditorSettings,
} from './editor-settings.mjs';
import { arraysEqual } from './utilities/array.mjs';
import { createElement, createSvgElement, clear } from './utilities/dom.mjs';
import { getErrorMessage } from './utilities/errors.mjs';
import { applyTextEditingShortcut } from './utilities/text-control.mjs';
import {
  createSqlExportState,
  getSqlExportUiState,
  transitionSqlExport,
} from './export-workflows.mjs';
import {
  createRowCountCache,
  createRowCountFilterKey,
  formatRowCount,
  getUnknownCountRowWindow,
  loadTableCountsInBackground,
  resolveUnknownCountRows,
} from './database-metadata.mjs';
import {
  createConfirmationModel,
  createDiscardDraftModel,
  getDestructiveSqlConfirmationDetails,
  requiresDestructiveSqlConfirmation,
  runDialogMutation,
  showConfirmation,
} from './dialog-workflows.mjs';
import {
  describeBlob,
  detectBlobMediaType,
  getBlobFileExtension,
  blobToObjectURL,
  isImageBlob,
} from './blob.mjs';
import { safeFileName } from './utilities/file.mjs';
import {
  getCellInteraction,
  getCellClipboardText,
  getCopilotSelectionContext,
  getGridColumnStyle,
  getObjectItemInteraction,
  getInfiniteRowWindow,
  getInfiniteScrollState,
  getPagerState,
  getPinnedCellStyle,
  getPinnedColumnLayout,
  getPinnedRowOffset,
  getRefreshButtonState,
  getRowActions,
  getRowNumberColumnStyle,
  getRowSelectionKey,
  getShiftedPinnedColumnLeft,
  ROW_NUMBER_COLUMN_WIDTH,
  getSelectedVisibleRows,
  getSelectAllRowsState,
  getTextEditingShortcutAction,
  shouldKeepKeyboardShortcutInField,
} from './grid-ui.mjs';
import {
  getRowFieldState,
  getRowValidationErrors,
  normalizeRowFieldValue,
  rowValuesEqual,
} from './row-detail-ui.mjs';
import {
  addQueryHistoryEntry,
  formatQueryHistoryLabel,
  normalizeQueryHistory,
} from './query-history.mjs';
import { getDirtyStatusText, getSaveButtonState } from './save-state.mjs';
import { getGridColumnCount, getGridEmptyStateKind } from './grid-empty-state.mjs';
import { getEvictedGridResources, getGridRenderPlan } from './grid-window.mjs';
import { createGridWindowSpacer } from './grid-window-view.mjs';
import {
  buildSchemaGraphModel,
  getSchemaGraphEdgePath,
  getSchemaGraphEmptyState,
  layoutSchemaGraph,
} from './schema-graph.mjs';
import { formatSchemaObjectDdl, resolveSchemaSelection } from './schema-object-ui.mjs';
import {
  configureDatabase,
  countTableRows,
  getSchemaObjects,
  queryAll,
  queryGridRows,
  readTableMetadata,
  runSqlScript,
  runWrite,
  runWriteBatch,
} from './sqlite-client.mjs';
import {
  analyzeSqlScript,
  assertSqlScriptCanExport,
  buildRowCopyContent,
  buildDelete,
  buildInsert,
  buildTableSelect,
  buildUpdate,
  describeValue,
  parseCellInput,
  toCsv,
} from './sql.mjs';
import { prepareSqlWorkspaceResults } from './sql-workspace.mjs';
import {
  buildAddColumn,
  buildCreateIndex,
  buildCreateTable,
  buildDropColumn,
  buildDropIndex,
  buildDropTable,
  buildRenameTable,
  parseIndexColumnNames,
} from './schema-management.mjs';

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
let querySql = 'SELECT name, type FROM sqlite_schema ORDER BY type, name;';
let queryHistory = normalizeQueryHistory(webviewState.queryHistory);
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
/** @type {Map<Uint8Array, string>} */
let gridBlobUrls = new Map();
let clipboardRequestId = 0;
const pendingClipboardReads = new Map();
let isRefreshingRows = false;
let isLoadingMoreRows = false;
let infiniteScrollCheckFrame = 0;
let gridWindowRenderFrame = 0;
let lastGridScrollTop = 0;
let isScrollingTowardBottom = true;

const QUERY_RESULT_PREVIEW_LIMIT = 2500;

let refreshRowsDebounceTimer = null;

function getTypeIcon(affinity) {
  switch (affinity) {
    case 'INTEGER': return '#' ;
    case 'TEXT': return 'Aa';
    case 'REAL': return '±';
    case 'BLOB': return '●';
    default: return '?';
  }
}

function getBadgeItems(column) {
  const items = [];
  if (column.keyKind) {
    const isPk = column.keyKind.startsWith('PK');
    items.push({
      label: isPk ? 'PK' : 'FK',
      className: isPk ? 'column-badge column-badge-pk' : 'column-badge column-badge-fk',
      icon: isPk ? '\u{1F511}' : '\u{1F517}',
      title: column.primaryKeyOrder
        ? `Primary key (${column.primaryKeyOrder})`
        : column.foreignKeyTarget
          ? `Foreign key \u2192 ${column.foreignKeyTarget}`
          : column.keyKind,
    });
  } else if (column.indexed) {
    items.push({
      label: 'IDX',
      className: 'column-badge column-badge-idx',
      icon: '\u26A1',
      title: 'Indexed',
    });
  }
  if (column.generated) {
    items.push({
      label: 'GEN',
      className: 'column-badge column-badge-generated',
      icon: null,
      title: `${column.generated === 'stored' ? 'Stored' : 'Virtual'} generated column · read-only`,
    });
  }
  items.push({
    label: getTypeIcon(column.affinity || column.type?.[0] || '?'),
    className: 'column-badge column-badge-type',
    icon: null,
    title: column.type || column.affinity || 'ANY',
  });
  return items;
}

const elements = buildShell();
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
  }
});

function buildShell() {
  const title = createElement('div', { className: 'title', text: 'Loading SQLite database...' });
  const status = createElement('div', { className: 'status', text: 'Waiting for file' });
  const saveButton = createElement('button', {
    className: 'toolbar-button primary save-button',
    text: 'Save',
    title: 'Save database (Ctrl+S / Cmd+S)',
    attributes: { type: 'button', 'data-action': 'save-database', disabled: 'true' },
  });

  const dataTab = createElement('button', {
    className: 'tab active',
    text: 'Data',
    attributes: { type: 'button', 'data-view': 'data' },
  });
  const schemaTab = createElement('button', {
    className: 'tab',
    text: 'Schema',
    attributes: { type: 'button', 'data-view': 'schema' },
  });
  const queryTab = createElement('button', {
    className: 'tab',
    text: 'SQL',
    attributes: { type: 'button', 'data-view': 'query' },
  });

  const sidebar = createElement('aside', { className: 'sidebar' });
  const objectRefresh = createElement('button', {
    className: 'icon-button object-refresh-button',
    text: '\u21BB',
    title: 'Refresh tables, views, indexes, and triggers',
    attributes: {
      type: 'button',
      'aria-label': 'Refresh database objects',
      'data-action': 'refresh-objects',
      disabled: 'true',
    },
  });
  const filterInput = createElement('input', {
    className: 'filter-input',
    attributes: { type: 'search', placeholder: 'Filter rows' },
  });
  const dataRefresh = createElement('button', {
    className: 'toolbar-button',
    text: 'Refresh data',
    title: 'Refresh rows for the selected table or view',
    attributes: { type: 'button', 'data-action': 'refresh-data', disabled: 'true' },
  });
  const pageSizeSelect = createElement('select', { className: 'page-size' });
  renderPageSizeOptions(pageSizeSelect);

  const previousPage = createElement('button', {
    className: 'icon-button',
    text: '\u25C0',
    title: 'Previous page',
    attributes: { type: 'button', 'data-action': 'previous-page' },
  });
  const nextPage = createElement('button', {
    className: 'icon-button',
    text: '\u25B6',
    title: 'Next page',
    attributes: { type: 'button', 'data-action': 'next-page' },
  });
  const pageLabel = createElement('span', { className: 'page-label' });
  const pageRowCount = createElement('span', { className: 'page-row-count' });
  const addRow = createElement('button', {
    className: 'toolbar-button',
    text: 'New row',
    title: 'Insert row',
    attributes: { type: 'button', 'data-action': 'add-row' },
  });
  const exportCsv = createElement('button', {
    className: 'toolbar-button',
    text: 'Export CSV',
    title: 'Export visible rows as CSV',
    attributes: { type: 'button', 'data-action': 'export-csv' },
  });
  const exportSql = createElement('button', {
    className: 'toolbar-button',
    text: 'Export SQL',
    title: 'Export database as SQL dump',
    attributes: { type: 'button', 'data-action': 'export-sql' },
  });
  const copyRowsFormat = createElement('select', {
    className: 'copy-format',
    title: 'Copy selected rows, or visible rows if no rows are selected',
    attributes: { 'aria-label': 'Copy rows as format' },
  });
  copyRowsFormat.append(createElement('option', {
    text: 'Copy rows as…',
    attributes: { value: '' },
  }));
  for (const format of ROW_COPY_FORMATS) {
    copyRowsFormat.append(createElement('option', {
      text: format.label,
      attributes: { value: format.value },
    }));
  }
  const deleteSelectedRows = createElement('button', {
    className: 'toolbar-button danger',
    text: 'Delete selected',
    title: 'Delete selected rows',
    attributes: { type: 'button', 'data-action': 'delete-selected-rows', disabled: 'true' },
  });
  const grid = createElement('div', { className: 'grid-wrap' });
  const pager = createElement('footer', {
    className: 'grid-footer',
    children: [
      pageRowCount,
      pageSizeSelect,
      previousPage,
      pageLabel,
      nextPage,
    ],
  });
  const newTable = createElement('button', {
    className: 'toolbar-button primary',
    text: 'New table',
    attributes: { type: 'button', 'data-action': 'new-table' },
  });
  const renameTable = createElement('button', {
    className: 'toolbar-button',
    text: 'Rename table',
    attributes: { type: 'button', 'data-action': 'rename-table' },
  });
  const addColumn = createElement('button', {
    className: 'toolbar-button',
    text: 'Add column',
    attributes: { type: 'button', 'data-action': 'add-column' },
  });
  const dropColumn = createElement('button', {
    className: 'toolbar-button',
    text: 'Drop column',
    attributes: { type: 'button', 'data-action': 'drop-column' },
  });
  const dropTable = createElement('button', {
    className: 'toolbar-button danger',
    text: 'Drop table',
    attributes: { type: 'button', 'data-action': 'drop-table' },
  });
  const createIndex = createElement('button', {
    className: 'toolbar-button',
    text: 'Create index',
    attributes: { type: 'button', 'data-action': 'create-index' },
  });
  const dropIndex = createElement('button', {
    className: 'toolbar-button danger',
    text: 'Drop index',
    attributes: { type: 'button', 'data-action': 'drop-index', disabled: 'true' },
  });
  const schema = createElement('pre', { className: 'schema-view hidden' });
  const schemaGraph = createElement('div', { className: 'schema-graph-wrap' });
  const schemaGraphButton = createElement('button', {
    className: 'segmented-button active',
    text: 'Graph',
    attributes: { type: 'button', 'data-action': 'schema-view-graph' },
  });
  const schemaDdlButton = createElement('button', {
    className: 'segmented-button',
    text: 'DDL',
    attributes: { type: 'button', 'data-action': 'schema-view-ddl' },
  });
  const schemaGraphFit = createElement('button', {
    className: 'toolbar-button',
    text: 'Fit',
    title: 'Reset the graph scroll position to the top-left bounds',
    attributes: { type: 'button', 'data-action': 'schema-graph-fit' },
  });
  const schemaGraphLayout = createElement('button', {
    className: 'toolbar-button',
    text: 'Auto layout',
    title: 'Recompute the schema graph layout',
    attributes: { type: 'button', 'data-action': 'schema-graph-layout' },
  });
  const schemaGraphSummary = createElement('div', { className: 'schema-graph-summary' });
  const schemaPanel = createElement('section', {
    className: 'schema-panel hidden',
    children: [
      createElement('div', {
        className: 'schema-header',
        children: [
          createElement('div', {
            className: 'schema-heading-copy',
            children: [
              createElement('div', { className: 'schema-heading-title', text: 'Schema tools' }),
              createElement('div', {
                className: 'schema-heading-description',
                text: 'Visualize table relationships, manage the selected table, or inspect generated SQLite definitions.',
              }),
            ],
          }),
          createElement('div', { className: 'schema-toolbar', children: [newTable, renameTable, addColumn, dropColumn, dropTable, createIndex, dropIndex] }),
        ],
      }),
      createElement('div', {
        className: 'schema-subtoolbar',
        children: [
          createElement('div', { className: 'schema-view-switch', children: [schemaGraphButton, schemaDdlButton] }),
          schemaGraphSummary,
          createElement('span', { className: 'toolbar-spacer' }),
          schemaGraphFit,
          schemaGraphLayout,
        ],
      }),
      createElement('div', { className: 'schema-body', children: [schemaGraph, schema] }),
    ],
  });
  const queryInput = createElement('textarea', {
    className: 'query-input',
    attributes: { spellcheck: 'false' },
  });
  queryInput.value = querySql;
  const runQuery = createElement('button', {
    className: 'toolbar-button primary',
    text: 'Run',
    attributes: { type: 'button', 'data-action': 'run-query' },
  });
  const queryHistorySelect = createElement('select', {
    className: 'query-history',
    title: 'Load a previous SQL script',
    attributes: { 'aria-label': 'Query history' },
  });
  const queryMessage = createElement('div', { className: 'query-message' });
  const queryOutput = createElement('div', { className: 'query-output' });
  const query = createElement('section', {
    className: 'query-view hidden',
    children: [
      createElement('div', {
        className: 'query-header',
        children: [
          createElement('div', {
            className: 'schema-heading-copy',
            children: [
              createElement('div', { className: 'schema-heading-title', text: 'SQL workspace' }),
              createElement('div', {
                className: 'schema-heading-description',
                text: 'Run SQL statements, inspect result sets, and save database changes when ready.',
              }),
            ],
          }),
          createElement('div', { className: 'query-toolbar', children: [queryHistorySelect, runQuery] }),
        ],
      }),
      createElement('div', { className: 'query-editor', children: [queryInput, queryMessage] }),
      queryOutput,
    ],
  });
  const data = createElement('section', {
    className: 'data-view',
    children: [
      createElement('div', {
        className: 'toolbar',
        children: [
          filterInput,
          dataRefresh,
          createElement('span', { className: 'toolbar-spacer' }),
          exportCsv,
          exportSql,
          copyRowsFormat,
          addRow,
          deleteSelectedRows,
        ],
      }),
      grid,
      pager,
    ],
  });

  app.replaceChildren(
    createElement('header', {
      className: 'topbar',
      children: [
        createElement('div', { className: 'title-block', children: [title, status] }),
        createElement('nav', { className: 'tabs', children: [dataTab, schemaTab, queryTab] }),
        saveButton,
      ],
    }),
    createElement('main', {
      className: 'workspace',
      children: [
        sidebar,
        createElement('div', { className: 'content', children: [data, schemaPanel, query] }),
      ],
    }),
  );

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
      scheduleGridWindowRender();
      scheduleInfiniteScrollCheck();
    } else if (nextScrollTop < lastGridScrollTop) {
      isScrollingTowardBottom = false;
      scheduleGridWindowRender();
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
    querySql = queryInput.value;
  });
  queryHistorySelect.addEventListener('change', () => {
    const selectedIndex = Number(queryHistorySelect.value);
    if (Number.isInteger(selectedIndex) && queryHistory[selectedIndex]) {
      setQuerySql(queryHistory[selectedIndex]);
      setQueryMessage('Loaded query from history.');
    }
    queryHistorySelect.value = '';
  });
  renderQueryHistory(queryHistorySelect);
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

  return {
    title,
    status,
    saveButton,
    tabs: [dataTab, schemaTab, queryTab],
    sidebar,
    objectRefresh,
    filterInput,
    dataRefresh,
    previousPage,
    nextPage,
    pageLabel,
    pageRowCount,
    pageSizeSelect,
    addRow,
    exportCsv,
    exportSql,
    copyRowsFormat,
    deleteSelectedRows,
    newTable,
    renameTable,
    addColumn,
    dropColumn,
    dropTable,
    createIndex,
    dropIndex,
    grid,
    pager,
    schema,
    schemaGraph,
    schemaGraphButton,
    schemaDdlButton,
    schemaGraphFit,
    schemaGraphLayout,
    schemaGraphSummary,
    schemaPanel,
    data,
    query,
    queryInput,
    queryHistorySelect,
    queryMessage,
    queryOutput,
  };
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
    renderSidebar();
    focusObjectSearch();
  }
}

async function openDatabase(name, data, { dirty = false, revision = 0, resetViewState = true } = {}) {
  try {
    elements.status.textContent = 'Opening database...';
    SQL ??= await initSqlJs({ locateFile: () => wasmUri });
    const nextDatabase = new SQL.Database(new Uint8Array(data));
    configureDatabase(nextDatabase);
    for (const url of gridBlobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    gridBlobUrls.clear();
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
  const sizes = [...new Set([50, 100, 250, 500, 1000, editorSettings.defaultPageSize])]
    .filter((size) => Number.isInteger(size) && size > 0)
    .sort((left, right) => left - right);
  select.replaceChildren(...sizes.map((size) => createElement('option', {
    text: `${size.toLocaleString()} rows`,
    attributes: { value: String(size), selected: size === pageSize ? 'selected' : undefined },
  })));
  select.value = String(pageSize);
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
  renderSidebar();
  renderSchema();
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
  renderSidebar();
  renderSchema();
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
    onLoaded: () => renderSidebar(),
    onError: (table) => {
      table.rowCount = undefined;
      renderSidebar();
    },
  }).then(() => {
    if (generation === metadataLoadGeneration && revision === currentRevision) {
      renderSchemaGraph();
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
      renderSidebar();
      renderSchemaGraph();
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
    renderGrid();
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
  renderGrid();
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
      appendGridRows(startIndex);
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
    appendGridRows(startIndex);
    if (nextRows.length < rowWindow.limit) {
      totalRows = visibleRows.length;
    }
    updatePager();
    scheduleInfiniteScrollCheck();
  } catch (error) {
    visibleRows.length = startIndex;
    renderGrid();
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

function renderSidebar() {
  const previousScrollTop = elements.sidebar.scrollTop;
  clear(elements.sidebar);
  const search = createElement('input', {
    className: 'object-search',
    attributes: {
      type: 'search',
      placeholder: 'Search objects',
      value: objectFilter,
      'data-object-search': 'true',
    },
  });
  elements.sidebar.append(createElement('div', {
    className: 'object-search-wrap',
    children: [search, elements.objectRefresh],
  }));

  appendObjectSection('Tables', tables.filter((table) => table.type === 'table'));
  appendObjectSection('Views', tables.filter((table) => table.type === 'view'));
  appendObjectSection('Indexes', schemaObjects.filter((object) => object.type === 'index'));
  appendObjectSection('Triggers', schemaObjects.filter((object) => object.type === 'trigger'));
  elements.sidebar.scrollTop = previousScrollTop;
}

function appendObjectSection(label, objects) {
  const visibleObjects = objects.filter((object) => matchesObjectFilter(object));
  if (visibleObjects.length === 0) {
    return;
  }

  elements.sidebar.append(createElement('div', { className: 'sidebar-heading', text: label }));
  for (const object of visibleObjects) {
    const interaction = getObjectItemInteraction({
      objectType: object.type,
      objectName: object.name,
      tableName: object.tableName,
    });
    const isSelected = object.type === selectedSchemaObject?.type && object.name === selectedSchemaObject?.name;
    const className = [
      isSelected ? 'object-item active' : 'object-item',
      interaction.browsable ? '' : 'secondary',
    ].filter(Boolean).join(' ');
    const attributes = interaction.browsable
      ? { type: 'button', 'data-table': object.name }
      : interaction.selectable
        ? { type: 'button', 'data-schema-object': object.name, 'data-schema-object-type': object.type }
        : {};
    const tagName = interaction.selectable ? 'button' : 'div';
    const meta = interaction.browsable
      ? formatRowCount(object.rowCount, {
        loading: object.type === 'table' && object.rowCount === null,
      })
      : object.tableName;
    elements.sidebar.append(createElement(tagName, {
      className,
      title: interaction.title,
      attributes,
      children: [
        createElement('span', { className: 'object-name', text: object.name }),
        createElement('span', { className: 'object-meta', text: meta }),
      ],
    }));
  }
}

function matchesObjectFilter(object) {
  const normalized = objectFilter.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return [object.name, object.type, object.tableName]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

function focusObjectSearch() {
  const search = elements.sidebar.querySelector('[data-object-search]');
  search?.focus();
  search?.setSelectionRange?.(objectFilter.length, objectFilter.length);
}

function focusColumnFilter(columnName) {
  const input = elements.grid.querySelector(`[data-column-filter="${CSS.escape(columnName)}"]`);
  const valueLength = input?.value.length ?? 0;
  input?.focus();
  input?.setSelectionRange?.(valueLength, valueLength);
}

function renderSchema() {
  const schemaObject = getSelectedSchemaObject();
  elements.dropIndex.disabled = schemaObject?.type !== 'index';
  elements.createIndex.disabled = !tables.some((candidate) => candidate.type === 'table');
  if (schemaObject && (schemaObject.type === 'index' || schemaObject.type === 'trigger')) {
    elements.schema.textContent = formatSchemaObjectDdl(schemaObject);
    renderSchemaGraph();
    setActiveSchemaView(activeSchemaView);
    return;
  }
  const table = getActiveTable();
  if (!table) {
    elements.schema.textContent = 'No schema available.';
    renderSchemaGraph();
    setActiveSchemaView(activeSchemaView);
    return;
  }

  const columnLines = table.columns.map((column) => {
    const parts = [
      `- ${column.name}`,
      column.type ? `type ${column.type}` : 'type ANY',
      column.nullable ? 'nullable' : 'not null',
      column.primaryKeyOrder ? `primary key ${column.primaryKeyOrder}` : null,
      column.defaultValue === null || column.defaultValue === undefined ? null : `default ${column.defaultValue}`,
    ].filter(Boolean);
    return parts.join(' · ');
  });
  const foreignKeyLines = table.foreignKeys.map((key) => (
    `- ${key.from} -> ${key.table}.${key.to || 'rowid'} on update ${key.on_update ?? 'NO ACTION'} on delete ${key.on_delete ?? 'NO ACTION'}`
  ));
  const indexLines = table.indexes.map((index) => `- ${index.name}\n${index.sql}`);
  const triggerLines = table.triggers.map((trigger) => `- ${trigger.name}\n${trigger.sql}`);

  elements.schema.textContent = [
    `${table.type.toUpperCase()} ${table.name}`,
    '',
    table.sql || 'No CREATE statement available.',
    '',
    'Columns',
    columnLines.join('\n') || '- none',
    '',
    'Foreign keys',
    foreignKeyLines.join('\n') || '- none',
    '',
    'Indexes',
    indexLines.join('\n\n') || '- none',
    '',
    'Triggers',
    triggerLines.join('\n\n') || '- none',
  ].join('\n');
  renderSchemaGraph();
  setActiveSchemaView(activeSchemaView);
}

function renderSchemaGraph() {
  const emptyState = getSchemaGraphEmptyState(tables);
  const model = layoutSchemaGraph(buildSchemaGraphModel(tables));
  const relationshipLabel = `${model.edges.length.toLocaleString()} ${model.edges.length === 1 ? 'relationship' : 'relationships'}`;
  elements.schemaGraphSummary.textContent = tables.length === 0
    ? 'No tables'
    : `${tables.length.toLocaleString()} ${tables.length === 1 ? 'object' : 'objects'} · ${relationshipLabel}`;
  elements.schemaGraphFit.disabled = tables.length === 0;
  elements.schemaGraphLayout.disabled = tables.length === 0;

  if (emptyState?.kind === 'no-tables') {
    elements.schemaGraph.replaceChildren(buildSchemaGraphEmptyState(emptyState));
    return;
  }

  const svg = createSvgElement('svg', {
    className: 'schema-graph',
    attributes: {
      role: 'img',
      'aria-label': 'SQLite schema relationship graph',
      viewBox: `0 0 ${model.bounds.width} ${model.bounds.height}`,
      width: String(model.bounds.width),
      height: String(model.bounds.height),
    },
  });
  svg.append(buildSchemaGraphDefs());

  const edgeLayer = createSvgElement('g', { className: 'schema-graph-edges' });
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  for (const edge of model.edges) {
    const sourceNode = nodeById.get(edge.sourceTable);
    const targetNode = nodeById.get(edge.targetTable);
    if (!sourceNode || !targetNode) {
      continue;
    }

    const path = createSvgElement('path', {
      className: 'schema-graph-edge',
      attributes: {
        d: getSchemaGraphEdgePath({ edge, sourceNode, targetNode }),
        'marker-end': 'url(#schema-graph-arrow)',
      },
    });
    path.append(createSvgElement('title', { text: buildSchemaGraphEdgeTitle(edge) }));
    edgeLayer.append(path);
  }
  svg.append(edgeLayer);

  const nodeLayer = createSvgElement('g', { className: 'schema-graph-nodes' });
  for (const node of model.nodes) {
    nodeLayer.append(renderSchemaGraphNode(node));
  }
  svg.append(nodeLayer);

  const children = [];
  if (emptyState?.kind === 'no-relationships') {
    children.push(buildSchemaGraphEmptyState(emptyState, { compact: true }));
  }
  if (model.skippedEdgeCount > 0) {
    children.push(createElement('div', {
      className: 'schema-graph-note',
      text: `${model.skippedEdgeCount.toLocaleString()} foreign-key ${model.skippedEdgeCount === 1 ? 'edge points' : 'edges point'} to missing tables and ${model.skippedEdgeCount === 1 ? 'was' : 'were'} hidden.`,
    }));
  }
  children.push(svg);
  elements.schemaGraph.replaceChildren(...children);
}

function buildSchemaGraphEmptyState(state, { compact = false } = {}) {
  return createElement('div', {
    className: compact ? 'schema-graph-empty compact' : 'schema-graph-empty',
    children: [
      createElement('div', { className: 'schema-graph-empty-title', text: state.title }),
      createElement('div', { className: 'schema-graph-empty-description', text: state.description }),
    ],
  });
}

function buildSchemaGraphDefs() {
  const defs = createSvgElement('defs');
  const marker = createSvgElement('marker', {
    className: 'schema-graph-arrow-marker',
    attributes: {
      id: 'schema-graph-arrow',
      viewBox: '0 0 10 10',
      refX: '9',
      refY: '5',
      markerWidth: '7',
      markerHeight: '7',
      orient: 'auto-start-reverse',
    },
  });
  marker.append(createSvgElement('path', { attributes: { d: 'M 0 0 L 10 5 L 0 10 z' } }));
  defs.append(marker);
  return defs;
}

function renderSchemaGraphNode(node) {
  const group = createSvgElement('g', {
    className: [
      'schema-graph-node',
      node.tableType === 'view' ? 'view-node' : 'table-node',
      node.tableName === activeTableName ? 'active' : '',
    ].filter(Boolean).join(' '),
    attributes: {
      transform: `translate(${node.x} ${node.y})`,
      tabindex: '0',
      role: 'button',
      'data-schema-graph-table': node.tableName,
      'aria-label': `${node.tableType} ${node.tableName}`,
    },
  });
  group.append(createSvgElement('title', { text: `${node.tableType} ${node.tableName} · ${formatRowCount(node.rowCount)}` }));
  group.append(createSvgElement('rect', {
    className: 'schema-graph-card',
    attributes: { width: String(node.width), height: String(node.height), rx: '10', ry: '10' },
  }));
  group.append(createSvgElement('rect', {
    className: 'schema-graph-card-header',
    attributes: { width: String(node.width), height: '34', rx: '10', ry: '10' },
  }));
  group.append(createSvgElement('text', {
    className: 'schema-graph-table-name',
    text: node.tableName,
    attributes: { x: '12', y: '22' },
  }));
  group.append(createSvgElement('text', {
    className: 'schema-graph-table-meta',
    text: node.tableType === 'view' ? 'VIEW' : formatRowCount(node.rowCount),
    attributes: { x: String(node.width - 12), y: '22', 'text-anchor': 'end' },
  }));

  node.columns.forEach((column, index) => {
    const y = 34 + (index * 24);
    const row = createSvgElement('g', { className: 'schema-graph-column-row' });
    row.append(createSvgElement('rect', {
      attributes: { x: '0', y: String(y), width: String(node.width), height: '24' },
    }));
    if (column.foreignKey) {
      row.append(createSvgElement('circle', {
        className: 'schema-graph-handle source',
        attributes: { cx: String(node.width), cy: String(y + 12), r: '3.5' },
      }));
    }
    row.append(createSvgElement('circle', {
      className: 'schema-graph-handle target',
      attributes: { cx: '0', cy: String(y + 12), r: '3' },
    }));
    row.append(createSvgElement('text', {
      className: 'schema-graph-column-name',
      text: column.name,
      attributes: { x: '12', y: String(y + 16) },
    }));
    const badges = [];
    if (column.primaryKey) badges.push('PK');
    if (column.foreignKey) badges.push('FK');
    if (!column.nullable) badges.push('NN');
    row.append(createSvgElement('text', {
      className: `schema-graph-column-type${column.primaryKey ? ' pk' : ''}${column.foreignKey ? ' fk' : ''}`,
      text: [badges.join(' '), column.type || 'ANY'].filter(Boolean).join(' · '),
      attributes: { x: String(node.width - 12), y: String(y + 16), 'text-anchor': 'end' },
    }));
    row.append(createSvgElement('title', {
      text: [
        column.name,
        column.type || 'ANY',
        column.primaryKey ? 'primary key' : null,
        column.foreignKey ? 'foreign key' : null,
        column.nullable ? 'nullable' : 'not null',
      ].filter(Boolean).join(' · '),
    }));
    group.append(row);
  });

  return group;
}

function buildSchemaGraphEdgeTitle(edge) {
  return [
    `${edge.sourceTable}.${edge.sourceColumn} → ${edge.targetTable}.${edge.targetColumn}`,
    edge.onUpdate ? `ON UPDATE ${edge.onUpdate}` : null,
    edge.onDelete ? `ON DELETE ${edge.onDelete}` : null,
  ].filter(Boolean).join(' · ');
}

function fitSchemaGraph() {
  elements.schemaGraph.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
}

function getVisibleRowOffset() {
  return editorSettings.autoPagination ? 0 : (page - 1) * pageSize;
}

function renderGrid({ bodyOnly = false } = {}) {
  const table = getActiveTable();
  if (!table) {
    return;
  }

  elements.copyRowsFormat.disabled = visibleRows.length === 0;

  const retainedBlobUrlKeys = new Set();

  const pinnedColStyles = getPinnedColumnLayout({
    columns: table.columns,
    pinnedColumns,
    columnWidths,
    rowNumberWidth: columnWidths.__rowNumber || ROW_NUMBER_COLUMN_WIDTH,
  });
  const rowNumberStyle = getRowNumberColumnStyle({ columnWidth: columnWidths.__rowNumber });
  const selectAllState = getSelectAllRowsState({ visibleRows, selectedRowKeys });

  let tableElement = bodyOnly ? elements.grid.querySelector('.data-grid') : null;
  if (!tableElement) {
    tableElement = createElement('table', { className: 'data-grid' });
    const thead = createElement('thead');
    const headerRow = createElement('tr', { className: 'column-heading-row' });
    const filterRow = createElement('tr', { className: 'column-filter-row' });

    const selectAllCheckbox = createElement('input', {
      className: 'row-select-checkbox',
      title: selectAllState.checked ? 'Deselect visible rows' : 'Select visible rows',
      attributes: {
        type: 'checkbox',
        'data-select-all-rows': 'true',
        checked: selectAllState.checked ? 'true' : undefined,
        disabled: visibleRows.length === 0 ? 'true' : undefined,
        'aria-label': 'Select all visible rows',
      },
    });
    headerRow.append(createElement('th', {
      className: 'row-number-header',
      style: rowNumberStyle,
      children: [
        createElement('div', {
          className: 'column-header',
          children: [
            selectAllCheckbox,
            createElement('span', { className: 'column-name row-number-heading-label', text: '#' }),
          ],
        }),
        createElement('div', {
          className: 'col-resize-handle',
          attributes: { 'data-resize-column': '__rowNumber' },
        }),
      ],
    }));
    filterRow.append(createElement('th', {
      className: 'row-number-header',
      style: rowNumberStyle,
      text: '',
    }));

    for (const column of table.columns) {
      const isPinned = pinnedColumns.has(column.name);
      const colWidth = columnWidths[column.name];

      const sortMarker = sortColumn === column.name ? (sortDirection === 'asc' ? ' \u25B2' : ' \u25BC') : '';
      const colStyle = isPinned
        ? getPinnedCellStyle({ columnLayout: pinnedColStyles[column.name], zIndex: 45 })
        : getGridColumnStyle({ columnWidth: colWidth });
      headerRow.append(createElement('th', {
        className: isPinned ? 'pinned' : '',
        style: colStyle,
        children: [
          createElement('div', {
            className: 'column-header',
            title: buildColumnTitle(column),
            children: [
              createElement('button', {
                className: 'column-sort-button',
                attributes: { type: 'button', 'data-sort-column': column.name },
                children: [
                  createElement('span', { className: 'column-name', text: `${column.name}${sortMarker}` }),
                ],
              }),
              createElement('span', {
                className: 'column-badges',
                children: [
                  ...getColumnBadges(column),
                  createElement('button', {
                    className: `pin-button${isPinned ? ' pinned' : ''}`,
                    text: '\u{1F4CC}',
                    title: isPinned ? 'Unpin column' : 'Pin column to left',
                    attributes: { type: 'button', 'data-pin-column': column.name },
                  }),
                ],
              }),
            ],
          }),
          createElement('div', {
            className: 'col-resize-handle',
            attributes: { 'data-resize-column': column.name },
          }),
        ],
      }));
      const filterStyle = isPinned
        ? getPinnedCellStyle({ columnLayout: pinnedColStyles[column.name], zIndex: 42 })
        : getGridColumnStyle({ columnWidth: colWidth });
      filterRow.append(createElement('th', {
        className: isPinned ? 'pinned' : '',
        style: filterStyle,
        children: [
          createElement('input', {
            className: 'column-filter-input',
            attributes: {
              type: 'search',
              placeholder: 'Filter',
              value: columnFilters[column.name] ?? '',
              'data-column-filter': column.name,
            },
          }),
        ],
      }));
    }

    if (table.type === 'table') {
      headerRow.append(createElement('th', {
        children: [
          createElement('div', {
            className: 'column-header row-actions-heading',
            children: [
              createElement('span', { className: 'column-name', text: 'actions' }),
            ],
          }),
        ],
      }));
      filterRow.append(createElement('th', { className: 'row-actions-filter-heading', text: '' }));
    }

    thead.append(headerRow, filterRow);
    tableElement.append(thead);
  }

  const columnCount = getGridColumnCount({ columnCount: table.columns.length, tableType: table.type });
  const tbody = createElement('tbody');

  const visibleRowOffset = getVisibleRowOffset();
  const gridWindow = getGridRenderPlan({
    rowCount: visibleRows.length,
    rowOffset: visibleRowOffset,
    scrollTop: elements.grid.scrollTop,
    viewportHeight: elements.grid.clientHeight,
    pinnedRows,
  });

  if (visibleRows.length === 0) {
    tbody.append(createElement('tr', {
      children: [
        createElement('td', {
          className: 'grid-empty-cell',
          attributes: { colspan: String(columnCount) },
          children: [buildGridEmptyState(table)],
        }),
      ],
    }));
  }

  for (let renderIndex = 0; renderIndex < gridWindow.rows.length; renderIndex += 1) {
    if (renderIndex === gridWindow.pinnedRowIndexes.length && gridWindow.topSpacerHeight > 0) {
      tbody.append(createGridWindowSpacer({ columnCount, height: gridWindow.topSpacerHeight }));
    }
    const rowPlan = gridWindow.rows[renderIndex];
    const { rowIndex, realRowIndex, isPinned: isRowPinned } = rowPlan;
    const row = visibleRows[rowIndex];
    const rowSelectionKey = getRowSelectionKey(row.identity);
    const isRowSelectedForBatch = selectedRowKeys.has(rowSelectionKey);
    const pinnedRowOffset = isRowPinned
      ? getPinnedRowOffset({ pinnedIndex: rowPlan.pinnedIndex })
      : undefined;
    const tr = createElement('tr', {
      className: [
        selectedRow === rowIndex ? 'selected-row' : '',
        isRowSelectedForBatch ? 'multi-selected-row' : '',
        isRowPinned ? 'pinned-row' : '',
      ].filter(Boolean).join(' '),
      attributes: { 'data-row': String(rowIndex) },
    });

    const rowNumCell = createElement('td', {
      className: [
        'row-number-cell',
        isRowPinned ? 'pinned-row-cell' : '',
      ].filter(Boolean).join(' '),
      style: getPinnedCellStyle({
        columnLayout: { style: rowNumberStyle },
        rowOffset: isRowPinned ? pinnedRowOffset : undefined,
        zIndex: isRowPinned ? 20 : undefined,
      }),
      children: [
        createElement('div', {
          className: 'row-number-content',
          children: [
            createElement('input', {
              className: 'row-select-checkbox',
              title: isRowSelectedForBatch ? 'Deselect row' : 'Select row',
              attributes: {
                type: 'checkbox',
                'data-select-row': String(rowIndex),
                checked: isRowSelectedForBatch ? 'true' : undefined,
                'aria-label': `Select row ${realRowIndex + 1}`,
              },
            }),
            createElement('span', { className: 'row-number-text', text: String(realRowIndex + 1) }),
            createElement('button', {
              className: `row-pin-button${isRowPinned ? ' pinned' : ''}`,
              title: isRowPinned ? 'Unpin row' : 'Pin row to top',
              attributes: { type: 'button', 'data-pin-row': String(rowIndex), 'aria-label': isRowPinned ? `Unpin row ${realRowIndex + 1}` : `Pin row ${realRowIndex + 1}` },
              children: [
                createElement('span', {
                  className: `row-pin-icon${isRowPinned ? ' pinned' : ''}`,
                  text: '\u{1F4CC}',
                }),
              ],
            }),
          ],
        }),
      ],
    });
    tr.append(rowNumCell);

    for (const column of table.columns) {
      const value = row.values[column.name];
      const interaction = getCellInteraction({ tableType: table.type, column, value });
      const isPinned = pinnedColumns.has(column.name);
      const colWidth = columnWidths[column.name];

      const isImage = isImageBlob(value);
      let imageURL = null;
      if (isImage) {
        const blobUrlKey = value;
        imageURL = gridBlobUrls.get(blobUrlKey) ?? blobToObjectURL(value);
        gridBlobUrls.set(blobUrlKey, imageURL);
        retainedBlobUrlKeys.add(blobUrlKey);
      }
      const cellChildren = isImage && imageURL
        ? [
            createElement('button', {
              className: 'cell-button',
              attributes: {
                type: 'button',
                'data-cell-row': String(rowIndex),
                'data-cell-column': column.name,
                disabled: interaction.disabled ? 'true' : undefined,
              },
              children: [
                createElement('img', {
                  className: 'blob-image-inline',
                  attributes: {
                    src: imageURL,
                    alt: describeBlob(value),
                    title: describeBlob(value),
                  },
                }),
              ],
            }),
          ]
        : [
            createElement('button', {
              className: 'cell-button',
              text: value instanceof Uint8Array ? describeBlob(value) : describeValue(value),
              title: interaction.title,
              attributes: {
                type: 'button',
                'data-cell-row': String(rowIndex),
                'data-cell-column': column.name,
                disabled: interaction.disabled ? 'true' : undefined,
              },
            }),
          ];

      const columnLayout = isPinned
        ? pinnedColStyles[column.name]
        : { style: getGridColumnStyle({ columnWidth: colWidth }) };
      const cellStyle = getPinnedCellStyle({
        columnLayout,
        rowOffset: isRowPinned ? pinnedRowOffset : undefined,
        zIndex: isRowPinned && isPinned ? 20 : (isRowPinned ? 8 : (isPinned ? 5 : undefined)),
      });
      const cell = createElement('td', {
        className: [
          value === null || value === undefined ? 'null-cell' : '',
          interaction.disabled ? '' : 'editable-cell',
          isPinned ? 'pinned' : '',
          isRowPinned ? 'pinned-row-cell' : '',
          isImage ? 'blob-image-cell' : '',
          selectedCell?.rowIndex === rowIndex && selectedCell?.columnName === column.name ? 'selected-cell' : '',
        ].filter(Boolean).join(' '),
        style: cellStyle,
        attributes: {
          'data-grid-cell-row': String(rowIndex),
          'data-grid-cell-column': column.name,
        },
        children: cellChildren,
      });
      tr.append(cell);
    }

    const rowActions = getRowActions({ tableType: table.type, rowIndex });
    if (rowActions.length > 0) {
      tr.append(createElement('td', {
        className: [
          'row-actions-cell',
          isRowPinned ? 'pinned-row-cell' : '',
        ].filter(Boolean).join(' '),
        style: getPinnedCellStyle({
          rowOffset: isRowPinned ? pinnedRowOffset : undefined,
          zIndex: isRowPinned ? 8 : undefined,
        }),
        children: [
          createElement('div', {
            className: 'row-action-group',
            children: rowActions.map((action) => createElement('button', {
              className: action.action === 'delete-row' ? 'row-action-button danger' : 'row-action-button',
              text: action.action === 'delete-row' ? 'Delete' : 'Edit',
              title: action.label,
              attributes: {
                type: 'button',
                'data-action': action.action,
                'data-action-row': String(action.rowIndex),
                disabled: action.disabled ? 'true' : undefined,
              },
            })),
          }),
        ],
      }));
    }

    tbody.append(tr);
  }
  if (gridWindow.bottomSpacerHeight > 0) {
    tbody.append(createGridWindowSpacer({ columnCount, height: gridWindow.bottomSpacerHeight }));
  }

  if (bodyOnly && tableElement.querySelector('tbody')) {
    tableElement.querySelector('tbody').replaceWith(tbody);
  } else {
    tableElement.append(tbody);
    elements.grid.replaceChildren(tableElement);
  }
  for (const key of getEvictedGridResources(gridBlobUrls.keys(), retainedBlobUrlKeys)) {
    URL.revokeObjectURL(gridBlobUrls.get(key));
    gridBlobUrls.delete(key);
  }
  const renderedSelectAll = elements.grid.querySelector('[data-select-all-rows]');
  if (renderedSelectAll) {
    renderedSelectAll.checked = selectAllState.checked;
    renderedSelectAll.indeterminate = selectAllState.indeterminate;
    renderedSelectAll.disabled = visibleRows.length === 0;
    renderedSelectAll.title = selectAllState.checked ? 'Deselect visible rows' : 'Select visible rows';
  }
  updateSelectionUi();
}

function appendGridRows() {
  renderGrid({ bodyOnly: true });
}

function scheduleGridWindowRender() {
  if (gridWindowRenderFrame) {
    return;
  }
  gridWindowRenderFrame = window.requestAnimationFrame(() => {
    gridWindowRenderFrame = 0;
    renderGrid({ bodyOnly: true });
  });
}

function buildGridEmptyState(table) {
  const kind = getGridEmptyStateKind({
    tableType: table.type,
    columnCount: table.columns.length,
    rowCount: visibleRows.length,
  });

  if (kind === 'view-no-columns') {
    return createElement('div', { className: 'empty-state', text: 'This view has no columns.' });
  }

  if (kind === 'view-no-rows') {
    return createElement('div', { className: 'empty-state', text: 'No rows to show.' });
  }

  if (kind === 'table-no-columns') {
    return createElement('div', {
      className: 'empty-state grid-empty-state',
      children: [
        createElement('div', { className: 'empty-state-title', text: 'This table has no columns yet.' }),
        createElement('div', {
          className: 'empty-state-description',
          text: 'Add a column to start entering data.',
        }),
        createElement('button', {
          className: 'toolbar-button primary',
          text: 'Add column',
          attributes: { type: 'button', 'data-action': 'add-column' },
        }),
      ],
    });
  }

  return createElement('div', {
    className: 'empty-state grid-empty-state',
    children: [
      createElement('div', { className: 'empty-state-title', text: 'No rows yet.' }),
      createElement('div', {
        className: 'empty-state-description',
        text: 'Insert a row or add another column to this table.',
      }),
      createElement('div', {
        className: 'empty-state-actions',
        children: [
          createElement('button', {
            className: 'toolbar-button primary',
            text: 'New row',
            attributes: { type: 'button', 'data-action': 'add-row' },
          }),
          createElement('button', {
            className: 'toolbar-button',
            text: 'Add column',
            attributes: { type: 'button', 'data-action': 'add-column' },
          }),
        ],
      }),
    ],
  });
}

function getColumnBadges(column) {
  return getBadgeItems(column).map((item) => {
    const children = [];
    if (item.icon) {
      children.push(createElement('span', { className: 'column-badge-icon', text: item.icon }));
    }
    children.push(createElement('span', { text: item.label }));
    return createElement('span', {
      className: item.className,
      title: item.title,
      children,
    });
  });
}

function buildColumnTitle(column) {
  return [
    column.type || 'ANY',
    column.primaryKeyOrder ? `Primary key (order ${column.primaryKeyOrder})` : null,
    column.generated ? `${column.generated === 'stored' ? 'Stored' : 'Virtual'} generated column · read-only` : null,
    column.foreignKeyTarget ? `Foreign key \u2192 ${column.foreignKeyTarget}` : null,
    column.indexed ? 'Indexed' : null,
    column.nullable ? 'Nullable' : 'Not null',
    column.defaultValue !== undefined ? `Default: ${column.defaultValue}` : null,
  ].filter(Boolean).join(' \u00B7 ');
}

function rememberRenderedColumnWidths() {
  const gridEl = elements.grid?.querySelector?.('.data-grid');
  if (!gridEl) {
    return;
  }

  const rowNumberHeader = gridEl.querySelector('.column-heading-row .row-number-header');
  const rowNumberWidth = Math.round(rowNumberHeader?.offsetWidth ?? 0);
  if (rowNumberWidth > 0) {
    columnWidths.__rowNumber = rowNumberWidth;
  }

  for (const handle of gridEl.querySelectorAll('[data-resize-column]')) {
    const columnName = handle.dataset.resizeColumn;
    const headerCell = handle.closest('th');
    const width = Math.round(headerCell?.offsetWidth ?? 0);
    if (columnName && width > 0) {
      columnWidths[columnName] = width;
    }
  }
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
    rememberRenderedColumnWidths();
    const columnName = pinButton.dataset.pinColumn;
    if (pinnedColumns.has(columnName)) {
      pinnedColumns.delete(columnName);
    } else {
      pinnedColumns.add(columnName);
    }
    renderGrid();
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
    renderGrid({ bodyOnly: true });
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
    showInlineCellEditor(rowIndex, columnName);
    return;
  }

  showRowDetails(rowIndex, columnName);
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
  renderSidebar();
  renderSchema();
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
  renderSidebar();
  renderSchema();
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
      showRowDetails(Number(sourceElement?.dataset.actionRow));
      break;
    case 'delete-row':
      await deleteRowAt(Number(sourceElement?.dataset.actionRow), sourceElement);
      break;
    case 'delete-selected-rows':
      await deleteSelectedRows(sourceElement);
      break;
    case 'add-row':
      showInsertDialog();
      break;
    case 'run-query':
      await runSqlWorkspace();
      break;
    case 'export-csv':
      exportVisibleCsv();
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
      fitSchemaGraph();
      break;
    case 'schema-graph-layout':
      renderSchemaGraph();
      fitSchemaGraph();
      break;
    case 'new-table':
      showCreateTableDialog();
      break;
    case 'rename-table':
      showRenameTableDialog();
      break;
    case 'add-column':
      showAddColumnDialog();
      break;
    case 'drop-column':
      showDropColumnDialog();
      break;
    case 'drop-table':
      await dropActiveTable(sourceElement);
      break;
    case 'create-index':
      showCreateIndexDialog();
      break;
    case 'drop-index':
      await dropSelectedIndex(sourceElement);
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

function showInlineCellEditor(rowIndex, columnName) {
  const table = getEditableTable();
  const row = visibleRows[rowIndex];
  const column = table?.columns.find((candidate) => candidate.name === columnName);
  if (!table || !row || !column || column.canUpdate === false || column.readOnly || row.values[column.name] instanceof Uint8Array) {
    showRowDetails(rowIndex, columnName);
    return;
  }

  const cell = elements.grid.querySelector(`[data-grid-cell-row="${CSS.escape(String(rowIndex))}"][data-grid-cell-column="${CSS.escape(columnName)}"]`);
  if (!cell) {
    return;
  }

  selectGridCell(rowIndex, columnName);
  const previousValue = row.values[column.name];
  const editor = createElement('textarea', {
    className: 'inline-cell-editor',
    attributes: {
      rows: String(Math.max(1, Math.min(4, String(previousValue ?? '').split('\n').length))),
      spellcheck: 'false',
      'aria-label': `Edit ${columnName}`,
    },
  });
  editor.value = previousValue === null || previousValue === undefined ? '' : String(previousValue);
  let committed = false;

  async function commit() {
    if (committed) {
      return;
    }
    committed = true;
    await updateCell(table, row, column, editor.value, previousValue);
  }

  function cancel() {
    if (committed) {
      return;
    }
    committed = true;
    renderGrid();
  }

  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      void commit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  });
  editor.addEventListener('blur', cancel);
  cell.replaceChildren(editor);
  editor.focus();
  editor.select();
}

function showRowDetails(rowIndex, initialColumnName = null) {
  const invoker = document.activeElement;
  const table = getActiveTable();
  if (!table || table.type !== 'table' || Number.isNaN(rowIndex)) {
    return;
  }

  const row = visibleRows[rowIndex];
  const dialog = createElement('dialog', { className: 'row-dialog' });
  const form = createElement('form', { className: 'row-dialog-form', attributes: { method: 'dialog' } });
  const absoluteRowNumber = rowIndex + 1 + getVisibleRowOffset();
  const title = createElement('div', {
    className: 'row-dialog-title-block',
    children: [
      createElement('div', { className: 'row-dialog-kicker', text: table.name }),
      createElement('div', { className: 'row-dialog-title', text: `Row ${absoluteRowNumber}` }),
    ],
  });
  const previous = createElement('button', {
    className: 'icon-button',
    text: '<',
    title: 'Previous row',
    attributes: { type: 'button', disabled: rowIndex <= 0 ? 'true' : undefined },
  });
  const next = createElement('button', {
    className: 'icon-button',
    text: '>',
    title: 'Next row',
    attributes: { type: 'button', disabled: rowIndex >= visibleRows.length - 1 ? 'true' : undefined },
  });

  const validationSummary = createElement('div', {
    className: 'validation-summary hidden',
    attributes: { role: 'alert' },
  });
  const fields = createElement('div', { className: 'row-fields' });
  const blobPreviewUrls = [];
  for (const column of table.columns) {
    const value = row.values[column.name];
    const isBlob = value instanceof Uint8Array;
    const readOnly = isBlob || column.canUpdate === false || column.readOnly;
    const control = isBlob
      ? createBlobPreview({
          tableName: table.name,
          rowIndex,
          columnName: column.name,
          value,
          previewUrls: blobPreviewUrls,
        })
      : createElement('textarea', {
          className: 'row-field-input',
          attributes: {
            name: column.name,
            rows: String(Math.max(1, Math.min(8, String(value ?? '').split('\n').length))),
            spellcheck: 'false',
            'data-column': column.name,
            readonly: readOnly ? 'true' : undefined,
          },
        });
    if (!isBlob) {
      control.value = value === null || value === undefined ? '' : String(value);
    }

    const nullToggle = createElement('input', {
      attributes: {
        type: 'checkbox',
        'data-null-column': column.name,
        checked: value === null || value === undefined ? 'true' : undefined,
        disabled: readOnly ? 'true' : undefined,
      },
    });
    const dirtyMarker = createElement('span', {
      className: 'dirty-marker hidden',
      text: 'Modified',
    });
    const reset = createElement('button', {
      className: 'field-reset-button',
      text: 'Reset',
      attributes: {
        type: 'button',
        'data-reset-column': column.name,
        disabled: 'true',
      },
    });
    fields.append(createElement('div', {
      className: 'row-field',
      attributes: { 'data-field-column': column.name },
      children: [
        createElement('div', {
          className: 'row-field-label-wrap',
          children: [
            createElement('span', {
              className: 'row-field-label',
              text: column.name,
              title: `${column.type || 'value'}${column.primaryKeyOrder ? ' primary key' : ''}`,
            }),
            createElement('span', {
              className: 'row-field-meta',
              text: buildRowFieldMeta(column),
            }),
          ],
        }),
        control,
        createElement('div', {
          className: 'row-field-actions',
          children: [
            dirtyMarker,
            createElement('label', {
              className: 'null-toggle',
              children: [nullToggle, createElement('span', { text: 'NULL' })],
            }),
            reset,
          ],
        }),
      ],
    }));
  }

  const cancel = createElement('button', {
    className: 'toolbar-button',
    text: 'Cancel',
    attributes: { type: 'button' },
  });
  const save = createElement('button', {
    className: 'toolbar-button primary',
    text: 'Save changes',
    attributes: { type: 'submit' },
  });
  const remove = createElement('button', {
    className: 'toolbar-button danger',
    text: 'Delete row',
    attributes: { type: 'button' },
  });
  form.append(
    createElement('header', { className: 'row-dialog-header', children: [previous, title, next] }),
    validationSummary,
    fields,
    createElement('div', { className: 'dialog-actions', children: [remove, createElement('span', { className: 'toolbar-spacer' }), cancel, save] }),
  );
  dialog.append(form);
  document.body.append(dialog);

  let hasDirtyDraft = false;
  const updateDirtyState = () => {
    hasDirtyDraft = updateRowDialogState({ table, row, form, validationSummary, save }).dirty;
  };
  const closeOrNavigate = async ({ destination, nextRowIndex = null, invoker = null }) => {
    if (hasDirtyDraft) {
      const confirmed = await confirmDestructiveAction(createDiscardDraftModel({
        tableName: table.name,
        rowNumber: absoluteRowNumber,
        destination,
      }), invoker);
      if (!confirmed) {
        return false;
      }
    }
    dialog.close();
    if (nextRowIndex !== null) {
      showRowDetails(nextRowIndex, initialColumnName);
    }
    return true;
  };

  previous.addEventListener('click', () => {
    void closeOrNavigate({
      destination: `moving to row ${absoluteRowNumber - 1}`,
      nextRowIndex: rowIndex - 1,
      invoker: previous,
    });
  });
  next.addEventListener('click', () => {
    void closeOrNavigate({
      destination: `moving to row ${absoluteRowNumber + 1}`,
      nextRowIndex: rowIndex + 1,
      invoker: next,
    });
  });
  fields.addEventListener('input', updateDirtyState);
  fields.addEventListener('change', updateDirtyState);
  fields.addEventListener('click', (event) => {
    const resetButton = event.target.closest?.('[data-reset-column]');
    if (!resetButton) {
      return;
    }

    resetRowField({ form, row, columnName: resetButton.dataset.resetColumn });
    updateDirtyState();
  });
  updateDirtyState();

  cancel.addEventListener('click', () => {
    void closeOrNavigate({ destination: 'closing this dialog', invoker: cancel });
  });
  remove.addEventListener('click', async () => {
    const result = await deleteRowAt(rowIndex, remove);
    if (result.deleted) {
      dialog.close();
    } else if (result.error) {
      renderDialogMutationError(validationSummary, result.error);
    }
  });
  dialog.addEventListener('cancel', (event) => {
    if (!hasDirtyDraft) {
      return;
    }
    event.preventDefault();
    void closeOrNavigate({ destination: 'closing this dialog', invoker: cancel });
  });
  dialog.addEventListener('close', () => {
    for (const url of blobPreviewUrls) {
      URL.revokeObjectURL(url);
    }
    dialog.remove();
    const focusTarget = invoker?.isConnected
      ? invoker
      : elements.grid.querySelector(`[data-row="${CSS.escape(String(Math.min(rowIndex, visibleRows.length - 1)))}"] button`);
    focusTarget?.focus?.();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await saveRowDetails(table, row, form, validationSummary);
    if (result.saved) {
      dialog.close();
    }
  });
  dialog.addEventListener('keydown', (event) => {
    if (shouldKeepKeyboardShortcutInField({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      targetTagName: event.target?.tagName,
    })) {
      event.stopPropagation();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  dialog.showModal();

  const initialInput = initialColumnName
    ? form.querySelector(`[data-column="${CSS.escape(initialColumnName)}"]`)
    : form.querySelector('[data-column]');
  initialInput?.focus();
  initialInput?.select?.();
}

function buildRowFieldMeta(column) {
  return [
    column.type || 'ANY',
    column.nullable ? 'nullable' : 'not null',
    column.primaryKeyOrder ? 'primary key' : null,
    column.generated ? `${column.generated} generated` : null,
    column.foreignKeyTarget ? `FK ${column.foreignKeyTarget}` : null,
  ].filter(Boolean).join(' · ');
}

function getCurrentRowFieldValue({ form, column }) {
  const input = form.elements.namedItem(column.name);
  if (!input) {
    return undefined;
  }

  const nullInput = form.querySelector(`[data-null-column="${CSS.escape(column.name)}"]`);
  return normalizeRowFieldValue({ inputValue: input.value, nullChecked: nullInput?.checked ?? false });
}

function updateRowDialogState({ table, row, form, validationSummary, save }) {
  const validationFields = [];
  let hasDirtyFields = false;
  for (const column of table.columns) {
    const field = form.querySelector(`[data-field-column="${CSS.escape(column.name)}"]`);
    const input = form.elements.namedItem(column.name);
    const readOnly = !input || input.readOnly;
    if (!field) {
      continue;
    }

    const nextValue = getCurrentRowFieldValue({ form, column });
    const state = getRowFieldState({
      previousValue: row.values[column.name],
      nextValue,
      readOnly,
    });
    hasDirtyFields ||= state.dirty;
    field.classList.toggle('dirty', state.dirty);
    field.querySelector('.dirty-marker')?.classList.toggle('hidden', !state.dirty);
    const reset = field.querySelector('[data-reset-column]');
    if (reset) {
      reset.disabled = state.resetDisabled;
    }
    validationFields.push({ column, value: nextValue, readOnly });
  }

  const errors = getRowValidationErrors(validationFields);
  renderValidationSummary(validationSummary, errors);
  save.disabled = errors.length > 0 || !hasDirtyFields;
  return { dirty: hasDirtyFields, errors };
}

function resetRowField({ form, row, columnName }) {
  const input = form.elements.namedItem(columnName);
  const nullInput = form.querySelector(`[data-null-column="${CSS.escape(columnName)}"]`);
  if (!input) {
    return;
  }

  const previousValue = row.values[columnName];
  input.value = previousValue === null || previousValue === undefined ? '' : String(previousValue);
  if (nullInput) {
    nullInput.checked = previousValue === null || previousValue === undefined;
  }
}

function renderValidationSummary(validationSummary, errors) {
  if (errors.length === 0) {
    validationSummary.classList.add('hidden');
    validationSummary.replaceChildren();
    return;
  }

  validationSummary.classList.remove('hidden');
  validationSummary.replaceChildren(
    createElement('strong', { text: 'Fix validation errors before saving:' }),
    createElement('ul', {
      children: errors.map((error) => createElement('li', { text: error })),
    }),
  );
}

function renderDialogMutationError(errorRegion, message) {
  errorRegion.classList.remove('hidden');
  errorRegion.replaceChildren(
    createElement('strong', { text: 'The change could not be saved:' }),
    createElement('div', { text: message }),
  );
}

function createBlobPreview({ tableName, rowIndex, columnName, value, previewUrls }) {
  const mediaType = detectBlobMediaType(value);
  const children = [];
  if (mediaType?.startsWith('image/')) {
    const url = URL.createObjectURL(new Blob([value], { type: mediaType }));
    previewUrls.push(url);
    children.push(createElement('img', {
      className: 'blob-image-preview',
      attributes: { src: url, alt: `${columnName} preview` },
    }));
  }

  const download = createElement('button', {
    className: 'toolbar-button',
    text: 'Export BLOB',
    attributes: { type: 'button' },
  });
  download.addEventListener('click', () => exportBlobValue({ tableName, rowIndex, columnName, value }));

  children.push(
    createElement('span', { className: 'blob-description', text: describeBlob(value) }),
    download,
  );

  return createElement('div', {
    className: 'blob-preview',
    children,
  });
}

function exportBlobValue({ tableName, rowIndex, columnName, value }) {
  const extension = getBlobFileExtension(value);
  const fileName = safeFileName(`${databaseName}-${tableName}-${rowIndex + 1}-${columnName}.${extension}`);
  if (getBlobExportStrategy({ configured: editorSettings.blobExportMode }) === 'web') {
    const mediaType = detectBlobMediaType(value) || 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([value], { type: mediaType }));
    const link = createElement('a', {
      attributes: { href: url, download: fileName },
    });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    elements.status.textContent = `Downloaded ${fileName}`;
    return;
  }

  vscode.postMessage({
    type: 'saveBinary',
    kind: 'blob',
    fileName,
    content: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  });
}

async function saveRowDetails(table, row, form, validationSummary) {
  const updates = [];
  const validationFields = [];
  try {
    for (const column of table.columns) {
      const input = form.elements.namedItem(column.name);
      if (!input || input.readOnly) {
        validationFields.push({ column, value: undefined, readOnly: true });
        continue;
      }
      const previousValue = row.values[column.name];
      const nextValue = getCurrentRowFieldValue({ form, column });
      validationFields.push({ column, value: nextValue, readOnly: false });
      if (rowValuesEqual(previousValue, nextValue)) {
        continue;
      }
      const update = buildUpdate({
        tableName: table.name,
        columnName: column.name,
        column,
        identity: row.identity,
        primaryKeyColumns: table.primaryKeyColumns,
        rowidAlias: table.rowidAlias,
      });
      updates.push({
        sql: update.sql,
        params: [parseCellInput(nextValue, column, previousValue), ...update.identityParams],
        expectedRowsModified: 1,
      });
    }

    const validationErrors = getRowValidationErrors(validationFields);
    if (validationErrors.length > 0) {
      renderValidationSummary(validationSummary, validationErrors);
      return { saved: false };
    }

    if (updates.length === 0) {
      return { saved: true };
    }

    runWriteBatch(db, updates);

    markChanged();
    await refreshRows();
    return { saved: true };
  } catch (error) {
    const message = getErrorMessage(error);
    renderDialogMutationError(validationSummary, message);
    elements.status.textContent = message;
    return { saved: false };
  }
}

async function updateCell(table, row, column, input, previousValue) {
  try {
    const parsed = parseCellInput(input, column, previousValue);
    const update = buildUpdate({
      tableName: table.name,
      columnName: column.name,
      column,
      identity: row.identity,
      primaryKeyColumns: table.primaryKeyColumns,
      rowidAlias: table.rowidAlias,
    });
    runWrite(db, update.sql, [parsed, ...update.identityParams], { expectedRowsModified: 1 });
    markChanged();
    await refreshRows();
  } catch (error) {
    reportError(error);
    renderGrid();
  }
}

async function deleteRowAt(rowIndex, invoker = null) {
  const table = getEditableTable();
  const row = visibleRows[rowIndex];
  if (!table || !row) {
    return { deleted: false };
  }
  return deleteRows([row], {
    invoker,
    model: createConfirmationModel({
      kind: 'row',
      tableName: table.name,
      rowNumber: getVisibleRowOffset() + rowIndex + 1,
    }),
  });
}

async function deleteSelectedRows(invoker = null) {
  return deleteRows(getVisibleSelectedRows(), { invoker });
}

function confirmDestructiveAction(model, invoker = document.activeElement) {
  return showConfirmation({
    model,
    invoker,
    fallbackFocus: () => elements.grid.querySelector('[data-row], [data-action]') ?? elements.dataRefresh,
  });
}

async function deleteRows(rows, { invoker = null, model = null } = {}) {
  const table = getActiveTable();
  if (!table || table.type === 'view' || rows.length === 0) {
    return { deleted: false };
  }

  const count = rows.length;
  const singleRowIndex = count === 1 ? visibleRows.indexOf(rows[0]) : -1;
  const confirmation = model ?? createConfirmationModel({
    kind: count === 1 ? 'row' : 'rows',
    tableName: table.name,
    rowNumber: singleRowIndex >= 0 ? getVisibleRowOffset() + singleRowIndex + 1 : 1,
    count,
  });
  if (!(await confirmDestructiveAction(confirmation, invoker))) {
    return { deleted: false };
  }

  const statements = rows.map((row) => {
    const deletion = buildDelete({
      tableName: table.name,
      identity: row.identity,
      primaryKeyColumns: table.primaryKeyColumns,
      rowidAlias: table.rowidAlias,
    });
    return { sql: deletion.sql, params: deletion.params, expectedRowsModified: 1 };
  });

  try {
    runWriteBatch(db, statements);
    markChanged();
    clearSelectedRows();
    await refreshTables();
    elements.status.textContent = `Deleted ${count.toLocaleString()} ${count === 1 ? 'row' : 'rows'}`;
    return { deleted: true };
  } catch (error) {
    const message = getErrorMessage(error);
    reportError(error);
    return { deleted: false, error: message };
  }
}

function showInsertDialog() {
  const invoker = document.activeElement;
  const table = getActiveTable();
  if (!table || table.type === 'view') {
    return;
  }

  const dialog = createElement('dialog', { className: 'insert-dialog' });
  const form = createElement('form', { attributes: { method: 'dialog' } });
  form.append(
    createElement('h2', { text: `Insert row into ${table.name}` }),
    createElement('div', { className: 'insert-fields' }),
  );

  const fields = form.querySelector('.insert-fields');
  const insertableColumns = table.columns.filter((column) => column.canInsert !== false && !column.generated && !column.hidden);
  for (const column of insertableColumns) {
    const input = createElement('input', {
      attributes: {
        type: 'text',
        name: column.name,
        placeholder: column.defaultValue === null || column.defaultValue === undefined
          ? ''
          : `default ${column.defaultValue}`,
      },
    });
    const nullInput = createElement('input', {
      attributes: { type: 'checkbox', 'data-null-column': column.name },
    });
    fields.append(createElement('label', {
      className: 'insert-field',
      children: [
        createElement('span', { text: `${column.name}${column.type ? ` (${column.type})` : ''}` }),
        input,
        createElement('span', { className: 'null-toggle', children: [nullInput, createElement('span', { text: 'NULL' })] }),
      ],
    }));
  }

  const cancel = createElement('button', {
    className: 'toolbar-button',
    text: 'Cancel',
    attributes: { type: 'button' },
  });
  const submit = createElement('button', {
    className: 'toolbar-button primary',
    text: 'Insert',
    attributes: { type: 'submit' },
  });
  const errorRegion = createElement('div', {
    className: 'validation-summary hidden',
    attributes: { role: 'alert' },
  });
  form.append(
    errorRegion,
    createElement('div', { className: 'dialog-actions', children: [cancel, submit] }),
  );
  dialog.append(form);
  document.body.append(dialog);

  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    const focusTarget = invoker?.isConnected ? invoker : elements.addRow;
    focusTarget?.focus?.();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await runDialogMutation({
      submitButton: submit,
      errorRegion,
      operation: () => insertRow(table, form),
    });
    if (result.ok) {
      dialog.close();
    }
  });
  dialog.showModal();
  form.querySelector('input:not([type="checkbox"]), select, textarea')?.focus();
}

async function insertRow(table, form) {
  try {
    const values = {};
    for (const column of table.columns.filter((candidate) => candidate.canInsert !== false && !candidate.generated && !candidate.hidden)) {
      const input = form.elements.namedItem(column.name);
      const nullInput = form.querySelector(`[data-null-column="${CSS.escape(column.name)}"]`);
      if (nullInput.checked) {
        values[column.name] = null;
      } else if (input.value !== '') {
        values[column.name] = parseCellInput(input.value, column, '');
      }
    }

    const insertion = buildInsert({ tableName: table.name, values, columns: table.columns });
    runWrite(db, insertion.sql, insertion.params, { expectedRowsModified: 1 });
    markChanged();
    await refreshTables();
    return { ok: true };
  } catch (error) {
    const message = getErrorMessage(error);
    elements.status.textContent = message;
    return { ok: false, error: message };
  }
}

function showCreateTableDialog() {
  showSchemaDialog({
    title: 'Create table',
    submitText: 'Create',
    fields: [
      { name: 'tableName', label: 'Table name', required: true },
      { name: 'columnName', label: 'First column', value: 'id', required: true },
      { name: 'type', label: 'Type', value: 'INTEGER', required: true },
      { name: 'primaryKey', label: 'Primary key', type: 'checkbox', checked: true },
      { name: 'notNull', label: 'Not null', type: 'checkbox' },
    ],
    onSubmit: async (values) => applySchemaChange(buildCreateTable({
      tableName: values.tableName,
      columns: [{
        name: values.columnName,
        type: values.type,
        primaryKey: values.primaryKey,
        notNull: values.notNull,
      }],
    }), { nextActiveTableName: values.tableName.trim() }),
  });
}

function showRenameTableDialog() {
  const table = getEditableTable();
  if (!table) {
    return;
  }

  showSchemaDialog({
    title: `Rename ${table.name}`,
    submitText: 'Rename',
    fields: [
      { name: 'newName', label: 'New table name', value: table.name, required: true },
    ],
    onSubmit: async (values) => applySchemaChange(
      buildRenameTable({ oldName: table.name, newName: values.newName }),
      { nextActiveTableName: values.newName.trim() },
    ),
  });
}

function showAddColumnDialog() {
  const table = getEditableTable();
  if (!table) {
    return;
  }

  showSchemaDialog({
    title: `Add column to ${table.name}`,
    submitText: 'Add column',
    fields: [
      { name: 'columnName', label: 'Column name', required: true },
      { name: 'type', label: 'Type', value: 'TEXT', required: true },
      { name: 'defaultValue', label: 'Default value' },
      { name: 'notNull', label: 'Not null', type: 'checkbox' },
      { name: 'unique', label: 'Unique', type: 'checkbox' },
    ],
    onSubmit: async (values) => applySchemaChange(buildAddColumn({
      tableName: table.name,
      column: {
        name: values.columnName,
        type: values.type,
        defaultValue: values.defaultValue,
        notNull: values.notNull,
        unique: values.unique,
      },
    })),
  });
}

function showDropColumnDialog() {
  const table = getEditableTable();
  if (!table) {
    return;
  }

  showSchemaDialog({
    title: `Drop column from ${table.name}`,
    submitText: 'Drop column',
    fields: [
      {
        name: 'columnName',
        label: 'Column',
        type: 'select',
        options: table.columns.map((column) => column.name),
        required: true,
      },
    ],
    onSubmit: async (values) => {
      const confirmed = await confirmDestructiveAction(createConfirmationModel({
        kind: 'column',
        tableName: table.name,
        columnName: values.columnName,
      }), document.activeElement);
      if (!confirmed) {
        return { ok: false, error: '' };
      }
      return applySchemaChange(buildDropColumn({ tableName: table.name, columnName: values.columnName }));
    },
  });
}

async function dropActiveTable(invoker = null) {
  const table = getEditableTable();
  if (!table) {
    return { ok: false };
  }
  const confirmed = await confirmDestructiveAction(createConfirmationModel({
    kind: 'table',
    tableName: table.name,
  }), invoker);
  if (!confirmed) {
    return { ok: false };
  }
  return applySchemaChange(buildDropTable({ tableName: table.name }), { nextActiveTableName: null });
}

function showCreateIndexDialog() {
  const editableTables = tables.filter((table) => table.type === 'table');
  if (editableTables.length === 0) {
    return;
  }
  const initialTable = getEditableTable() ?? editableTables[0];
  showSchemaDialog({
    title: 'Create index',
    submitText: 'Create index',
    fields: [
      { name: 'indexName', label: 'Index name', required: true },
      { name: 'tableName', label: 'Table', type: 'select', options: editableTables.map((table) => table.name), value: initialTable.name, required: true },
      { name: 'columns', label: 'Ordered columns (comma-separated)', value: initialTable.columns[0]?.name ?? '', required: true },
      { name: 'direction', label: 'Sort direction', type: 'select', options: [{ label: 'Default', value: '' }, 'ASC', 'DESC'] },
      { name: 'unique', label: 'Unique', type: 'checkbox' },
    ],
    onSubmit: async (values) => {
      const indexName = values.indexName.trim();
      return applySchemaChange(buildCreateIndex({
        indexName,
        tableName: values.tableName,
        columns: parseIndexColumnNames(values.columns, values.direction),
        unique: values.unique,
      }), {
        nextActiveTableName: values.tableName,
        nextSchemaObject: { type: 'index', name: indexName },
      });
    },
  });
}

async function dropSelectedIndex(invoker = null) {
  const index = getSelectedSchemaObject();
  if (index?.type !== 'index') {
    return { ok: false };
  }
  let sql;
  try {
    sql = buildDropIndex({ indexName: index.name });
  } catch (error) {
    const message = getErrorMessage(error);
    elements.status.textContent = message;
    return { ok: false, error: message };
  }
  const confirmed = await confirmDestructiveAction(createConfirmationModel({
    kind: 'index',
    target: index.name,
  }), invoker);
  if (!confirmed) {
    return { ok: false };
  }
  return applySchemaChange(sql, {
    nextActiveTableName: index.tableName,
    nextSchemaObject: { type: 'table', name: index.tableName },
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

function showSchemaDialog({ title, submitText, fields, onSubmit }) {
  const invoker = document.activeElement;
  const dialog = createElement('dialog', { className: 'insert-dialog schema-dialog' });
  const form = createElement('form', { attributes: { method: 'dialog' } });
  const fieldList = createElement('div', { className: 'insert-fields' });

  for (const field of fields) {
    fieldList.append(createSchemaField(field));
  }

  const cancel = createElement('button', {
    className: 'toolbar-button',
    text: 'Cancel',
    attributes: { type: 'button' },
  });
  const submit = createElement('button', {
    className: 'toolbar-button primary',
    text: submitText,
    attributes: { type: 'submit' },
  });
  const errorRegion = createElement('div', {
    className: 'validation-summary hidden',
    attributes: { role: 'alert' },
  });
  form.append(
    createElement('h2', { text: title }),
    fieldList,
    errorRegion,
    createElement('div', { className: 'dialog-actions', children: [cancel, submit] }),
  );
  dialog.append(form);
  document.body.append(dialog);

  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    const focusTarget = invoker?.isConnected ? invoker : elements.schemaDdlButton;
    focusTarget?.focus?.();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await runDialogMutation({
      submitButton: submit,
      errorRegion,
      operation: () => onSubmit(readSchemaForm(form, fields)),
    });
    if (result.ok) {
      dialog.close();
    }
  });
  dialog.showModal();
  form.querySelector('input:not([type="checkbox"]), select, textarea')?.focus();
}

function createSchemaField(field) {
  let control;
  if (field.type === 'select') {
    control = createElement('select', { attributes: { name: field.name, required: field.required ? 'true' : undefined } });
    for (const option of field.options) {
      const optionValue = typeof option === 'string' ? option : option.value;
      const optionLabel = typeof option === 'string' ? option : option.label;
      control.append(createElement('option', {
        text: optionLabel,
        attributes: { value: optionValue, selected: optionValue === field.value ? 'selected' : undefined },
      }));
    }
    control.value = field.value ?? String(typeof field.options[0] === 'string' ? field.options[0] : field.options[0]?.value ?? '');
  } else if (field.type === 'checkbox') {
    control = createElement('input', {
      attributes: {
        type: 'checkbox',
        name: field.name,
        checked: field.checked ? 'true' : undefined,
      },
    });
  } else {
    control = createElement('input', {
      attributes: {
        type: 'text',
        name: field.name,
        value: field.value,
        required: field.required ? 'true' : undefined,
      },
    });
  }

  return createElement('label', {
    className: 'insert-field',
    children: [
      createElement('span', { text: field.label }),
      control,
    ],
  });
}

function readSchemaForm(form, fields) {
  return Object.fromEntries(fields.map((field) => {
    const control = form.elements.namedItem(field.name);
    return [field.name, field.type === 'checkbox' ? control.checked : control.value];
  }));
}

function setQuerySql(sql) {
  querySql = sql;
  elements.queryInput.value = sql;
  elements.queryInput.focus();
}

function setQueryMessage(message, kind = 'info') {
  elements.queryMessage.textContent = message;
  elements.queryMessage.classList.remove('success', 'warning', 'error');
  if (kind !== 'info') {
    elements.queryMessage.classList.add(kind);
  }
}

function recordQueryHistory(sql) {
  const nextHistory = addQueryHistoryEntry(queryHistory, sql);
  if (nextHistory === queryHistory || arraysEqual(nextHistory, queryHistory)) {
    return;
  }

  queryHistory = nextHistory;
  vscode.setState({
    ...(vscode.getState?.() ?? {}),
    queryHistory,
  });
  renderQueryHistory();
}

function renderQueryHistory(select = elements.queryHistorySelect) {
  if (!select) {
    return;
  }

  const placeholder = createElement('option', {
    text: queryHistory.length === 0 ? 'No history yet' : 'Query history',
    attributes: { value: '' },
  });
  select.replaceChildren(placeholder, ...queryHistory.map((sql, index) => createElement('option', {
    text: formatQueryHistoryLabel(sql),
    title: sql,
    attributes: { value: String(index) },
  })));
  select.value = '';
  select.disabled = queryHistory.length === 0;
}

function getQueryResultPreviewLimit() {
  return editorSettings.maxRows > 0 && editorSettings.maxRows < QUERY_RESULT_PREVIEW_LIMIT
    ? editorSettings.maxRows
    : QUERY_RESULT_PREVIEW_LIMIT;
}

async function runSqlWorkspace() {
  clear(elements.queryOutput);
  setQueryMessage('');

  if (!db) {
    setQueryMessage('Open a database before running SQL.', 'warning');
    return;
  }

  const analysis = analyzeSqlScript(querySql);
  if (analysis.isEmpty) {
    setQueryMessage('Enter a SQL statement to run.', 'warning');
    return;
  }

  if (requiresDestructiveSqlConfirmation(analysis)) {
    const details = getDestructiveSqlConfirmationDetails(analysis) ?? {
      action: 'destructive SQL',
      target: 'the identified SQL target',
    };
    const confirmed = await confirmDestructiveAction(createConfirmationModel({
      kind: 'sql',
      ...details,
    }), document.activeElement);
    if (!confirmed) {
      setQueryMessage('Destructive SQL was not run.', 'warning');
      return;
    }
  }

  recordQueryHistory(querySql);

  try {
    const previewLimit = getQueryResultPreviewLimit();
    const { results, changed } = runSqlScript(db, querySql, analysis, {
      previewLimit,
      timeoutMs: editorSettings.queryTimeoutMs,
    });
    assertSqlScriptCanExport(analysis);
    if (changed) {
      markChanged();
      await refreshTables();
    }

    const prepared = prepareSqlWorkspaceResults({
      results,
      changed,
      previewLimit,
      statementCount: analysis.statementCount,
    });
    setQueryMessage(prepared.message, prepared.kind);
    if (prepared.results.length > 0) {
      for (const result of prepared.results) {
        elements.queryOutput.append(await renderResultTable(result));
      }
    }
  } catch (error) {
    const message = getErrorMessage(error);
    if (error?.databaseChanged) {
      markChanged();
      try {
        await refreshTables();
        setQueryMessage(`${message} · database may have changed`, 'error');
      } catch (refreshError) {
        setQueryMessage(`${message} · database may have changed; refresh failed: ${getErrorMessage(refreshError)}`, 'error');
      }
      return;
    }
    setQueryMessage(message, 'error');
  }
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

async function renderResultTable(result) {
  const tableElement = createElement('table', { className: 'data-grid result-grid' });
  const thead = createElement('thead');
  thead.append(createElement('tr', {
    children: result.columns.map((column) => createElement('th', { text: column })),
  }));
  tableElement.append(thead);

  const tbody = createElement('tbody');
  for (const [index, row] of result.values.entries()) {
    tbody.append(createElement('tr', {
      children: row.map((value) => createElement('td', { text: describeValue(value) })),
    }));
    if (index > 0 && index % 200 === 0) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
  }

  if (result.__truncated) {
    tbody.append(createElement('tr', {
      className: 'query-result-truncated',
      children: [
        createElement('td', {
          attributes: {
            colspan: String(result.columns.length),
          },
          text: `Result truncated after ${result.values.length.toLocaleString()} retained rows; at least ${result.__rowCount.toLocaleString()} rows were available ${result.__truncatedStatementIndex ? `(statement ${result.__truncatedStatementIndex})` : ''}.`,
        }),
      ],
    }));
  }

  tableElement.append(tbody);
  return tableElement;
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
