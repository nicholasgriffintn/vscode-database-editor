export function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function buildTableSelect({ tableName, columns, filter, sortColumn, sortDirection, limit, offset, includeRowid = true }) {
  const visibleColumns = columns.map((column) => `${quoteIdentifier(column.name)}`).join(', ');
  const identityColumn = includeRowid ? 'rowid AS __database_editor_rowid' : null;
  const selectColumns = [identityColumn, visibleColumns].filter(Boolean).join(', ') || '*';
  const params = [];
  const where = buildFilterClause(columns, filter, params);
  const order = sortColumn
    ? ` ORDER BY ${quoteIdentifier(sortColumn)} ${sortDirection === 'desc' ? 'DESC' : 'ASC'}`
    : '';

  return {
    sql: `SELECT ${selectColumns} FROM ${quoteIdentifier(tableName)}${where}${order} LIMIT ? OFFSET ?`,
    params: [...params, limit, offset],
  };
}

export function buildTableCount({ tableName, columns, filter }) {
  const params = [];
  const where = buildFilterClause(columns, filter, params);
  return {
    sql: `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}${where}`,
    params,
  };
}

export function buildUpdate({ tableName, columnName, identity, primaryKeyColumns }) {
  const where = buildIdentityWhere(identity, primaryKeyColumns);
  return {
    sql: `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(columnName)} = ? WHERE ${where.sql}`,
    identityParams: where.params,
  };
}

export function buildDelete({ tableName, identity, primaryKeyColumns }) {
  const where = buildIdentityWhere(identity, primaryKeyColumns);
  return {
    sql: `DELETE FROM ${quoteIdentifier(tableName)} WHERE ${where.sql}`,
    params: where.params,
  };
}

export function buildInsert({ tableName, values }) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return {
      sql: `INSERT INTO ${quoteIdentifier(tableName)} DEFAULT VALUES`,
      params: [],
    };
  }

  const columns = entries.map(([name]) => quoteIdentifier(name)).join(', ');
  const placeholders = entries.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
    params: entries.map(([, value]) => value),
  };
}

export function parseCellInput(input, column, previousValue) {
  if (input === null) {
    return null;
  }

  if (previousValue instanceof Uint8Array) {
    return previousValue;
  }

  const declaredType = String(column.type ?? '').toUpperCase();
  if (declaredType.includes('INT')) {
    const trimmed = input.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(`${column.name} expects an integer value.`);
    }
    return Number.parseInt(trimmed, 10);
  }

  if (declaredType.includes('REAL') || declaredType.includes('FLOA') || declaredType.includes('DOUB')) {
    const trimmed = input.trim();
    const parsed = Number(trimmed);
    if (trimmed === '' || Number.isNaN(parsed)) {
      throw new Error(`${column.name} expects a numeric value.`);
    }
    return parsed;
  }

  if (typeof previousValue === 'number' && input.trim() !== '') {
    const parsed = Number(input);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return input;
}

export function isReadOnlyQuery(sql) {
  const statements = splitSqlStatements(stripSqlComments(sql));
  if (statements.length !== 1) {
    return false;
  }

  const statement = statements[0].trim();
  const normalized = statement.toLowerCase();
  if (normalized.startsWith('select')) {
    return true;
  }

  return normalized.startsWith('with') && !containsWriteKeyword(statement);
}

export function describeValue(value) {
  if (value === null || value === undefined) {
    return '(NULL)';
  }

  if (value instanceof Uint8Array) {
    return `[BLOB ${value.byteLength} bytes]`;
  }

  return String(value);
}

export function toCsv(columns, rows) {
  const lines = [
    columns.map(serializeCsvCell).join(','),
    ...rows.map((row) => columns.map((column) => serializeCsvCell(row[column])).join(',')),
  ];

  return `${lines.join('\n')}\n`;
}

export function buildSqlDump({ schema, tables }) {
  const lines = ['BEGIN TRANSACTION;'];

  for (const statement of schema) {
    const trimmed = statement.trim();
    if (trimmed) {
      lines.push(trimmed.endsWith(';') ? trimmed : `${trimmed};`);
    }
  }

  for (const table of tables) {
    const columnList = table.columns.map(quoteIdentifier).join(', ');
    for (const row of table.rows) {
      const values = table.columns.map((column) => serializeSqlLiteral(row[column])).join(', ');
      lines.push(`INSERT INTO ${quoteIdentifier(table.name)} (${columnList}) VALUES (${values});`);
    }
  }

  lines.push('COMMIT;', '');
  return lines.join('\n');
}

function buildFilterClause(columns, filter, params) {
  const trimmed = filter.trim();
  if (!trimmed) {
    return '';
  }

  const searchableColumns = columns.filter((column) => column.name);
  if (searchableColumns.length === 0) {
    return '';
  }

  params.push(...searchableColumns.map(() => `%${trimmed}%`));
  const predicates = searchableColumns
    .map((column) => `CAST(${quoteIdentifier(column.name)} AS TEXT) LIKE ?`)
    .join(' OR ');

  return ` WHERE ${predicates}`;
}

function stripSqlComments(sql) {
  let output = '';
  let index = 0;
  let quote = null;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (quote) {
      output += current;
      if (current === quote) {
        if (sql[index + 1] === quote) {
          output += sql[index + 1];
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }

    if (current === '\'' || current === '"') {
      quote = current;
      output += current;
      index += 1;
      continue;
    }

    if (current === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }

    if (current === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      output += ' ';
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];

    if (quote) {
      current += character;
      if (character === quote) {
        if (sql[index + 1] === quote) {
          current += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === '\'' || character === '"') {
      quote = character;
      current += character;
      continue;
    }

    if (character === ';') {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = '';
      continue;
    }

    current += character;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

function containsWriteKeyword(sql) {
  const withoutStrings = sql.replace(/'([^']|'')*'|"([^"]|"")*"/g, ' ');
  return /\b(insert|update|delete|drop|alter|create|replace|vacuum|attach|detach|pragma|reindex)\b/i.test(withoutStrings);
}

function serializeCsvCell(value) {
  const text = describeValueForExport(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function describeValueForExport(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return describeValue(value);
}

function serializeSqlLiteral(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (value instanceof Uint8Array) {
    return `X'${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')}'`;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }

  if (typeof value === 'bigint') {
    return String(value);
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildIdentityWhere(identity, primaryKeyColumns) {
  if (identity.rowid !== null && identity.rowid !== undefined) {
    return {
      sql: 'rowid = ?',
      params: [identity.rowid],
    };
  }

  const params = [];
  const predicates = primaryKeyColumns.map((column) => {
    params.push(identity.primaryKey[column]);
    return `${quoteIdentifier(column)} IS ?`;
  });

  if (predicates.length === 0) {
    throw new Error('This row cannot be edited because it has neither a rowid nor a primary key.');
  }

  return {
    sql: predicates.join(' AND '),
    params,
  };
}
