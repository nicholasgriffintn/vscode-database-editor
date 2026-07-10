import { createHash } from 'node:crypto';

export class SqliteDocumentState {
  private data: Uint8Array;
  private savedFingerprint: string | undefined;

  constructor(initialData: Uint8Array, savedData: Uint8Array | null = initialData) {
    this.data = initialData;
    this.savedFingerprint = savedData ? fingerprint(savedData) : undefined;
  }

  getData(): Uint8Array {
    return this.data;
  }

  updateData(data: Uint8Array): void {
    this.data = data;
  }

  markSaved(data: Uint8Array = this.data): void {
    this.savedFingerprint = fingerprint(data);
  }

  replaceWithSavedData(data: Uint8Array): void {
    this.data = data;
    this.markSaved();
  }

  isDirty(
    data: Uint8Array = this.data,
    { isNewEdit = false }: { isNewEdit?: boolean } = {},
  ): boolean {
    return isNewEdit || this.savedFingerprint === undefined || fingerprint(data) !== this.savedFingerprint;
  }
}

function fingerprint(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('base64');
}
