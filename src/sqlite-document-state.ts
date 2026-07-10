import { createHash } from 'node:crypto';

export class SqliteDocumentState {
  private data: Uint8Array;
  private savedFingerprint: string | undefined;
  private dataFingerprint: string | undefined;

  constructor(initialData: Uint8Array, savedData: Uint8Array | null = initialData) {
    this.data = initialData;
    this.savedFingerprint = savedData ? this.fingerprint(savedData) : undefined;
    this.dataFingerprint = this.fingerprint(initialData);
  }

  getData(): Uint8Array {
    return this.data;
  }

  updateData(data: Uint8Array): void {
    this.data = data;
    this.dataFingerprint = undefined;
  }

  markSaved(data: Uint8Array = this.data): void {
    this.savedFingerprint = this.fingerprint(data);
    if (data === this.data) {
      this.dataFingerprint = this.savedFingerprint;
    }
  }

  replaceWithSavedData(data: Uint8Array): void {
    this.data = data;
    const savedFingerprint = this.fingerprint(data);
    this.savedFingerprint = savedFingerprint;
    this.dataFingerprint = savedFingerprint;
  }

  isDirty(
    data: Uint8Array = this.data,
    { isNewEdit = false }: { isNewEdit?: boolean } = {},
  ): boolean {
    if (isNewEdit) {
      return true;
    }

    if (this.savedFingerprint === undefined) {
      return true;
    }

    return this.getDataFingerprint(data) !== this.savedFingerprint;
  }

  private getDataFingerprint(data: Uint8Array): string {
    if (data === this.data && this.dataFingerprint !== undefined) {
      return this.dataFingerprint;
    }
    return this.fingerprint(data);
  }

  private fingerprint(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('base64');
  }
}
