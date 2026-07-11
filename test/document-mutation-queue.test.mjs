import assert from 'node:assert/strict';
import test from 'node:test';

import queueModule from '../dist/document-mutation-queue.js';

const { DocumentMutationQueue } = queueModule;

test('document mutation queue serializes overlapping mutations in arrival order', async () => {
  const queue = new DocumentMutationQueue();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
    return 1;
  });
  const second = queue.enqueue(async () => {
    order.push('second');
    return 2;
  });

  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('failed document mutation does not poison the queue', async () => {
  const queue = new DocumentMutationQueue();
  const failed = queue.enqueue(async () => {
    throw new Error('conflict');
  });
  const recovered = queue.enqueue(async () => 'recovered');

  await assert.rejects(failed, /conflict/);
  assert.equal(await recovered, 'recovered');
});
