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

export interface SnapshotContentChangeEvent<T extends SnapshotDocument> {
  readonly document: T;
}

export type SnapshotChangeEvent<T extends SnapshotDocument> =
  | SnapshotEditEvent<T>
  | SnapshotContentChangeEvent<T>;

export function cloneData(data: Uint8Array): Uint8Array {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

export async function applySnapshotDocumentChange<T extends SnapshotDocument>({
  document,
  data,
  label,
  emitEdit,
  postSnapshot,
  postAfterApply = false,
  maxUndoMemoryBytes = Number.POSITIVE_INFINITY,
}: {
  document: T;
  data: Uint8Array;
  label?: string;
  emitEdit: (event: SnapshotChangeEvent<T>) => void;
  postSnapshot: SnapshotPost;
  postAfterApply?: boolean;
  maxUndoMemoryBytes?: number;
}): Promise<void> {
  const before = cloneData(document.getData());
  const after = cloneData(data);

  if (postAfterApply) {
    await postSnapshot(cloneData(after));
  }

  document.updateData(cloneData(after));
  if (shouldKeepUndoSnapshots(before, after, maxUndoMemoryBytes)) {
    emitEdit(createSnapshotEditEvent({ document, before, after, label, postSnapshot }));
  } else {
    emitEdit({ document });
  }
}

function shouldKeepUndoSnapshots(before: Uint8Array, after: Uint8Array, maxUndoMemoryBytes: number): boolean {
  const budget = Number(maxUndoMemoryBytes);
  return !Number.isFinite(budget) || budget <= 0 || before.byteLength + after.byteLength <= budget;
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
