export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

export function basenameFromUri(uri: string): string {
  const index = uri.lastIndexOf('/');
  return index === -1 ? uri : decodeURIComponent(uri.slice(index + 1));
}
