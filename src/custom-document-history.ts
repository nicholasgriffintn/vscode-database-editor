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

export type CloneData = (data: Uint8Array) => Uint8Array;

export function cloneData(data: Uint8Array): Uint8Array {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

/**
 * Peak copy expectations:
 * - Over-budget path clones only the incoming payload once, then applies it directly and
 *   emits a content-change event.
 * - In-budget path clones current bytes once and incoming bytes once before updating the
 *   document, then stores both immutable snapshots for undo/redo.
 */
export async function applySnapshotDocumentChange<T extends SnapshotDocument>({
  document,
  data,
  label,
  emitEdit,
  postSnapshot,
  postAfterApply = false,
  maxUndoMemoryBytes = Number.POSITIVE_INFINITY,
  expectedRevision,
  cloneData: cloneBytes = cloneData,
}: {
  document: T;
  data: Uint8Array;
  label?: string;
  emitEdit: (event: SnapshotChangeEvent<T>) => void;
  postSnapshot: SnapshotPost;
  postAfterApply?: boolean;
  maxUndoMemoryBytes?: number;
  expectedRevision?: number;
  cloneData?: CloneData;
}): Promise<SnapshotApplyResult> {
  return enqueue(document, async () => {
    const currentRevision = getRevision(document);
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      return { accepted: false, currentRevision };
    }

    const before = document.getData();
    const keepUndoSnapshots = shouldKeepUndoSnapshots(before.byteLength, data.byteLength, maxUndoMemoryBytes);
    let postedData: Uint8Array;

    if (keepUndoSnapshots) {
      const beforeSnapshot = cloneBytes(before);
      const afterSnapshot = cloneBytes(data);
      document.updateData(afterSnapshot);
      postedData = afterSnapshot;

      emitEdit(
        createSnapshotEditEvent({
          document,
          before: beforeSnapshot,
          after: afterSnapshot,
          label,
          postSnapshot,
          cloneData: cloneBytes,
          cloneInputs: false,
        }),
      );
    } else {
      const replacement = cloneBytes(data);
      document.updateData(replacement);
      postedData = replacement;
      emitEdit({ document });
    }

    const revision = getRevision(document);

    if (postAfterApply) {
      await postBestEffort(postSnapshot, postedData);
    }
    return { accepted: true, revision };
  });
}

function shouldKeepUndoSnapshots(currentLength: number, nextLength: number, maxUndoMemoryBytes: number): boolean {
  const budget = Number(maxUndoMemoryBytes);
  return !Number.isFinite(budget) || budget <= 0 || currentLength + nextLength <= budget;
}

export function createSnapshotEditEvent<T extends SnapshotDocument>({
  document,
  before,
  after,
  label,
  postSnapshot,
  cloneData: cloneBytes = cloneData,
  cloneInputs = true,
}: {
  document: T;
  before: Uint8Array;
  after: Uint8Array;
  label?: string;
  postSnapshot: SnapshotPost;
  cloneData?: CloneData;
  cloneInputs?: boolean;
}): SnapshotEditEvent<T> {
  const beforeSnapshot = cloneInputs ? cloneBytes(before) : before;
  const afterSnapshot = cloneInputs ? cloneBytes(after) : after;

  async function apply(snapshot: Uint8Array): Promise<void> {
    await enqueue(document, async () => {
      const nextData = cloneBytes(snapshot);
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
    await postSnapshot(data);
  } catch {
    // Panels can be disposed while a queued authoritative mutation is completing.
  }
}

function cloneBytes(data: Uint8Array): Uint8Array {
  return cloneData(data);
}
