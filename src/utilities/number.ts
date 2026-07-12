export function formatByteSize(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) {
    return `${value.toLocaleString()} ${value === 1 ? 'byte' : 'bytes'}`;
  }
  if (value < 1024 * 1024) {
    return `${formatUnit(value / 1024)} KB`;
  }
  return `${formatUnit(value / (1024 * 1024))} MB`;
}

function formatUnit(value: number): string {
  return value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}
