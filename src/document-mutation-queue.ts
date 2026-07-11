export class DocumentMutationQueue {
  private pending: Promise<void> = Promise.resolve();

  enqueue<T>(mutation: () => PromiseLike<T> | T): Promise<T> {
    const result = this.pending.then(mutation, mutation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
