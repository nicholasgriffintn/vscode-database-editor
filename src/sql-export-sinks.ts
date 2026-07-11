import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

import type { SqlExportSink } from './sql-export';

export function createFileSqlExportSink(filePath: string): SqlExportSink {
  const partialPath = `${filePath}.database-editor-partial-${randomUUID()}`;
  const stream = createWriteStream(partialPath, { encoding: 'utf8' });
  let completed = false;
  return {
    write: async (chunk) => {
      await new Promise<void>((resolve, reject) => {
        stream.write(chunk, 'utf8', (error) => error ? reject(error) : resolve());
      });
    },
    complete: async () => {
      stream.end();
      await finished(stream);
      await rename(partialPath, filePath);
      completed = true;
    },
    abort: async () => {
      if (!completed && !stream.closed) {
        await new Promise<void>((resolve) => {
          stream.once('close', resolve);
          stream.destroy();
        });
      }
      await rm(partialPath, { force: true });
    },
  };
}

export function createBufferedSqlExportSink({
  maxBytes,
  writeFile,
}: {
  maxBytes: number;
  writeFile: (content: Uint8Array) => Promise<void>;
}): SqlExportSink {
  const limit = Math.max(1, Math.floor(maxBytes));
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  return {
    write: async (chunk) => {
      const bytes = Buffer.from(chunk, 'utf8');
      if (totalBytes + bytes.byteLength > limit) {
        throw new Error(`SQL export exceeded the ${limit} byte non-file limit.`);
      }
      chunks.push(bytes);
      totalBytes += bytes.byteLength;
    },
    complete: async () => {
      const content = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await writeFile(content);
      chunks.length = 0;
      totalBytes = 0;
    },
    abort: async () => {
      chunks.length = 0;
      totalBytes = 0;
    },
  };
}
