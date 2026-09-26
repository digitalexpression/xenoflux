import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { desktopReady } from '../src/desktop.js';

test('desktop readiness accepts Enter and displays the standard acknowledgement', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const ready = desktopReady({ input, output })({});
  input.write('\n');
  assert.equal(await ready, true);
  assert.match(text, /Wait for the current Codex response/);
  assert.match(text, /Press Enter when ready/);
});

test('desktop readiness cancels for text, closed input, or an aborted signal', async () => {
  for (const action of ['text', 'close', 'abort']) {
    const input = new PassThrough(), output = new PassThrough(), controller = new AbortController();
    const ready = desktopReady({ input, output, noOpen: true })({ signal: controller.signal });
    if (action === 'text') input.write('cancel\n');
    if (action === 'close') input.end();
    if (action === 'abort') controller.abort();
    assert.equal(await ready, false);
  }
});
