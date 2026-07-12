import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeBlob,
  detectBlobMediaType,
  getBlobFileExtension,
} from '../media/data/blob.mjs';

test('describes BLOB values with size and detected image type', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  assert.equal(detectBlobMediaType(png), 'image/png');
  assert.equal(getBlobFileExtension(png), 'png');
  assert.equal(describeBlob(png), 'PNG image · 8 bytes');
});

test('falls back to binary BLOB metadata for unknown bytes', () => {
  const value = new Uint8Array([1, 2, 3]);

  assert.equal(detectBlobMediaType(value), null);
  assert.equal(getBlobFileExtension(value), 'blob');
  assert.equal(describeBlob(value), 'BLOB · 3 bytes');
});
