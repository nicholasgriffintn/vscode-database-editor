import { createElement, clear } from './dom-utils.mjs';
import { safeFileName } from './file-utils.mjs';
import {
  getCellInteraction,
  getPagerState,
  getRowActions,
} from './grid-ui.mjs';
import {
  getSchemaObjects,
  queryAll,
  readTableMetadata,
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

const elements = buildShell();
vscode.postMessage({ type: 'ready' });

window.addEventListener('message', async (event) => {
  const message = event.data;
  if (message.type === 'loadDatabase') {
    await openDatabase(message.name, message.data);
  }
});

function buildShell() {
  const title = createElement('div', { className: 'title', text: 'Loading SQLite database...' });
  const status = createElement('div', { className: 'status', text: 'Waiting for file' });

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
  const schema = createElement('pre', { className: 'schema-view hidden' });
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
      createElement('div', { className: 'query-toolbar', children: [runQuery, queryMessage] }),
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
        createElement('div', { children: [title, status] }),
        createElement('nav', { className: 'tabs', children: [dataTab, schemaTab, queryTab] }),
      ],
    }),
    createElement('main', {
      className: 'workspace',
      children: [
        sidebar,
        createElement('div', { className: 'content', children: [data, schema, query] }),
      ],
    }),
  );

  app.addEventListener('click', handleClick);
  app.addEventListener('dblclick', handleDoubleClick);
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

  return {
    title,
    status,
    tabs: [dataTab, schemaTab, queryTab],
    sidebar,
    filterInput,
    previousPage,
    nextPage,
    pageLabel,
    addRow,
    exportCsv,
    exportSql,
    grid,
    pager,
    schema,
    data,
    query,
    queryInput,
    queryMessage,
    queryOutput,
  };
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
    sortColumn = null;
    sortDirection = 'asc';
    await refreshTables();
    elements.status.textContent = 'Ready';
  } catch (error) {
    reportError(error);
  }
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
    const countQuery = buildTableCount({ tableName: table.name, columns: table.columns, filter });
    totalRows = queryAll(db, countQuery.sql, countQuery.params)[0]?.count ?? 0;
    const maxPage = Math.max(1, Math.ceil(totalRows / pageSize));
    page = Math.min(page, maxPage);
    const selectQuery = buildTableSelect({
      tableName: table.name,
      columns: table.columns,
      filter,
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
  elements.sidebar.append(createElement('div', { className: 'sidebar-heading', text: 'Tables and views' }));

  for (const table of tables) {
    const button = createElement('button', {
      className: table.name === activeTableName ? 'object-item active' : 'object-item',
      attributes: { type: 'button', 'data-table': table.name },
      children: [
        createElement('span', { className: 'object-name', text: table.name }),
        createElement('span', { className: 'object-meta', text: `${table.type} · ${table.rowCount}` }),
      ],
    });
    elements.sidebar.append(button);
  }

  const secondaryObjects = schemaObjects.filter((object) => object.type === 'index' || object.type === 'trigger');
  if (secondaryObjects.length > 0) {
    elements.sidebar.append(createElement('div', { className: 'sidebar-heading', text: 'Indexes and triggers' }));
    for (const object of secondaryObjects) {
      elements.sidebar.append(createElement('div', {
        className: 'object-item secondary',
        children: [
          createElement('span', { className: 'object-name', text: object.name }),
          createElement('span', { className: 'object-meta', text: `${object.type} · ${object.tableName}` }),
        ],
      }));
    }
  }
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
  const headerRow = createElement('tr');

  if (table.type === 'table') {
    headerRow.append(createElement('th', { className: 'row-actions-heading', text: '' }));
  }

  for (const column of table.columns) {
    const sortMarker = sortColumn === column.name ? (sortDirection === 'asc' ? ' ^' : ' v') : '';
    headerRow.append(createElement('th', {
      children: [
        createElement('button', {
          className: 'column-header',
          text: `${column.name}${sortMarker}`,
          title: `${column.type || 'value'}${column.primaryKeyOrder ? ' primary key' : ''}`,
          attributes: { type: 'button', 'data-sort-column': column.name },
        }),
      ],
    }));
  }

  thead.append(headerRow);
  tableElement.append(thead);

  const tbody = createElement('tbody');
  for (const [rowIndex, row] of visibleRows.entries()) {
    const tr = createElement('tr', {
      className: selectedRow === rowIndex ? 'selected-row' : '',
      attributes: { 'data-row': String(rowIndex) },
    });

    const rowActions = getRowActions({ tableType: table.type, rowIndex });
    if (rowActions.length > 0) {
      tr.append(createElement('td', {
        className: 'row-actions-cell',
        children: rowActions.map((action) => createElement('button', {
          className: 'row-action-button danger',
          text: 'Delete',
          title: action.label,
          attributes: {
            type: 'button',
            'data-action': action.action,
            'data-action-row': String(action.rowIndex),
            disabled: action.disabled ? 'true' : undefined,
          },
        })),
      }));
    }

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
            text: describeValue(value),
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

    tbody.append(tr);
  }

  tableElement.append(tbody);
  elements.grid.replaceChildren(tableElement);
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
      startCellEdit(cellButton, selectedRow, cellButton.dataset.cellColumn);
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

  startCellEdit(cellButton, Number(cellButton.dataset.cellRow), cellButton.dataset.cellColumn);
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
  }
}

