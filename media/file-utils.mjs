export function safeFileName(value) {
  const cleaned = String(value)
    .replace(/\.\./g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || 'database-export';
}
