import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { inspectProfile } from '../src/profile-inventory.js';

async function put(path, text) { await mkdir(dirname(path), {recursive:true,mode:0o700}); await writeFile(path,text,{mode:0o600}); }
async function fixture(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'xfx-inventory-'))); t.after(()=>rm(root,{recursive:true,force:true}));
  const executable=join(root,'codex'); await writeFile(executable,'#!/bin/sh\nexit 99\n',{mode:0o700});
  const native=await prepareNativeHome({directory:join(root,'native'),executable,codexVersion:'0.153.4'});
  const store=new Store(join(root,'store')); await store.update(d=>create(d,'A'));
  await registerHome(store,'A',native.root,{executable,version:'0.153.4'});
  const user=join(root,'user'); await mkdir(join(user,'.codex'),{recursive:true,mode:0o700});
  return {root,native,store,user,userHome:native.userHome,home:native.home};
}
const by=(result,category,label)=>result.items.find(x=>x.category===category&&x.label===label);
async function append(path,text) { await writeFile(path,`${await readFile(path,'utf8')}${text}`); }

test('inventories supported profile and user settings without exposing bodies or secrets',async t=>{
  const f=await fixture(t);
  await append(join(f.home,'config.toml'),'model="gpt-safe"\napi_key="sk-secret-secret-secret"\n[agents]\nmax_threads=3\n');
  await put(join(f.home,'AGENTS.md'),'private instruction body');
  await put(join(f.home,'agents','worker.toml'),'name="worker"\ndescription="A role"\ndeveloper_instructions="Work safely."\n');
  await put(join(f.home,'rules','review.rules'),'prefix_rule(pattern="git status")\n');
  await put(join(f.userHome,'.agents','skills','review','SKILL.md'),'private skill body');
  const before=await readFile(join(f.home,'config.toml'));
  const result=await inspectProfile(f.store,'A',{defaultUserHome:f.user});
  assert.equal(result.profile.name,'A');
  assert.equal(by(result,'config','model').copyable,true);
  assert.equal(by(result,'config','agents.max_threads').copyable,true);
  assert.equal(by(result,'instruction','AGENTS.md').copyable,true);
  assert.equal(by(result,'agent','worker.toml').transfer.kind,'agent');
  assert.equal(by(result,'rule','review.rules').transfer.kind,'rule');
  assert.equal(by(result,'skill','review').scope,'user');
  assert.equal(by(result,'skill','review').transfer.path,'skills/review');
  const serialized=JSON.stringify(result);
  for(const secret of ['sk-secret-secret-secret','private instruction body','private skill body','developer_instructions']) assert.equal(serialized.includes(secret),false);
  assert.deepEqual(await readFile(join(f.home,'config.toml')),before);
});

test('reports absent, malformed, unsupported, and symbolic-link entries without making them copyable',async t=>{
  const f=await fixture(t);
  await append(join(f.home,'config.toml'),'model_provider="other"\n');
  await put(join(f.home,'agents','broken.toml'),'not = [toml');
  await mkdir(join(f.home,'skills','visible'),{recursive:true});
  await mkdir(join(f.root,'outside-skill'),{recursive:true});
  await symlink(join(f.root,'outside-skill'),join(f.home,'skills','linked'));
  const result=await inspectProfile(f.store,'A',{defaultUserHome:f.user});
  assert.equal(by(result,'config','config.toml').copyable,false);
  assert.match(by(result,'config','config.toml').reason,/Malformed|unsupported/i);
  assert.equal(by(result,'agent','broken.toml').copyable,false);
  assert.equal(by(result,'skill','linked').copyable,false);
  assert.match(by(result,'skill','linked').reason,/Unsupported/);
  assert.equal(by(result,'plugin','plugins').reason,'Missing');
  assert.equal(by(result,'db','state_5.sqlite').reason,'Missing');
  assert.equal(by(result,'memory','memories_1.sqlite').reason,'Missing');
  assert.equal(by(result,'conversation','thread index').reason,'Missing');
  assert.equal((await lstat(join(f.home,'skills','linked'))).isSymbolicLink(),true);
});

