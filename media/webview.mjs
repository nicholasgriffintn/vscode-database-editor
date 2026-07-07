import { createElement, clear } from './dom-utils.mjs';
import {
  describeBlob,
  detectBlobMediaType,
  getBlobFileExtension,
} from './blob-utils.mjs';
import { safeFileName } from './file-utils.mjs';
import {
  getCellInteraction,
  getPagerState,
  getRowActions,
  shouldKeepKeyboardShortcutInField,
} from './grid-ui.mjs';
import {
  getRowFieldState,
  getRowValidationErrors,
  normalizeRowFieldValue,
  rowValuesEqual,
} from './row-detail-ui.mjs';
import { getDirtyStatusText, getSaveButtonState } from './save-state.mjs';
import {
  getSchemaObjects,
  queryAll,
  readTableMetadata,
  runStatement,
  runWrite,
} from './sqlite-client.mjs';
import {
  buildSqlDump,
  buildDelete,
  buildInsert,
  buildTableCount,
  buildTableSelect,
  buildUpdate,
  describeValue,
  isReadOnlyQuery,
  parseCellInput,
  toCsv,
} from './sql-utils.mjs';
import {
  buildAddColumn,
  buildCreateTable,
  buildDropColumn,
  buildDropTable,
  buildRenameTable,
} from './schema-management.mjs';

const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');
const wasmUri = app.dataset.wasmUri;

let SQL = null;
let db = null;
let databaseName = 'SQLite database';
let tables = [];
let activeTableName = null;
let activeView = 'data';
let filter = '';
let columnFilters = {};
let objectFilter = '';
let sortColumn = null;
let sortDirection = 'asc';
let page = 1;
let pageSize = 100;
let totalRows = 0;
let visibleRows = [];
let selectedRow = null;
let querySql = 'SELECT name, type FROM sqlite_schema ORDER BY type, name;';
let queryResults = [];
let schemaObjects = [];
let isDirty = false;
let isSaving = false;

const elements = buildShell();
vscode.postMessage({ type: 'ready' });

window.addEventListener('message', async (event) => {
  const message = event.data;
  if (message.type === 'loadDatabase') {
    await openDatabase(message.name, message.data);
  } else if (message.type === 'databaseSaved') {
    handleDatabaseSaved();
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
  const filterInput = createElement('input', {
    className: 'filter-input',
    attributes: { type: 'search', placeholder: 'Filter rows' },
  });
  const pageSizeSelect = createElement('select', { className: 'page-size' });
  for (const size of [50, 100, 250, 500]) {
    pageSizeSelect.append(createElement('option', {
      text: `${size} rows`,
      attributes: { value: String(size), selected: size === pageSize ? 'selected' : undefined },
    }));
  }

  const previousPage = createElement('button', {
    className: 'icon-button',
    text: '<',
    title: 'Previous page',
    attributes: { type: 'button', 'data-action': 'previous-page' },
  });
  const nextPage = createElement('button', {
    className: 'icon-button',
    text: '>',
    title: 'Next page',
    attributes: { type: 'button', 'data-action': 'next-page' },
  });
  const pageLabel = createElement('span', { className: 'page-label', text: 'Page 1' });
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
  const grid = createElement('div', { className: 'grid-wrap' });
  const pager = createElement('footer', {
    className: 'grid-footer',
    children: [
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
  const schema = createElement('pre', { className: 'schema-view' });
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
                text: 'Manage the selected table and inspect generated SQLite definitions.',
              }),
            ],
          }),
          createElement('div', { className: 'schema-toolbar', children: [newTable, renameTable, addColumn, dropColumn, dropTable] }),
        ],
      }),
      schema,
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
                text: 'Run read-only SELECT statements and inspect result sets without changing the database.',
              }),
            ],
          }),
          createElement('div', { className: 'query-toolbar', children: [runQuery, queryMessage] }),
        ],
      }),
      queryInput,
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
          pageSizeSelect,
          createElement('span', { className: 'toolbar-spacer' }),
          exportCsv,
          exportSql,
          addRow,
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
  filterInput.addEventListener('input', async () => {
    filter = filterInput.value;
    page = 1;
    await refreshRows();
  });
  pageSizeSelect.addEventListener('change', async () => {
    pageSize = Number(pageSizeSelect.value);
    page = 1;
    await refreshRows();
  });
  queryInput.addEventListener('input', () => {
    querySql = queryInput.value;
  });
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      requestSave();
    }
  });

  return {
    title,
    status,
    saveButton,
    tabs: [dataTab, schemaTab, queryTab],
    sidebar,
    filterInput,
    previousPage,
    nextPage,
    pageLabel,
    addRow,
    exportCsv,
    exportSql,
    newTable,
    renameTable,
    addColumn,
    dropColumn,
    dropTable,
    grid,
    pager,
    schema,
    schemaPanel,
    data,
    query,
    queryInput,
    queryMessage,
    queryOutput,
  };
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
    await refreshRows();
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

