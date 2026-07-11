export function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function buildTableSelect({
  tableName,
  columns,
  filter,
  columnFilters = {},
  sortColumn,
  sortDirection,
  limit,
  offset,
  includeRowid = true,
  rowidAlias = '_rowid_',
}) {
  const visibleColumns = columns
    .map((column) => `${quoteIdentifier(tableName)}.${quoteIdentifier(column.name)}`)
    .join(', ');
  const qualifiedRowid = includeRowid && rowidAlias
    ? `${quoteIdentifier(tableName)}.${rowidAlias}`
    : null;
  const identityColumn = qualifiedRowid
    ? `${qualifiedRowid} AS "__database_editor_identity"`
    : null;
  const selectColumns = [identityColumn, visibleColumns].filter(Boolean).join(', ') || '*';
  const params = [];
  const where = buildFilterClause(columns, filter, columnFilters, params);
  const orderColumns = [];
  if (sortColumn) {
    orderColumns.push(`${quoteIdentifier(sortColumn)} ${sortDirection === 'desc' ? 'DESC' : 'ASC'}`);
  }
  if (qualifiedRowid) {
    orderColumns.push(`${qualifiedRowid} ASC`);
  } else {
    const primaryKeyColumns = columns
      .filter((column) => Number(column.primaryKeyOrder) > 0 && column.name !== sortColumn)
      .sort((left, right) => Number(left.primaryKeyOrder) - Number(right.primaryKeyOrder));
    orderColumns.push(...primaryKeyColumns.map((column) => `${quoteIdentifier(column.name)} ASC`));
  }
  const order = orderColumns.length > 0 ? ` ORDER BY ${orderColumns.join(', ')}` : '';

  return {
    sql: `SELECT ${selectColumns} FROM ${quoteIdentifier(tableName)}${where}${order} LIMIT ? OFFSET ?`,
    params: [...params, limit, offset],
    hasIdentityColumn: Boolean(identityColumn),
  };
}

export function buildTableCount({ tableName, columns, filter, columnFilters = {} }) {
  const params = [];
  const where = buildFilterClause(columns, filter, columnFilters, params);
  return {
    sql: `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}${where}`,
    params,
  };
}

export function buildUpdate({ tableName, columnName, column, identity, primaryKeyColumns, rowidAlias = '_rowid_' }) {
  if (column?.canUpdate === false || column?.readOnly) {
    throw new Error(column.generated
      ? 'Generated columns are read-only and cannot be updated.'
      : `${column.name || columnName} is read-only and cannot be updated.`);
  }
  const where = buildIdentityWhere(identity, primaryKeyColumns, rowidAlias, tableName);
  return {
    sql: `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(columnName)} = ? WHERE ${where.sql}`,
    identityParams: where.params,
  };
}

export function buildDelete({ tableName, identity, primaryKeyColumns, rowidAlias = '_rowid_' }) {
  const where = buildIdentityWhere(identity, primaryKeyColumns, rowidAlias, tableName);
  return {
    sql: `DELETE FROM ${quoteIdentifier(tableName)} WHERE ${where.sql}`,
    params: where.params,
  };
}

