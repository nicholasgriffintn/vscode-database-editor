import { safeFileName } from './file-utils.mjs';

export function createSqlExportRequest({ databaseName, revision, requestId }) {
  return {
    type: 'exportSql',
    fileName: `${safeFileName(databaseName)}.sql`,
    revision,
    requestId,
  };
}
