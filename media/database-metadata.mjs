export function createRowCountCache() {
  const counts = new Map();
  let cachedRevision;

  return {
    get({ revision, objectName, filterKey = '', load }) {
      if (revision !== cachedRevision) {
        counts.clear();
        cachedRevision = revision;
      }
      const key = createCountKey(revision, objectName, filterKey);
      if (!counts.has(key)) {
        counts.set(key, { objectName, value: load() });
      }
      return counts.get(key).value;
    },
    invalidateObject(objectName) {
      for (const [key, entry] of counts) {
        if (entry.objectName === objectName) {
          counts.delete(key);
        }
      }
    },
    clear() {
      counts.clear();
    },
  };
}

export function createRowCountFilterKey(filter = '', columnFilters = {}) {
  return JSON.stringify([
    String(filter).trim(),
    Object.entries(columnFilters)
      .filter(([, value]) => String(value).trim())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, String(value).trim()]),
  ]);
}

export function formatRowCount(count, { loading = false } = {}) {
  if (loading) {
    return 'Loading rows…';
  }
  if (!Number.isFinite(count)) {
    return 'Rows not counted';
  }
  return `${count.toLocaleString()} row${count === 1 ? '' : 's'}`;
}

export function getUnknownCountRowWindow({
  page,
  pageSize,
  autoPagination,
  loadedRows,
  maxRows = 0,
}) {
  const offset = autoPagination
    ? Math.max(0, Number(loadedRows) || 0)
    : Math.max(0, ((Number(page) || 1) - 1) * pageSize);
  const remaining = maxRows > 0 ? Math.max(0, maxRows - offset) : Number.POSITIVE_INFINITY;
  const retainedLimit = Math.min(pageSize, remaining);
  const limit = retainedLimit + (remaining > retainedLimit ? 1 : 0);
  return { offset, limit, retainedLimit };
}

export function resolveUnknownCountRows(rows, { offset, retainedLimit }) {
  const hasMore = rows.length > retainedLimit;
  const retainedRows = rows.slice(0, retainedLimit);
  return {
    rows: retainedRows,
    totalRows: offset + retainedRows.length + (hasMore ? 1 : 0),
    hasMore,
  };
}

function createCountKey(revision, objectName, filterKey) {
  return JSON.stringify([Number(revision), String(objectName), String(filterKey)]);
}