async function openDatabase(name, data) {
  try {
    elements.status.textContent = 'Opening database...';
    SQL ??= await initSqlJs({ locateFile: () => wasmUri });
    db?.close();
    db = new SQL.Database(new Uint8Array(data));
    databaseName = name;
    elements.title.textContent = name;
    selectedRow = null;
    page = 1;
    filter = '';
    columnFilters = {};
    objectFilter = '';
    elements.filterInput.value = '';
    sortColumn = null;
    sortDirection = 'asc';
    isDirty = false;
    isSaving = false;
    await refreshTables();
    updateSaveUi();
  } catch (error) {
    reportError(error);
  }
}

function handleDatabaseSaved() {
  isDirty = false;
  isSaving = false;
  updateSaveUi();
}

function requestSave() {
  if (!db || !isDirty || isSaving) {
    return;
  }

  isSaving = true;
  updateSaveUi();
  vscode.postMessage({ type: 'requestSave' });
}

function updateSaveUi() {
  const hasDatabase = Boolean(db);
  const saveState = getSaveButtonState({ hasDatabase, isDirty, isSaving });
  elements.saveButton.disabled = saveState.disabled;
  elements.saveButton.textContent = saveState.label;
  elements.status.textContent = getDirtyStatusText({ hasDatabase, isDirty, isSaving });
}

async function refreshTables() {
  schemaObjects = getSchemaObjects(db);
  tables = readTableMetadata(db, schemaObjects);

  activeTableName = activeTableName && tables.some((table) => table.name === activeTableName)
    ? activeTableName
    : tables[0]?.name ?? null;
  renderSidebar();
  renderSchema();
  await refreshRows();
}

async function refreshRows() {
  const table = getActiveTable();
  selectedRow = null;

  if (!table) {
    totalRows = 0;
    visibleRows = [];
    elements.grid.replaceChildren(createElement('div', { className: 'empty-state', text: 'No tables found.' }));
    updatePager();
    return;
  }

  try {
    const countQuery = buildTableCount({ tableName: table.name, columns: table.columns, filter, columnFilters });
    totalRows = queryAll(db, countQuery.sql, countQuery.params)[0]?.count ?? 0;
    const maxPage = Math.max(1, Math.ceil(totalRows / pageSize));
    page = Math.min(page, maxPage);
    const selectQuery = buildTableSelect({
      tableName: table.name,
      columns: table.columns,
      filter,
      columnFilters,
      sortColumn,
      sortDirection,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      includeRowid: table.hasRowid,
    });
    visibleRows = queryAll(db, selectQuery.sql, selectQuery.params).map((row) => ({
      identity: buildIdentity(table, row),
      values: row,
    }));
    renderGrid();
    updatePager();
  } catch (error) {
    elements.grid.replaceChildren(createElement('div', { className: 'error-state', text: getErrorMessage(error) }));
  }
}