export function buildInsert({ tableName, values, columns: columnMetadata }) {
  const metadataByName = columnMetadata
    ? new Map(columnMetadata.map((column) => [column.name, column]))
    : null;
  const entries = Object.entries(values).filter(([name]) => {
    if (!metadataByName) {
      return true;
    }
    const column = metadataByName.get(name);
    return Boolean(column && column.canInsert !== false && !column.generated && !column.hidden);
  });
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

export function analyzeSqlScript(sql) {
  const statements = splitSqlStatements(stripSqlComments(String(sql ?? '')));
  const hasStatements = statements.length > 0;
  const transaction = analyzeTransactionControl(statements);
  const hasTransactionControl = transaction.transactionControl.length > 0;
  const mutates = statements.some((statement) => !isReadOnlyStatement(statement));

  return {
    statements,
    statementCount: statements.length,
    isEmpty: !hasStatements,
    isReadOnly: hasStatements && !mutates,
    mutates,
    hasTransactionControl,
    isMultiStatement: statements.length > 1,
    ...transaction,
  };
}

export function assertSqlScriptCanExport(analysis) {
  if (analysis.hasUnmatchedTransactionClose) {
    throw new Error('SQL script contains an unmatched transaction close or savepoint release.');
  }
  if (analysis.leavesTransactionOpen) {
    throw new Error('SQL script leaves a transaction or savepoint open; you must include COMMIT, ROLLBACK, or matching RELEASE before the script ends.');
  }
}

export function isReadOnlyQuery(sql) {
  const analysis = analyzeSqlScript(sql);
  return analysis.statementCount === 1 && analysis.isReadOnly;
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

export function buildRowCopyContent({ format, tableName = 'rows', columns, rows }) {
  const columnNames = normalizeColumnNames(columns);
  const exportRows = rows.map((row) => Object.fromEntries(columnNames.map((column) => [column, row[column]])));

  switch (format) {
    case 'tsv':
      return toDelimited(columnNames, exportRows, '\t');
    case 'csv':
      return toCsv(columnNames, exportRows);
    case 'sqlite-inserts':
      return exportRows
        .map((row) => {
          const columnList = columnNames.map(quoteIdentifier).join(', ');
          const values = columnNames.map((column) => serializeSqlLiteral(row[column])).join(', ');
          return `INSERT INTO ${quoteIdentifier(tableName)} (${columnList}) VALUES (${values});`;
        })
        .join('\n') + (exportRows.length > 0 ? '\n' : '');
    case 'json-objects':
      return JSON.stringify(exportRows.map(jsonSafeRow), null, 2);
    case 'json-arrays':
      return JSON.stringify(exportRows.map((row) => columnNames.map((column) => jsonSafeValue(row[column]))), null, 2);
    case 'html':
      return toHtmlTable(columnNames, exportRows);
    case 'markdown':
      return toMarkdownTable(columnNames, exportRows);
    default:
      throw new Error(`Unsupported row copy format: ${format}`);
  }
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

function normalizeColumnNames(columns) {
  return columns.map((column) => typeof column === 'string' ? column : column.name);
}

function toDelimited(columns, rows, delimiter) {
  const lines = [
    columns.join(delimiter),
    ...rows.map((row) => columns.map((column) => describeValueForExport(row[column])).join(delimiter)),
  ];
  return `${lines.join('\n')}\n`;
}

function jsonSafeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonSafeValue(value)]));
}

function jsonSafeValue(value) {
  if (value instanceof Uint8Array) {
    return describeValue(value);
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return null;
  }
  return value ?? null;
}

