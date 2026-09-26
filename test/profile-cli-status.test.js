import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/xfx.js', import.meta.url));
const loader = fileURLToPath(new URL('../test-support/profile-cli-fixture-loader.mjs', import.meta.url));
const ttyBootstrap = fileURLToPath(new URL('../test-support/profile-cli-tty-bootstrap.mjs', import.meta.url));

async function fixture(t, loginMode = 'failure') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profile-cli-status-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex'), store = join(root, 'controller'), base = join(root, 'profiles');
  const login = loginMode === 'cancel' ? 'kill -TERM $$' : 'exit 4';
  await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex v0.153.4"; exit 0; fi\nif [ "$1" = "login" ]; then ${login}; fi\nexit 9\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable, store, base };
}

function runSetup(f, replies) {
  const child = spawn(process.execPath, ['--loader', loader, '--import', ttyBootstrap, cli,
    '--store', f.store, 'profile', 'create', 'sample', '--apply', '--base', f.base, '--codex', f.executable], {
    env: { ...process.env, HOME: f.root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
    const prompts = ['Settings:', 'Type create', 'Type signin'];
    for (const prompt of prompts) {
      const occurrence = stdout.indexOf(prompt);
      if (occurrence >= 0 && !answered.has(prompt)) {
        answered.add(prompt);
        const reply = replies.shift();
        if (reply === null) child.kill('SIGINT');
        else child.stdin.write(`${reply}\n`);
      }
    }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const answered = new Set();
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('profile CLI subprocess timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  return closed.then(({ code, signal }) => ({ code, signal, stdout, stderr, unanswered: [...answered] }));
}

async function marker(f) {
  const [id] = await readdir(f.base);
  return JSON.parse(await readFile(join(f.base, id, '.xfx-home-setup.json'), 'utf8'));
}

test('public profile create returns native login failure exit code and persists failed phase', async t => {
  const f = await fixture(t, 'failure');
  const result = await runSetup(f, ['1', 'create', 'signin']);
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stdout, /"status": "failed"/);
  assert.match(result.stdout, /"exitCode": 4/);
  assert.equal((await marker(f)).phase, 'login-failed');
});

test('public profile create maps a signalled native login to cancellation exit 130', async t => {
  const f = await fixture(t, 'cancel');
  const result = await runSetup(f, ['1', 'create', 'signin']);
  assert.equal(result.code, 130, result.stderr);
  assert.match(result.stdout, /"status": "cancelled"/);
  assert.equal((await marker(f)).phase, 'login-cancelled');
});

test('public profile create keeps intentional sign-in deferral successful and does not start login', async t => {
  const f = await fixture(t, 'failure');
  const result = await runSetup(f, ['1', 'create', 'later']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"status": "setup-pending"/);
  assert.equal((await marker(f)).phase, 'registered');
});

test('interrupting the sign-in prompt exits 130 while preserving the prepared profile', async t => {
  const f = await fixture(t);
  const result = await runSetup(f, ['1', 'create', null]);
  assert.equal(result.code, 130, result.stderr);
  assert.match(result.stdout, /"status": "cancelled"/);
  assert.equal((await marker(f)).phase, 'registered');
});
