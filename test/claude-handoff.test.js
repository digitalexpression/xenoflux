import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { serveClaudeHandoff } from '../src/claude-handoff.js';

const exec = promisify(execFile);
const resume = 'claude://resume?session=09876543-abcd-0123-4567-123456789abc';
const mac = { skip: process.platform !== 'darwin' };

test('a managed Claude open forwards only the session to its own live launcher', mac, async t => {
  const calls = [];
  const first = await serveClaudeHandoff(async id => { calls.push(['first', id]); });
  t.after(() => first.close());
  const second = await serveClaudeHandoff(async id => {
    calls.push(['second', id]);
    throw new Error('No verified Desktop');
  });
  t.after(() => second.close());

  const open = service => join(service.directory, 'open');
  for (const args of [[resume + '&prompt=unexpected'], ['-a', 'Claude', resume], [resume.replace('claude:', 'claude-dev:')]]) {
    await assert.rejects(exec(open(first), args), error => error.code === 1 && /could not confirm the handoff/.test(error.stderr));
  }
  assert.deepEqual(calls, []);
  await assert.rejects(exec(open(second), [resume]), error => error.code === 1 && /could not confirm the handoff/.test(error.stderr));
  assert.equal(second.accepted, false);
  assert.equal(first.accepted, false);
  await exec(open(first), [resume]);
  assert.equal(first.accepted, true);
  await assert.rejects(exec(open(first), [resume]), error => error.code === 1);
  assert.deepEqual(calls, [['second', resume.slice(resume.indexOf('=') + 1)], ['first', resume.slice(resume.indexOf('=') + 1)]]);
});
