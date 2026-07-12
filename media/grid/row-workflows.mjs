import { getBlobExportStrategy } from '../editor/settings.mjs';
import { describeBlob, detectBlobMediaType, getBlobFileExtension } from '../data/blob.mjs';
import { createConfirmationModel, createDiscardDraftModel, runDialogMutation } from '../dialogs/workflows.mjs';
import { runWrite, runWriteBatch } from '../database/client.mjs';
import { buildDelete, buildInsert, buildUpdate, parseCellInput } from '../sql/statements.mjs';
import { createElement } from '../utilities/dom.mjs';
import { getErrorMessage } from '../utilities/errors.mjs';
import { safeFileName } from '../utilities/file.mjs';
import { shouldKeepKeyboardShortcutInField } from './ui.mjs';
import { getRowFieldState, getRowValidationErrors, normalizeRowFieldValue, rowValuesEqual } from './row-detail.mjs';

export function createRowWorkflows({
  elements,
  vscode,
  getState,
  selectGridCell,
  renderGrid,
  refreshRows,
  refreshTables,
  markChanged,
  clearSelectedRows,
  getSelectedRows,
  confirm,
  reportError,
  setStatus,
}) {
  function showInlineEditor(rowIndex, columnName) {
    const state = getState();
    const table = state.editableTable;
    const row = state.visibleRows[rowIndex];
    const column = table?.columns.find((candidate) => candidate.name === columnName);
    if (!table || !row || !column || column.canUpdate === false || column.readOnly || row.values[column.name] instanceof Uint8Array) {
      showDetails(rowIndex, columnName);
      return;
    }
    const cell = elements.grid.querySelector(`[data-grid-cell-row="${CSS.escape(String(rowIndex))}"][data-grid-cell-column="${CSS.escape(columnName)}"]`);
    if (!cell) return;
    selectGridCell(rowIndex, columnName);
    const previousValue = row.values[column.name];
    const editor = createElement('textarea', { className: 'inline-cell-editor', attributes: {
      rows: String(Math.max(1, Math.min(4, String(previousValue ?? '').split('\n').length))), spellcheck: 'false', 'aria-label': `Edit ${columnName}`,
    } });
    editor.value = previousValue == null ? '' : String(previousValue);
    let finished = false;
    const cancel = () => { if (!finished) { finished = true; renderGrid(); } };
    const commit = async () => { if (!finished) { finished = true; await updateCell(table, row, column, editor.value, previousValue); } };
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void commit(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    });
    editor.addEventListener('blur', cancel);
    cell.replaceChildren(editor);
    editor.focus(); editor.select();
  }

  function showDetails(rowIndex, initialColumnName = null) {
    const invoker = document.activeElement;
    const state = getState();
    const table = state.table;
    if (!table || table.type !== 'table' || Number.isNaN(rowIndex)) return;
    const row = state.visibleRows[rowIndex];
    if (!row) return;
    const absoluteRowNumber = rowIndex + 1 + state.visibleRowOffset;
    const dialog = createElement('dialog', { className: 'row-dialog', attributes: {
      'aria-labelledby': 'row-dialog-title', 'aria-describedby': 'row-dialog-description',
    } });
    const form = createElement('form', { className: 'row-dialog-form', attributes: { method: 'dialog' } });
    const previous = createElement('button', { className: 'icon-button', text: '<', title: 'Previous row', attributes: { type: 'button', disabled: rowIndex <= 0 ? 'true' : undefined } });
    const next = createElement('button', { className: 'icon-button', text: '>', title: 'Next row', attributes: { type: 'button', disabled: rowIndex >= state.visibleRows.length - 1 ? 'true' : undefined } });
    const summary = createElement('div', { className: 'validation-summary hidden', attributes: { role: 'alert' } });
    const fields = createElement('div', { className: 'row-fields' });
    const previewUrls = [];
    for (const column of table.columns) fields.append(buildRowField({ state, table, row, rowIndex, column, previewUrls }));
    const cancel = createElement('button', { className: 'toolbar-button', text: 'Cancel', attributes: { type: 'button' } });
    const save = createElement('button', { className: 'toolbar-button primary', text: 'Save changes', attributes: { type: 'submit' } });
    const remove = createElement('button', { className: 'toolbar-button danger', text: 'Delete row', attributes: { type: 'button' } });
    form.append(
      createElement('header', { className: 'row-dialog-header', children: [previous, createElement('div', { className: 'row-dialog-title-block', children: [
        createElement('div', { className: 'row-dialog-kicker', text: table.name }), createElement('div', { className: 'row-dialog-title', text: `Row ${absoluteRowNumber}`, attributes: { id: 'row-dialog-title' } }),
      ] }), next] }),
      createElement('p', { className: 'visually-hidden', text: 'Inspect and edit values for this row. Read-only values can still be selected and copied.', attributes: { id: 'row-dialog-description' } }),
      summary, fields,
      createElement('div', { className: 'dialog-actions', children: [remove, createElement('span', { className: 'toolbar-spacer' }), cancel, save] }),
    );
    dialog.append(form); document.body.append(dialog);
    let dirty = false;
    const update = () => { dirty = updateDialogState({ table, row, form, summary, save }).dirty; };
    const closeOrNavigate = async ({ destination, nextRowIndex = null, control = null }) => {
      if (dirty && !await confirm(createDiscardDraftModel({ tableName: table.name, rowNumber: absoluteRowNumber, destination }), control)) return false;
      dialog.close();
      if (nextRowIndex !== null) showDetails(nextRowIndex, initialColumnName);
      return true;
    };
    previous.addEventListener('click', () => void closeOrNavigate({ destination: `moving to row ${absoluteRowNumber - 1}`, nextRowIndex: rowIndex - 1, control: previous }));
    next.addEventListener('click', () => void closeOrNavigate({ destination: `moving to row ${absoluteRowNumber + 1}`, nextRowIndex: rowIndex + 1, control: next }));
    fields.addEventListener('input', update); fields.addEventListener('change', update);
    fields.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-reset-column]');
      if (button) { resetField({ form, row, columnName: button.dataset.resetColumn }); update(); }
    });
    update();
    cancel.addEventListener('click', () => void closeOrNavigate({ destination: 'closing this dialog', control: cancel }));
    remove.addEventListener('click', async () => {
      const result = await deleteAt(rowIndex, remove);
      if (result.deleted) dialog.close(); else if (result.error) renderMutationError(summary, result.error);
    });
    dialog.addEventListener('cancel', (event) => { if (dirty) { event.preventDefault(); void closeOrNavigate({ destination: 'closing this dialog', control: cancel }); } });
    dialog.addEventListener('close', () => {
      for (const url of previewUrls) URL.revokeObjectURL(url);
      dialog.remove();
      const latestRows = getState().visibleRows;
      const focus = invoker?.isConnected ? invoker : elements.grid.querySelector(`[data-row="${CSS.escape(String(Math.min(rowIndex, latestRows.length - 1)))}"] button`);
      focus?.focus?.();
    });
    form.addEventListener('submit', async (event) => { event.preventDefault(); if ((await saveDetails(table, row, form, summary)).saved) dialog.close(); });
    dialog.addEventListener('keydown', (event) => {
      if (shouldKeepKeyboardShortcutInField({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, targetTagName: event.target?.tagName })) { event.stopPropagation(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); form.requestSubmit(); }
    });
    dialog.showModal();
    const initial = initialColumnName ? form.querySelector(`[data-column="${CSS.escape(initialColumnName)}"]`) : form.querySelector('[data-column]');
    initial?.focus(); initial?.select?.();
  }

  function buildRowField({ state, table, row, rowIndex, column, previewUrls }) {
    const value = row.values[column.name];
    const blob = value instanceof Uint8Array;
    const readOnly = blob || column.canUpdate === false || column.readOnly;
    const control = blob ? createBlobPreview({ state, tableName: table.name, rowIndex, columnName: column.name, value, previewUrls }) : createElement('textarea', {
      className: 'row-field-input', attributes: { name: column.name, rows: String(Math.max(1, Math.min(8, String(value ?? '').split('\n').length))), spellcheck: 'false', 'data-column': column.name, readonly: readOnly ? 'true' : undefined },
    });
    if (!blob) control.value = value == null ? '' : String(value);
    return createElement('div', { className: 'row-field', attributes: { 'data-field-column': column.name }, children: [
      createElement('div', { className: 'row-field-label-wrap', children: [
        createElement('span', { className: 'row-field-label', text: column.name, title: `${column.type || 'value'}${column.primaryKeyOrder ? ' primary key' : ''}` }),
        createElement('span', { className: 'row-field-meta', text: fieldMeta(column) }),
      ] }), control,
      createElement('div', { className: 'row-field-actions', children: [
        createElement('span', { className: 'dirty-marker hidden', text: 'Modified' }),
        createElement('label', { className: 'null-toggle', children: [createElement('input', { attributes: { type: 'checkbox', 'data-null-column': column.name, checked: value == null ? 'true' : undefined, disabled: readOnly ? 'true' : undefined } }), createElement('span', { text: 'NULL' })] }),
        createElement('button', { className: 'field-reset-button', text: 'Reset', attributes: { type: 'button', 'data-reset-column': column.name, disabled: 'true' } }),
      ] }),
    ] });
  }

  function createBlobPreview({ state, tableName, rowIndex, columnName, value, previewUrls }) {
    const mediaType = detectBlobMediaType(value);
    const children = [];
    if (mediaType?.startsWith('image/')) {
      const url = URL.createObjectURL(new Blob([value], { type: mediaType })); previewUrls.push(url);
      children.push(createElement('img', { className: 'blob-image-preview', attributes: { src: url, alt: `${columnName} preview` } }));
    }
    const download = createElement('button', { className: 'toolbar-button', text: 'Export BLOB', attributes: { type: 'button' } });
    download.addEventListener('click', () => exportBlob({ state, tableName, rowIndex, columnName, value }));
    children.push(createElement('span', { className: 'blob-description', text: describeBlob(value) }), download);
    return createElement('div', { className: 'blob-preview', children });
  }

  function exportBlob({ state, tableName, rowIndex, columnName, value }) {
    const fileName = safeFileName(`${state.databaseName}-${tableName}-${rowIndex + 1}-${columnName}.${getBlobFileExtension(value)}`);
    if (getBlobExportStrategy({ configured: state.settings.blobExportMode }) === 'web') {
      const url = URL.createObjectURL(new Blob([value], { type: detectBlobMediaType(value) || 'application/octet-stream' }));
      const link = createElement('a', { attributes: { href: url, download: fileName } });
      document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`Downloaded ${fileName}`);
      return;
    }
    vscode.postMessage({ type: 'saveBinary', kind: 'blob', fileName, content: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) });
  }

  async function saveDetails(table, row, form, summary) {
    const updates = [];
    const validation = [];
    try {
      for (const column of table.columns) {
        const input = form.elements.namedItem(column.name);
        if (!input || input.readOnly) { validation.push({ column, value: undefined, readOnly: true }); continue; }
        const previousValue = row.values[column.name];
        const nextValue = currentFieldValue(form, column);
        validation.push({ column, value: nextValue, readOnly: false });
        if (rowValuesEqual(previousValue, nextValue)) continue;
        const update = buildUpdate({ tableName: table.name, columnName: column.name, column, identity: row.identity, primaryKeyColumns: table.primaryKeyColumns, rowidAlias: table.rowidAlias });
        updates.push({ sql: update.sql, params: [parseCellInput(nextValue, column, previousValue), ...update.identityParams], expectedRowsModified: 1 });
      }
      const errors = getRowValidationErrors(validation);
      if (errors.length > 0) { renderValidation(summary, errors); return { saved: false }; }
      if (updates.length === 0) return { saved: true };
      runWriteBatch(getState().database, updates); markChanged(); await refreshRows();
      return { saved: true };
    } catch (error) {
      const message = getErrorMessage(error); renderMutationError(summary, message); setStatus(message); return { saved: false };
    }
  }

  async function updateCell(table, row, column, input, previousValue) {
    try {
      const update = buildUpdate({ tableName: table.name, columnName: column.name, column, identity: row.identity, primaryKeyColumns: table.primaryKeyColumns, rowidAlias: table.rowidAlias });
      runWrite(getState().database, update.sql, [parseCellInput(input, column, previousValue), ...update.identityParams], { expectedRowsModified: 1 });
      markChanged(); await refreshRows();
      return true;
    } catch (error) { reportError(error); renderGrid(); return false; }
  }

  async function clearCell(rowIndex, columnName, invoker = null) {
    const state = getState();
    const table = state.editableTable;
    const row = state.visibleRows[rowIndex];
    const column = table?.columns.find((candidate) => candidate.name === columnName);
    if (!table || !row || !column || column.canUpdate === false || column.readOnly || row.values[column.name] instanceof Uint8Array) {
      return false;
    }
    const confirmed = await confirm(createConfirmationModel({
      kind: 'cell',
      tableName: table.name,
      columnName: column.name,
      rowNumber: state.visibleRowOffset + rowIndex + 1,
    }), invoker);
    if (!confirmed) return false;
    const updated = await updateCell(table, row, column, null, row.values[column.name]);
    if (updated) setStatus(`Cleared ${column.name}`);
    return updated;
  }

  async function deleteAt(rowIndex, invoker = null) {
    const state = getState();
    const row = state.visibleRows[rowIndex];
    if (!state.editableTable || !row) return { deleted: false };
    return deleteRows([row], { invoker, model: createConfirmationModel({ kind: 'row', tableName: state.editableTable.name, rowNumber: state.visibleRowOffset + rowIndex + 1 }) });
  }

  function deleteSelected(invoker = null) { return deleteRows(getSelectedRows(), { invoker }); }

  async function deleteRows(rows, { invoker = null, model = null } = {}) {
    const state = getState();
    const table = state.table;
    if (!table || table.type === 'view' || rows.length === 0) return { deleted: false };
    const count = rows.length;
    const rowIndex = count === 1 ? state.visibleRows.indexOf(rows[0]) : -1;
    const confirmation = model ?? createConfirmationModel({ kind: count === 1 ? 'row' : 'rows', tableName: table.name, rowNumber: rowIndex >= 0 ? state.visibleRowOffset + rowIndex + 1 : 1, count });
    if (!await confirm(confirmation, invoker)) return { deleted: false };
    try {
      runWriteBatch(state.database, rows.map((row) => {
        const deletion = buildDelete({ tableName: table.name, identity: row.identity, primaryKeyColumns: table.primaryKeyColumns, rowidAlias: table.rowidAlias });
        return { sql: deletion.sql, params: deletion.params, expectedRowsModified: 1 };
      }));
      markChanged(); clearSelectedRows(); await refreshTables(); setStatus(`Deleted ${count.toLocaleString()} ${count === 1 ? 'row' : 'rows'}`);
      return { deleted: true };
    } catch (error) { const message = getErrorMessage(error); reportError(error); return { deleted: false, error: message }; }
  }

  function showInsert() {
    const invoker = document.activeElement;
    const table = getState().table;
    if (!table || table.type === 'view') return;
    const dialog = createElement('dialog', { className: 'insert-dialog', attributes: {
      'aria-labelledby': 'insert-row-dialog-title', 'aria-describedby': 'insert-row-dialog-description',
    } });
    const form = createElement('form', { attributes: { method: 'dialog' } });
    const fields = createElement('div', { className: 'insert-fields' });
    form.append(
      createElement('h2', { text: `Insert row into ${table.name}`, attributes: { id: 'insert-row-dialog-title' } }),
      createElement('p', { className: 'visually-hidden', text: 'Enter values for the new row.', attributes: { id: 'insert-row-dialog-description' } }),
      fields,
    );
    for (const column of insertableColumns(table)) fields.append(createElement('label', { className: 'insert-field', children: [
      createElement('span', { text: `${column.name}${column.type ? ` (${column.type})` : ''}` }),
      createElement('input', { attributes: { type: 'text', name: column.name, placeholder: column.defaultValue == null ? '' : `default ${column.defaultValue}` } }),
      createElement('span', { className: 'null-toggle', children: [createElement('input', { attributes: { type: 'checkbox', 'data-null-column': column.name } }), createElement('span', { text: 'NULL' })] }),
    ] }));
    const cancel = createElement('button', { className: 'toolbar-button', text: 'Cancel', attributes: { type: 'button' } });
    const submit = createElement('button', { className: 'toolbar-button primary', text: 'Insert', attributes: { type: 'submit' } });
    const errorRegion = createElement('div', { className: 'validation-summary hidden', attributes: { role: 'alert' } });
    form.append(errorRegion, createElement('div', { className: 'dialog-actions', children: [cancel, submit] }));
    dialog.append(form); document.body.append(dialog);
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); (invoker?.isConnected ? invoker : elements.addRow)?.focus?.(); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = await runDialogMutation({ submitButton: submit, errorRegion, operation: () => insert(table, form) });
      if (result.ok) dialog.close();
    });
    dialog.showModal(); form.querySelector('input:not([type="checkbox"]), select, textarea')?.focus();
  }

  async function insert(table, form) {
    try {
      const values = {};
      for (const column of insertableColumns(table)) {
        const input = form.elements.namedItem(column.name);
        const nullInput = form.querySelector(`[data-null-column="${CSS.escape(column.name)}"]`);
        if (nullInput.checked) values[column.name] = null;
        else if (input.value !== '') values[column.name] = parseCellInput(input.value, column, '');
      }
      const insertion = buildInsert({ tableName: table.name, values, columns: table.columns });
      runWrite(getState().database, insertion.sql, insertion.params, { expectedRowsModified: 1 });
      markChanged(); await refreshTables(); return { ok: true };
    } catch (error) { const message = getErrorMessage(error); setStatus(message); return { ok: false, error: message }; }
  }

  return { clearCell, deleteAt, deleteSelected, showDetails, showInlineEditor, showInsert };
}

