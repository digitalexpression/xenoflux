import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { pickAdvancedItems } from '../src/advanced-picker.js';

const runFile = promisify(execFile);

const inventory = { items: [
  { id: 'a', category: 'Core', label: 'Alpha', scope: 'global', origin: 'local', copyable: true },
  { id: 'b', category: 'Extra', label: 'Beta settings', scope: 'profile', origin: 'local', copyable: true },
  { id: 'blocked', category: 'Extra', label: 'Unsupported', scope: 'workspace', origin: 'generated', path: 'agents/remote.toml', copyable: false, reason: 'managed externally' },
] };

function streams({ tty = false } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = tty;
  input.isRaw = false;
  const rawChanges = [];
  input.setRawMode = value => { input.isRaw = value; rawChanges.push(value); };
  output.isTTY = tty;
  output.rows = 24;
  let shown = '';
  output.on('data', chunk => { shown += chunk.toString(); });
  return { input, output, rawChanges, shown: () => shown };
}

test('search reaches items in collapsed categories and only eligible items can be selected', async () => {
  const io = streams();
  const pending = pickAdvancedItems(inventory, io);
  io.input.write('\u001b[B');
  io.input.write('\u001b[B'); // Extra category
  io.input.write('\u001b[D'); // collapse it
  io.input.write('/extra');
  io.input.write('\r');
  io.input.write('\u001b[B'); // matching item
  io.input.write(' ');
  io.input.write('\u001b[B'); // unsupported item is visible too
  io.input.write(' '); // unavailable items cannot be selected
  io.input.write('\r');
  io.input.end();
  assert.deepEqual(await pending, ['b']);
  assert.match(io.shown(), /Beta settings/);
  assert.match(io.shown(), /Unsupported/);
});

test('selects by keyboard, keeps canonical inventory order, and reviews before returning IDs', async () => {
  const io = streams();
  const reviews = [];
  const pending = pickAdvancedItems(inventory, {
    ...io,
    review: async ids => {
      reviews.push(ids);
      return { items: [{ id: 'a', label: 'Alpha', status: 'new', changes: [{ before: 'old', after: 'new' }] }] };
    },
  });
  io.input.write('\u001b[B'); // Alpha
  io.input.write(' ');
  io.input.write('\u001b[B'); // Beta
  io.input.write('\u001b[B');
  io.input.write(' ');
  io.input.write('\r');
  io.input.end();
  assert.deepEqual(await pending, ['a', 'b']);
  assert.deepEqual(reviews, [['a', 'b']]);
  assert.match(io.shown(), /Alpha — new/);
  assert.match(io.shown(), /before: old; after: new/);
});

test('setup guidance is selectable but unavailable inventory rows remain unselectable; empty selection is valid', async () => {
  const items = { items: [
    { id: 'setup:server', category: 'setup', label: 'Public docs server', scope: 'profile', origin: 'config', path: 'config.toml', setup: true, copyable: false, integration: 'plugin', pluginIdentity: 'docs@personal', marketplace: 'personal', sourceVersion: '1.2.3', installedVersion: 'unknown', steps: ['Check the destination server list first.'] },
    { id: 'blocked', category: 'Other', label: 'Unknown', copyable: false },
  ] };
  const io = streams();
  const pending = pickAdvancedItems(items, io);
  io.input.write('\u001b[B'); // setup row
  io.input.write('d');
  assert.match(io.shown(), /Plugin identity: docs@personal/);
  assert.match(io.shown(), /Source manifest version: 1\.2\.3/);
  assert.match(io.shown(), /Installed version: unknown/);
  io.input.write('x'); // return to picker
  io.input.write(' ');
  io.input.write('\r');
  io.input.end();
  assert.deepEqual(await pending, ['setup:server']);
  assert.match(io.shown(), /manual setup/);
  assert.match(io.shown(), /Check the destination server list first/);

  const empty = streams();
  const emptyPending = pickAdvancedItems({ items: [] }, empty);
  empty.input.write('\r'); empty.input.end();
  assert.deepEqual(await emptyPending, []);
});

