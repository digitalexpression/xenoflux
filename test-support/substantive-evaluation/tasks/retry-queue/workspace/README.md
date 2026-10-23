# Retry queue coding task

Implement a small sequential async job processor in `src/retry-queue.js`. The intended exercise is about async control flow, bounded retries, cancellation, and trustworthy result accounting. A typical complete implementation should fit in about 100 lines.

## API

Export `async function processQueue(items, worker, options = {})`. `items` is an array and `worker(item, index, attempt, signal)` returns a value or promise. Attempts are numbered from 1. Process items in input order, one at a time.

Options: `maxRetries` is a nonnegative integer (default 0); `delay` is a nonnegative number in milliseconds (default 0); `sleep(ms, signal)` is an injectable async wait (default uses a timer and rejects on abort); `signal` is an optional AbortSignal. After a failed worker attempt, wait `delay` before retrying if retries remain. Do not wait after the last attempt. Invalid retry/delay options should throw `TypeError` before calling the worker.

Return `{ results, stats }`. There is one result per input, in input order. A successful item is `{ status: 'fulfilled', value, attempts }`; an exhausted failure is `{ status: 'rejected', error, attempts }`, retaining the final thrown value; an item skipped or interrupted by abort is `{ status: 'cancelled', attempts }`. `attempts` counts worker calls for that item. Abort stops new work. If it occurs during a worker or retry wait, mark that item cancelled and settle the queue promptly without waiting for the worker/wait promise; that underlying promise may still run or settle later. Preserve earlier completed results. Fill all remaining input positions as cancelled with zero attempts.

`stats` is `{ total, succeeded, failed, cancelled, attempts }`; the last field is the total number of worker calls. The first three outcome counts sum to `total`.

## Run visible tests

```sh
node --test test/visible.test.js
```
