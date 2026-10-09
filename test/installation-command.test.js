import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/profiles.js';
import { installationCommand, restoreHomeLogs } from '../src/installation-command.js';
import { readLogSettings, writeLogSettings } from '../src/log-storage.js';
import { supportedNode, checkNode, nativePath } from '../src/node-runtime.js';

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'xfx-install-command-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.codex'), { mode: 0o700 });
  const store = new Store(join(home, '.xfx', 'controller'));
  const events = [];
  const runtime = {
    assertExternal: async () => events.push('external'),
    prepareClients: async () => events.push('quit'),
    assertIdle: async () => events.push('idle'),
  };
  return { home, store, events, runtime, lockPath: join(home, 'native-lock') };
}

test('installation holds native authority during routing and releases it on failure', async t => {
  const f = await fixture(t);
  await assert.rejects(installationCommand(f.store, 'install', {
    ...f, userHome: f.home, nodeCheck: async () => f.events.push('node'),
    logs: { prepareHome: async ({home,key}) => {
      assert.equal(home, join(f.home, '.codex')); assert.equal(key, 'default');
      assert.ok((await lstat(f.lockPath)).isDirectory());
      f.events.push('prepare'); throw new Error('mount failed');
    } },
    installation: ({ prepareLogs }) => ({ install: prepareLogs }),
  }), /mount failed/);
  assert.deepEqual(f.events.slice(0, 4), ['node', 'external', 'quit', 'idle']);
  await assert.rejects(lstat(f.lockPath), {code:'ENOENT'});
  await assert.rejects(lstat(f.lockPath + '.selection'), {code:'ENOENT'});
});

test('CLI Node failure precedes client shutdown and controller writes', async t => {
  const f = await fixture(t);
  await assert.rejects(installationCommand(f.store, 'install', { ...f,
    nodeCheck: async () => { throw new Error('missing Node'); }, userHome: f.home,
  }), /missing Node/);
  assert.deepEqual(f.events, []);
  await assert.rejects(lstat(f.store.directory), {code:'ENOENT'});
});

test('disk log cleanup does not read a controller and rejects a self-hosted operation', async t => {
  const f = await fixture(t);
  let restores = 0;
  const logs = { restoreHome: async request => { restores++; return request; } };
  const result = await restoreHomeLogs(join(f.home, '.codex'), 'default', { ...f, logs });
  assert.equal(result.key, 'default'); assert.equal(restores, 1);
  await assert.rejects(restoreHomeLogs(join(f.home, '.codex'), 'default', { ...f, logs,
    runtime: { assertExternal: async () => { throw new Error('external terminal required'); } },
  }), /external terminal/);
  assert.equal(restores, 1);
});

test('RAM mode is explicit, private, and survives a new settings read', async t => {
  const {home} = await fixture(t);
  assert.equal(readLogSettings({home}).enabled, false);
  const settings = {enabled:true, backgroundPath:'/usr/bin:/bin'};
  await writeLogSettings(settings, {home});
  assert.deepEqual(readLogSettings({home}), settings);
  assert.equal((await lstat(join(home,'.xfx','ramlogs','settings.json'))).mode & 0o777, 0o600);
  await writeFile(join(home,'.xfx','ramlogs','settings.json'), '{}');
  assert.throws(() => readLogSettings({home}), /Invalid RAM-log settings/);
});

test('Node prerequisite checks use the passed environment and never pin an executable path', async () => {
  for (const version of ['v20.0.0', 'v22.12.9', 'v23.0.0', 'v23.3.0'])
    assert.equal(supportedNode(version), false, version);
  for (const version of ['v22.13.0', 'v22.14.0', 'v23.4.0', 'v23.11.0', 'v24.0.0'])
    assert.equal(supportedNode(version), true, version);
  assert.throws(() => nativePath({PATH:'.:/bin'}), /absolute/);
  let seen;
  await checkNode({env:{HOME:'/fixture/user',PATH:'/fixture/bin:/bin'}, execute:async (...args) => {
    seen = args; return {stdout:'v22.13.0\n'};
  }});
  assert.equal(seen[0], 'node');
  assert.deepEqual(seen[2].env, {HOME:'/fixture/user',PATH:'/fixture/bin:/bin'});
  await assert.rejects(checkNode({execute: async () => ({stdout:'v20.0.0'})}), /22.13.0/);
});

