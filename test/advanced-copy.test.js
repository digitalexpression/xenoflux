import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
  await undoCopy(f.store,result.id,f.options);
  assert.equal((await read(config)).toString(),originalText);
});

test('skill copies exact package assets and executable modes, removes package extras, and undo restores the package',async t=>{
  const f=await fixture(t), src=join(f.source,'skills','tool'); await mkdir(join(src,'bin'),{recursive:true,mode:0o700});
  await mkdir(join(src,'assets'),{mode:0o700}); await writeFile(join(src,'SKILL.md'),'A test skill.\n',{mode:0o600});
  await mkdir(join(src,'empty'),{mode:0o700});
  await writeFile(join(src,'bin','run'),'#!/bin/sh\nexit 0\n',{mode:0o700}); await writeFile(join(src,'assets','payload.bin'),Buffer.from([0,255,1,2]),{mode:0o600});
  await writeFile(join(src,'assets','readme.txt'),'plain text\n',{mode:0o644});
  const dst=join(f.b.home,'skills','tool'); await mkdir(join(dst,'empty'),{recursive:true,mode:0o750}); await writeFile(join(dst,'local.txt'),'keep me\n',{mode:0o600});
  const selected=await item(f.store,'Default','skill','tool',f.defaultUserHome);
  const preview=await planCopy(f.store,'Default','B',{...f.options,selection:[selected.id]});
  assert.ok(preview.items[0].changes.some(c=>c.action==='remove'&&c.path==='skills/tool/local.txt'));
  const oldUmask=process.umask(0o077); let result;
  try { result=await applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id],expectedHash:preview.hash}); }
  finally { process.umask(oldUmask); }
  assert.deepEqual(await read(join(dst,'assets','payload.bin')),Buffer.from([0,255,1,2]));
  assert.equal((await stat(join(dst,'empty'))).mode&0o777,0o700);
  assert.equal((await stat(join(dst,'bin','run'))).mode&0o777,0o700); await assert.rejects(stat(join(dst,'local.txt')),{code:'ENOENT'});
  assert.equal((await stat(join(dst,'assets','readme.txt'))).mode&0o777,0o644);
  const undo=await planUndo(f.store,result.id); await undoCopy(f.store,result.id,{...f.options,expectedHash:undo.hash});
  await assert.rejects(stat(join(dst,'SKILL.md')),{code:'ENOENT'}); assert.equal((await read(join(dst,'local.txt'))).toString(),'keep me\n');
  assert.equal((await stat(join(dst,'empty'))).mode&0o777,0o750);
});

test('interruption immediately after package deletion restores the removed executable and mode',async t=>{
  const f=await fixture(t),src=join(f.source,'skills','delete-resume'); await mkdir(src,{recursive:true,mode:0o700});
  await writeFile(join(src,'SKILL.md'),'New exact package.\n',{mode:0o600});
  const dst=join(f.b.home,'skills','delete-resume'); await mkdir(dst,{recursive:true,mode:0o700});
  await writeFile(join(dst,'SKILL.md'),'Old.\n',{mode:0o600}); await writeFile(join(dst,'obsolete'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const selected=await item(f.store,'Default','skill','delete-resume',f.defaultUserHome); let interrupted=false;
  await assert.rejects(applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id],checkpoint:async()=>{if(!interrupted){interrupted=true;throw new Error('after deletion');}}}),/prior settings were restored/);
  assert.equal((await read(join(dst,'obsolete'))).toString(),'#!/bin/sh\nexit 0\n'); assert.equal((await stat(join(dst,'obsolete'))).mode&0o777,0o700);
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

test('interrupted undo can resume after the selected SKILL.md was removed',async t=>{
  const f=await fixture(t),src=join(f.source,'skills','last-file'); await mkdir(join(src,'bin'),{recursive:true,mode:0o700});
  await writeFile(join(src,'SKILL.md'),'Last file.\n',{mode:0o600}); await writeFile(join(src,'bin','run'),'#!/bin/sh\n',{mode:0o700});
  const selected=await item(f.store,'Default','skill','last-file',f.defaultUserHome);
  const result=await applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id]}); let checkpoints=0;
  await assert.rejects(undoCopy(f.store,result.id,{...f.options,checkpoint:async()=>{if(++checkpoints===2)throw new Error('after SKILL removal');}}),/after SKILL removal/);
  assert.equal((await planUndo(f.store,'pending')).phase,'applied');
  await undoCopy(f.store,'pending',f.options);
  await assert.rejects(stat(join(f.b.home,'skills','last-file')),{code:'ENOENT'});
});

