import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirmClientShutdown } from '../src/client-shutdown.js';

const apps = [{ name: 'Visual Studio Code', appPath: '/Applications/Visual Studio Code.app' },
  { name: 'Codex', appPath: '/Applications/ChatGPT.app' }];
function terminal() {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  let shown = ''; output.on('data', chunk => { shown += chunk.toString(); });
  return { input, output, get shown() { return shown; } };
}

test('shutdown confirmation names every app and accepts an explicit yes', async () => {
  for (const answer of ['y', 'YES']) {
    const io = terminal(), pending = confirmClientShutdown(apps, io);
    io.input.end(answer + '\n');
    assert.equal(await pending, true);
    assert.match(io.shown, /Visual Studio Code \(\/Applications\/Visual Studio Code.app\)/);
    assert.match(io.shown, /Codex \(\/Applications\/ChatGPT.app\)/);
    assert.match(io.shown, /\[y\/N\]/);
    assert.match(io.shown, /Cancelling.*Quit stops this command/);
  }
});

test('shutdown confirmation defaults to no, including EOF and cancellation', async () => {
  for (const answer of ['\n', 'no\n', 'anything\n', '']) {
    const io = terminal(), pending = confirmClientShutdown(apps, io);
    io.input.end(answer); assert.equal(await pending, false);
  }
  const io = terminal(), controller = new AbortController();
  const pending = confirmClientShutdown(apps, { ...io, signal: controller.signal });
  controller.abort();
  assert.equal(await pending, false);
});

test('noninteractive or already cancelled shutdown never prompts', async () => {
  const io = terminal(); io.input.isTTY = false;
  assert.equal(await confirmClientShutdown(apps, io), false);
  assert.equal(io.shown, '');
  const cancelled = terminal(), controller = new AbortController(); controller.abort();
  assert.equal(await confirmClientShutdown(apps, { ...cancelled, signal: controller.signal }), false);
  assert.equal(cancelled.shown, '');
});

test('application labels cannot inject terminal control sequences into the prompt', async () => {
  const io = terminal();
  const pending = confirmClientShutdown([{ name: 'Code\n\u001b[2J', appPath: '/Applications/Code\u0007.app' }], io);
  io.input.end('n\n');
  assert.equal(await pending, false);
  assert.match(io.shown, /Code  \[2J \(\/Applications\/Code .app\)/);
});
