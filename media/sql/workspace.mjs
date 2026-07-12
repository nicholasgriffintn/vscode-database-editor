import { arraysEqual } from '../utilities/array.mjs';
import { createElement, clear } from '../utilities/dom.mjs';
import { getErrorMessage } from '../utilities/errors.mjs';
import {
  createConfirmationModel,
  getDestructiveSqlConfirmationDetails,
  requiresDestructiveSqlConfirmation,
} from '../dialogs/workflows.mjs';
import { addQueryHistoryEntry, formatQueryHistoryLabel, normalizeQueryHistory } from './query-history.mjs';
import { analyzeSqlScript, assertSqlScriptCanExport, describeValue, isReadOnlyStatement } from './statements.mjs';

export function createSqlWorkspace({
  elements,
  vscode,
  initialHistory,
  executeScript,
  getDatabase,
  getSettings,
  confirm,
  markChanged,
  refreshTables,
  previewLimit = 2500,
}) {
  let sql = 'SELECT name, type FROM sqlite_schema ORDER BY type, name;';
  let history = normalizeQueryHistory(initialHistory);

  function setSql(value, { focus = true } = {}) {
    sql = value;
    elements.queryInput.value = value;
    if (focus) elements.queryInput.focus();
  }

  function captureInput() {
    sql = elements.queryInput.value;
  }

  function loadHistory(index) {
    if (!Number.isInteger(index) || !history[index]) return false;
    setSql(history[index]);
    setMessage('Loaded query from history.');
    return true;
  }

  function renderHistory() {
    const placeholder = createElement('option', { text: history.length === 0 ? 'No history yet' : 'Query history', attributes: { value: '' } });
    elements.queryHistorySelect.replaceChildren(placeholder, ...history.map((entry, index) => createElement('option', {
      text: formatQueryHistoryLabel(entry), title: entry, attributes: { value: String(index) },
    })));
    elements.queryHistorySelect.value = '';
    elements.queryHistorySelect.disabled = history.length === 0;
  }

  async function run() {
    clear(elements.queryOutput);
    setMessage('');
    const database = getDatabase();
    if (!database) return setMessage('Open a database before running SQL.', 'warning');
    const analysis = analyzeSqlScript(sql);
    if (analysis.isEmpty) return setMessage('Enter a SQL statement to run.', 'warning');
    if (requiresDestructiveSqlConfirmation(analysis)) {
      const details = getDestructiveSqlConfirmationDetails(analysis) ?? { action: 'destructive SQL', target: 'the identified SQL target' };
      if (!await confirm(createConfirmationModel({ kind: 'sql', ...details }), document.activeElement)) {
        return setMessage('Destructive SQL was not run.', 'warning');
      }
    }
    recordHistory();
    try {
      const limit = Math.min(previewLimit, getSettings().maxRows || previewLimit);
      const { results, changed } = executeScript(database, sql, analysis, { previewLimit: limit, timeoutMs: getSettings().queryTimeoutMs });
      assertSqlScriptCanExport(analysis);
      if (changed) { markChanged(); await refreshTables(); }
      const prepared = prepareSqlWorkspaceResults({ results, changed, previewLimit: limit, statementCount: analysis.statementCount });
      setMessage(prepared.message, prepared.kind);
      for (const result of prepared.results) elements.queryOutput.append(await renderResultTable(result));
    } catch (error) {
      const message = getErrorMessage(error);
      if (!error?.databaseChanged) return setMessage(message, 'error');
      markChanged();
      try {
        await refreshTables();
        setMessage(`${message} · database may have changed`, 'error');
      } catch (refreshError) {
        setMessage(`${message} · database may have changed; refresh failed: ${getErrorMessage(refreshError)}`, 'error');
      }
    }
  }

  function recordHistory() {
    const next = addQueryHistoryEntry(history, sql);
    if (next === history || arraysEqual(next, history)) return;
    history = next;
    vscode.setState({ ...(vscode.getState?.() ?? {}), queryHistory: history });
    renderHistory();
  }

  function setMessage(message, kind = 'info') {
    elements.queryMessage.textContent = message;
    elements.queryMessage.classList.remove('success', 'warning', 'error');
    if (kind !== 'info') elements.queryMessage.classList.add(kind);
  }

  renderHistory();
  setSql(sql, { focus: false });
  return { captureInput, loadHistory, renderHistory, run, setSql };
}

async function renderResultTable(result) {
  const table = createElement('table', { className: 'data-grid result-grid' });
  table.append(createElement('thead', { children: [createElement('tr', {
    children: result.columns.map((column) => createElement('th', { text: column })),
  })] }));
  const body = createElement('tbody');
  for (const [index, row] of result.values.entries()) {
    body.append(createElement('tr', { children: row.map((value) => createElement('td', { text: describeValue(value) })) }));
    if (index > 0 && index % 200 === 0) await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
  if (result.__truncated) {
    body.append(createElement('tr', { className: 'query-result-truncated', children: [createElement('td', {
      attributes: { colspan: String(result.columns.length) },
      text: `Result truncated after ${result.values.length.toLocaleString()} retained rows; at least ${result.__rowCount.toLocaleString()} rows were available ${result.__truncatedStatementIndex ? `(statement ${result.__truncatedStatementIndex})` : ''}.`,
    })] }));
  }
  table.append(body);
  return table;
}

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
