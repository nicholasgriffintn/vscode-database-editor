import { importCsvRows, parseCsv } from './import.mjs';
import { getErrorMessage } from '../utilities/errors.mjs';

export function createCsvImportWorkflow({
  vscode,
  getEditableTable,
  getDatabase,
  showDialog,
  markChanged,
  refreshTables,
  setStatus,
}) {
  let requestCounter = 0;
  const pendingReads = new Map();

  function handleFileRead(message) {
    const resolve = pendingReads.get(message.requestId);
    if (!resolve) return false;
    pendingReads.delete(message.requestId);
    resolve(message);
    return true;
  }

  async function requestImport() {
    const table = getEditableTable();
    if (!table) return;
    const requestId = `csv-${++requestCounter}`;
    const response = await new Promise((resolve) => {
      pendingReads.set(requestId, resolve);
      vscode.postMessage({ type: 'readCsv', requestId });
    });
    if (response.status === 'failed') {
      setStatus(response.message || 'Could not read CSV file.');
      return;
    }
    if (response.status !== 'completed') return;
    try {
      const parsed = parseCsv(response.content);
      if (parsed.rows.length === 0) {
        setStatus('The CSV file is empty.');
        return;
      }
      showImportDialog(table, response.name, parsed);
    } catch (error) {
      setStatus(getErrorMessage(error));
    }
  }

  function showImportDialog(table, fileName, parsed) {
    const insertableColumns = table.columns.filter((column) => column.canInsert !== false && !column.generated && !column.hidden);
    const firstRow = parsed.rows[0];
    const mappingFields = firstRow.map((heading, index) => ({
      name: `map${index}`,
      label: `CSV ${heading || `column ${index + 1}`}`,
      type: 'select',
      value: insertableColumns.some((column) => column.name === heading) ? heading : '',
      options: [{ label: 'Do not import', value: '' }, ...insertableColumns.map((column) => column.name)],
    }));
    const preview = parsed.rows.slice(0, 5).map((row) => row.join(' · ')).join('\n');
    showDialog({
      title: `Import ${fileName} into ${table.name}`,
      description: `Preview (first ${Math.min(5, parsed.rows.length)} rows)\n${preview}`,
      submitText: 'Import rows',
      fields: [
        { name: 'hasHeader', label: 'First row is a header', type: 'checkbox', checked: true },
        { name: 'nullText', label: 'Text to import as NULL (blank disables)' },
        { name: 'convertTypes', label: 'Convert INTEGER/REAL values explicitly', type: 'checkbox' },
        { name: 'allowUnmapped', label: 'Allow missing/unmapped table columns', type: 'checkbox', checked: true },
        ...mappingFields,
      ],
      onSubmit: (values) => importRows({ table, parsed, mappingFields, insertableColumns, values }),
    });
  }

  async function importRows({ table, parsed, mappingFields, insertableColumns, values }) {
    const mapping = mappingFields
      .map((field, csvIndex) => ({ csvIndex, tableColumn: values[field.name] }))
      .filter((item) => item.tableColumn);
    if (!values.allowUnmapped && mapping.length !== insertableColumns.length) {
      return { ok: false, error: 'Map every insertable table column or allow unmapped columns.' };
    }
    const offset = values.hasHeader ? 1 : 0;
    try {
      const result = importCsvRows(getDatabase(), {
        tableName: table.name,
        columns: insertableColumns,
        mapping,
        rows: parsed.rows.slice(offset),
        lineNumbers: parsed.lineNumbers.slice(offset),
        nullText: values.nullText || undefined,
        convertTypes: values.convertTypes,
      });
      markChanged();
      await refreshTables();
      setStatus(`Imported ${result.inserted.toLocaleString()} rows into ${table.name}.`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: getErrorMessage(error) };
    }
  }

  return { handleFileRead, requestImport };
}
