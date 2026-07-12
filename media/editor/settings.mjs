export const DEFAULT_EDITOR_SETTINGS = Object.freeze({
  maxFileSizeMb: 200,
  defaultPageSize: 500,
  autoPagination: true,
  maxRows: 0,
  instantCommit: 'never',
  doubleClickBehavior: 'inline',
  blobExportMode: 'native',
  queryTimeoutMs: 30_000,
  maxUndoMemoryBytes: 52_428_800,
  isRemote: false,
});

const INSTANT_COMMIT_VALUES = new Set(['always', 'never', 'remote-only']);
const DOUBLE_CLICK_VALUES = new Set(['inline', 'modal']);
const BLOB_EXPORT_VALUES = new Set(['native', 'web']);

export function normalizeEditorSettings(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    maxFileSizeMb: normalizeNonNegativeNumber(source.maxFileSizeMb, DEFAULT_EDITOR_SETTINGS.maxFileSizeMb),
    defaultPageSize: normalizePositiveInteger(source.defaultPageSize, DEFAULT_EDITOR_SETTINGS.defaultPageSize),
    autoPagination: typeof source.autoPagination === 'boolean' ? source.autoPagination : DEFAULT_EDITOR_SETTINGS.autoPagination,
    maxRows: normalizeNonNegativeInteger(source.maxRows, DEFAULT_EDITOR_SETTINGS.maxRows),
    instantCommit: INSTANT_COMMIT_VALUES.has(source.instantCommit) ? source.instantCommit : DEFAULT_EDITOR_SETTINGS.instantCommit,
    doubleClickBehavior: DOUBLE_CLICK_VALUES.has(source.doubleClickBehavior) ? source.doubleClickBehavior : DEFAULT_EDITOR_SETTINGS.doubleClickBehavior,
    blobExportMode: BLOB_EXPORT_VALUES.has(source.blobExportMode) ? source.blobExportMode : DEFAULT_EDITOR_SETTINGS.blobExportMode,
    queryTimeoutMs: normalizePositiveInteger(source.queryTimeoutMs, DEFAULT_EDITOR_SETTINGS.queryTimeoutMs, { min: 100 }),
    maxUndoMemoryBytes: normalizePositiveInteger(source.maxUndoMemoryBytes, DEFAULT_EDITOR_SETTINGS.maxUndoMemoryBytes, { min: 1024 }),
    isRemote: Boolean(source.isRemote),
  };
}

export function shouldRejectWasmFile({ fileSizeBytes, maxFileSizeMb }) {
  const maxMb = normalizeNonNegativeNumber(maxFileSizeMb, DEFAULT_EDITOR_SETTINGS.maxFileSizeMb);
  if (maxMb === 0) {
    return false;
  }
  return Number(fileSizeBytes) > maxMb * 1024 * 1024;
}

export function getEffectiveRowWindow({ totalRows, page, pageSize, maxRows }) {
  const effectiveTotalRows = getEffectiveTotalRows({ totalRows, maxRows });
  const normalizedPageSize = normalizePositiveInteger(pageSize, DEFAULT_EDITOR_SETTINGS.defaultPageSize);
  const maxPage = Math.max(1, Math.ceil(effectiveTotalRows / normalizedPageSize));
  const normalizedPage = Math.min(
    Math.max(1, normalizePositiveInteger(page, 1)),
    maxPage,
  );
  const offset = Math.min((normalizedPage - 1) * normalizedPageSize, effectiveTotalRows);
  const remainingRows = Math.max(0, effectiveTotalRows - offset);
  return {
    effectiveTotalRows,
    page: normalizedPage,
    limit: Math.min(normalizedPageSize, remainingRows),
    offset,
  };
}

export function getEffectiveTotalRows({ totalRows, maxRows }) {
  const rowCount = Math.max(0, normalizeNonNegativeInteger(totalRows, 0));
  const cap = normalizeNonNegativeInteger(maxRows, DEFAULT_EDITOR_SETTINGS.maxRows);
  return cap > 0 ? Math.min(rowCount, cap) : rowCount;
}

export function getInstantCommitAction({ strategy, isRemote }) {
  switch (strategy) {
    case 'always':
      return 'save';
    case 'remote-only':
      return isRemote ? 'save' : 'manual';
    case 'never':
    default:
      return 'manual';
  }
}

export function getDoubleClickEditMode({ behavior, canInlineEdit }) {
  if (behavior === 'inline' && canInlineEdit) {
    return 'inline';
  }
  return 'modal';
}

export function getBlobExportStrategy({ configured }) {
  return configured === 'web' ? 'web' : 'native';
}

function normalizePositiveInteger(value, fallback, { min = 1 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function normalizeNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}
