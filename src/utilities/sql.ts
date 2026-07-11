export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteIdentifier(identifier: string): string {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function serializeSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString('hex')}'`;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  return sqlLiteral(String(value));
}

export function terminateSqlStatement(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}
