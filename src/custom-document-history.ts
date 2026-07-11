export interface SnapshotDocument {
  getData(): Uint8Array;
  getRevision(): number;
  updateData(data: Uint8Array): number;
  enqueueMutation<T>(operation: () => PromiseLike<T> | T): Promise<T>;
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

export type SnapshotApplyResult =
  | { accepted: true; revision: number }
  | { accepted: false; currentRevision: number };

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
  expectedRevision,
}: {
  document: T;
  data: Uint8Array;
  label?: string;
  emitEdit: (event: SnapshotChangeEvent<T>) => void;
  postSnapshot: SnapshotPost;
  postAfterApply?: boolean;
  maxUndoMemoryBytes?: number;
  expectedRevision?: number;
}): Promise<SnapshotApplyResult> {
  return enqueue(document, async () => {
    const currentRevision = getRevision(document);
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      return { accepted: false, currentRevision };
    }

    const before = cloneData(document.getData());
    const after = cloneData(data);
    document.updateData(cloneData(after));
    const revision = getRevision(document);

    if (shouldKeepUndoSnapshots(before, after, maxUndoMemoryBytes)) {
      emitEdit(createSnapshotEditEvent({ document, before, after, label, postSnapshot }));
    } else {
      emitEdit({ document });
    }

    if (postAfterApply) {
      await postBestEffort(postSnapshot, after);
    }
    return { accepted: true, revision };
  });
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
    await enqueue(document, async () => {
      const nextData = cloneData(snapshot);
      document.updateData(nextData);
      await postBestEffort(postSnapshot, nextData);
    });
  }

  return {
    document,
    label,
    undo: () => apply(beforeSnapshot),
    redo: () => apply(afterSnapshot),
  };
}

function getRevision(document: SnapshotDocument): number {
  return typeof document.getRevision === 'function' ? document.getRevision() : 0;
}

function enqueue<T>(document: SnapshotDocument, operation: () => PromiseLike<T> | T): Promise<T> {
  return typeof document.enqueueMutation === 'function'
    ? document.enqueueMutation(operation)
    : Promise.resolve().then(operation);
}

async function postBestEffort(postSnapshot: SnapshotPost, data: Uint8Array): Promise<void> {
  try {
    await postSnapshot(cloneData(data));
  } catch {
    // Panels can be disposed while a queued authoritative mutation is completing.
  }
}
