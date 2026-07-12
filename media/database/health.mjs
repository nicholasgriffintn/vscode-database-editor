export function runDatabaseHealthChecks(db, { limit = 50 } = {}) {
  const boundedLimit = normalizeLimit(limit);
  const quickRows = readBounded(db, `PRAGMA quick_check(${boundedLimit + 1})`, boundedLimit);
  const foreignKeyRows = readBounded(db, 'PRAGMA foreign_key_check', boundedLimit);
  const quickIssues = quickRows.rows.filter((row) => String(firstValue(row)).toLowerCase() !== 'ok');
  return {
    ok: quickIssues.length === 0 && foreignKeyRows.rows.length === 0,
    quickCheck: {
      ok: quickIssues.length === 0,
      issues: quickIssues,
      truncated: quickRows.truncated,
    },
    foreignKeyCheck: {
      ok: foreignKeyRows.rows.length === 0,
      issues: foreignKeyRows.rows,
      truncated: foreignKeyRows.truncated,
    },
  };
}

export function createDatabaseHealthWorkflow({
  getDatabase,
  showReport,
  setStatus,
  limit = 50,
}) {
  return {
    run() {
      const database = getDatabase();
      if (!database) {
        return null;
      }
      const report = runDatabaseHealthChecks(database, { limit });
      showReport(formatDatabaseHealthReport(report), report);
      setStatus(report.ok ? 'Database health check passed.' : 'Database health check found issues.');
      return report;
    },
  };
}

export function formatDatabaseHealthReport(report) {
  const lines = ['DATABASE HEALTH', ''];
  appendCheck(lines, 'Quick check', report.quickCheck, (issue) => String(firstValue(issue)));
  lines.push('');
  appendCheck(lines, 'Foreign-key check', report.foreignKeyCheck, (issue) => [
    issue.table,
    `rowid ${issue.rowid ?? 'unknown'}`,
    `parent ${issue.parent ?? 'unknown'}`,
    `constraint ${issue.fkid ?? 'unknown'}`,
  ].join(' · '));
  lines.push('', report.ok ? 'No integrity or foreign-key issues found.' : 'Review these issues before saving or modifying the database.');
  return lines.join('\n');
}

function appendCheck(lines, label, check, formatIssue) {
  if (check.ok) {
    lines.push(`${label}: ok`);
    return;
  }
  lines.push(`${label}: ${check.issues.length.toLocaleString()} ${check.issues.length === 1 ? 'issue' : 'issues'} shown${check.truncated ? ' (additional issues omitted)' : ''}`);
  for (const issue of check.issues) {
    lines.push(`- ${formatIssue(issue)}`);
  }
}

function readBounded(db, sql, limit) {
  const statement = db.prepare(sql);
  const rows = [];
  let truncated = false;
  try {
    while (statement.step()) {
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      rows.push(statement.getAsObject());
    }
    return { rows, truncated };
  } finally {
    statement.free();
  }
}

function normalizeLimit(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? Math.min(numeric, 500) : 50;
}

function firstValue(row) {
  return Object.values(row)[0];
}
