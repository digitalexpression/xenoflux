import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, bind } from '../src/profiles.js';
import { launchHome, launchPlan } from '../src/launcher.js';
import { managedNativeProfiles } from '../src/managed-native-profile.js';
import { runInteractive } from '../src/interactive-process.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { recoverProfileRun } from '../src/profile-recovery.js';

async function fixture(t, client) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-native-launch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, client === 'claude-code' ? 'claude' : 'copilot');
  const log = join(root, 'invocation');
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo '${client === 'claude-code' ? '2.1.319 (Claude Code)' : 'GitHub Copilot CLI 1.0.107'}'; exit 0; fi
printf '%s\\n' "$CLAUDE_CONFIG_DIR" "$COPILOT_HOME" "$HOME" "$PWD" > '${log}'
`, { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  const userHome = client === 'copilot' ? homedir() : root;
  const terminalEnvironment = { PATH: `${root}:/usr/bin:/bin`, HOME: homedir(), USER: userInfo().username, LOGNAME: userInfo().username };
  const service = managedNativeProfiles({ store, profilesBase: join(root, 'profiles'), defaultUserHome: userHome, terminalEnvironment });
  const binary = await service.binary(client);
  const profiles = [];
  for (const name of ['First', 'Second']) {
    profiles.push(await service.createProfile(name, client, binary));
  }
  return { root, store, profiles, log, executable, terminalEnvironment, defaultUserHome: userHome };
}

for (const client of ['claude-code', 'copilot']) {
  test(`${client}: stopped interactive owners recover through the existing explicit recovery boundary`, async t => {
    const f = await fixture(t, client);
    const result = await launchHome(f.store, 'First', { defaultUserHome: f.defaultUserHome, terminalEnvironment: f.terminalEnvironment,
      run: async options => { await options.onSpawn(123); throw Object.assign(new Error('Fixture uncertain shutdown'), { code: 'SHUTDOWN_FAILED' }); } });
    assert.equal(result.error, 'SHUTDOWN_FAILED');
    const checked = [];
    const options = { lockPath: join(f.root, 'recovery.lock'), isAlive: () => false,
      runtime: { assertExternal: async () => {}, assertIdle: async input => checked.push(input) } };
    assert.equal((await recoverProfileRun(f.store, 'First', options)).status, 'preview');
    assert.equal(checked.length, 0);
    await assert.rejects(recoverProfileRun(f.store, 'First', { ...options, isAlive: pid => pid === 123, apply: true }), /Native CLI may still be live/);
    assert.equal((await recoverProfileRun(f.store, 'First', { ...options, apply: true })).status, 'recovered');
    assert.ok(checked[0].resourcePaths.includes(f.profiles[0].native.configRoot));
    assert.ok(checked[0].cliExecutables.includes(f.executable));
    await assert.rejects(access(join(f.profiles[0].native.root, '.run-lock')), { code: 'ENOENT' });
    await access(result.reportPath);
  });

  test(`${client}: the app opens only the selected profile through the owned launcher`, async t => {
    const f = await fixture(t, client), calls = [];
    const provider = createEngineProvider({ store: f.store, defaultUserHome: f.defaultUserHome,
      runContext: { terminalEnvironment: f.terminalEnvironment },
      clientOps: { openTerminal: async args => calls.push(args) } });
    t.after(() => provider.close());
    await provider.clientAction({ name: 'Second', action: 'open-terminal' });
    assert.deepEqual(calls, [['launch', 'Second']]);
    await assert.rejects(provider.clientAction({ name: 'Second', action: 'resume' }), { code: 'invalid-action' });
    await rm(f.executable);
    await assert.rejects(provider.clientAction({ name: 'First', action: 'open-terminal' }), { code: 'client-failed' });
    assert.deepEqual(calls, [['launch', 'Second']]);
    await assert.rejects(access(f.log), { code: 'ENOENT' });
  });

  test(`${client}: named profile preview and interactive launch preserve exact roots and own the reservation`, async t => {
    const f = await fixture(t, client), before = await readFile(f.store.file);
    const options = { defaultUserHome: f.defaultUserHome };
    const plans = await Promise.all(f.profiles.map(profile => launchPlan(f.store, profile.name, f.terminalEnvironment, options)));
    const cli = new URL('../bin/xfx.js', import.meta.url).pathname;
    const dryRun = JSON.parse((await promisify(execFile)(process.execPath, [cli, '--store', f.store.directory, 'launch', 'First', '--dry-run', '--json'],
      { env: f.terminalEnvironment })).stdout);
    assert.equal(dryRun.client, client);
    assert.equal(dryRun.home, plans[0].home);
    assert.notEqual(plans[0].home, plans[1].home);
    assert.deepEqual(await readFile(f.store.file), before);
    await assert.rejects(access(f.log), { code: 'ENOENT' });
    await assert.rejects(access(join(plans[0].nativeRoot, 'launches')), { code: 'ENOENT' });
    for (const plan of plans) {
      const result = await launchHome(f.store, plan.name, { ...options, terminalEnvironment: f.terminalEnvironment,
        ramLogs: { prepareHome: () => assert.fail('Codex RAM routing must not touch another vendor') },
        run: async args => {
          await access(join(plan.nativeRoot, '.run-lock', 'owner.json'));
          await assert.rejects(launchHome(f.store, plan.name, { ...options, terminalEnvironment: f.terminalEnvironment }), /in use/);
          return runInteractive({ ...args, testStdio: 'ignore' });
        } });
      assert.equal(result.client, client);
      assert.equal(result.status, 'exited');
      assert.equal(result.postflight, 'profile-paths-checked');
      const [claude, copilot, home, cwd] = (await readFile(f.log, 'utf8')).trimEnd().split('\n');
      assert.equal(client === 'claude-code' ? claude : copilot, plan.home);
      assert.equal(client === 'claude-code' ? copilot : claude, '');
      assert.equal(home, f.defaultUserHome);
      assert.equal(cwd, plan.cwd);
      await assert.rejects(access(join(plan.nativeRoot, '.run-lock')), { code: 'ENOENT' });
      assert.doesNotMatch(await readFile(result.reportPath, 'utf8'), /CLAUDE_CONFIG_DIR|COPILOT_HOME/);
    }
  });

  test(`${client}: repository, resume and changed-installation refusals start no interactive client`, async t => {
    const f = await fixture(t, client), options = { defaultUserHome: f.defaultUserHome };
    const repository = join(f.root, 'repository'); await mkdir(repository, { mode: 0o700 });
    await assert.rejects(launchPlan(f.store, 'First', f.terminalEnvironment, { ...options, repository }), /Bind this repository/);
    await f.store.update(data => bind(data, 'First', repository));
    assert.equal((await launchPlan(f.store, 'First', f.terminalEnvironment, { ...options, repository })).cwd, repository);
    await assert.rejects(launchPlan(f.store, 'First', f.terminalEnvironment, { ...options, resumeId: randomUUID() }), /only supported for Codex/);
    const result = await launchHome(f.store, 'First', { ...options, terminalEnvironment: f.terminalEnvironment,
      probe: async () => { await writeFile(f.executable, '#!/bin/sh\nexit 9\n'); return '99.0.0'; },
      run: () => assert.fail('Changed installation must not launch') });
    assert.equal(result.error, 'EXECUTABLE_CHANGED');
    await assert.rejects(access(join(f.profiles[0].native.root, '.run-lock')), { code: 'ENOENT' });
    await assert.rejects(access(f.log), { code: 'ENOENT' });
  });

  test(`${client}: a manually replaced root cannot receive journal writes or lose another owner`, async t => {
    const f = await fixture(t, client), root = f.profiles[0].native.root, moved = `${root}-moved`;
    let replacement;
    const result = await launchHome(f.store, 'First', { defaultUserHome: f.defaultUserHome, terminalEnvironment: f.terminalEnvironment,
      run: async options => {
        await options.onSpawn(123);
        const owner = JSON.parse(await readFile(join(root, '.run-lock', 'owner.json'), 'utf8'));
        await rename(root, moved);
        await mkdir(join(root, '.run-lock'), { recursive: true, mode: 0o700 });
        await writeFile(join(root, '.run-lock', 'owner.json'), 'unrelated-owner');
        replacement = join(root, 'launches', owner.runId, 'report.json');
        await mkdir(join(root, 'launches', owner.runId), { recursive: true, mode: 0o700 });
        await writeFile(replacement, 'unrelated-evidence');
        return { exitCode: 0, shutdown: { groupTerminated: true } };
      } });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.error, 'HOME_CHANGED');
    assert.equal(result.reportPath, null);
    assert.equal(await readFile(replacement, 'utf8'), 'unrelated-evidence');
    assert.equal(await readFile(join(root, '.run-lock', 'owner.json'), 'utf8'), 'unrelated-owner');
    await access(join(moved, '.run-lock', 'owner.json'));
  });
}