test('directory-only package change is applied and restored without treating identical files as a no-op',async t=>{
  const f=await fixture(t),src=join(f.source,'skills','empty-dir-change'); await mkdir(join(src,'empty'),{recursive:true,mode:0o700});
  await writeFile(join(src,'SKILL.md'),'Same bytes.\n',{mode:0o600});
  const dst=join(f.b.home,'skills','empty-dir-change'); await mkdir(join(dst,'empty'),{recursive:true,mode:0o750});
  await writeFile(join(dst,'SKILL.md'),'Same bytes.\n',{mode:0o600});
  const selected=await item(f.store,'Default','skill','empty-dir-change',f.defaultUserHome), options={...f.options,selection:[selected.id]};
  const preview=await planCopy(f.store,'Default','B',options);
  assert.ok(preview.changes.some(change=>change.path==='skills/empty-dir-change/empty'&&change.action==='directory-mode'));
  const result=await applyCopy(f.store,'Default','B',{...options,expectedHash:preview.hash}); assert.equal(result.status,'applied');
  assert.equal((await stat(join(dst,'empty'))).mode&0o777,0o700);
  await undoCopy(f.store,result.id,f.options); assert.equal((await stat(join(dst,'empty'))).mode&0o777,0o750);
});

test('file to directory and directory to file skill transitions are refused during preview',async t=>{
  for(const direction of ['file-to-directory','directory-to-file']) await t.test(direction,async t=>{
    const f=await fixture(t),src=join(f.source,'skills','shape'),dst=join(f.b.home,'skills','shape');
    await mkdir(src,{recursive:true,mode:0o700}); await writeFile(join(src,'SKILL.md'),'Shape.\n',{mode:0o600});
    await mkdir(dst,{recursive:true,mode:0o700}); await writeFile(join(dst,'SKILL.md'),'Old.\n',{mode:0o600});
    if(direction==='file-to-directory') { await writeFile(join(src,'asset'),'source file',{mode:0o600}); await mkdir(join(dst,'asset'),{mode:0o700}); await writeFile(join(dst,'asset','old'),'target child',{mode:0o600}); }
    else { await mkdir(join(src,'asset'),{mode:0o700}); await writeFile(join(src,'asset','child'),'source child',{mode:0o600}); await writeFile(join(dst,'asset'),'target file',{mode:0o600}); }
    const selected=await item(f.store,'Default','skill','shape',f.defaultUserHome);
    await assert.rejects(planCopy(f.store,'Default','B',{...f.options,selection:[selected.id]}),/file\/directory type transition/);
    assert.equal((await read(join(dst,'SKILL.md'))).toString(),'Old.\n');
  });
});

test('v1 and v2 copy journals remain readable and undoable',async t=>{
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for(const version of [1,2]) await t.test(`schema v${version}`,async t=>{
    const f=await fixture(t),journalDir=join(f.store.directory,'native-copies');
    await writeFile(join(f.source,'AGENTS.md'),'Source instructions.\n',{mode:0o600});
    await writeFile(join(f.b.home,'AGENTS.md'),'Destination instructions.\n',{mode:0o600});
    const original=(await read(join(f.b.home,'AGENTS.md'))).toString();
    const result=await applyCopy(f.store,'Default','B',f.options),journal=JSON.parse(await readFile(result.backup,'utf8'));
    journal.schemaVersion=version; delete journal.packages;
    if(version===1) {
      const legacyAfter='model = "legacy-v1"\n';
      journal.files=[{path:'AGENTS.md',before:original,beforeMode:0o600,after:legacyAfter,afterMode:0o600}];
      await writeFile(join(f.b.home,'AGENTS.md'),legacyAfter,{mode:0o600});
      delete journal.selection; delete journal.createdDirectories;
    }
    const base={source:journal.source,target:journal.target,components:journal.components,files:journal.files,defaultUserHome:journal.defaultUserHome};
    journal.payloadHash=digest(version===2?{...base,selection:journal.selection,createdDirectories:journal.createdDirectories}:base);
    await writeFile(result.backup,JSON.stringify(journal),{mode:0o600});
    await undoCopy(f.store,result.id,f.options);
    assert.equal((await read(join(f.b.home,'AGENTS.md'))).toString(),original);
    await assert.rejects(stat(join(journalDir,'pending.json')),{code:'ENOENT'});
  });
});

