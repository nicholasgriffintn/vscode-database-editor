export interface TextSink {
  write(chunk: string): Promise<void>;
}

export class TextChunkBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private readonly targetBytes: number;

  constructor(private readonly sink: TextSink, targetBytes = 64 * 1024) {
    this.targetBytes = Math.max(256, Math.floor(targetBytes));
  }

  async append(chunk: string): Promise<boolean> {
    const chunkBytes = Buffer.byteLength(chunk);
    let flushed = false;
    if (this.bytes > 0 && this.bytes + chunkBytes > this.targetBytes) {
      await this.flush();
      flushed = true;
    }
    this.chunks.push(chunk);
    this.bytes += chunkBytes;
    return flushed;
  }

  async flush(): Promise<void> {
    if (this.chunks.length === 0) {
      return;
    }
    const content = this.chunks.join('');
    this.chunks = [];
    this.bytes = 0;
    await this.sink.write(content);
  }
}
