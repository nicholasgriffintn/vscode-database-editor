import { createElement } from '../utilities/dom.mjs';
import { getRovingIndex } from '../utilities/array.mjs';
import { formatRowCount } from '../database/metadata.mjs';
import { getPagerState } from '../grid/ui.mjs';

export function createEditorControls({ elements, getState }) {
  function render() {
    const state = getState();
    const { table } = state;
    const pager = getPagerState({
      page: state.page,
      pageSize: state.pageSize,
      filteredRows: state.totalRows,
      totalRows: table?.rowCount ?? state.totalRows,
      autoPagination: state.autoPagination,
      loadedRows: state.loadedRows,
    });
    elements.pageLabel.textContent = pager.label;
    elements.pageRowCount.textContent = table
      ? table.rowCount === null
        ? `${formatRowCount(null)} · ${state.loadedRows.toLocaleString()} loaded`
        : state.maxRows > 0 && table.rowCount > state.totalRows
          ? `${state.totalRows.toLocaleString()} of ${table.rowCount.toLocaleString()} rows shown`
          : `${table.rowCount.toLocaleString()} row${table.rowCount !== 1 ? 's' : ''} total`
      : '';
    elements.previousPage.disabled = !pager.canGoPrevious;
    elements.nextPage.disabled = !pager.canGoNext;
    elements.previousPage.classList.toggle('hidden', state.autoPagination);
    elements.nextPage.classList.toggle('hidden', state.autoPagination);

    const editable = table?.type === 'table';
    const schemaEditable = state.selectedSchemaObject?.type === 'table'
      && state.selectedSchemaObject.name === table?.name
      && editable;
    elements.addRow.disabled = !editable;
    elements.importCsv.disabled = !editable;
    elements.deleteSelectedRows.disabled = !editable || state.selectedRowCount === 0;
    elements.renameTable.disabled = !schemaEditable;
    elements.addColumn.disabled = !schemaEditable;
    elements.dropColumn.disabled = !schemaEditable || table.columns.length === 0;
    elements.dropTable.disabled = !schemaEditable;
    elements.exportCsv.disabled = !table;
    elements.exportSql.disabled = state.sqlExportUi.disabled;
    elements.exportSql.textContent = state.sqlExportUi.label;
  }

  return { render };
}

export function createEditorNavigation({ elements }) {
  let activeView = 'data';
  let activeSchemaView = 'graph';

  function setView(view, { focusTab = false } = {}) {
    if (!['data', 'schema', 'query'].includes(view)) return;
    activeView = view;
    for (const tab of elements.tabs) {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focusTab) tab.focus();
    }
    elements.data.classList.toggle('hidden', view !== 'data');
    elements.schemaPanel.classList.toggle('hidden', view !== 'schema');
    elements.query.classList.toggle('hidden', view !== 'query');
  }

  function setSchemaView(view) {
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

  function handleTabKeydown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = elements.tabs.findIndex((tab) => tab.dataset.view === activeView);
    const next = getRovingIndex({ key: event.key, currentIndex: current, itemCount: elements.tabs.length });
    setView(elements.tabs[next].dataset.view, { focusTab: true });
  }

  for (const tab of elements.tabs) tab.addEventListener('keydown', handleTabKeydown);
  setView(activeView);
  setSchemaView(activeSchemaView);
  return {
    setSchemaView,
    setView,
    get activeSchemaView() { return activeSchemaView; },
    get activeView() { return activeView; },
  };
}

