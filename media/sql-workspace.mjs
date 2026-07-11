import { isReadOnlyStatement } from './sql-utils.mjs';

export function executeSqlStatements(db, statements, options = {}) {
  const context = createExecutionContext(options);
  const results = [];
  for (const [index, sql] of statements.entries()) {
    const statement = db.prepare(sql);
    try {
      const result = executePreparedStatement(statement, sql, index + 1, context);
      if (result) {
        results.push(result);
      }
    } finally {
      statement.free();
    }
  }
  return results;
}

export function executeSqlScript(db, sql, options = {}) {
  const context = createExecutionContext(options);
  const iterator = db.iterateStatements(sql);
  const results = [];
  let statementIndex = 0;
  let finished = false;

  try {
    while (true) {
      assertExecutionCanContinue(context);
      const next = iterator.next();
      if (next.done) {
        finished = true;
        break;
      }
      statementIndex += 1;
      const statementSql = next.value.getSQL();
      const result = executePreparedStatement(next.value, statementSql, statementIndex, context);
      if (result) {
        results.push(result);
      }
    }
    return results;
  } finally {
    if (!finished) {
      drainStatementIterator(iterator);
    }
  }
}

export function prepareSqlWorkspaceResults({ results, changed, previewLimit, statementCount }) {
  if (results.length === 0) {
    return {
      results: [],
      message: changed
        ? `Executed ${statementCount.toLocaleString()} statement${statementCount === 1 ? '' : 's'} · database modified`
        : 'Query returned no rows.',
      kind: changed ? 'success' : 'info',
    };
  }

  let rowCount = 0;
  let truncatedStatements = 0;
  const preparedResults = results.map((result, index) => {
    rowCount += result.rowCount;
    if (result.truncated) {
      truncatedStatements += 1;
    }
    return {
      ...result,
      __truncated: result.truncated,
      __rowCount: result.rowCount,
      __truncatedStatementIndex: result.statementIndex ?? index + 1,
    };
  });
  const truncationMessage = truncatedStatements
    ? ` · ${truncatedStatements.toLocaleString()} result set${truncatedStatements === 1 ? '' : 's'} truncated to ${previewLimit.toLocaleString()} retained rows`
    : '';
  const countLabel = `${truncatedStatements ? 'at least ' : ''}${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'}`;

  return {
    results: preparedResults,
    message: changed
      ? `${countLabel} · database modified${truncationMessage}`
      : `${countLabel}${truncationMessage}`,
    kind: changed ? 'success' : 'info',
  };
}

function drainStatementIterator(iterator) {
  try {
    while (!iterator.next().done) {
      // Advancing finalizes the previous statement without executing remaining SQL.
    }
  } catch {
    // A parse failure finalizes the iterator itself; preserve the original execution error.
  }
}

function executePreparedStatement(statement, sql, statementIndex, context) {
  const columns = statement.getColumnNames();
  const readOnly = isReadOnlyStatement(sql);
  const values = [];
  let rowCount = 0;
  let truncated = false;

  while (statement.step()) {
    assertExecutionCanContinue(context);
    if (columns.length === 0) {
      continue;
    }

    rowCount += 1;
    if (values.length < context.previewLimit) {
      values.push(statement.get());
    } else if (readOnly) {
      truncated = true;
      break;
    } else {
      truncated = true;
    }
  }

  if (columns.length === 0) {
    return null;
  }

  const result = { columns, values };
  Object.defineProperties(result, {
    rowCount: { value: rowCount, enumerable: false },
    truncated: { value: truncated, enumerable: false },
    statementIndex: { value: statementIndex, enumerable: false },
  });
  return result;
}

function createExecutionContext(options) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  return {
    previewLimit: normalizePreviewLimit(options.previewLimit),
    timeoutMs: Math.max(0, Number(options.timeoutMs) || 0),
    now,
    isCancelled: typeof options.isCancelled === 'function' ? options.isCancelled : () => false,
    startedAt: now(),
  };
}

function normalizePreviewLimit(value) {
  if (value === undefined || value === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor(Number(value) || 0));
}

function assertExecutionCanContinue({ isCancelled, timeoutMs, now, startedAt }) {
  if (isCancelled()) {
    throw new Error('SQLite query was cancelled.');
  }
  if (timeoutMs > 0 && now() - startedAt > timeoutMs) {
    throw new Error(`SQLite query timed out after ${timeoutMs} ms.`);
  }
}
