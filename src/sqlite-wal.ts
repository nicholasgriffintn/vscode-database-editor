import type * as vscode from 'vscode';

import { formatByteSize } from './utilities/number';

export type WalSidecarResult =
  | { detected: false }
  | { detected: true; size: number; warning: string };

export async function detectWalSidecar({
  databaseUri,
  stat,
}: {
  databaseUri: vscode.Uri;
  stat: typeof vscode.workspace.fs.stat;
}): Promise<WalSidecarResult> {
  if (databaseUri.scheme !== 'file') {
    return { detected: false };
  }
  try {
    const walUri = databaseUri.with({ path: `${databaseUri.path}-wal` });
    const wal = await stat(walUri);
    if (wal.size <= 0) {
      return { detected: false };
    }
    return {
      detected: true,
      size: wal.size,
      warning: `A non-empty SQLite WAL sidecar (${formatByteSize(wal.size)}) exists. The main database file may not include uncheckpointed changes from another connection.`,
    };
  } catch {
    return { detected: false };
  }
}
