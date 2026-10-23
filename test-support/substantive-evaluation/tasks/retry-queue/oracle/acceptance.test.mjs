import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = process.env.EVAL_WORKSPACE;
if (!root) throw new Error('EVAL_WORKSPACE must be an absolute candidate workspace path');
const candidate = await import(pathToFileURL(resolve(root, 'src/retry-queue.js')).href);
const { processQueue } = candidate;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('does not start the next job until the current promise settles', { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const events = [];
  const run = processQueue([1, 2], async value => {
    events.push(`start${value}`);
    if (value === 1) started.resolve();
    if (value === 1) await gate.promise;
    events.push(`end${value}`);
    return value;
  });
  await started.promise;
  assert.deepEqual(events, ['start1']);
  gate.resolve();
  const out = await run;
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2']);
  assert.deepEqual(out.results.map(x => x.value), [1, 2]);
});

test('counts worker calls exactly and does not sleep after the final failed attempt', async () => {
  const sleeps = [];
  const error = new Error('still broken');
  const out = await processQueue(['x'], () => { throw error; }, {
    maxRetries: 2, delay: 5, sleep: async ms => sleeps.push(ms),
  });
  assert.deepEqual(sleeps, [5, 5]);
  assert.deepEqual(out.results, [{ status: 'rejected', error, attempts: 3 }]);
  assert.deepEqual(out.stats, { total: 1, succeeded: 0, failed: 1, cancelled: 0, attempts: 3 });
});

test('cancels during retry wait and marks later jobs without starting them', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const waiting = deferred();
  const sleepEntered = deferred();
  const calls = [];
  const outPromise = processQueue(['a', 'b', 'c'], item => {
    calls.push(item);
    throw Error('retryable');
  }, { maxRetries: 4, signal: controller.signal, sleep: async () => { sleepEntered.resolve(); return waiting.promise; } });
  await sleepEntered.promise;
  controller.abort();
  const out = await outPromise;
  waiting.resolve();
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(out.results, [
    { status: 'cancelled', attempts: 1 },
    { status: 'cancelled', attempts: 0 },
    { status: 'cancelled', attempts: 0 },
  ]);
  assert.deepEqual(out.stats, { total: 3, succeeded: 0, failed: 0, cancelled: 3, attempts: 1 });
});

test('abort during an active worker settles promptly even if the worker later resolves', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const gate = deferred();
  const started = deferred();
  let nextStarted = false;
  const run = processQueue([1, 2], async value => {
    if (value === 1) { started.resolve(); return gate.promise; }
    nextStarted = true;
    return value;
  }, { signal: controller.signal });
  await started.promise;
  controller.abort();
  const out = await run;
  gate.resolve('late');
  assert.equal(nextStarted, false);
  assert.deepEqual(out.results, [
    { status: 'cancelled', attempts: 1 },
    { status: 'cancelled', attempts: 0 },
  ]);
  assert.deepEqual(out.stats, { total: 2, succeeded: 0, failed: 0, cancelled: 2, attempts: 1 });
});

test('consumes a worker rejection when the worker aborts synchronously', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const out = await processQueue([1], () => {
    controller.abort();
    return Promise.reject(new Error('late rejection'));
  }, { signal: controller.signal });
  assert.deepEqual(out.results, [{ status: 'cancelled', attempts: 1 }]);
  assert.deepEqual(out.stats, { total: 1, succeeded: 0, failed: 0, cancelled: 1, attempts: 1 });
});

test('handles an in-flight worker rejection after abort has settled the queue', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const gate = deferred();
  const started = deferred();
  const run = processQueue([1], () => { started.resolve(); return gate.promise; }, { signal: controller.signal });
  await started.promise;
  controller.abort();
  const out = await run;
  gate.reject(new Error('late worker rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(out.results, [{ status: 'cancelled', attempts: 1 }]);
  assert.deepEqual(out.stats, { total: 1, succeeded: 0, failed: 0, cancelled: 1, attempts: 1 });
});

test('validates retry and delay options before invoking worker', async () => {
  let called = false;
  for (const options of [{ maxRetries: -1 }, { maxRetries: 1.5 }, { delay: Infinity }, { delay: -1 }]) {
    await assert.rejects(processQueue([1], () => { called = true; }, options), TypeError);
  }
  assert.equal(called, false);
});

test('abort before start returns a complete zero-attempt accounting record', async () => {
  const controller = new AbortController();
  controller.abort();
  const out = await processQueue([1, 2], () => assert.fail('worker must not run'), { signal: controller.signal });
  assert.deepEqual(out.results, [
    { status: 'cancelled', attempts: 0 },
    { status: 'cancelled', attempts: 0 },
  ]);
  assert.deepEqual(out.stats, { total: 2, succeeded: 0, failed: 0, cancelled: 2, attempts: 0 });
});