test('final preview rows retain origin, scope, and source path', async () => {
  const io = streams();
  const pending = pickAdvancedItems({ items: [{ id: 'x', category: 'Skills', label: 'review-helper', origin: 'Default', scope: 'profile', path: 'skills/review-helper/SKILL.md', sourcePath: '/profiles/default/skills/review-helper', copyable: true }] }, {
    ...io, review: async () => ({ items: [{ id: 'x', label: 'review-helper', origin: 'Default', scope: 'profile', sourcePath: '/profiles/default/skills/review-helper', status: 'conflict', changes: [{ path: 'old.sh', action: 'remove', beforeMode: '0755' }] }] }),
  });
  io.input.write('\u001b[B'); io.input.write(' '); io.input.write('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(io.shown(), /Origin: Default \| Scope: profile \| Source: \/profiles\/default\/skills\/review-helper/);
  assert.match(io.shown(), /old\.sh; action: remove; beforeMode: 0755/);
  io.input.write('q'); io.input.end(); await pending;
});

test('preview shows complete bounded text details beyond the former 220-character limit', async () => {
  const io = streams();
  const longValue = 'reviewable-change-'.repeat(40);
  const pending = pickAdvancedItems({ items: [{ id: 'long', category: 'Core', label: 'Long change', copyable: true }] }, {
    ...io, review: async () => ({ items: [{ id: 'long', label: 'Long change', origin: 'Default', scope: 'profile', sourcePath: '/source/config.toml', status: 'conflict', changes: [{ path: 'config.toml:model', before: longValue, after: 'new' }] }] }),
  });
  io.input.write('\u001b[B'); io.input.write(' '); io.input.write('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(io.shown().includes(longValue));
  assert.doesNotMatch(io.shown(), /\[truncated\]/);
  io.input.write('q'); io.input.end(); await pending;
});

test('cancel, EOF and abort restore terminal raw mode', async () => {
  const cancelled = streams({ tty: true });
  const cancelPending = pickAdvancedItems(inventory, cancelled);
  cancelled.input.write('q');
  cancelled.input.end();
  assert.equal(await cancelPending, null);
  assert.deepEqual(cancelled.rawChanges, [true, false]);

  const controller = new AbortController();
  const aborted = streams({ tty: true });
  const abortPending = pickAdvancedItems(inventory, { ...aborted, signal: controller.signal });
  controller.abort();
  assert.equal(await abortPending, null);
  assert.deepEqual(aborted.rawChanges, [true, false]);

  const eof = streams();
  const eofPending = pickAdvancedItems(inventory, eof);
  eof.input.end();
  assert.equal(await eofPending, null);
});

test('details show unavailable item metadata without calling review, and Ctrl-C cancels details', async () => {
  const io = streams();
  let reviewCalls = 0;
  const pending = pickAdvancedItems(inventory, { ...io, review: async () => { reviewCalls++; throw new Error('must not run'); } });
  for (let i = 0; i < 4; i++) io.input.write('\u001b[B'); // unsupported item
  io.input.write('d');
  io.input.write('\u0003');
  io.input.end();
  assert.equal(await pending, null);
  assert.equal(reviewCalls, 0);
  assert.match(io.shown(), /Availability: unavailable — managed externally/);
  assert.match(io.shown(), /Origin: generated/);
  assert.match(io.shown(), /path: agents\/remote.toml/);
});

test('a delayed review cannot redraw after abort', async () => {
  const io = streams();
  const controller = new AbortController();
  let release;
  const pending = pickAdvancedItems(inventory, {
    ...io, signal: controller.signal,
    review: () => new Promise(resolve => { release = resolve; }),
  });
  io.input.write('\u001b[B'); // Alpha
  io.input.write('d');
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(await pending, null);
  const lengthAtAbort = io.shown().length;
  release({ items: [{ id: 'a', status: 'new', changes: ['redacted'] }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(io.shown().length, lengthAtAbort);
});

test('works in a real pseudo-terminal', async t => {
  if (!['darwin', 'linux'].includes(process.platform)) return t.skip('POSIX-only PTY test');
  if (!existsSync('/usr/bin/expect')) return t.skip('expect is unavailable');
  const root = await mkdtemp(join(tmpdir(), 'xfx-advanced-picker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new URL('../src/advanced-picker.js', import.meta.url).pathname;
  const driver = join(root, 'picker.mjs');
  await writeFile(driver, `
import { pickAdvancedItems } from ${JSON.stringify(source)};
const selected = await pickAdvancedItems({ items: [{ id: 'a', category: 'Core', label: 'Alpha', copyable: true }] });
console.log('RESULT:' + JSON.stringify(selected));
`);
  const expectProgram = `set timeout 5
spawn ${process.execPath} ${driver}
expect {
  -re {Alpha} { send -- "\\033[B"; send -- " "; send -- "\\r" }
  timeout { puts stderr "picker did not render"; exit 1 }
}
expect {
  -re {RESULT:\\["a"\\]} { }
  timeout { puts stderr "picker did not return the selected ID"; exit 1 }
}
expect {
  eof { }
  timeout { puts stderr "picker did not exit"; exit 1 }
}
catch wait result
exit [lindex $result 3]`;
  await runFile('/usr/bin/expect', ['-c', expectProgram], { timeout: 8_000 });
});

 test('conversation details identify the native thread and its project and update time', async()=>{
  const io=streams();
  const pending=pickAdvancedItems({items:[{id:'thread',category:'conversation',label:'Repeated title [abc12345]',copyable:false,conversationId:'abc12345-full-id',cwd:'/fixture/project',updatedAt:'2026-09-28T00:00:00.000Z',reason:'Native conversation; transfer is not supported'}]},io);
  io.input.write('\u001b[B'); io.input.write('d');
  assert.match(io.shown(),/abc12345-full-id/);
  assert.match(io.shown(),/Project: \/fixture\/project/);
  assert.match(io.shown(),/Updated: 2026-09-28/);
  io.input.end(); await pending;
});
