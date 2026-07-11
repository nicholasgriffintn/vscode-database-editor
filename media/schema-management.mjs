import { quoteIdentifier } from './sql.mjs';

const allowedTypes = new Set([
  'INTEGER',
  'REAL',
  'TEXT',
  'BLOB',
  'NUMERIC',
  'BOOLEAN',
  'DATE',
  'DATETIME',
]);

export function buildCreateTable({ tableName, columns }) {
  const name = requireName(tableName, 'Table name');
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('At least one column is required.');
  }

  return `CREATE TABLE ${quoteIdentifier(name)} (${columns.map(serializeColumn).join(', ')})`;
}

export function buildRenameTable({ oldName, newName }) {
  return `ALTER TABLE ${quoteIdentifier(requireName(oldName, 'Current table name'))} RENAME TO ${quoteIdentifier(requireName(newName, 'New table name'))}`;
}

export function buildDropTable({ tableName }) {
  return `DROP TABLE ${quoteIdentifier(requireName(tableName, 'Table name'))}`;
}

export function buildAddColumn({ tableName, column }) {
  return `ALTER TABLE ${quoteIdentifier(requireName(tableName, 'Table name'))} ADD COLUMN ${serializeColumn(column)}`;
}

export function buildDropColumn({ tableName, columnName }) {
  return `ALTER TABLE ${quoteIdentifier(requireName(tableName, 'Table name'))} DROP COLUMN ${quoteIdentifier(requireName(columnName, 'Column name'))}`;
}

export function buildCreateIndex({ indexName, tableName, columns, unique = false }) {
  const name = requireName(indexName, 'Index name');
  const table = requireName(tableName, 'Table name');
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('At least one index column is required.');
  }

  const serializedColumns = columns.map((column) => {
    const normalized = typeof column === 'string' ? { name: column } : column;
    const columnName = requireName(normalized?.name, 'Index column name');
    const direction = normalizeSortDirection(normalized?.direction);
    return `${quoteIdentifier(columnName)}${direction ? ` ${direction}` : ''}`;
  });
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(table)} (${serializedColumns.join(', ')})`;
}

export function buildDropIndex({ indexName }) {
  const name = requireName(indexName, 'Index name');
  if (name.toLowerCase().startsWith('sqlite_autoindex_')) {
    throw new Error('SQLite autoindexes are managed by SQLite and cannot be dropped directly.');
  }
  return `DROP INDEX ${quoteIdentifier(name)}`;
}

export function parseIndexColumnNames(value, direction) {
  const names = String(value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error('At least one index column is required.');
  }
  const normalizedDirection = normalizeSortDirection(direction);
  return names.map((name) => ({ name, direction: normalizedDirection || undefined }));
}

function serializeColumn(column) {
  const name = requireName(column?.name, 'Column name');
  const parts = [quoteIdentifier(name), normalizeType(column?.type)];

  if (column?.primaryKey) {
    parts.push('PRIMARY KEY');
  }

  if (column?.notNull) {
    parts.push('NOT NULL');
  }

  if (column?.unique) {
    parts.push('UNIQUE');
  }

  if (column?.defaultValue !== undefined && String(column.defaultValue).trim() !== '') {
    parts.push(`DEFAULT ${serializeDefault(column.defaultValue)}`);
  }

  return parts.join(' ');
}

function requireName(value, label) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function normalizeType(value) {
  const trimmed = String(value ?? '').trim().toUpperCase();
  if (!allowedTypes.has(trimmed)) {
    throw new Error(`Unsupported column type: ${value}`);
  }
  return trimmed;
}

function normalizeSortDirection(value) {
  const direction = String(value ?? '').trim().toUpperCase();
  if (!direction) {
    return '';
  }
  if (direction !== 'ASC' && direction !== 'DESC') {
    throw new Error(`Unsupported index sort direction: ${value}`);
  }
  return direction;
}

function serializeDefault(value) {
  const trimmed = String(value).trim();
  if (/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  if (/^(NULL|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  if (/^'.*'$/.test(trimmed)) {
    return trimmed;
  }

  return `'${trimmed.replaceAll("'", "''")}'`;
}
