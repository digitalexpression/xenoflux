import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { pickProfile } from '../src/picker.js';

const entries = [{ id: 'a', name: 'A\u001b[2J', state: 'ready', home: '/fixed/A' }, { id: 'b', name: 'B', state: 'unbound' }];
async function choose(text, callbacks = {}) {
  const input = new PassThrough(), output = new PassThrough();
  let shown = ''; output.on('data', chunk => { shown += chunk.toString(); });
  const pending = pickProfile(entries, { input, output, ...callbacks });
  input.end(text);
  return { selected: await pending, shown };
}
test('picker inspects and compares stored selections before choosing a stable ready ID', async () => {
  const calls = [];
  const result = await choose('i 1\nc 1 2\n1\n', {
    inspect: async id => { calls.push(['inspect', id]); return { home: '/fixed/A' }; },
    compare: async (a, b) => { calls.push(['compare', a, b]); return { kind: 'stored-profile-comparison' }; },
  });
  assert.equal(result.selected, 'a');
  assert.deepEqual(calls, [['inspect', 'a'], ['compare', 'a', 'b']]);
  assert.match(result.shown, /stored-profile-comparison/);
  assert.doesNotMatch(result.shown, /\u001b/);
});
test('picker rejects unavailable and invalid entries and supports cancellation and EOF', async () => {
  const result = await choose('2\n99\ni 1\nq\n', { inspect: async () => { throw Error('private error'); } });
  assert.equal(result.selected, null);
  assert.match(result.shown, /profile is unavailable/);
  assert.match(result.shown, /could not complete/);
  assert.doesNotMatch(result.shown, /private error/);
  assert.equal((await choose('')).selected, null);
});
test('picker abort closes without selecting or invoking a callback', async () => {
  const controller = new AbortController(), input = new PassThrough(), output = new PassThrough();
  const pending = pickProfile(entries, { input, output, signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
});

test('combined history keeps each task origin when a duplicate ID is selected for resume', async () => {
  const calls=[];
  const result=await choose('r 1\nh\nr 2\n', {history: async profile=>{
    calls.push(profile);
    return {entries:[{id:'same',profileId:'a',profileName:'A',title:'Task A',updatedAt:1},
      {id:'same',profileId:'b',profileName:'B',title:'Task B',updatedAt:2}],homes:[],truncated:false};
  }});
  assert.deepEqual(result.selected,{profileId:'b',resumeId:'same'});
  assert.deepEqual(calls,[undefined]); assert.match(result.shown,/\[A\] Task A/); assert.match(result.shown,/\[B\] Task B/);
  assert.match(result.shown,/Show history with h/);
});

test('a failed history refresh clears old task numbers and reports incomplete sources', async () => {
  let calls=0;
  const result=await choose('h 1\nh\nr 1\nq\n',{history: async profile=>{
    if(++calls===2)throw Error('unavailable');
    assert.equal(profile,'a');
    return {entries:[{id:'task',profileId:'a',profileName:'A',title:'test',updatedAt:0}],homes:[{status:'unavailable'}],truncated:true};
  }});
  assert.equal(result.selected,null); assert.match(result.shown,/history is incomplete/);
  assert.match(result.shown,/More tasks/); assert.match(result.shown,/Show history with h/);
});