function insertableColumns(table) { return table.columns.filter((column) => column.canInsert !== false && !column.generated && !column.hidden); }
function fieldMeta(column) { return [column.type || 'ANY', column.nullable ? 'nullable' : 'not null', column.primaryKeyOrder ? 'primary key' : null, column.generated ? `${column.generated} generated` : null, column.foreignKeyTarget ? `FK ${column.foreignKeyTarget}` : null].filter(Boolean).join(' · '); }
function currentFieldValue(form, column) {
  const input = form.elements.namedItem(column.name);
  if (!input) return undefined;
  return normalizeRowFieldValue({ inputValue: input.value, nullChecked: form.querySelector(`[data-null-column="${CSS.escape(column.name)}"]`)?.checked ?? false });
}
function updateDialogState({ table, row, form, summary, save }) {
  const validation = [];
  let dirty = false;
  for (const column of table.columns) {
    const field = form.querySelector(`[data-field-column="${CSS.escape(column.name)}"]`);
    const input = form.elements.namedItem(column.name);
    const readOnly = !input || input.readOnly;
    if (!field) continue;
    const value = currentFieldValue(form, column);
    const state = getRowFieldState({ previousValue: row.values[column.name], nextValue: value, readOnly });
    dirty ||= state.dirty;
    field.classList.toggle('dirty', state.dirty); field.querySelector('.dirty-marker')?.classList.toggle('hidden', !state.dirty);
    const reset = field.querySelector('[data-reset-column]'); if (reset) reset.disabled = state.resetDisabled;
    validation.push({ column, value, readOnly });
  }
  const errors = getRowValidationErrors(validation); renderValidation(summary, errors); save.disabled = errors.length > 0 || !dirty;
  return { dirty, errors };
}
function resetField({ form, row, columnName }) {
  const input = form.elements.namedItem(columnName); if (!input) return;
  const value = row.values[columnName]; input.value = value == null ? '' : String(value);
  const nullInput = form.querySelector(`[data-null-column="${CSS.escape(columnName)}"]`); if (nullInput) nullInput.checked = value == null;
}
function renderValidation(summary, errors) {
  summary.classList.toggle('hidden', errors.length === 0);
  summary.replaceChildren(...(errors.length === 0 ? [] : [createElement('strong', { text: 'Fix validation errors before saving:' }), createElement('ul', { children: errors.map((error) => createElement('li', { text: error })) })]));
}
function renderMutationError(region, message) {
  region.classList.remove('hidden'); region.replaceChildren(createElement('strong', { text: 'The change could not be saved:' }), createElement('div', { text: message }));
}
