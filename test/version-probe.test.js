import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeNativeProfileVersion, probeVersion } from '../src/version-probe.js';

async function executable(t, body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-version-probe-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'probe.mjs');
  await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { root, path };
}
const options = (entry, extra = {}) => ({ executable: entry.path, cwd: entry.root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, ...extra });

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