test('discovers project roots from config and marks project scope inventory-only',async t=>{
  const f=await fixture(t), project=join(f.root,'repo');
  await mkdir(join(project,'nested','.codex'),{recursive:true,mode:0o700});
  await append(join(f.home,'config.toml'),`\n[projects."${project}"]\ntrust_level="trusted"\n`);
  await put(join(project,'AGENTS.md'),'project guidance');
  await put(join(project,'nested','.codex','config.toml'),'model="project-model"\n');
  await put(join(project,'nested','.codex','skills','project-codex','SKILL.md'),'codex skill');
  await put(join(project,'nested','.agents','skills','project-agent','SKILL.md'),'agent skill');
  const result=await inspectProfile(f.store,'A',{defaultUserHome:f.user});
  assert.ok(result.projects.some(p=>p.path===project&&p.status==='ready'));
  assert.ok(result.items.some(x=>x.category==='instruction'&&x.label==='AGENTS.md'&&x.scope==='project'));
  const projectSetting=result.items.find(x=>x.scope==='project'&&x.category==='config'&&x.label==='model');
  assert.ok(projectSetting); assert.equal(projectSetting.copyable,false);
  assert.ok(result.items.some(x=>x.scope==='project'&&x.category==='skill'&&x.label==='project-codex'));
  assert.ok(result.items.some(x=>x.scope==='project'&&x.category==='skill'&&x.label==='project-agent'));
  assert.ok(result.limitations.some(x=>x.includes('does not prove')));
});

test('Default resolves from the supplied user home and does not mutate source files',async t=>{
  const f=await fixture(t); await put(join(f.user,'.codex','config.toml'),'model="default-model"\n');
  const before=await readFile(join(f.user,'.codex','config.toml'));
  const result=await inspectProfile(f.store,'Default',{defaultUserHome:f.user});
  assert.equal(result.profile.home,join(f.user,'.codex'));
  assert.equal(by(result,'config','model').scope,'profile');
  assert.deepEqual(await readFile(join(f.user,'.codex','config.toml')),before);
});

test('items have stable distinct IDs, safe config display values, and explicit named versus Dock skills',async t=>{
  const f=await fixture(t);
  await append(join(f.home,'config.toml'),'model="gpt-safe"\nmodel_reasoning_effort="high"\nunknown_setting="secret-value"\n');
  await put(join(f.userHome,'.agents','skills','cli-skill','SKILL.md'),'cli');
  await put(join(f.user,'.agents','skills','dock-skill','SKILL.md'),'dock');
  const result=await inspectProfile(f.store,'A',{defaultUserHome:f.user});
  const model=by(result,'config','model'), reasoning=by(result,'config','model_reasoning_effort');
  assert.notEqual(model.id,reasoning.id);
  assert.equal(model.value,'gpt-safe');
  assert.equal(by(result,'config','unknown_setting').status,'unsupported');
  assert.equal(JSON.stringify(result).includes('secret-value'),false);
  assert.equal(by(result,'skill','cli-skill').scope,'user');
  assert.equal(by(result,'skill','cli-skill').copyable,true);
  assert.equal(by(result,'skill','dock-skill').copyable,false);
  assert.match(by(result,'skill','dock-skill').origin,/Dock-dependent/);
});

test('finds bounded cache manifests, inventories bundled skills and memory names only',async t=>{
  const f=await fixture(t);
  await put(join(f.home,'plugins','cache','market.example','sample-plugin','1.2.3','.codex-plugin','plugin.json'),
    JSON.stringify({id:'sample-plugin',name:'Sample Plugin',version:'1.2.3',secret:'must-not-appear'}));
  await put(join(f.home,'plugins','.staging','secret.json'),'{"name":"staging-only"}');
  await put(join(f.home,'skills','.system','bundled','SKILL.md'),'system skill');
  await put(join(f.home,'skills','random-folder','README.md'),'not a skill');
  await put(join(f.home,'memories','project-memory.md'),'memory body');
  const result=await inspectProfile(f.store,'A',{defaultUserHome:f.user});
  const cached=result.items.find(x=>x.category==='plugin'&&x.label==='market.example/sample-plugin/1.2.3');
  assert.ok(cached); assert.equal(cached.pluginId,'sample-plugin'); assert.equal(cached.version,'1.2.3');
  assert.equal(cached.copyable,false);
  assert.ok(result.items.some(x=>x.category==='skill'&&x.label==='bundled'&&x.scope==='system'));
  assert.equal(by(result,'skill','random-folder').copyable,false);
  assert.ok(result.items.some(x=>x.category==='memory'&&x.label==='project-memory.md'));
  assert.ok(result.items.some(x=>x.category==='memory'&&x.label==='memories_1.sqlite'&&x.status==='missing'));
  assert.equal(JSON.stringify(result).includes('must-not-appear'),false);
  assert.equal(JSON.stringify(result).includes('staging-only'),false);
});