function renderSidebar() {
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
  elements.sidebar.append(createElement('div', { className: 'object-search-wrap', children: [search] }));

  appendObjectSection('Tables', tables.filter((table) => table.type === 'table'));
  appendObjectSection('Views', tables.filter((table) => table.type === 'view'));
  appendObjectSection('Indexes', schemaObjects.filter((object) => object.type === 'index'));
  appendObjectSection('Triggers', schemaObjects.filter((object) => object.type === 'trigger'));
}

function appendObjectSection(label, objects) {
  const visibleObjects = objects.filter((object) => matchesObjectFilter(object));
  if (visibleObjects.length === 0) {
    return;
  }

  elements.sidebar.append(createElement('div', { className: 'sidebar-heading', text: label }));
  for (const object of visibleObjects) {
    const isTableLike = object.type === 'table' || object.type === 'view';
    const className = [
      object.name === activeTableName ? 'object-item active' : 'object-item',
      isTableLike ? '' : 'secondary',
    ].filter(Boolean).join(' ');
    const attributes = isTableLike ? { type: 'button', 'data-table': object.name } : {};
    const tagName = isTableLike ? 'button' : 'div';
    const meta = isTableLike ? `${object.rowCount} rows` : object.tableName;
    elements.sidebar.append(createElement(tagName, {
      className,
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
  const table = getActiveTable();
  if (!table) {
    elements.schema.textContent = 'No schema available.';
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
    `- ${key.from} -> ${key.table}.${key.to} on update ${key.on_update} on delete ${key.on_delete}`
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
}

function renderGrid() {
  const table = getActiveTable();
  if (!table) {
    return;
  }

  const tableElement = createElement('table', { className: 'data-grid' });
  const thead = createElement('thead');
  const headerRow = createElement('tr', { className: 'column-heading-row' });
  const filterRow = createElement('tr', { className: 'column-filter-row' });

  for (const column of table.columns) {
    const sortMarker = sortColumn === column.name ? (sortDirection === 'asc' ? ' ^' : ' v') : '';
    headerRow.append(createElement('th', {
      children: [
        createElement('button', {
          className: 'column-header',
          title: buildColumnTitle(column),
          attributes: { type: 'button', 'data-sort-column': column.name },
          children: [
            createElement('span', { className: 'column-name', text: `${column.name}${sortMarker}` }),
            createElement('span', { className: 'column-badges', children: getColumnBadges(column) }),
          ],
        }),
      ],
    }));
    filterRow.append(createElement('th', {
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
            createElement('span', { className: 'column-name', text: 'Actions' }),
          ],
        }),
      ],
    }));
    filterRow.append(createElement('th', { className: 'row-actions-filter-heading', text: '' }));
  }

  thead.append(headerRow, filterRow);
  tableElement.append(thead);

  const tbody = createElement('tbody');
  for (const [rowIndex, row] of visibleRows.entries()) {
    const tr = createElement('tr', {
      className: selectedRow === rowIndex ? 'selected-row' : '',
      attributes: { 'data-row': String(rowIndex) },
    });

    for (const column of table.columns) {
      const value = row.values[column.name];
      const interaction = getCellInteraction({ tableType: table.type, value });
      const cell = createElement('td', {
        className: [
          value === null || value === undefined ? 'null-cell' : '',
          interaction.disabled ? '' : 'editable-cell',
        ].filter(Boolean).join(' '),
        children: [
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
        ],
      });
      tr.append(cell);
    }

    const rowActions = getRowActions({ tableType: table.type, rowIndex });
    if (rowActions.length > 0) {
      tr.append(createElement('td', {
        className: 'row-actions-cell',
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

  tableElement.append(tbody);
  elements.grid.replaceChildren(tableElement);
}

function getColumnBadges(column) {
  return [
    column.keyKind,
    column.indexed ? 'IDX' : null,
    column.affinity,
  ]
    .filter(Boolean)
    .map((label) => createElement('span', { className: 'column-badge', text: label }));
}

function buildColumnTitle(column) {
  return [
    column.type || 'ANY',
    column.primaryKeyOrder ? `primary key ${column.primaryKeyOrder}` : null,
    column.foreignKeyTarget ? `foreign key ${column.foreignKeyTarget}` : null,
    column.indexed ? 'indexed' : null,
    column.nullable ? 'nullable' : 'not null',
  ].filter(Boolean).join(' · ');
}

async function handleClick(event) {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action) {
    await runAction(action, event.target.closest('[data-action]'));
    return;
  }

  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    setActiveView(viewButton.dataset.view);
    return;
  }

  const tableButton = event.target.closest('[data-table]');
  if (tableButton) {
    activeTableName = tableButton.dataset.table;
    page = 1;
    columnFilters = {};
    sortColumn = null;
    sortDirection = 'asc';
    renderSidebar();
    renderSchema();
    await refreshRows();
    return;
  }

  const sortButton = event.target.closest('[data-sort-column]');
  if (sortButton) {
    const column = sortButton.dataset.sortColumn;
    sortDirection = sortColumn === column && sortDirection === 'asc' ? 'desc' : 'asc';
    sortColumn = column;
    await refreshRows();
    return;
  }

  const cellButton = event.target.closest('[data-cell-row]');
  if (cellButton) {
    selectedRow = Number(cellButton.dataset.cellRow);
    if (!cellButton.disabled) {
      showRowDetails(selectedRow, cellButton.dataset.cellColumn);
    }
    return;
  }

  const row = event.target.closest('tr[data-row]');
  if (row) {
    selectedRow = Number(row.dataset.row);
    renderGrid();
    return;
  }
}

function handleDoubleClick(event) {
  const cellButton = event.target.closest('[data-cell-row]');
  if (!cellButton || cellButton.disabled) {
    return;
  }

  showRowDetails(Number(cellButton.dataset.cellRow), cellButton.dataset.cellColumn);
}

async function runAction(action, sourceElement = null) {
  switch (action) {
    case 'previous-page':
      if (page > 1) {
        page -= 1;
        await refreshRows();
      }
      break;
    case 'next-page':
      if (page < Math.ceil(totalRows / pageSize)) {
        page += 1;
        await refreshRows();
      }
      break;
    case 'edit-row':
      showRowDetails(Number(sourceElement?.dataset.actionRow));
      break;
    case 'delete-row':
      await deleteRowAt(Number(sourceElement?.dataset.actionRow));
      break;
    case 'add-row':
      showInsertDialog();
      break;
    case 'run-query':
      runReadOnlyQuery();
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
      await dropActiveTable();
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

function showRowDetails(rowIndex, initialColumnName = null) {
  const table = getActiveTable();
  if (!table || table.type !== 'table' || Number.isNaN(rowIndex)) {
    return;
  }

  const row = visibleRows[rowIndex];
  const dialog = createElement('dialog', { className: 'row-dialog' });
  const form = createElement('form', { className: 'row-dialog-form', attributes: { method: 'dialog' } });
  const absoluteRowNumber = rowIndex + 1 + ((page - 1) * pageSize);
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
    const readOnly = isBlob || column.primaryKeyOrder > 0;
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

  previous.addEventListener('click', () => {
    dialog.close();
    showRowDetails(rowIndex - 1, initialColumnName);
  });
  next.addEventListener('click', () => {
    dialog.close();
    showRowDetails(rowIndex + 1, initialColumnName);
  });
  const updateDirtyState = () => updateRowDialogState({ table, row, form, validationSummary, save });
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

  cancel.addEventListener('click', () => dialog.close());
  remove.addEventListener('click', async () => {
    if (window.confirm(`Delete row ${rowIndex + 1}?`)) {
      await deleteRowAt(rowIndex);
      dialog.close();
    }
  });
  dialog.addEventListener('close', () => {
    for (const url of blobPreviewUrls) {
      URL.revokeObjectURL(url);
    }
    dialog.remove();
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
        identity: row.identity,
        primaryKeyColumns: table.primaryKeyColumns,
      });
      updates.push({
        sql: update.sql,
        params: [parseCellInput(nextValue, column, previousValue), ...update.identityParams],
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

    db.run('BEGIN IMMEDIATE');
    try {
      for (const update of updates) {
        runStatement(db, update.sql, update.params);
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }

    markChanged();
    await refreshRows();
    return { saved: true };
  } catch (error) {
    reportError(error);
    return { saved: false };
  }
}

async function updateCell(table, row, column, input, previousValue) {
  try {
    const parsed = parseCellInput(input, column, previousValue);
    const update = buildUpdate({
      tableName: table.name,
      columnName: column.name,
      identity: row.identity,
      primaryKeyColumns: table.primaryKeyColumns,
    });
    runWrite(db, update.sql, [parsed, ...update.identityParams]);
    markChanged();
    await refreshRows();
  } catch (error) {
    reportError(error);
    renderGrid();
  }
}

async function deleteRowAt(rowIndex) {
  const table = getActiveTable();
  if (!table || Number.isNaN(rowIndex) || table.type === 'view') {
    return;
  }

  try {
    const row = visibleRows[rowIndex];
    const deletion = buildDelete({
      tableName: table.name,
      identity: row.identity,
      primaryKeyColumns: table.primaryKeyColumns,
    });
    runWrite(db, deletion.sql, deletion.params);
    markChanged();
    await refreshTables();
  } catch (error) {
    reportError(error);
  }
}

function showInsertDialog() {
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
  for (const column of table.columns) {
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
  form.append(createElement('div', { className: 'dialog-actions', children: [cancel, submit] }));
  dialog.append(form);
  document.body.append(dialog);

  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await insertRow(table, form);
    dialog.close();
  });
  dialog.showModal();
}

async function insertRow(table, form) {
  try {
    const values = {};
    for (const column of table.columns) {
      const input = form.elements.namedItem(column.name);
      const nullInput = form.querySelector(`[data-null-column="${CSS.escape(column.name)}"]`);
      if (nullInput.checked) {
        values[column.name] = null;
      } else if (input.value !== '') {
        values[column.name] = parseCellInput(input.value, column, '');
      }
    }

    const insertion = buildInsert({ tableName: table.name, values });
    runWrite(db, insertion.sql, insertion.params);
    markChanged();
    await refreshTables();
  } catch (error) {
    reportError(error);
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
    onSubmit: async (values) => {
      activeTableName = values.tableName.trim();
      await applySchemaChange(buildCreateTable({
        tableName: values.tableName,
        columns: [{
          name: values.columnName,
          type: values.type,
          primaryKey: values.primaryKey,
          notNull: values.notNull,
        }],
      }));
    },
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
    onSubmit: async (values) => {
      activeTableName = values.newName.trim();
      await applySchemaChange(buildRenameTable({ oldName: table.name, newName: values.newName }));
    },
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
    onSubmit: async (values) => {
      await applySchemaChange(buildAddColumn({
        tableName: table.name,
        column: {
          name: values.columnName,
          type: values.type,
          defaultValue: values.defaultValue,
          notNull: values.notNull,
          unique: values.unique,
        },
      }));
    },
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
      await applySchemaChange(buildDropColumn({ tableName: table.name, columnName: values.columnName }));
    },
  });
}

async function dropActiveTable() {
  const table = getEditableTable();
  if (!table || !window.confirm(`Drop table "${table.name}"? This cannot be undone after saving.`)) {
    return;
  }

  activeTableName = null;
  await applySchemaChange(buildDropTable({ tableName: table.name }));
}

async function applySchemaChange(sql) {
  try {
    runWrite(db, sql);
    markChanged();
    await refreshTables();
  } catch (error) {
    reportError(error);
  }
}

function showSchemaDialog({ title, submitText, fields, onSubmit }) {
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
  form.append(
    createElement('h2', { text: title }),
    fieldList,
    createElement('div', { className: 'dialog-actions', children: [cancel, submit] }),
  );
  dialog.append(form);
  document.body.append(dialog);

  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await onSubmit(readSchemaForm(form, fields));
    dialog.close();
  });
  dialog.showModal();
}

function createSchemaField(field) {
  let control;
  if (field.type === 'select') {
    control = createElement('select', { attributes: { name: field.name, required: field.required ? 'true' : undefined } });
    for (const option of field.options) {
      control.append(createElement('option', { text: option, attributes: { value: option } }));
    }
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

function runReadOnlyQuery() {
  clear(elements.queryOutput);
  elements.queryMessage.textContent = '';

  if (!isReadOnlyQuery(querySql)) {
    elements.queryMessage.textContent = 'Only SELECT queries run from this tab.';
    return;
  }

  try {
    queryResults = db.exec(querySql);
    if (queryResults.length === 0) {
      elements.queryMessage.textContent = 'Query returned no rows.';
      return;
    }

    elements.queryMessage.textContent = `${queryResults.reduce((sum, result) => sum + result.values.length, 0)} rows`;
    for (const result of queryResults) {
      elements.queryOutput.append(renderResultTable(result));
    }
  } catch (error) {
    elements.queryMessage.textContent = getErrorMessage(error);
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
  const schema = getSchemaObjects(db).map((row) => row.sql);
  const dataTables = tables
    .filter((table) => table.type === 'table')
    .map((table) => {
      const columns = table.columns.map((column) => column.name);
      const select = buildTableSelect({
        tableName: table.name,
        columns: table.columns,
        filter: '',
        sortColumn: null,
        sortDirection: 'asc',
        limit: Number.MAX_SAFE_INTEGER,
        offset: 0,
        includeRowid: false,
      });

      return {
        name: table.name,
        columns,
        rows: queryAll(db, select.sql, select.params),
      };
    });

  vscode.postMessage({
    type: 'saveText',
    kind: 'sql',
    fileName: `${safeFileName(databaseName)}.sql`,
    content: buildSqlDump({ schema, tables: dataTables }),
  });
}

function renderResultTable(result) {
  const tableElement = createElement('table', { className: 'data-grid result-grid' });
  const thead = createElement('thead');
  thead.append(createElement('tr', {
    children: result.columns.map((column) => createElement('th', { text: column })),
  }));
  tableElement.append(thead);

  const tbody = createElement('tbody');
  for (const row of result.values) {
    tbody.append(createElement('tr', {
      children: row.map((value) => createElement('td', { text: describeValue(value) })),
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
  });
  elements.pageLabel.textContent = pager.label;
  elements.previousPage.disabled = !pager.canGoPrevious;
  elements.nextPage.disabled = !pager.canGoNext;
  const editable = table?.type === 'table';
  elements.addRow.disabled = !editable;
  elements.renameTable.disabled = !editable;
  elements.addColumn.disabled = !editable;
  elements.dropColumn.disabled = !editable || table.columns.length === 0;
  elements.dropTable.disabled = !editable;
  elements.exportCsv.disabled = !table;
  elements.exportSql.disabled = tables.length === 0;
}

function getActiveTable() {
  return tables.find((table) => table.name === activeTableName) ?? null;
}

function getEditableTable() {
  const table = getActiveTable();
  return table?.type === 'table' ? table : null;
}

function buildIdentity(table, row) {
  return {
    rowid: table.hasRowid ? row.__database_editor_rowid : null,
    primaryKey: Object.fromEntries(table.primaryKeyColumns.map((column) => [column, row[column]])),
  };
}

function markChanged() {
  const exported = db.export();
  isDirty = true;
  updateSaveUi();
  vscode.postMessage({
    type: 'databaseChanged',
    label: 'Edit SQLite database',
    data: exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength),
  });
}

function reportError(error) {
  const message = getErrorMessage(error);
  elements.status.textContent = message;
  vscode.postMessage({ type: 'error', message });
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
