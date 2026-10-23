function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function abortRace(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => finish(reject, signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    // Attach both handlers even if already aborted, so a later worker rejection is consumed.
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export async function processQueue(items, worker, options = {}) {
  const { maxRetries = 0, delay = 0, sleep = wait, signal } = options;
  if (!Array.isArray(items) || typeof worker !== 'function') throw new TypeError('items and worker are required');
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new TypeError('maxRetries must be a nonnegative integer');
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) throw new TypeError('delay must be a nonnegative finite number');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');

  const results = new Array(items.length);
  let succeeded = 0, failed = 0, cancelled = 0, attemptsTotal = 0;
  for (let index = 0; index < items.length; index++) {
    let attempts = 0;
    if (signal?.aborted) {
      results[index] = { status: 'cancelled', attempts: 0 };
      cancelled++;
      continue;
    }
    while (true) {
      attempts++;
      attemptsTotal++;
      try {
        const value = await abortRace(worker(items[index], index, attempts, signal), signal);
        results[index] = { status: 'fulfilled', value, attempts };
        succeeded++;
        break;
      } catch (error) {
        if (signal?.aborted) {
          results[index] = { status: 'cancelled', attempts };
          cancelled++;
          break;
        }
        if (attempts > maxRetries) {
          results[index] = { status: 'rejected', error, attempts };
          failed++;
          break;
        }
        try {
          await abortRace(sleep(delay, signal), signal);
        } catch (waitError) {
          if (!signal?.aborted) throw waitError;
          results[index] = { status: 'cancelled', attempts };
          cancelled++;
          break;
        }
      }
    }
  }
  return { results, stats: { total: items.length, succeeded, failed, cancelled, attempts: attemptsTotal } };
}
