import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { SqlWorkerRequest, SqlWorkerResponse, SqlWorkerResult } from './sql-worker';

type CancellationTokenLike = {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => void): { dispose(): void };
};

export type SqlWorkerClient = {
  run<TRequest extends SqlWorkerRequest>(
    request: TRequest,
    options: { timeoutMs: number; cancellationToken?: CancellationTokenLike },
  ): Promise<SqlWorkerResult<TRequest>>;
};

export function createSqlWorkerClient({ extensionPath }: { extensionPath: string }): SqlWorkerClient {
  return {
    run: (request, options) => runSqlWorkerRequest({ extensionPath, request, ...options }),
  };
}

export function runSqlWorkerRequest<TRequest extends SqlWorkerRequest>({
  extensionPath,
  request,
  timeoutMs,
  cancellationToken,
}: {
  extensionPath: string;
  request: SqlWorkerRequest;
  timeoutMs: number;
  cancellationToken?: CancellationTokenLike;
}): Promise<SqlWorkerResult<TRequest>> {
  const workerPath = path.join(__dirname, 'sql-worker.js');
  const worker = new Worker(workerPath);
  const database = new Uint8Array(request.database);
  const effectiveTimeoutMs = Math.max(1, Math.floor(timeoutMs));

  return new Promise<SqlWorkerResult<TRequest>>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cancellationPoll) clearInterval(cancellationPoll);
      cancellationSubscription?.dispose();
      void worker.terminate();
      operation();
    };
    const cancel = () => finish(() => reject(new Error('SQLite operation was cancelled.')));
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`SQLite query timed out after ${effectiveTimeoutMs} ms.`)));
    }, effectiveTimeoutMs);
    const cancellationSubscription = cancellationToken?.onCancellationRequested?.(cancel);
    const cancellationPoll = cancellationToken && !cancellationSubscription
      ? setInterval(() => {
        if (cancellationToken.isCancellationRequested) cancel();
      }, 10)
      : undefined;

    worker.once('message', (response: SqlWorkerResponse) => {
      finish(() => response.ok
        ? resolve(response.value as SqlWorkerResult<TRequest>)
        : reject(new Error(response.error)));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      finish(() => reject(new Error(`SQLite worker exited before responding (code ${code}).`)));
    });

    if (cancellationToken?.isCancellationRequested) {
      cancel();
      return;
    }
    worker.postMessage({ extensionPath, request: { ...request, database } }, [database.buffer]);
  });
}
