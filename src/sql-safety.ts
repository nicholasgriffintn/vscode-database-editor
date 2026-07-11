export { quoteIdentifier } from './utilities/sql';

const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|create|replace|vacuum|attach|detach|pragma|reindex)\b/i;
const MODIFICATION_KEYWORDS = /^(insert|update|delete|replace|create|alter|drop)\b/i;
const TRANSACTION_KEYWORDS = /^(begin|commit|rollback|savepoint|release)\b/i;

export function isReadOnlyQuery(sql: string): boolean {
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

export function isSingleStatement(sql: string): boolean {
  return splitSqlStatements(stripSqlComments(sql)).length === 1;
}

export function isAllowedModification(sql: string): boolean {
  const statements = splitSqlStatements(stripSqlComments(sql));
  if (statements.length !== 1) {
    return false;
  }

  const statement = statements[0].trim();
  return MODIFICATION_KEYWORDS.test(statement) && !TRANSACTION_KEYWORDS.test(statement);
}

export function capRows(
  rows: Record<string, unknown>[],
  maxRows = 200,
  redactedColumns: RegExp[] = [],
  redactedColumnNames: ReadonlySet<string> = new Set(),
): {
  rows: Record<string, unknown>[];
  truncated: boolean;
  rowCount: number;
} {
  const cappedRows = rows.slice(0, maxRows).map((row) => jsonSafeRow(row, redactedColumns, redactedColumnNames));
  return {
    rows: cappedRows,
    truncated: rows.length > maxRows,
    rowCount: rows.length,
  };
}

export function jsonSafeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `[BLOB ${value.byteLength} bytes]`;
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return null;
  }
  return value ?? null;
}

function jsonSafeRow(
  row: Record<string, unknown>,
  redactedColumns: RegExp[],
  redactedColumnNames: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    redactedColumnNames.has(key) || redactedColumns.some((pattern) => pattern.test(key))
      ? '[REDACTED]'
      : jsonSafeValue(value),
  ]));
}

function stripSqlComments(sql: string): string {
  let output = '';
  let index = 0;
  let quote: string | undefined;

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
        quote = undefined;
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

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: string | undefined;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];

    if (quote) {
      current += character;
      if (character === quote) {
        if (sql[index + 1] === quote) {
          current += sql[index + 1];
          index += 1;
        } else {
          quote = undefined;
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

function containsWriteKeyword(sql: string): boolean {
  return WRITE_KEYWORDS.test(sql.replace(/'([^']|'')*'|"([^"]|"")*"/g, ' '));
}
