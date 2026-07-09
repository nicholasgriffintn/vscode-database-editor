const DEFAULT_QUERY_HISTORY_LIMIT = 20;
const DEFAULT_QUERY_HISTORY_LABEL_LENGTH = 72;

export function addQueryHistoryEntry(history, sql, { limit = DEFAULT_QUERY_HISTORY_LIMIT } = {}) {
  const entry = normalizeQueryText(sql);
  const current = normalizeQueryHistory(history, { limit });
  if (!entry) {
    return current;
  }

  return [entry, ...current.filter((item) => item !== entry)].slice(0, limit);
}

export function normalizeQueryHistory(history, { limit = DEFAULT_QUERY_HISTORY_LIMIT } = {}) {
  if (!Array.isArray(history)) {
    return [];
  }

  const entries = [];
  for (const item of history) {
    const entry = normalizeQueryText(item);
    if (!entry || entries.includes(entry)) {
      continue;
    }
    entries.push(entry);
    if (entries.length >= limit) {
      break;
    }
  }
  return entries;
}

export function formatQueryHistoryLabel(sql, { maxLength = DEFAULT_QUERY_HISTORY_LABEL_LENGTH } = {}) {
  const text = normalizeQueryText(sql).replace(/\s+/g, ' ');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeQueryText(sql) {
  return String(sql ?? '').trim();
}
