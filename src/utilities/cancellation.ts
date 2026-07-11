export interface CancellationState {
  readonly isCancellationRequested: boolean;
}

export function throwIfCancellationRequested(
  cancellation?: CancellationState,
  createError: () => Error = () => new Error('Operation was cancelled.'),
): void {
  if (cancellation?.isCancellationRequested) {
    throw createError();
  }
}
