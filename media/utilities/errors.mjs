export function getErrorMessage(error, fallback = 'The operation failed.') {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? fallback);
}
