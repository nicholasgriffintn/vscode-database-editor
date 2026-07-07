export interface SnapshotDocument {
  getData(): Uint8Array;
  updateData(data: Uint8Array): void;
}

export type SnapshotPost = (data: Uint8Array) => PromiseLike<void> | void;

export interface SnapshotEditEvent<T extends SnapshotDocument> {
  readonly document: T;
  readonly label?: string;
  undo(): PromiseLike<void> | void;
  redo(): PromiseLike<void> | void;
}

export function cloneData(data: Uint8Array): Uint8Array {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

export function createSnapshotEditEvent<T extends SnapshotDocument>({
  document,
  before,
  after,
  label,
  postSnapshot,
}: {
  document: T;
  before: Uint8Array;
  after: Uint8Array;
  label?: string;
  postSnapshot: SnapshotPost;
}): SnapshotEditEvent<T> {
  const beforeSnapshot = cloneData(before);
  const afterSnapshot = cloneData(after);

  async function apply(snapshot: Uint8Array): Promise<void> {
    const nextData = cloneData(snapshot);
    document.updateData(nextData);
    await postSnapshot(cloneData(nextData));
  }

  return {
    document,
    label,
    undo: () => apply(beforeSnapshot),
    redo: () => apply(afterSnapshot),
  };
}
