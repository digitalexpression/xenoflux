// TODO: implement processQueue(items, worker, options) as described in README.md.
export async function processQueue(items, worker, options = {}) {
  return { results: [], stats: { total: items.length, succeeded: 0, failed: 0, cancelled: 0, attempts: 0 } };
}
