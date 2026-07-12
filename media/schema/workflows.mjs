import { createConfirmationModel } from '../dialogs/workflows.mjs';
import {
  buildAddColumn,
  buildCreateIndex,
  buildCreateTable,
  buildDropColumn,
  buildDropIndex,
  buildDropTable,
  buildRenameTable,
  parseIndexColumnNames,
} from './management.mjs';
import { getErrorMessage } from '../utilities/errors.mjs';

export function createSchemaWorkflows({
  getTables,
  getEditableTable,
  getSelectedSchemaObject,
  showDialog,
  confirm,
  applyChange,
  setStatus,
  getActiveElement = () => document.activeElement,
}) {
  function createTable() {
    showDialog({
      title: 'Create table', submitText: 'Create',
      fields: [
        { name: 'tableName', label: 'Table name', required: true },
        { name: 'columnName', label: 'First column', value: 'id', required: true },
        { name: 'type', label: 'Type', value: 'INTEGER', required: true },
        { name: 'primaryKey', label: 'Primary key', type: 'checkbox', checked: true },
        { name: 'notNull', label: 'Not null', type: 'checkbox' },
      ],
      onSubmit: (values) => applyChange(buildCreateTable({
        tableName: values.tableName,
        columns: [{ name: values.columnName, type: values.type, primaryKey: values.primaryKey, notNull: values.notNull }],
      }), { nextActiveTableName: values.tableName.trim() }),
    });
  }

  function renameTable() {
    const table = getEditableTable();
    if (!table) return;
    showDialog({
      title: `Rename ${table.name}`, submitText: 'Rename',
      fields: [{ name: 'newName', label: 'New table name', value: table.name, required: true }],
      onSubmit: (values) => applyChange(buildRenameTable({ oldName: table.name, newName: values.newName }), {
        nextActiveTableName: values.newName.trim(),
      }),
    });
  }

  function addColumn() {
    const table = getEditableTable();
    if (!table) return;
    showDialog({
      title: `Add column to ${table.name}`, submitText: 'Add column',
      fields: [
        { name: 'columnName', label: 'Column name', required: true },
        { name: 'type', label: 'Type', value: 'TEXT', required: true },
        { name: 'defaultValue', label: 'Default value' },
        { name: 'notNull', label: 'Not null', type: 'checkbox' },
        { name: 'unique', label: 'Unique', type: 'checkbox' },
      ],
      onSubmit: (values) => applyChange(buildAddColumn({ tableName: table.name, column: {
        name: values.columnName, type: values.type, defaultValue: values.defaultValue,
        notNull: values.notNull, unique: values.unique,
      } })),
    });
  }

  function dropColumn() {
    const table = getEditableTable();
    if (!table) return;
    showDialog({
      title: `Drop column from ${table.name}`, submitText: 'Drop column',
      fields: [{ name: 'columnName', label: 'Column', type: 'select', options: table.columns.map((column) => column.name), required: true }],
      onSubmit: async (values) => {
        if (!await confirm(createConfirmationModel({ kind: 'column', tableName: table.name, columnName: values.columnName }), getActiveElement())) {
          return { ok: false, error: '' };
        }
        return applyChange(buildDropColumn({ tableName: table.name, columnName: values.columnName }));
      },
    });
  }

  async function dropTable(invoker = null) {
    const table = getEditableTable();
    if (!table || !await confirm(createConfirmationModel({ kind: 'table', tableName: table.name }), invoker)) return { ok: false };
    return applyChange(buildDropTable({ tableName: table.name }), { nextActiveTableName: null });
  }

  function createIndex() {
    const editableTables = getTables().filter((table) => table.type === 'table');
    if (editableTables.length === 0) return;
    const initialTable = getEditableTable() ?? editableTables[0];
    showDialog({
      title: 'Create index', submitText: 'Create index',
      fields: [
        { name: 'indexName', label: 'Index name', required: true },
        { name: 'tableName', label: 'Table', type: 'select', options: editableTables.map((table) => table.name), value: initialTable.name, required: true },
        { name: 'columns', label: 'Ordered columns (comma-separated)', value: initialTable.columns[0]?.name ?? '', required: true },
        { name: 'direction', label: 'Sort direction', type: 'select', options: [{ label: 'Default', value: '' }, 'ASC', 'DESC'] },
        { name: 'unique', label: 'Unique', type: 'checkbox' },
      ],
      onSubmit: (values) => {
        const indexName = values.indexName.trim();
        return applyChange(buildCreateIndex({
          indexName, tableName: values.tableName,
          columns: parseIndexColumnNames(values.columns, values.direction), unique: values.unique,
        }), { nextActiveTableName: values.tableName, nextSchemaObject: { type: 'index', name: indexName } });
      },
    });
  }

  async function dropIndex(invoker = null) {
    const index = getSelectedSchemaObject();
    if (index?.type !== 'index') return { ok: false };
    let sql;
    try {
      sql = buildDropIndex({ indexName: index.name });
    } catch (error) {
      const message = getErrorMessage(error);
      setStatus(message);
      return { ok: false, error: message };
    }
    if (!await confirm(createConfirmationModel({ kind: 'index', target: index.name }), invoker)) return { ok: false };
    return applyChange(sql, {
      nextActiveTableName: index.tableName,
      nextSchemaObject: { type: 'table', name: index.tableName },
    });
  }

  return { createTable, renameTable, addColumn, dropColumn, dropTable, createIndex, dropIndex };
}