test('depth-limited projects report partial and invalid project/system skills remain unsupported', async t => {
  const f = await fixture(t), project = join(f.root, 'deep-project');
  await mkdir(join(project, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true, mode: 0o700 });
  await append(join(f.home, 'config.toml'), `\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`);
  await mkdir(join(project, '.agents', 'skills', 'empty'), { recursive: true, mode: 0o700 });
  await mkdir(join(f.home, 'skills', '.system', 'empty'), { recursive: true, mode: 0o700 });
  const result = await inspectProfile(f.store, 'A', { defaultUserHome: f.user });
  assert.equal(result.projects.find(p => p.path === project).status, 'partial');
  const empty = result.items.filter(item => item.category === 'skill' && item.label === 'empty');
  assert.equal(empty.length, 2);
  assert.ok(empty.every(item => item.status === 'unsupported' && item.copyable === false));
});

test('includeProjects excludes repository inventory but preserves distinct read-only conversation metadata', async t => {
  const f = await fixture(t), projectA = join(f.root, 'repo-a'), projectB = join(f.root, 'repo-b');
  await mkdir(projectA, { recursive: true, mode: 0o700 });
  await mkdir(projectB, { recursive: true, mode: 0o700 });
  await append(join(f.home, 'config.toml'), `\n[projects.${JSON.stringify(projectA)}]\ntrust_level="trusted"\n`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(f.home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const insert = db.prepare('INSERT INTO threads (id,cwd,title,updated_at) VALUES (?,?,?,?)');
  insert.run('aaaaaaaa-1111-4111-8111-111111111111', projectA, 'Same title', 1710000000);
  insert.run('bbbbbbbb-2222-4222-8222-222222222222', projectB, 'Same title', 1710000001000);
  db.close();

  const result = await inspectProfile(f.store, 'A', { defaultUserHome: f.user, includeProjects: false });
  assert.deepEqual(result.projects, []);
  assert.equal(result.items.some(item => item.category === 'project'), false);
  const conversations = result.items.filter(item => item.category === 'conversation');
  assert.equal(conversations.length, 2);
  assert.notEqual(conversations[0].id, conversations[1].id);
  assert.notEqual(conversations[0].label, conversations[1].label);
  assert.match(conversations[0].label, /^Same title · #[a-f0-9]{8}$/);
  assert.equal(conversations.find(item => item.conversationId.startsWith('aaaaaaaa')).cwd, projectA);
  assert.equal(conversations.find(item => item.conversationId.startsWith('bbbbbbbb')).cwd, projectB);
  assert.equal(conversations.find(item => item.conversationId.startsWith('aaaaaaaa')).updatedAt, new Date(1710000000 * 1000).toISOString());
  assert.equal(conversations.find(item => item.conversationId.startsWith('bbbbbbbb')).updatedAt, new Date(1710000001000).toISOString());
  assert.ok(conversations.every(item => /metadata only|bodies are not inspected/.test(item.reason)));
  assert.equal(JSON.stringify(result).includes('session body'), false);
});

 test('main conversation filter excludes children and side chats before the inventory cap',async t=>{
  const f=await fixture(t); const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(join(f.home,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,title TEXT,updated_at INTEGER,source TEXT,thread_source TEXT,agent_path TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT)');
  const put=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)');
  for(let i=0;i<270;i++) put.run('sub'+i,'/fixture','Same title',100+i,JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'main'}}}),'subagent',null);
  for(const [id,source,kind,path] of [['main','vscode','user',null],['legacy','cli',null,null],['handoff','vscode','chatgpt_handoff',null],['separate','vscode','agent_created_thread',null],['side','vscode','side_chat',null],['child','vscode','user','/root/worker'],['linked','cli',null,null],['unknown','future',null,null],['guardian','vscode','guardian_review',null]]) put.run(id,'/fixture','Same title',1,source,kind,path);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run('main','linked');
  db.exec('ALTER TABLE threads ADD COLUMN name TEXT');
  db.prepare('UPDATE threads SET name=? WHERE id=?').run('Analyze Xenoflux complexity','main');
  db.prepare('UPDATE threads SET name=? WHERE id=?').run('   ','legacy'); db.close();
  const result=await inspectProfile(f.store,'A',{defaultUserHome:f.user,includeProjects:false,mainConversationsOnly:true});
  assert.deepEqual(result.items.filter(x=>x.conversationId).map(x=>x.conversationId).sort(),['handoff','legacy','main','separate']);
  assert.equal(result.items.find(x=>x.conversationId==='main').label,'Analyze Xenoflux complexity · #main');
  assert.equal(result.items.find(x=>x.conversationId==='legacy').label,'Same title · #legacy');
  assert.ok(!result.limitations.some(x=>x.includes('metadata was capped')));
  const full=await inspectProfile(f.store,'A',{defaultUserHome:f.user,includeProjects:false});
  assert.ok(full.items.some(x=>x.conversationId?.startsWith('sub')));
});