test('same-named skills from different origins cannot target one package, even with distinct package contents',async t=>{
  const f=await fixture(t),profileSkill=join(f.source,'skills','duplicate'),userHome=join(f.defaultUserHome,'.agents'),userSkill=join(userHome,'skills','duplicate');
  await mkdir(profileSkill,{recursive:true,mode:0o700}); await writeFile(join(profileSkill,'SKILL.md'),'Profile copy.\n',{mode:0o600});
  await mkdir(userSkill,{recursive:true,mode:0o700}); await writeFile(join(userSkill,'SKILL.md'),'User copy.\n',{mode:0o600});
  await writeFile(join(userSkill,'user-only.txt'),'distinct file\n',{mode:0o600});
  const profileItem=await item(f.store,'Default','skill','duplicate',f.defaultUserHome);
  const inventory=await inspectProfile(f.store,'Default',{defaultUserHome:f.defaultUserHome,copyOnly:true});
  const userItem=inventory.items.find(candidate=>candidate.category==='skill'&&candidate.label==='duplicate'&&candidate.scope==='user'&&candidate.copyable);
  assert.ok(userItem); assert.notEqual(profileItem.origin,userItem.origin);
  await assert.rejects(planCopy(f.store,'Default','B',{...f.options,selection:[profileItem.id,userItem.id]}),/same destination package/);
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

test('package membership is guarded between preview and apply, and exact undo refuses later additions',async t=>{
  const f=await fixture(t),src=join(f.source,'skills','guarded'); await mkdir(src,{recursive:true,mode:0o700});
  await writeFile(join(src,'SKILL.md'),'Guarded package.\n',{mode:0o600});
  const selected=await item(f.store,'Default','skill','guarded',f.defaultUserHome), options={...f.options,selection:[selected.id]};
  const preview=await planCopy(f.store,'Default','B',options), dst=join(f.b.home,'skills','guarded');
  await mkdir(dst,{recursive:true,mode:0o700}); await writeFile(join(dst,'SKILL.md'),'Old.\n',{mode:0o600});
  await writeFile(join(dst,'unreviewed.txt'),'keep',{mode:0o600});
  await assert.rejects(applyCopy(f.store,'Default','B',{...options,expectedHash:preview.hash}),/preview changed/);
  assert.equal((await read(join(dst,'unreviewed.txt'))).toString(),'keep');
  const next=await planCopy(f.store,'Default','B',options), result=await applyCopy(f.store,'Default','B',{...options,expectedHash:next.hash});
  await writeFile(join(dst,'later.txt'),'later',{mode:0o600});
  await assert.rejects(undoCopy(f.store,result.id,f.options),/package changed|unplanned changes/);
  assert.equal((await read(join(dst,'later.txt'))).toString(),'later');
});

test('crafted v3 journal directory traversal is refused before clients or outside deletion',async t=>{
  const f=await fixture(t),src=join(f.source,'skills','journal-guard'); await mkdir(src,{recursive:true,mode:0o700});
  await writeFile(join(src,'SKILL.md'),'Journal guard.\n',{mode:0o600});
  const selected=await item(f.store,'Default','skill','journal-guard',f.defaultUserHome);
  const result=await applyCopy(f.store,'Default','B',{...f.options,selection:[selected.id]});
  const journal=JSON.parse(await readFile(result.backup,'utf8')),victim=join(f.b.root,'empty-victim');
  await mkdir(victim,{mode:0o700});
  journal.phase='prepared'; journal.files=[];
  journal.packages=[{path:'skills/journal-guard',before:{files:[],directories:[]},after:{files:[],directories:[{path:'skills/journal-guard/../../../empty-victim',mode:0o700}]}}];
  const base={source:journal.source,target:journal.target,components:journal.components,files:journal.files,defaultUserHome:journal.defaultUserHome};
  journal.payloadHash=createHash('sha256').update(JSON.stringify({...base,selection:journal.selection,createdDirectories:journal.createdDirectories,packages:journal.packages})).digest('hex');
  await writeFile(result.backup,JSON.stringify(journal),{mode:0o600});
  const calls=[],runtime={prepareClients:async()=>calls.push('prepare'),assertIdle:async()=>calls.push('idle')};
  await assert.rejects(undoCopy(f.store,result.id,{...f.options,runtime}),/Invalid skill package journal manifest/);
  assert.deepEqual(calls,[]); assert.deepEqual(await readdir(victim),[]);
});

test('empty selection is a no-op without client preparation or a journal',async t=>{
  const f=await fixture(t), calls=[];
  const result=await applyCopy(f.store,'Default','B',{...f.options,selection:[],runtime:{prepareClients:async()=>calls.push('prepare'),assertIdle:async()=>calls.push('idle')}});
  assert.equal(result.status,'unchanged'); assert.deepEqual(result.items,[]); assert.deepEqual(calls,[]);
  await assert.rejects(stat(join(f.store.directory,'native-copies')),{code:'ENOENT'});
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

test('source OpenAI provider overrides refuse category and stale item selections before mutation',async t=>{
  const f=await fixture(t);
  const selected=await item(f.store,'Default','config','model',f.defaultUserHome);
  const source='model = "custom-model"\n[model_providers.openai]\nbase_url = "https://example.invalid/v1"\n';
  await writeFile(join(f.source,'config.toml'),source);
  const namedConfig=parse((await read(join(f.a.home,'config.toml'))).toString());
  await writeFile(join(f.a.home,'config.toml'),stringify({...namedConfig,...parse(source)}));
  const before=await read(join(f.b.home,'config.toml'));
  for(const name of ['Default','A']) {
    const inv=await inspectProfile(f.store,name,{...f.options,copyOnly:true});
    assert.equal(inv.items.some(x=>x.category==='config'&&x.copyable),false);
    await assert.rejects(planCopy(f.store,name,'B',{...f.options,include:['config']}),/custom model providers/i);
    await assert.rejects(applyCopy(f.store,name,'B',{...f.options,include:['config']}),/custom model providers/i);
  }
  await assert.rejects(planCopy(f.store,'Default','B',{...f.options,selection:[selected.id]}),/no longer available or copyable/);
  assert.deepEqual(await read(join(f.b.home,'config.toml')),before);
});

test('preview reports unsupported and uncertain retained destination inventory without reading its contents',async t=>{
  const f=await fixture(t);
  await mkdir(join(f.b.home,'agents'),{recursive:true});
  await writeFile(join(f.b.home,'agents','local-extra.toml'),'unsupported_role_field = "private body"\n');
  await symlink(join(f.root,'unavailable-rules'),join(f.b.home,'rules'));
  const selected=await item(f.store,'Default','config','model',f.defaultUserHome);
  const preview=await planCopy(f.store,'Default','B',{...f.options,selection:[selected.id]});
  const agent=preview.kept.find(x=>x.label==='local-extra.toml');
  assert.equal(agent.status,'kept'); assert.equal(agent.inventoryStatus,'unsupported');
  assert.match(agent.reason,/unsupported or unsafe/i);
  assert.equal(agent.destinationPath,join(f.b.home,'agents','local-extra.toml'));
  assert.equal(preview.kept.find(x=>x.label==='rules').inventoryStatus,'unsupported');
  assert.ok(preview.destinationLimitations.some(x=>x.includes('Copy discovery is limited')));
  assert.equal(preview.kept.some(x=>x.label==='model'&&x.scope==='profile'),false);
  assert.equal(JSON.stringify(preview).includes('private body'),false);
});
