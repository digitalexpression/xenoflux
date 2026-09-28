import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { inspectProfile } from '../src/profile-inventory.js';
import { validateAdvancedFiles } from '../src/advanced-copy.js';
import { planCopy, applyCopy, planUndo, undoCopy, validateAdvancedSelection } from '../src/native-copy.js';

const read = path => readFile(path);
async function fixture(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'xfx-advanced-copy-'))); t.after(()=>rm(root,{recursive:true,force:true}));
  const executable=join(root,'codex'); await writeFile(executable,'#!/bin/sh\nexit 99\n',{mode:0o700});
  const a=await prepareNativeHome({directory:join(root,'native-a'),executable,codexVersion:'0.153.4'});
  const b=await prepareNativeHome({directory:join(root,'native-b'),executable,codexVersion:'0.153.4'});
  const store=new Store(join(root,'store')); await store.update(d=>{create(d,'A');create(d,'B');});
  await registerHome(store,'A',a.root,{executable,version:'0.153.4'}); await registerHome(store,'B',b.root,{executable,version:'0.153.4'});
  const defaultUserHome=join(root,'user'), source=join(defaultUserHome,'.codex'); await mkdir(source,{recursive:true,mode:0o700});
  await writeFile(join(source,'config.toml'),'model = "source-model"\npersonality = "friendly"\n',{mode:0o600});
  const options={defaultUserHome,lockPath:join(root,'copy.lock'),runtime:{assertIdle:async()=>{}}};
  return {root,store,a,b,source,defaultUserHome,options};
}
async function item(store,scope,category,label,defaultUserHome) {
  const inv=await inspectProfile(store,scope,{defaultUserHome});
  const found=inv.items.find(x=>x.category===category&&x.label===label&&x.copyable);
  assert.ok(found,`expected copyable ${category} ${label}`); return found;
}

test('individual config selection merges one key and reports conflicts at key granularity',async t=>{
  const f=await fixture(t); const config=join(f.b.home,'config.toml');
  const original=parse((await read(config)).toString()); original.model='target-model'; original.personality='plain'; original.service_tier='flex';
  const originalText=stringify(original); await writeFile(config,originalText,{mode:0o600});
  const selected=await item(f.store,'Default','config','model',f.defaultUserHome);
  const preview=await planCopy(f.store,'Default','B',{...f.options,selection:[selected.id]});
  assert.equal(preview.items[0].status,'conflict');
  assert.equal(preview.items[0].changes[0].path,'config.toml:model');
  const result=await applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id],expectedHash:preview.hash});
  const text=(await read(config)).toString();
  assert.match(text,/model = "source-model"/); assert.match(text,/personality = "plain"/); assert.match(text,/service_tier = "flex"/);
  const undo=await planUndo(f.store,result.id); await undoCopy(f.store,result.id,{...f.options,expectedHash:undo.hash});
  assert.equal((await read(config)).toString(),originalText);
});

test('skill copies binary assets and executable modes, preserves target-only files, and undo restores only selected files',async t=>{
  const f=await fixture(t), src=join(f.source,'skills','tool'); await mkdir(join(src,'bin'),{recursive:true,mode:0o700});
  await mkdir(join(src,'assets'),{mode:0o700}); await writeFile(join(src,'SKILL.md'),'A test skill.\n',{mode:0o600});
  await writeFile(join(src,'bin','run'),'#!/bin/sh\nexit 0\n',{mode:0o700}); await writeFile(join(src,'assets','payload.bin'),Buffer.from([0,255,1,2]),{mode:0o600});
  await writeFile(join(src,'assets','readme.txt'),'plain text\n',{mode:0o644});
  const dst=join(f.b.home,'skills','tool'); await mkdir(dst,{recursive:true,mode:0o700}); await writeFile(join(dst,'local.txt'),'keep me\n',{mode:0o600});
  const selected=await item(f.store,'Default','skill','tool',f.defaultUserHome);
  const preview=await planCopy(f.store,'Default','B',{...f.options,selection:[selected.id]});
  assert.ok(preview.items[0].changes.some(c=>c.action==='retain'&&c.path==='skills/tool/local.txt'));
  const oldUmask=process.umask(0o077); let result;
  try { result=await applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id],expectedHash:preview.hash}); }
  finally { process.umask(oldUmask); }
  assert.deepEqual(await read(join(dst,'assets','payload.bin')),Buffer.from([0,255,1,2]));
  assert.equal((await stat(join(dst,'bin','run'))).mode&0o777,0o700); assert.equal((await read(join(dst,'local.txt'))).toString(),'keep me\n');
  assert.equal((await stat(join(dst,'assets','readme.txt'))).mode&0o777,0o644);
  const undo=await planUndo(f.store,result.id); await undoCopy(f.store,result.id,{...f.options,expectedHash:undo.hash});
  await assert.rejects(stat(join(dst,'SKILL.md')),{code:'ENOENT'}); assert.equal((await read(join(dst,'local.txt'))).toString(),'keep me\n');
});

test('journal payload tampering is refused',async t=>{
  const f=await fixture(t),src=join(f.source,'skills','fresh'); await mkdir(src,{recursive:true,mode:0o700});
  await writeFile(join(src,'SKILL.md'),'Fresh package.\n',{mode:0o600});
  const selected=await item(f.store,'Default','skill','fresh',f.defaultUserHome);
  const result=await applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id]});
  const journal=JSON.parse((await readFile(result.backup,'utf8'))), payload=join(result.backup,'..',journal.files[0].after.path);
  await writeFile(payload,'tampered',{mode:0o600});
  await assert.rejects(planUndo(f.store,result.id),/advanced-copy payload/i);
});

