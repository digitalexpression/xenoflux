import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeClaudeAccount, probeCodexAccount, probeCodexEmbeddedCli, probeNativeProfileVersion, probeVersion } from '../src/version-probe.js';

async function executable(t, body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-version-probe-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'probe.mjs');
  await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { root, path };
}
const options = (entry, extra = {}) => ({ executable: entry.path, cwd: entry.root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, ...extra });

test('Claude rejects account status reported for a different profile directory', async t => {
  const fake = await executable(t, `
    if (process.argv.slice(2).join(' ') !== 'auth status') process.exit(2);
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: process.cwd(), email: 'claude@example.test',
      token: 'credential-must-not-be-projected' }));
  `);
  const selected = configDirectory => options(fake, { env: { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: configDirectory } });
  assert.deepEqual(await probeClaudeAccount(selected(fake.root)), { state: 'signed-in', route: 'native subscription', accountLabel: 'claude@example.test' });
  assert.deepEqual(await probeClaudeAccount(selected(join(fake.root, 'other-profile'))), { state: 'unverified' });
});

test('Codex reads the account with no token refresh or model call', async t => {
  const fake = await executable(t, `
    import { createInterface } from 'node:readline';
    if (process.argv.slice(2).join(' ') !== 'app-server') process.exit(1);
    const input = createInterface({ input: process.stdin });
    let step = 0;
    for await (const line of input) {
      const { id, method, params } = JSON.parse(line);
      if (step === 0 && method === 'initialize') console.log(JSON.stringify({ id, result: {} }));
      else if (step === 1 && method === 'initialized' && id === undefined) {}
      else if (step === 2 && method === 'account/read' && params.refreshToken === false) {
        console.log(JSON.stringify({ method: 'account/updated', params: {} }));
        console.log(JSON.stringify({ id, result: { account: JSON.parse(process.env.TEST_ACCOUNT) } }));
      } else process.exit(2);
      step++;
    }
    if (step !== 3) process.exit(3);
  `);
  const check = account => probeCodexAccount(options(fake, { env: { PATH: '/usr/bin:/bin', TEST_ACCOUNT: JSON.stringify(account) } }));
  assert.deepEqual(await check({ type: 'chatgpt', email: 'case@example.test', privateToken: 'credential' }),
    { state: 'signed-in', accountLabel: 'case@example.test' });
  assert.deepEqual(await check({ type: 'chatgpt', email: 'first@example.test\nsecond@example.test' }), { state: 'signed-in' });
  assert.deepEqual(await check({ type: 'apiKey', privateToken: 'credential' }), { state: 'signed-in', accountLabel: 'API key' });
  assert.deepEqual(await check(null), { state: 'signed-out' });
});

test('Codex account probing refuses native requests and joins its subprocess', async t => {
  const fake = await executable(t, `
    process.stdin.resume();
    console.log(JSON.stringify({ id: 99, method: 'account/login/start' }));
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(probeCodexAccount(options(fake)), { code: 'PROTOCOL_ERROR' });
});

test('Codex embedded runtime support must be advertised by the selected command', async t => {
  const fake = await executable(t, `
    const args = process.argv.slice(2).join(' ');
    if (args === '--help') console.log('      --no-daemon  Run without the background server');
    else if (args === 'resume --help') console.log('      --no-daemon-extra  An unrelated option');
    else process.exitCode = 2;
  `);
  assert.equal(await probeCodexEmbeddedCli(options(fake)), true);
  assert.equal(await probeCodexEmbeddedCli(options(fake, { resume: true })), false);
});

test('accepts only bounded recognizable version output', async t => {
  const valid = await executable(t, "console.log('codex-cli 0.153.4');");
  assert.equal(await probeVersion(options(valid)), '0.153.4');
  const invalid = await executable(t, "console.log('unrelated 0.153.4');");
  await assert.rejects(probeVersion(options(invalid)), { code: 'VERSION_MISMATCH' });
  const noisy = await executable(t, "process.stdout.write('x'.repeat(100)); setInterval(() => {}, 1000);");
  // Test the output bound with the normal startup allowance; timeout behavior has its own case.
  await assert.rejects(probeVersion(options(noisy, { maxBytes: 20 })), { code: 'OUTPUT_LIMIT' });
});

test('cancels a timed-out owned probe group', async t => {
  const hanging = await executable(t, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  await assert.rejects(probeVersion(options(hanging, { timeoutMs: 30 })), { code: 'RPC_TIMEOUT' });
  const controller = new AbortController();
  const pending = probeVersion(options(hanging, { signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});

test('Copilot accepts the installed version banner with a trailing period', async t => {
  const banner = await executable(t, `console.log("GitHub Copilot CLI 1.0.107.\\nRun 'copilot update' to check for updates.");`);
  assert.equal(await probeNativeProfileVersion('copilot', options(banner)), '1.0.107');
  const prerelease = await executable(t, "console.log('GitHub Copilot CLI 1.0.107-beta.1.');");
  assert.equal(await probeNativeProfileVersion('copilot', options(prerelease)), '1.0.107-beta.1');
  const invalid = await executable(t, "console.log('GitHub Copilot CLI 1.0.107.bad');");
  await assert.rejects(probeNativeProfileVersion('copilot', options(invalid)), /Unrecognized native CLI version/);
});
