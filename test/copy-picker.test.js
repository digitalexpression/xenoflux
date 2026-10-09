import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirmCopyAction, parseCopySelection, pickCopyComponents } from '../src/copy-picker.js';

const components = ['config', 'instructions', 'agents'];
async function choose(text) {
  const input = new PassThrough(), output = new PassThrough();
  let shown = ''; output.on('data', chunk => { shown += chunk.toString(); });
  const pending = pickCopyComponents(components, { input, output });
  input.end(text);
  return { selected: await pending, shown };
}

test('copy component picker accepts names, numbers, all, and preserves canonical order', async () => {
  assert.deepEqual(parseCopySelection('3, config', components), ['config', 'agents']);
  assert.deepEqual(parseCopySelection('all', components), components);
  assert.deepEqual((await choose('2, 1\n')).selected, ['config', 'instructions']);
  assert.match((await choose('all\n')).shown, /History, authentication, desktop data, skills, and plugins are not copied/);
  assert.match((await choose('all\n')).shown, /Destination-only settings and items are kept/);
});

test('copy component picker retries invalid values and permits cancellation', async () => {
  const invalid = await choose('history\n0\nagents\n');
  assert.deepEqual(invalid.selected, ['agents']);
  assert.match(invalid.shown, /Choose listed numbers or names/);
  assert.equal((await choose('q\n')).selected, null);
  assert.equal((await choose('')).selected, null);
});

test('copy confirmation accepts only its exact action word', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const pending = confirmCopyAction('copy', { input, output }); input.end('COPY\n');
  assert.equal(await pending, false);
  const yes = new PassThrough(), sink = new PassThrough();
  const accepted = confirmCopyAction('undo', { input: yes, output: sink }); yes.end('undo\n');
  assert.equal(await accepted, true);
});
