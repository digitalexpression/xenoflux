import test from 'node:test';
import assert from 'node:assert/strict';
import { processQueue } from '../src/retry-queue.js';

test('runs jobs sequentially and returns ordered values and attempt accounting', async () => {
  const order = [];
  const result = await processQueue(['a', 'b'], async (item, index, attempt) => {
    order.push(`${item}:${index}:${attempt}`);
    return item.toUpperCase();
  });
  assert.deepEqual(order, ['a:0:1', 'b:1:1']);
  assert.deepEqual(result, {
    results: [
      { status: 'fulfilled', value: 'A', attempts: 1 },
      { status: 'fulfilled', value: 'B', attempts: 1 },
    ],
    stats: { total: 2, succeeded: 2, failed: 0, cancelled: 0, attempts: 2 },
  });
});

test('retries a failed job up to the finite limit with injected waits', async () => {
  const waits = [];
  let calls = 0;
  const result = await processQueue([7], () => {
    if (++calls < 3) throw new Error('again');
    return 21;
  }, { maxRetries: 2, delay: 12, sleep: async ms => waits.push(ms) });
  assert.deepEqual(waits, [12, 12]);
  assert.deepEqual(result.results, [{ status: 'fulfilled', value: 21, attempts: 3 }]);
  assert.deepEqual(result.stats, { total: 1, succeeded: 1, failed: 0, cancelled: 0, attempts: 3 });
});

test('stops at the first exhausted failure but continues with later jobs', async () => {
  const seen = [];
  const marker = { reason: 'permanent' };
  const result = await processQueue([0, 1], value => {
    seen.push(value);
    if (value === 0) throw marker;
    return value;
  }, { maxRetries: 1 });
  assert.deepEqual(seen, [0, 0, 1]);
  assert.deepEqual(result.results, [
    { status: 'rejected', error: marker, attempts: 2 },
    { status: 'fulfilled', value: 1, attempts: 1 },
  ]);
  assert.deepEqual(result.stats, { total: 2, succeeded: 1, failed: 1, cancelled: 0, attempts: 3 });
});
