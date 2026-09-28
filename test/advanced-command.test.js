import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { reviewAdvancedConflicts } from '../src/advanced-command.js';

test('conflicts need explicit replacement; skipping preserves selection of nonconflicting items', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  const replies = ['skip', 'replace'];
  output.on('data', chunk => {
    if (chunk.toString().includes('Type replace')) queueMicrotask(() => input.write(replies.shift() + '\n'));
  });
  const result = await reviewAdvancedConflicts({ items: [
    { id: 'one', label: 'reviewer', status: 'conflict' },
    { id: 'two', label: 'model', status: 'conflict' },
    { id: 'three', label: 'new rule', status: 'new' },
  ] }, ['one', 'two', 'three'], { input, output });
  assert.deepEqual(result, ['two', 'three']);
});

test('aborted conflict review cannot approve replacement', async () => {
  const signal = AbortSignal.abort();
  assert.equal(await reviewAdvancedConflicts({ items: [{ id: 'one', label: 'agent', status: 'conflict' }] }, ['one'], { signal }), null);
});


test('conflict details cannot emit C1 terminal controls', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let printed = '';
  output.on('data', chunk => {
    printed += chunk.toString();
    if (chunk.toString().includes('Type replace')) queueMicrotask(() => input.write('skip\n'));
  });
  await reviewAdvancedConflicts({ items: [{ id: 'item', label: 'example', status: 'conflict', changes: [{ before: '\u009b31m' }] }] }, ['item'], { input, output });
  assert.equal(printed.includes('\u009b'), false);
});