function setActiveView(view) {
  activeView = view;
  for (const tab of elements.tabs) {
    tab.classList.toggle('active', tab.dataset.view === view);
  }
  elements.data.classList.toggle('hidden', view !== 'data');
  elements.schema.classList.toggle('hidden', view !== 'schema');
  elements.query.classList.toggle('hidden', view !== 'query');
}

function startCellEdit(button, rowIndex, columnName) {
  const table = getActiveTable();
  if (!table) {
    return;
  }

  const row = visibleRows[rowIndex];
  const column = table.columns.find((candidate) => candidate.name === columnName);
  const previousValue = row.values[columnName];
  const editor = createElement('span', { className: 'cell-editor-wrap' });
  const input = createElement('input', {
    className: 'cell-editor',
    attributes: { type: 'text' },
  });
  const nullButton = createElement('button', {
    className: 'cell-null-button',
    text: 'Set NULL',
    attributes: { type: 'button' },
  });
  input.value = previousValue === null || previousValue === undefined ? '' : String(previousValue);
  editor.append(input, nullButton);
  button.replaceWith(editor);
  input.focus();
  input.select();

  let committed = false;
  const commit = async () => {
    if (committed) {
      return;
    }
    committed = true;
    await updateCell(table, row, column, input.value, previousValue);
  };
  const commitNull = async () => {
    if (committed) {
      return;
    }
    committed = true;
    await updateCell(table, row, column, null, previousValue);
  };

  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      await commit();
    }
    if (event.key === 'Escape') {
      committed = true;
      renderGrid();
    }
  });
  input.addEventListener('blur', commit);
  nullButton.addEventListener('mousedown', (event) => event.preventDefault());
  nullButton.addEventListener('click', commitNull);
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
    elements.status.textContent = 'Unsaved changes';
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
    elements.status.textContent = 'Unsaved changes';
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
    elements.status.textContent = 'Unsaved changes';
  } catch (error) {
    reportError(error);
  }
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
  const pager = getPagerState({ page, pageSize, totalRows });
  elements.pageLabel.textContent = pager.label;
  elements.previousPage.disabled = !pager.canGoPrevious;
  elements.nextPage.disabled = !pager.canGoNext;
  const table = getActiveTable();
  const editable = table?.type === 'table';
  elements.addRow.disabled = !editable;
  elements.exportCsv.disabled = !table;
  elements.exportSql.disabled = tables.length === 0;
}

function getActiveTable() {
  return tables.find((table) => table.name === activeTableName) ?? null;
}

function buildIdentity(table, row) {
  return {
    rowid: table.hasRowid ? row.__database_editor_rowid : null,
    primaryKey: Object.fromEntries(table.primaryKeyColumns.map((column) => [column, row[column]])),
  };
}

function markChanged() {
  const exported = db.export();
  vscode.postMessage({
    type: 'databaseChanged',
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
