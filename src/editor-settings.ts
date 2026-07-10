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
  return {
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
  };
}