test('advanced conflict replacement rolls back failures and protects later target edits',async t=>{
  const f=await fixture(t),src=join(f.source,'skills','replace'); await mkdir(join(src,'bin'),{recursive:true,mode:0o700});
  await writeFile(join(src,'SKILL.md'),'Source version.\n',{mode:0o600}); await writeFile(join(src,'bin','tool'),'#!/bin/sh\n',{mode:0o700});
  const dst=join(f.b.home,'skills','replace'); await mkdir(dst,{recursive:true,mode:0o700}); await writeFile(join(dst,'SKILL.md'),'Old version.\n',{mode:0o600});
  const selected=await item(f.store,'Default','skill','replace',f.defaultUserHome);
  let hit=false;
  await assert.rejects(applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id],checkpoint:async()=>{if(!hit){hit=true;throw new Error('fixture rollback');}}}),/prior settings were restored/);
  assert.equal((await read(join(dst,'SKILL.md'))).toString(),'Old version.\n');
  await assert.rejects(stat(join(dst,'bin','tool')),{code:'ENOENT'});
  const preview=await planCopy(f.store,'Default','B',{...f.options,selection:[selected.id]}); assert.equal(preview.items[0].status,'conflict');
  const result=await applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id],expectedHash:preview.hash});
  await writeFile(join(dst,'SKILL.md'),'Newer user edit.\n',{mode:0o600});
  await assert.rejects(undoCopy(f.store,result.id,f.options),/refusing to overwrite/);
  assert.equal((await read(join(dst,'SKILL.md'))).toString(),'Newer user edit.\n');
});

test('advanced interrupted undo resumes through the common pending journal',async t=>{
  const f=await fixture(t),src=join(f.source,'skills','resume'); await mkdir(join(src,'bin'),{recursive:true,mode:0o700});
  await writeFile(join(src,'SKILL.md'),'Resume.\n',{mode:0o600}); await writeFile(join(src,'bin','tool'),'#!/bin/sh\n',{mode:0o700});
  const selected=await item(f.store,'Default','skill','resume',f.defaultUserHome);
  const result=await applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id]}); let interrupted=false;
  await assert.rejects(undoCopy(f.store,result.id,{...f.options,checkpoint:async()=>{if(!interrupted){interrupted=true;throw new Error('simulated interruption');}}}),/simulated interruption/);
  const resumed=await undoCopy(f.store,'pending',f.options); assert.equal(resumed.status,'undone');
  await assert.rejects(stat(join(f.b.home,'skills')),{code:'ENOENT'});
});

test('source changes invalidate the preview and unsafe selected skill links are refused',async t=>{
  const f=await fixture(t), src=join(f.source,'skills','unsafe'); await mkdir(src,{recursive:true,mode:0o700});
  await writeFile(join(src,'SKILL.md'),'Safe.\n',{mode:0o600});
  const selected=await item(f.store,'Default','skill','unsafe',f.defaultUserHome);
  const valid=await validateAdvancedSelection(f.store,'Default',[selected.id],f.options); assert.equal(valid.valid,true);
  const preview=await planCopy(f.store,'Default','B',{...f.options,selection:[selected.id]});
  await writeFile(join(src,'SKILL.md'),'Changed.\n',{mode:0o600});
  await assert.rejects(applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id],expectedHash:preview.hash}),/preview changed/);
  const escape=join(f.root,'outside'); await writeFile(escape,'outside',{mode:0o600}); await symlink(escape,join(src,'escape'));
  await assert.rejects(validateAdvancedSelection(f.store,'Default',[selected.id],f.options),/Unsafe advanced-copy|Unsupported or hidden/);
});

 test('advanced journal rejects writable-to-others snapshot modes', async t=>{
  const f=await fixture(t);
  const selected=await item(f.store,'Default','config','model',f.defaultUserHome);
  const result=await applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id]});
  const journal=JSON.parse(await readFile(result.backup,'utf8'));
  journal.files[0].afterMode=0o666;
  await assert.rejects(validateAdvancedFiles(join(result.backup,'..'),journal.files),/file mode/);
});

 test('selected safe config keys ignore unrelated credentials but refuse a selected credential-like value', async t=>{
  const f=await fixture(t), config=join(f.source,'config.toml');
  const secret='sk-fixture12345678901234567890';
  await writeFile(config,`model="safe-model"\n# ${secret}\n[mcp_servers.private.http_headers]\nAuthorization="Bearer ${secret}"\n`,{mode:0o600});
  const selected=await item(f.store,'Default','config','model',f.defaultUserHome);
  const options={...f.options,selection:[selected.id]};
  await validateAdvancedSelection(f.store,'Default',options.selection,options);
  const preview=await planCopy(f.store,'Default','B',options);
  assert.equal(JSON.stringify(preview).includes(secret),false);
  const before=await read(join(f.b.home,'config.toml'));
  const result=await applyCopy(f.store,'Default','B',{...options,expectedHash:preview.hash});
  const target=await readFile(join(f.b.home,'config.toml'),'utf8');
  assert.equal(parse(target).model,'safe-model');
  assert.equal(target.includes(secret),false);
  assert.equal(parse(target).mcp_servers,undefined);
  await undoCopy(f.store,result.id,f.options);
  assert.deepEqual(await read(join(f.b.home,'config.toml')),before);
  await writeFile(config,`model="${secret}"\n`,{mode:0o600});
  await assert.rejects(validateAdvancedSelection(f.store,'Default',options.selection,options),/Credential-like content in selected setting/);
});