for (const recoveryFailure of [false, true]) test(`service failure, archive recovery and retry use native environment IDs (retry fails: ${recoveryFailure})`, async t => {
  const { readFile, readlink, readdir } = await import('node:fs/promises');
  const { create } = await import('../src/profiles.js');
  const { registerHome, resolveHome } = await import('../src/homes.js');
  const { prepareNativeHome } = await import('../test-support/native-home-fixture.js');
  const { createRamLogs, ramLogTarget } = await import('../src/ram-logs.js');
  const { createInstallation } = await import('../src/installation.js');
  const f = await fixture(t), executable=join(f.home,'codex');
  await writeFile(executable,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const homes=[{name:'Default',key:'default',home:join(f.home,'.codex')}];
  for(const name of ['First','Second']) {
    const native=await prepareNativeHome({directory:join(f.home,name),executable,codexVersion:'0.153.4'});
    await f.store.update(data=>create(data,name));
    await registerHome(f.store,name,native.root,{executable,version:'0.153.4'});
    const {profile,environment}=await resolveHome(f.store,name);
    assert.notEqual(profile.id,environment.id);
    homes.push({name,key:environment.id,home:environment.home});
  }
  for(const h of homes)await writeFile(join(h.home,'logs_2.sqlite'),'old '+h.name,{mode:0o600});
  const mountPath=join(f.home,'ram'),registry=join(f.home,'.xfx','ramlogs','homes');
  const disk={ensure:async()=>{await mkdir(mountPath,{recursive:true,mode:0o700});return mountPath;},inspect:async()=>({mounted:true})};
  const logs=createRamLogs({mountPath,registry,disk,execFile:async()=>({stdout:'',stderr:''})});
  let failService=true,loaded=false,settings={enabled:false,backgroundPath:'/usr/bin:/bin'};
  const installation=options=>createInstallation({...options,check:async()=> 'v24.0.0',execute:async()=>({stdout:''}),
    readLogSettings:()=>settings,writeLogSettings:async value=>{settings=value;},serviceLoaded:async()=>loaded,
    runService:async(_file,args)=>{if(args[0]==='bootstrap'){if(failService)throw Error('synthetic service failure');loaded=true;}else if(args[0]==='bootout')loaded=false;}});
  const options={...f,userHome:f.home,logs,installation,nodeCheck:async()=>{}};
  await assert.rejects(installationCommand(f.store,'install',options),/is installed, but RAM-log setup failed.*synthetic service failure/);
  assert.equal(settings.enabled,false);assert.equal(loaded,false);
  for(const h of homes){assert.ok((await lstat(join(h.home,'logs_2.sqlite'))).isFile());await writeFile(join(h.home,'logs_2.sqlite'),'new '+h.name);}
  failService=false;
  await assert.rejects(installationCommand(f.store,'enable',options),/Default.*different contents.*ramlogs recover/);
  for(const h of homes)assert.equal(await readFile(join(h.home,'logs_2.sqlite'),'utf8'),'new '+h.name);
  if (recoveryFailure) {
    failService=true;
    await assert.rejects(installationCommand(f.store,'recover',options), /synthetic service failure.*Diagnostic archives preserved/);
    assert.equal(settings.enabled,false); assert.equal(loaded,false);
    const archiveRoot=join(f.home,'.xfx','ramlogs','recovery');
    const archives=await readdir(archiveRoot);
    assert.equal(archives.length,3);
    for(const directory of archives) {
      const manifest=JSON.parse(await readFile(join(archiveRoot,directory,'manifest.json'),'utf8'));
      const h=homes.find(home=>home.key===manifest.key);
      assert.equal(await readFile(join(archiveRoot,directory,'disk','logs_2.sqlite'),'utf8'),'new '+h.name);
      assert.equal(await readFile(join(archiveRoot,directory,'logs_2.sqlite'),'utf8'),'old '+h.name);
    }
    for(const h of homes) await writeFile(join(h.home,'logs_2.sqlite'),'new '+h.name);
    failService=false;
  }
  const result=await installationCommand(f.store,'recover',options);
  assert.equal(result.enabled,true);assert.equal(loaded,true);assert.equal(settings.enabled,true);
  assert.equal(result.archives.length,3);
  for(const h of homes){
    const archive=result.archives.find(a=>a.name===h.name);
    assert.equal(await readFile(join(archive.archive,'logs_2.sqlite'),'utf8'),(recoveryFailure?'new ':'old ')+h.name);
    assert.equal(await readFile(join(archive.archive,'disk','logs_2.sqlite'),'utf8'),'new '+h.name);
    assert.equal(await readlink(join(h.home,'logs_2.sqlite')),ramLogTarget(h.key,{mountPath}));
    assert.equal(await readFile(join(h.home,'logs_2.sqlite'),'utf8'),'new '+h.name);
  }
  const quitCount=f.events.filter(e=>e==='quit').length;
  await assert.rejects(installationCommand(f.store,'recover',options),/already linked/);
  assert.equal(f.events.filter(e=>e==='quit').length,quitCount);
  await assert.rejects(lstat(f.lockPath),{code:'ENOENT'});
  assert.equal((await readdir(join(f.home,'.xfx','ramlogs','recovery'))).length,recoveryFailure?6:3);
});