function toHtmlTable(columns, rows) {
  const head = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  const body = rows
    .map((row) => `    <tr>${columns.map((column) => `<td>${escapeHtml(describeValueForExport(row[column]))}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table>\n  <thead><tr>${head}</tr></thead>\n  <tbody>\n${body}\n  </tbody>\n</table>\n`;
}

function toMarkdownTable(columns, rows) {
  const header = `| ${columns.map(escapeMarkdownCell).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => escapeMarkdownCell(describeValueForExport(row[column]))).join(' | ')} |`);
  return `${[header, separator, ...body].join('\n')}\n`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function buildFilterClause(columns, filter, columnFilters, params) {
  const predicates = [];
  const trimmed = String(filter ?? '').trim();
  const searchableColumns = columns.filter((column) => column.name);
  if (trimmed && searchableColumns.length > 0) {
    params.push(...searchableColumns.map(() => `%${trimmed}%`));
    const globalPredicate = searchableColumns
      .map((column) => `CAST(${quoteIdentifier(column.name)} AS TEXT) LIKE ?`)
      .join(' OR ');
    predicates.push(hasColumnFilters(columnFilters) ? `(${globalPredicate})` : globalPredicate);
  }

  for (const column of columns) {
    const predicate = buildColumnFilterPredicate(column, columnFilters[column.name], params);
    if (predicate) {
      predicates.push(predicate);
    }
  }

  return predicates.length > 0 ? ` WHERE ${predicates.join(' AND ')}` : '';
}

function buildColumnFilterPredicate(column, filter, params) {
  const trimmed = String(filter ?? '').trim();
  if (!trimmed) {
    return '';
  }

  const identifier = quoteIdentifier(column.name);
  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
  if (['null', 'is null', '= null'].includes(normalized)) {
    return `${identifier} IS NULL`;
  }

  if (['not null', 'is not null', '!= null', '<> null'].includes(normalized)) {
    return `${identifier} IS NOT NULL`;
  }

  const operatorMatch = /^(<=|>=|!=|<>|=|<|>)\s*(.+)$/.exec(trimmed);
  if (operatorMatch) {
    params.push(operatorMatch[2]);
    return `${identifier} ${operatorMatch[1]} ?`;
  }

  params.push(`%${trimmed}%`);
  return `CAST(${identifier} AS TEXT) LIKE ?`;
}

function hasColumnFilters(columnFilters) {
  return Object.values(columnFilters).some((value) => String(value ?? '').trim() !== '');
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
        if (quote !== ']' && sql[index + 1] === quote) {
          output += sql[index + 1];
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }

    if (current === '\'' || current === '"' || current === '`' || current === '[') {
      quote = current === '[' ? ']' : current;
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
      index = Math.min(sql.length, index + 2);
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
        if (quote !== ']' && sql[index + 1] === quote) {
          current += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === '\'' || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character;
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

function isReadOnlyStatement(statement) {
  const keyword = getLeadingKeyword(statement);
  if (keyword === 'select' || keyword === 'values') {
    return true;
  }
  if (keyword === 'with') {
    return !containsWriteKeyword(statement);
  }
  if (keyword === 'explain') {
    return true;
  }
  if (keyword === 'pragma') {
    return isReadOnlyPragma(statement);
  }
  return false;
}

function analyzeTransactionControl(statements) {
  let transactionOpen = false;
  let explicitTransaction = false;
  let hasUnmatchedTransactionClose = false;
  let savepoints = [];
  const transactionControl = [];

  for (const statement of statements) {
    const trimmed = statement.trim();
    if (!isTransactionControlStatement(trimmed)) {
      continue;
    }

    const keyword = getLeadingKeyword(trimmed);
    transactionControl.push(keyword === 'end' ? 'commit' : keyword);

    if (keyword === 'begin') {
      if (transactionOpen) {
        hasUnmatchedTransactionClose = true;
      }
      transactionOpen = true;
      explicitTransaction = true;
      continue;
    }

    if (keyword === 'savepoint') {
      transactionOpen = true;
      savepoints.push(readTransactionName(trimmed, /^savepoint\s+/i));
      continue;
    }

    if (keyword === 'release') {
      const name = readTransactionName(trimmed, /^release(?:\s+savepoint)?\s+/i);
      const index = findSavepointIndex(savepoints, name);
      if (index === -1) {
        hasUnmatchedTransactionClose = true;
      } else {
        savepoints = savepoints.slice(0, index);
        if (savepoints.length === 0 && !explicitTransaction) {
          transactionOpen = false;
        }
      }
      continue;
    }

    if (keyword === 'rollback') {
      const rollbackTo = trimmed.match(/^rollback(?:\s+transaction)?\s+to(?:\s+savepoint)?\s+(.+)$/i);
      if (rollbackTo) {
        const name = normalizeTransactionName(rollbackTo[1]);
        const index = findSavepointIndex(savepoints, name);
        if (index === -1) {
          hasUnmatchedTransactionClose = true;
        } else {
          savepoints = savepoints.slice(0, index + 1);
        }
      } else {
        if (!transactionOpen) {
          hasUnmatchedTransactionClose = true;
        }
        transactionOpen = false;
        explicitTransaction = false;
        savepoints = [];
      }
      continue;
    }

    if (keyword === 'commit' || keyword === 'end') {
      if (!transactionOpen) {
        hasUnmatchedTransactionClose = true;
      }
      transactionOpen = false;
      explicitTransaction = false;
      savepoints = [];
    }
  }

  return {
    transactionControl,
    leavesTransactionOpen: transactionOpen,
    hasUnmatchedTransactionClose,
    openSavepointCount: savepoints.length,
  };
}

function readTransactionName(statement, prefix) {
  return normalizeTransactionName(statement.replace(prefix, ''));
}

function normalizeTransactionName(value) {
  const token = String(value ?? '').trim().match(/^(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|`(?:[^`]|``)*`|\[[^\]]*\]|[^\s]+)/)?.[0] ?? '';
  if (token.startsWith('[') && token.endsWith(']')) {
    return token.slice(1, -1).toLowerCase();
  }
  if ((token.startsWith('"') && token.endsWith('"'))
    || (token.startsWith("'") && token.endsWith("'"))
    || (token.startsWith('`') && token.endsWith('`'))) {
    return token.slice(1, -1).replaceAll(token[0] + token[0], token[0]).toLowerCase();
  }
  return token.toLowerCase();
}

function findSavepointIndex(savepoints, name) {
  for (let index = savepoints.length - 1; index >= 0; index -= 1) {
    if (savepoints[index] === name) {
      return index;
    }
  }
  return -1;
}

function isTransactionControlStatement(statement) {
  return /^(?:begin(?:\s+(?:deferred|immediate|exclusive|transaction))?|commit|end|rollback|savepoint|release)\b/i.test(statement.trim());
}

function getLeadingKeyword(statement) {
  return statement.trim().match(/^[a-z]+/i)?.[0].toLowerCase() ?? '';
}

const READ_ONLY_PRAGMAS = new Set([
  'collation_list',
  'compile_options',
  'database_list',
  'foreign_key_check',
  'foreign_key_list',
  'function_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'integrity_check',
  'module_list',
  'pragma_list',
  'quick_check',
  'table_info',
  'table_list',
  'table_xinfo',
]);

function isReadOnlyPragma(statement) {
  const match = statement.trim().match(/^pragma\s+(?:["'`\[]?[^\s."'`\]]+["'`\]]?\s*\.\s*)?["'`\[]?([\w-]+)["'`\]]?/i);
  if (!match) {
    return false;
  }
  const name = match[1].toLowerCase();
  if (!READ_ONLY_PRAGMAS.has(name)) {
    return false;
  }
  const remainder = statement.slice(match[0].length).trim();
  return !remainder.startsWith('=');
}

function containsWriteKeyword(sql) {
  const withoutStrings = sql.replace(/'([^']|'')*'|"([^"]|"")*"|`([^`]|``)*`|\[[^\]]*\]/g, ' ');
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

function buildIdentityWhere(identity, primaryKeyColumns, rowidAlias, tableName) {
  const qualifiedRowid = `${quoteIdentifier(tableName)}.${rowidAlias}`;
  if (identity?.kind === 'visiblePosition') {
    throw new Error('This browse-only row cannot be edited because it has no durable database identity.');
  }

  if (identity?.kind === 'rowid') {
    return {
      sql: `${qualifiedRowid} = ?`,
      params: [identity.value],
    };
  }

  const primaryKey = identity?.kind === 'primaryKey'
    ? identity.values
    : identity?.primaryKey;
  if (primaryKey && primaryKeyColumns.length > 0) {
    const params = [];
    const predicates = primaryKeyColumns.map((column) => {
      params.push(primaryKey[column]);
      return `${quoteIdentifier(column)} IS ?`;
    });
    return {
      sql: predicates.join(' AND '),
      params,
    };
  }

  if (identity?.rowid !== null && identity?.rowid !== undefined) {
    return {
      sql: `${qualifiedRowid} = ?`,
      params: [identity.rowid],
    };
  }

  throw new Error('This row cannot be edited because it has neither a rowid nor a primary key.');
}
