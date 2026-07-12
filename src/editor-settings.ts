export interface EditorSettings {
  maxFileSizeMb: number;
  defaultPageSize: number;
  autoPagination: boolean;
  maxRows: number;
  instantCommit: 'always' | 'never' | 'remote-only';
  doubleClickBehavior: 'inline' | 'modal';
  blobExportMode: 'native' | 'web';
  queryTimeoutMs: number;
  maxUndoMemoryBytes: number;
  isRemote: boolean;
}

export interface ConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

export function readEditorSettings(configuration: ConfigurationReader, isRemote: boolean): EditorSettings {
  return normalizeEditorSettings({
    maxFileSizeMb: configuration.get('maxFileSizeMb', 200),
    defaultPageSize: configuration.get('defaultPageSize', 500),
    autoPagination: configuration.get('autoPagination', true),
    maxRows: configuration.get('maxRows', 0),
    instantCommit: configuration.get<EditorSettings['instantCommit']>('instantCommit', 'never'),
    doubleClickBehavior: configuration.get<EditorSettings['doubleClickBehavior']>('doubleClickBehavior', 'inline'),
    blobExportMode: configuration.get<EditorSettings['blobExportMode']>('blobExportMode', 'native'),
    queryTimeoutMs: configuration.get('queryTimeoutMs', 30_000),
    maxUndoMemoryBytes: configuration.get('maxUndoMemoryBytes', 52_428_800),
    isRemote,
  });
}

export function normalizeEditorSettings(settings: Partial<EditorSettings>): EditorSettings {
  return {
    maxFileSizeMb: nonNegativeNumber(settings.maxFileSizeMb, 200),
    defaultPageSize: positiveInteger(settings.defaultPageSize, 500),
    autoPagination: typeof settings.autoPagination === 'boolean' ? settings.autoPagination : true,
    maxRows: nonNegativeInteger(settings.maxRows, 0),
    instantCommit: normalizeInstantCommit(settings.instantCommit),
    doubleClickBehavior: normalizeDoubleClickBehavior(settings.doubleClickBehavior),
    blobExportMode: normalizeBlobExportMode(settings.blobExportMode),
    queryTimeoutMs: positiveInteger(settings.queryTimeoutMs, 30_000, 100),
    maxUndoMemoryBytes: positiveInteger(settings.maxUndoMemoryBytes, 52_428_800, 1024),
    isRemote: Boolean(settings.isRemote),
  };
}

function normalizeInstantCommit(value: unknown): EditorSettings['instantCommit'] {
  return value === 'always' || value === 'remote-only' ? value : 'never';
}

function normalizeDoubleClickBehavior(value: unknown): EditorSettings['doubleClickBehavior'] {
  return value === 'modal' ? 'modal' : 'inline';
}

function normalizeBlobExportMode(value: unknown): EditorSettings['blobExportMode'] {
  return value === 'web' ? 'web' : 'native';
}

function positiveInteger(value: unknown, fallback: number, minimum = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
