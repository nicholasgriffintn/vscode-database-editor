const signatures = [
  {
    mediaType: 'image/png',
    extension: 'png',
    label: 'PNG image',
    matches: (value) => startsWith(value, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mediaType: 'image/jpeg',
    extension: 'jpg',
    label: 'JPEG image',
    matches: (value) => startsWith(value, [0xff, 0xd8, 0xff]),
  },
  {
    mediaType: 'image/gif',
    extension: 'gif',
    label: 'GIF image',
    matches: (value) => startsWith(value, [0x47, 0x49, 0x46, 0x38]),
  },
  {
    mediaType: 'image/webp',
    extension: 'webp',
    label: 'WebP image',
    matches: (value) => startsWith(value, [0x52, 0x49, 0x46, 0x46]) && startsWith(value.slice(8), [0x57, 0x45, 0x42, 0x50]),
  },
];

export function detectBlobMediaType(value) {
  return signatures.find((signature) => signature.matches(value))?.mediaType ?? null;
}

export function isImageBlob(value) {
  return value instanceof Uint8Array && value.length > 0 && signatures.some((s) => s.matches(value));
}

export function blobToObjectURL(value) {
  const mediaType = detectBlobMediaType(value) || 'application/octet-stream';
  return URL.createObjectURL(new Blob([value], { type: mediaType }));
}

export function getBlobFileExtension(value) {
  return signatures.find((signature) => signature.matches(value))?.extension ?? 'blob';
}

export function describeBlob(value) {
  const signature = signatures.find((item) => item.matches(value));
  return `${signature?.label ?? 'BLOB'} · ${formatByteCount(value.byteLength)}`;
}

function startsWith(value, bytes) {
  if (!(value instanceof Uint8Array) || value.byteLength < bytes.length) {
    return false;
  }

  return bytes.every((byte, index) => value[index] === byte);
}

function formatByteCount(bytes) {
  return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
}