test('inventory omits filesystem metadata without deleting it or hiding system skills',async t=>{
  const f=await fixture(t);
  await put(join(f.home,'skills','.system','bundled','SKILL.md'),'Bundled skill');
  await put(join(f.home,'memories','notes.md'),'Memory');
  const before=await inspectProfile(f.store,'A',{defaultUserHome:f.user,includeProjects:false});
  const metadata=[];
  for(const folder of ['skills','memories']) for(const name of ['.DS_Store','.git','.tmp']) {
    const path=join(f.home,folder,name); metadata.push(path);
    if(name==='.DS_Store') await put(path,'metadata'); else await mkdir(path,{mode:0o700});
  }
  const after=await inspectProfile(f.store,'A',{defaultUserHome:f.user,includeProjects:false});
  assert.ok(!after.items.some(x=>['.DS_Store','.git','.tmp'].includes(x.label)));
  assert.deepEqual(after.sections,before.sections);
  assert.ok(after.items.some(x=>x.label==='bundled'&&x.scope==='system'));
  assert.ok(after.items.some(x=>x.label==='notes.md'));
  for(const path of metadata) await lstat(path);
});

test('copy-only inventory scans transferable settings and standalone files without runtime or project discovery', async t => {
  const f = await fixture(t), project = join(f.root, 'unvisited-project');
  await append(join(f.home, 'config.toml'), `\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`);
  await put(join(f.home, 'plugins', 'cache', 'market.example', 'plugin', '1.0.0', 'plugin.json'), '{"name":"cached"}');
  await put(join(f.home, 'memories', 'private.md'), 'private memory');
  await put(join(f.home, 'agents', 'worker.toml'), 'name="worker"\ndescription="A role"\ndeveloper_instructions="Do work."\n');
  await put(join(f.home, 'rules', 'safe.rules'), 'prefix_rule(pattern="true")\n');
  await put(join(f.home, 'skills', 'safe', 'SKILL.md'), '---\nname: safe\ndescription: safe\n---\n');
  const result = await inspectProfile(f.store, 'A', { defaultUserHome: f.user, copyOnly: true });
  assert.ok(result.items.some(item => item.category === 'agent' && item.label === 'worker.toml'));
  assert.ok(result.items.some(item => item.category === 'rule' && item.label === 'safe.rules'));
  assert.ok(result.items.some(item => item.category === 'skill' && item.label === 'safe'));
  assert.equal(result.items.some(item => ['plugin', 'memory', 'conversation', 'project', 'db'].includes(item.category)), false);
  assert.deepEqual(result.projects, []);
  assert.equal(JSON.stringify(result).includes('private memory'), false);
  assert.ok(result.limitations.some(message => message.includes('Copy discovery is limited')));
});