export function createEditorShell({ app, pageSizes, pageSize, rowCopyFormats }) {
  const title = createElement('div', { className: 'title', text: 'Loading SQLite database...' });
  const status = createElement('div', { className: 'status', text: 'Waiting for file', attributes: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
  const databaseWarning = createElement('div', {
    className: 'database-warning hidden',
    attributes: { role: 'status' },
  });
  const saveButton = actionButton('Save', 'save-database', { className: 'toolbar-button primary save-button', title: 'Save database (Ctrl+S / Cmd+S)', disabled: true });
  const dataTab = tab('Data', 'data', 'data-panel', true);
  const schemaTab = tab('Schema', 'schema', 'schema-panel');
  const queryTab = tab('SQL', 'query', 'query-panel');
  const sidebar = createElement('aside', { className: 'sidebar' });
  const objectRefresh = actionButton('↻', 'refresh-objects', { className: 'icon-button object-refresh-button', title: 'Refresh tables, views, indexes, and triggers', disabled: true, ariaLabel: 'Refresh database objects' });
  const filterInput = createElement('input', { className: 'filter-input', attributes: { type: 'search', placeholder: 'Filter rows', 'aria-label': 'Filter rows' } });
  const dataRefresh = actionButton('Refresh data', 'refresh-data', { title: 'Refresh rows for the selected table or view', disabled: true });
  const pageSizeSelect = createElement('select', { className: 'page-size', children: pageSizes.map((size) => createElement('option', {
    text: `${size.toLocaleString()} rows`, attributes: { value: String(size), selected: size === pageSize ? 'selected' : undefined },
  })) });
  pageSizeSelect.value = String(pageSize);
  const previousPage = actionButton('◀', 'previous-page', { className: 'icon-button', title: 'Previous page' });
  const nextPage = actionButton('▶', 'next-page', { className: 'icon-button', title: 'Next page' });
  const pageLabel = createElement('span', { className: 'page-label' });
  const pageRowCount = createElement('span', { className: 'page-row-count' });
  const addRow = actionButton('New row', 'add-row', { title: 'Insert row' });
  const exportCsv = actionButton('Export CSV', 'export-csv', { title: 'Export visible rows as CSV' });
  const importCsv = actionButton('Import CSV', 'import-csv', { title: 'Import CSV rows into the selected table' });
  const exportSql = actionButton('Export SQL', 'export-sql', { title: 'Export database as SQL dump' });
  const copyRowsFormat = createElement('select', { className: 'copy-format toolbar-select', title: 'Copy selected rows, or visible rows if no rows are selected', attributes: { 'aria-label': 'Copy rows as format' } });
  copyRowsFormat.append(createElement('option', { text: 'Copy rows as…', attributes: { value: '' } }), ...rowCopyFormats.map((format) => createElement('option', { text: format.label, attributes: { value: format.value } })));
  const deleteSelectedRows = actionButton('Delete selected', 'delete-selected-rows', { className: 'toolbar-button danger', title: 'Delete selected rows', disabled: true });
  const grid = createElement('div', { className: 'grid-wrap' });
  const pager = createElement('footer', { className: 'grid-footer', children: [pageRowCount, pageSizeSelect, previousPage, pageLabel, nextPage] });

  const newTable = actionButton('New table', 'new-table', { className: 'toolbar-button primary' });
  const renameTable = actionButton('Rename table', 'rename-table');
  const addColumn = actionButton('Add column', 'add-column');
  const dropColumn = actionButton('Drop column', 'drop-column');
  const dropTable = actionButton('Drop table', 'drop-table', { className: 'toolbar-button danger' });
  const createIndex = actionButton('Create index', 'create-index');
  const dropIndex = actionButton('Drop index', 'drop-index', { className: 'toolbar-button danger', disabled: true });
  const checkHealth = actionButton('Check health', 'check-database-health', { title: 'Run bounded SQLite integrity and foreign-key checks' });
  const schema = createElement('pre', { className: 'schema-view hidden' });
  const schemaGraph = createElement('div', { className: 'schema-graph-wrap' });
  const schemaGraphButton = actionButton('Graph', 'schema-view-graph', { className: 'segmented-button active' });
  const schemaDdlButton = actionButton('DDL', 'schema-view-ddl', { className: 'segmented-button' });
  const schemaGraphFit = actionButton('Fit', 'schema-graph-fit', { title: 'Reset the graph scroll position to the top-left bounds' });
  const schemaGraphLayout = actionButton('Auto layout', 'schema-graph-layout', { title: 'Recompute the schema graph layout' });
  const schemaGraphSummary = createElement('div', { className: 'schema-graph-summary' });
  const schemaPanel = createElement('section', { className: 'schema-panel hidden', attributes: { id: 'schema-panel', role: 'tabpanel', 'aria-labelledby': 'schema-tab' }, children: [
    createElement('div', { className: 'schema-header', children: [
      heading('Schema tools', 'Visualize table relationships, manage the selected table, or inspect generated SQLite definitions.'),
      createElement('div', { className: 'schema-toolbar', children: [newTable, renameTable, addColumn, dropColumn, dropTable, createIndex, dropIndex, checkHealth] }),
    ] }),
    createElement('div', { className: 'schema-subtoolbar', children: [
      createElement('div', { className: 'schema-view-switch', children: [schemaGraphButton, schemaDdlButton] }),
      schemaGraphSummary, createElement('span', { className: 'toolbar-spacer' }), schemaGraphFit, schemaGraphLayout,
    ] }),
    createElement('div', { className: 'schema-body', children: [schemaGraph, schema] }),
  ] });

  const queryInput = createElement('textarea', { className: 'query-input', attributes: {
    spellcheck: 'false',
    placeholder: 'Run SQL against the open database…',
    'aria-label': 'SQL query editor',
  } });
  const queryHistorySelect = createElement('select', { className: 'query-history toolbar-select', title: 'Load a previous SQL script', attributes: { 'aria-label': 'Query history' } });
  const queryMessage = createElement('div', { className: 'query-message' });
  const queryOutput = createElement('div', { className: 'query-output' });
  const query = createElement('section', { className: 'query-view hidden', attributes: { id: 'query-panel', role: 'tabpanel', 'aria-labelledby': 'query-tab' }, children: [
    createElement('div', { className: 'query-header', children: [heading('SQL workspace', 'Run SQL statements, inspect result sets, and save database changes when ready.'), createElement('div', { className: 'query-toolbar', children: [queryHistorySelect, actionButton('Run', 'run-query', { className: 'toolbar-button primary' })] })] }),
    createElement('div', { className: 'query-editor', children: [queryInput, queryMessage] }), queryOutput,
  ] });
  const data = createElement('section', { className: 'data-view', attributes: { id: 'data-panel', role: 'tabpanel', 'aria-labelledby': 'data-tab' }, children: [
    createElement('div', { className: 'toolbar', children: [filterInput, dataRefresh, createElement('span', { className: 'toolbar-spacer' }), exportCsv, importCsv, exportSql, copyRowsFormat, addRow, deleteSelectedRows] }),
    grid, pager,
  ] });
  app.replaceChildren(
    createElement('header', { className: 'topbar', children: [createElement('div', { className: 'title-block', children: [title, status] }), createElement('nav', { className: 'tabs', attributes: { role: 'tablist', 'aria-label': 'Database editor views' }, children: [dataTab, schemaTab, queryTab] }), saveButton] }),
    databaseWarning,
    createElement('main', { className: 'workspace', children: [sidebar, createElement('div', { className: 'content', children: [data, schemaPanel, query] })] }),
  );
  return {
    title, status, databaseWarning, saveButton, tabs: [dataTab, schemaTab, queryTab], sidebar, objectRefresh, filterInput, dataRefresh,
    previousPage, nextPage, pageLabel, pageRowCount, pageSizeSelect, addRow, exportCsv, importCsv, exportSql,
    copyRowsFormat, deleteSelectedRows, newTable, renameTable, addColumn, dropColumn, dropTable, createIndex, dropIndex, checkHealth,
    grid, pager, schema, schemaGraph, schemaGraphButton, schemaDdlButton, schemaGraphFit, schemaGraphLayout,
    schemaGraphSummary, schemaPanel, data, query, queryInput, queryHistorySelect, queryMessage, queryOutput,
  };
}

function actionButton(text, action, { className = 'toolbar-button', title, disabled = false, ariaLabel } = {}) {
  return createElement('button', { className, text, title, attributes: {
    type: 'button', 'data-action': action, disabled: disabled ? 'true' : undefined, 'aria-label': ariaLabel,
  } });
}

function tab(text, view, panelId, active = false) {
  return createElement('button', { className: active ? 'tab active' : 'tab', text, attributes: {
    id: `${view}-tab`, type: 'button', role: 'tab', 'data-view': view, 'aria-controls': panelId,
    'aria-selected': String(active), tabindex: active ? '0' : '-1',
  } });
}

function heading(title, description) {
  return createElement('div', { className: 'schema-heading-copy', children: [
    createElement('div', { className: 'schema-heading-title', text: title }),
    createElement('div', { className: 'schema-heading-description', text: description }),
  ] });
}
