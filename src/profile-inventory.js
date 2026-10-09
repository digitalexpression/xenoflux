// Read-only inventory of native Codex state. File contents are never returned;
// transfer descriptors only identify explicitly supported, non-secret items.
import { lstat, opendir, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { find } from './profiles.js';
import { resolveNativeSettingsHome } from './native-copy.js';
import { redactValue } from './redact.js';

const CONFIG_KEYS = ['model', 'model_reasoning_effort', 'plan_mode_reasoning_effort', 'model_verbosity',
  'model_context_window', 'model_auto_compact_token_limit', 'personality', 'service_tier',
  'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'project_doc_max_bytes', 'project_doc_fallback_filenames'];
const AGENT_KEYS = ['max_threads', 'max_concurrent_threads_per_session', 'max_depth', 'job_max_runtime_seconds',
  'default_subagent_model', 'default_subagent_reasoning_effort'];
const ROLE_KEYS = ['name', 'description', 'model', 'model_reasoning_effort', 'sandbox_mode', 'nickname_candidates', 'developer_instructions'];
const MAX_DEPTH = 5, MAX_ENTRIES = 256, MAX_PROJECTS = 256, MAX_FILE = 384 * 1024;
const MAX_PLUGIN_ENTRIES = 512;
const INVENTORY_METADATA = new Set(['.DS_Store', '.git', '.tmp']);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

function safeConfigValue(value) {
  if (['string', 'number', 'boolean'].includes(typeof value)) return redactValue(value);
  if (Array.isArray(value) && value.every(x => typeof x === 'string')) return redactValue(value);
  return undefined;
}
function add(items, { category, label, scope, origin, path, copyable = false, reason, transfer, value,
  pluginId, pluginName, version, identity }) {
  const id = hash([scope, origin, category, path ?? '', transfer?.key ?? identity ?? label].join('\0'));
  const status = !reason || /^present/i.test(reason) ? 'present' : /^missing|^no /i.test(reason) ? 'missing'
    : /partial|capped/i.test(reason) ? 'partial' : /unreadable/i.test(reason) ? 'unreadable'
      : /unsupported|unsafe|malformed/i.test(reason) ? 'unsupported' : 'unavailable';
  items.push({ id, category, label, scope, origin, status, ...(path ? { path } : {}), copyable,
    ...(value !== undefined ? {value} : {}), ...(pluginId ? {pluginId} : {}), ...(pluginName ? {pluginName} : {}), ...(version ? {version} : {}),
    ...(reason ? { reason } : {}), ...(transfer ? { transfer } : {}) });
}
async function kind(path) {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) return 'unsafe';
    if (s.isDirectory()) return 'directory';
    if (s.isFile()) return 'file';
    return 'unsupported';
  } catch (e) { return e.code === 'ENOENT' ? 'missing' : 'unreadable'; }
}
async function safeNames(path) {
  if (await kind(path) !== 'directory') return null;
  try {
    if(await realpath(path)!==path) return null;
    const dir=await opendir(path), entries=[]; let partial=false;
    for await (const entry of dir) { if(INVENTORY_METADATA.has(entry.name)) continue; if(entries.length>=MAX_ENTRIES) { partial=true; break; } entries.push(entry); }
    entries.sort((a,b)=>a.name.localeCompare(b.name)); Object.defineProperty(entries,'partial',{value:partial}); return entries;
  } catch { return null; }
}
async function safeText(path) {
  let handle;
  try {
    const parent=dirname(path); if(await realpath(parent)!==parent) return null;
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const s=await handle.stat(); if(!s.isFile()||s.nlink!==1||s.size>MAX_FILE||(process.getuid&&s.uid!==process.getuid())||(s.mode&0o022)||(s.mode&0o7000)) return null;
    const bytes=await handle.readFile(); if(bytes.includes(0)) return null;
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  } catch { return null; } finally { await handle?.close(); }
}
async function safeFile(path) {
  try {
    if(await realpath(dirname(path))!==dirname(path)||await realpath(path)!==path) return false;
    const s=await lstat(path);
    return s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=MAX_FILE
      &&(!process.getuid||s.uid===process.getuid())&&!(s.mode&0o022)&&!(s.mode&0o7000);
  } catch { return false; }
}
async function safeSkill(path) {
  try {
    if(await realpath(path)!==path) return false;
    const dir=await lstat(path); if(!dir.isDirectory()||dir.isSymbolicLink()||(process.getuid&&dir.uid!==process.getuid())||(dir.mode&0o022)||(dir.mode&0o7000)) return false;
    const skill=join(path,'SKILL.md'), s=await lstat(skill);
    return s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=MAX_FILE&&await realpath(skill)===skill
      &&(!process.getuid||s.uid===process.getuid())&&!(s.mode&0o022)&&!(s.mode&0o7000);
  } catch { return false; }
}
async function supportedAgent(path) {
  try {
    const content=await safeText(path); if(content===null) return false;
    const data = parse(content);
    return Object.keys(data).every(k => ROLE_KEYS.includes(k)) && typeof data.name === 'string'
      && typeof data.description === 'string' && typeof data.developer_instructions === 'string';
  } catch { return false; }
}
async function settings(home, items, scope, origin) {
  const configPath = join(home, 'config.toml'), status = await kind(configPath);
  if (status === 'file') {
    try {
      const content=await safeText(configPath); if(content===null) throw new Error('unsafe config');
      const config = parse(content);
      if ((config.model_provider ?? 'openai') !== 'openai' || Object.hasOwn(config.model_providers ?? {}, 'openai')) throw new Error('custom model provider is unsupported');
      for (const key of CONFIG_KEYS) if (Object.hasOwn(config, key)) {
        const value = safeConfigValue(config[key]);
        const eligible=['profile','user'].includes(scope);
        add(items, { category:'config', label:key, scope, origin, path:configPath, copyable:value !== undefined&&eligible,
          ...(value !== undefined ? {value} : {}),
          ...(value === undefined ? { reason:'Unsupported or sensitive value' } : {}),
          ...(value !== undefined && eligible ? { transfer:{kind:'config',key,path:'config.toml',sourcePath:configPath} } : {}) });
      }
      for (const key of AGENT_KEYS) if (Object.hasOwn(config.agents ?? {}, key)) {
        const value = safeConfigValue(config.agents[key]);
        const eligible=['profile','user'].includes(scope);
        add(items, { category:'config', label:`agents.${key}`, scope, origin, path:configPath, copyable:value !== undefined&&eligible,
          ...(value !== undefined ? {value} : {}),
          ...(value === undefined ? { reason:'Unsupported or sensitive value' } : {}),
          ...(value !== undefined && eligible ? { transfer:{kind:'config',key:`agents.${key}`,path:'config.toml',sourcePath:configPath} } : {}) });
      }
      if (typeof config.features?.multi_agent === 'boolean') add(items, {category:'config',label:'features.multi_agent',scope,origin,path:configPath,value:config.features.multi_agent,copyable:['profile','user'].includes(scope),...(['profile','user'].includes(scope)?{transfer:{kind:'config',key:'features.multi_agent',path:'config.toml',sourcePath:configPath}}:{})});
      else if (config.features && Object.hasOwn(config.features,'multi_agent')) add(items,{category:'config',label:'features.multi_agent',scope,origin,path:configPath,reason:'Unsupported value'});
      const supportedTop=new Set([...CONFIG_KEYS,'agents','features','projects','model_provider','model_providers','mcp_servers','hooks','plugins']);
      for(const key of Object.keys(config)) if(!supportedTop.has(key)) add(items,{category:'config',label:key,scope,origin,path:configPath,reason:'Unsupported config key; value omitted'});
      for(const key of Object.keys(config.agents??{})) if(!AGENT_KEYS.includes(key)) add(items,{category:'config',label:`agents.${key}`,scope,origin,path:configPath,reason:'Unsupported agent setting; value omitted'});
      for(const key of Object.keys(config.features??{})) if(key!=='multi_agent') add(items,{category:'config',label:`features.${key}`,scope,origin,path:configPath,reason:'Unsupported feature setting; value omitted'});
      if(config.model_providers&&Object.keys(config.model_providers).length) add(items,{category:'config',label:'model_providers',scope,origin,path:configPath,reason:'Custom provider definitions are unsupported; values omitted'});
    } catch (e) { add(items,{category:'config',label:'config.toml',scope,origin,path:configPath,reason:e.message==='custom model provider is unsupported' ? e.message : 'Malformed, unsafe, or unreadable config'}); }
  } else add(items,{category:'config',label:'config.toml',scope,origin,path:configPath,reason:status==='missing'?'Missing configuration':status});
  for (const name of ['AGENTS.md','AGENTS.override.md']) {
    const p=join(home,name), k=await kind(p), valid=k==='file'&&await safeFile(p);
    add(items,{category:'instruction',label:name,scope,origin,path:p,copyable:valid&&['profile','user'].includes(scope),reason:k==='missing'?'Missing instruction file':(valid?undefined:k==='file'?'Unsafe instruction file':k),...(valid&&['profile','user'].includes(scope)?{transfer:{kind:'instruction',path:name,sourcePath:p}}:{})});
  }
  const rulesPath=join(home,'rules'), rules=await safeNames(rulesPath);
  if (!rules) { const k=await kind(rulesPath); add(items,{category:'rule',label:'rules',scope,origin,path:rulesPath,reason:k==='missing'?'No rules':k}); }
  else if(rules.length===0) add(items,{category:'rule',label:'rules',scope,origin,path:rulesPath,reason:'No rules'});
  else for(const ent of rules) {
    const p=join(rulesPath,ent.name), valid=ent.isFile()&&!ent.name.startsWith('.')&&/^[A-Za-z0-9_-]+\.rules$/.test(ent.name)&&await safeFile(p);
    add(items,{category:'rule',label:ent.name,scope,origin,path:p,copyable:valid&&['profile','user'].includes(scope),reason:valid?undefined:'Unsupported rule entry',...(valid&&['profile','user'].includes(scope)?{transfer:{kind:'rule',path:`rules/${ent.name}`,sourcePath:p}}:{})});
  }
  if(rules?.partial) add(items,{category:'rule',label:'additional rules',scope,origin,path:rulesPath,reason:'Rule enumeration is partial'});
  const agents=join(home,'agents'), names=await safeNames(agents);
  if (!names) { const k=await kind(agents); add(items,{category:'agent',label:'agents',scope,origin,path:agents,reason:k==='missing'?'No agent definitions':k}); }
  else if(names.length===0) add(items,{category:'agent',label:'agents',scope,origin,path:agents,reason:'No agent definitions'});
  else for (const ent of names) {
    const p=join(agents,ent.name), valid=ent.isFile()&&/^[A-Za-z0-9_-]+\.toml$/.test(ent.name)&&await supportedAgent(p);
    add(items,{category:'agent',label:ent.name,scope,origin,path:p,copyable:valid&&['profile','user'].includes(scope),reason:valid?undefined:'Unsupported or unsafe agent definition',...(valid&&['profile','user'].includes(scope)?{transfer:{kind:'agent',path:`agents/${ent.name}`,sourcePath:p}}:{})});
  }
  if(names?.partial) add(items,{category:'agent',label:'additional agents',scope,origin,path:agents,reason:'Agent enumeration is partial'});
}
async function threadMetadata(home, mainOnly = false) {
  const db=join(home,'state_5.sqlite');
  if(await kind(db)==='missing') return {status:'missing',rows:[]};
  if(await kind(db)!=='file') return {status:'unsupported',rows:[]};
  try {
    const file=await lstat(db); if(file.nlink!==1||await realpath(db)!==db) throw new Error('unsafe database');
    for(const suffix of ['-wal','-shm','-journal']) {
      const sidecar=db+suffix, sidecarKind=await kind(sidecar);
      if(['unsafe','unreadable','unsupported'].includes(sidecarKind)) throw new Error();
      if(sidecarKind==='file') { const s=await lstat(sidecar); if(s.nlink!==1||s.uid!==file.uid||await realpath(sidecar)!==sidecar) throw new Error(); }
    }
    const {DatabaseSync}=await import('node:sqlite'), conn=new DatabaseSync(db,{readOnly:true});
    try {
      conn.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
      const table=conn.prepare("SELECT type FROM sqlite_master WHERE name='threads'").get();
      const cols=table?.type==='table'?conn.prepare('PRAGMA table_info(threads)').all():[];
      if(!['id','cwd','title','updated_at'].every(n=>cols.some(c=>c.name===n))) throw new Error('unsupported schema');
      const filters=[];
      if(mainOnly) {
        if(!cols.some(c=>c.name==='source')) return {status:'unsupported',rows:[]};
        filters.push("source IN ('cli','vscode','exec')");
        if(cols.some(c=>c.name==='thread_source')) filters.push("(thread_source IS NULL OR thread_source IN ('','user','chatgpt_handoff','agent_created_thread'))");
        if(cols.some(c=>c.name==='agent_path')) filters.push("(agent_path IS NULL OR agent_path IN ('','/root'))");
        const edges=conn.prepare("SELECT type FROM sqlite_master WHERE name='thread_spawn_edges'").get();
        if(edges) {
          if(edges.type!=='table'||!conn.prepare('PRAGMA table_info(thread_spawn_edges)').all().some(c=>c.name==='child_thread_id')) return {status:'unsupported',rows:[]};
          filters.push('NOT EXISTS (SELECT 1 FROM thread_spawn_edges e WHERE e.child_thread_id=threads.id)');
        }
      }
      const where=filters.length?` WHERE ${filters.join(' AND ')}`:'';
      const displayName=cols.some(c=>c.name==='name')?'substr(name,1,201)':'NULL';
      const rows=conn.prepare(`SELECT ${displayName} AS name, substr(id,1,64) AS id, substr(cwd,1,4097) AS cwd, substr(title,1,201) AS title, updated_at FROM threads${where} ORDER BY updated_at DESC LIMIT ?`).all(MAX_PROJECTS+1);
      return {status:rows.length>MAX_PROJECTS?'partial':'present',rows:rows.slice(0,MAX_PROJECTS)};
    } finally { conn.close(); }
  } catch { return {status:'unreadable',rows:[]}; }
}
function updatedAtIso(value) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0) return undefined;
  const millis=value>=1e12?value:value*1000;
  const date=new Date(millis);
  return Number.isNaN(date.valueOf())?undefined:date.toISOString();
}
async function collectProjects(store, profile, home, defaultUserHome, items, projects, limitations, {includeProjects=true,mainConversationsOnly=false}={}) {
  const roots=new Set();
  if(includeProjects) {
    try { const txt=await safeText(join(home,'config.toml')), c=parse(txt??''); for(const p of Object.keys(c.projects??{})) if(p.startsWith('/')&&resolve(p)===p) roots.add(p); }
    catch {}
    // The application state is optional and versioned by upstream; do not infer
    // project roots from unknown formats.
    const state=join(home,'.codex-global-state.json');
    try { const text=await safeText(state); if(text===null) throw new Error('unsafe saved roots'); const data=JSON.parse(text); const saved=data?.project_roots??data?.projects;
      add(items,{category:'project',label:'.codex-global-state.json',scope:'profile',origin:'native-home',path:state});
      if(Array.isArray(saved)) for(const p of saved) if(typeof p==='string'&&p.startsWith('/')&&resolve(p)===p) roots.add(p);
      const electron=data?.['electron-saved-workspace-roots'];
      if(Array.isArray(electron)) { for(const p of electron) if(typeof p==='string'&&p.startsWith('/')&&resolve(p)===p) roots.add(p); }
      else if(electron&&typeof electron==='object') { for(const p of Object.keys(electron)) if(p.startsWith('/')&&resolve(p)===p) roots.add(p); }
    } catch(e) { add(items,{category:'project',label:'.codex-global-state.json',scope:'profile',origin:'native-home',path:join(home,'.codex-global-state.json'),reason:e.code==='ENOENT'?'Missing saved project state':'Saved project roots are unreadable or unsupported'}); if(e.code!=='ENOENT') limitations.push('Saved project roots could not be read or had an unsupported format.'); }
    for(const repo of profile.repositories??[]) if(repo.path?.startsWith('/')&&resolve(repo.path)===repo.path) roots.add(repo.path);
  }
  const conversation=await threadMetadata(home,mainConversationsOnly);
  if(conversation.status==='unreadable'||conversation.status==='unsupported') limitations.push('Conversation inventory is partial because the thread index was unreadable or unsupported.');
  if(conversation.status==='partial') limitations.push(`Conversation metadata was capped at ${MAX_PROJECTS} entries.`);
  for(const row of conversation.rows) {
    if(typeof row.cwd==='string'&&row.cwd.startsWith('/')&&resolve(row.cwd)===row.cwd) roots.add(row.cwd);
    const displayTitle=typeof row.name==='string'&&row.name.trim()?row.name:row.title;
    const title=typeof displayTitle==='string' ? String(redactValue(displayTitle)).replace(/[\x00-\x1f\x7f-\x9f]/g,' ').trim().slice(0,200) : 'Untitled task';
    const id=String(row.id??'').slice(0,64), date=updatedAtIso(row.updated_at);
    add(items,{category:'conversation',label:`${title||'Untitled task'} · #${id.slice(-8)}`,scope:'profile',origin:'thread-index',path:join(home,'state_5.sqlite'),identity:id,reason:conversation.status==='partial'?'Conversation index is partial; native thread metadata only':'Native thread metadata only; session bodies are not inspected'});
    const last=items[items.length-1]; last.conversationId=id; if(typeof row.cwd==='string'&&row.cwd.startsWith('/')&&resolve(row.cwd)===row.cwd) last.cwd=row.cwd; if(date) last.updatedAt=date;
  }
  if(!conversation.rows.length) add(items,{category:'conversation',label:'thread index',scope:'profile',origin:'thread-index',path:join(home,'state_5.sqlite'),reason:conversation.status==='present'?'No conversations':conversation.status==='missing'?'Missing':`Conversation index ${conversation.status}`});
  if(!includeProjects) return;
  if(roots.size>MAX_PROJECTS) { limitations.push(`Project discovery was capped at ${MAX_PROJECTS} roots.`); }
  let count=0;
  for(const candidate of [...roots].sort().slice(0,MAX_PROJECTS)) {
    let root=candidate;
    try { const st=await lstat(root); if(!st.isDirectory()||st.isSymbolicLink()) { projects.push({path:candidate,status:'unsupported'}); add(items,{category:'project',label:candidate,scope:'project',origin:'discovery',path:candidate,reason:'Unsupported project root'}); continue; } root=await realpath(root); } catch { projects.push({path:candidate,status:'missing'}); add(items,{category:'project',label:candidate,scope:'project',origin:'discovery',path:candidate,reason:'Missing project root'}); continue; }
    const proj={path:root,status:'ready'}; projects.push(proj); count++;
    let visited=0;
    async function scan(dir,depth) {
      if(depth>MAX_DEPTH||visited>=MAX_ENTRIES) { proj.status='partial'; return; }
      const entries=await safeNames(dir); if(!entries) { proj.status='partial'; return; }
      if(entries.partial) proj.status='partial';
      for(const ent of entries) {
        if(visited++>=MAX_ENTRIES) { proj.status='partial'; break; }
        const p=join(dir,ent.name); if(ent.isSymbolicLink()) { add(items,{category:'project',label:ent.name,scope:'project',origin:root,path:p,reason:'Symbolic link is not inspected'}); continue; }
        if(ent.isDirectory()) {
          if(ent.name==='.codex') { await settings(p,items,'project',root); await skillDirs(p,'project',root,items); }
          else if(ent.name==='.agents') {
            const skills=await safeNames(join(p,'skills'));
            if(skills) {
              for(const skill of skills) {
                const location=join(p,'skills',skill.name);
                const valid=skill.isDirectory()&&!skill.isSymbolicLink()&&await safeSkill(location);
                add(items,{category:'skill',label:skill.name,scope:'project',origin:root,path:location,reason:valid?'Project skills are inventory-only':'Unsupported project skill; missing or unsafe SKILL.md'});
              }
              if(skills.partial) { proj.status='partial'; add(items,{category:'skill',label:'additional project skills',scope:'project',origin:root,path:join(p,'skills'),reason:'Project skill enumeration is partial'}); }
            }
          }
          else if(ent.name!=='.git' && ent.name!=='node_modules') {
            if(depth<MAX_DEPTH) await scan(p,depth+1);
            else proj.status='partial';
          }
        } else if(ent.isFile() && ['AGENTS.md','AGENTS.override.md'].includes(ent.name)) add(items,{category:'instruction',label:ent.name,scope:'project',origin:root,path:p,reason:'Project instructions are inventory-only'});
      }
    }
    await scan(root,0);
    add(items,{category:'project',label:root,scope:'project',origin:'discovery',path:root,reason:proj.status==='partial'?'Project scan is partial':undefined});
  }
  if(roots.size>MAX_PROJECTS) limitations.push(`Project discovery was capped at ${MAX_PROJECTS} roots.`);
  if(projects.some(p=>p.status==='partial')) limitations.push(`Project scans include unreadable paths or were capped at depth ${MAX_DEPTH} or ${MAX_ENTRIES} entries per root.`);
  if(count===0) { limitations.push('No accessible project roots were discovered.'); add(items,{category:'project',label:'project roots',scope:'project',origin:'discovery',reason:'No accessible project roots discovered'}); }
}
async function skillDirs(home, scope, origin, items) {
  const dir=join(home,'skills'), entries=await safeNames(dir);
  if(!entries) { const k=await kind(dir); add(items,{category:'skill',label:'skills',scope,origin,path:dir,reason:k==='missing'?'No standalone skills':k}); return; }
  if(entries.length===0) add(items,{category:'skill',label:'skills',scope,origin,path:dir,reason:'No standalone skills'});
  if(entries.partial) add(items,{category:'skill',label:'additional skills',scope,origin,path:dir,reason:'Skill enumeration is partial'});
  for(const e of entries) {
    const p=join(dir,e.name), isDir=e.isDirectory()&&!e.isSymbolicLink(), valid=isDir&&!e.name.startsWith('.')&&await safeSkill(p);
    if(e.name==='.system'&&isDir) {
      const bundled=await safeNames(p);
      if(bundled?.length) for(const skill of bundled) {
        const location=join(p,skill.name);
        const valid=skill.isDirectory()&&!skill.isSymbolicLink()&&await safeSkill(location);
        add(items,{category:'skill',label:skill.name,scope:'system',origin:'bundled-skills',path:location,reason:valid?'Bundled system skill is inventory-only':'Unsupported bundled skill; missing or unsafe SKILL.md'});
      }
      else add(items,{category:'skill',label:'.system',scope:'system',origin:'bundled-skills',path:p,reason:bundled?'No bundled skills':'Bundled skills unreadable'});
      if(bundled?.partial) add(items,{category:'skill',label:'additional bundled skills',scope:'system',origin:'bundled-skills',path:p,reason:'Bundled skill enumeration is partial'});
      continue;
    }
    add(items,{category:'skill',label:e.name,scope,origin,path:p,copyable:valid&&['profile','user'].includes(scope),reason:valid?(scope==='project'?'Project skills are inventory-only':undefined):(isDir?'Missing or unsafe SKILL.md':'Unsupported or hidden skill entry'),...(valid&&['profile','user'].includes(scope)?{transfer:{kind:'skill',path:`skills/${e.name}`,sourcePath:p}}:{})});
  }
}
async function runtimeItems(home,items,limitations) {
  const pluginDir=join(home,'plugins'), plugins=await safeNames(pluginDir);
  if(!plugins) { const k=await kind(pluginDir); add(items,{category:'plugin',label:'plugins',scope:'plugin',origin:'native-home',path:pluginDir,reason:k==='missing'?'Missing':k}); }
  else {
    const rootItem=add(items,{category:'plugin',label:'plugins',scope:'plugin',origin:'native-home',path:pluginDir,reason:plugins.length?'Present; cache metadata only':'No plugin cache entries'});
    let inspected=0, found=0, cachePartial=false;
    async function scanCache(dir,depth,labels=[]) {
      if(depth>5||inspected>=MAX_PLUGIN_ENTRIES) return;
      const entries=await safeNames(dir); if(!entries) return;
      if(entries.partial) cachePartial=true;
      for(const entry of entries) {
        if(inspected++>=MAX_PLUGIN_ENTRIES) break;
        if(entry.isSymbolicLink()||!entry.isDirectory()||['data','.staging'].includes(entry.name)) continue;
        const p=join(dir,entry.name), next=[...labels,entry.name];
        const candidates=[join(p,'plugin.json'),join(p,'manifest.json'),join(p,'.codex-plugin','plugin.json')];
        let manifest=null;
        for(const file of candidates) try { const content=await safeText(file); if(content!==null) { manifest=JSON.parse(content); break; } } catch {}
        if(manifest&&typeof manifest==='object') {
          found++;
          const metadata={
            ...(typeof manifest.id==='string'?{pluginId:String(redactValue(manifest.id)).slice(0,128)}:{}),
            ...(typeof manifest.name==='string'?{pluginName:String(redactValue(manifest.name)).slice(0,128)}:{}),
            ...(typeof manifest.version==='string'?{version:String(redactValue(manifest.version)).slice(0,64)}:{})};
          add(items,{category:'plugin',label:next.slice(-3).join('/'),scope:'plugin',origin:'native-cache',path:p,...metadata,reason:'Cached manifest metadata only; installation and activation are unverified'});
        } else if(depth<5) await scanCache(p,depth+1,next);
      }
    }
    const cache=join(pluginDir,'cache'); if(await kind(cache)==='directory') await scanCache(cache,1);
    if(plugins.partial||cachePartial) { rootItem.status='partial'; rootItem.reason='Plugin inventory is partial'; }
    if(inspected>=MAX_PLUGIN_ENTRIES) limitations.push(`Plugin cache discovery was capped at ${MAX_PLUGIN_ENTRIES} entries.`);
    if(cachePartial||plugins.partial) limitations.push('Plugin cache inventory was limited by a directory entry cap.');
    if(plugins.length&&found===0) { rootItem.status='partial'; rootItem.reason='Plugin data or staging exists, but no bounded cache manifests were found'; }
  }
  for(const [category,names] of Object.entries({db:['state_5.sqlite'],memory:['memories','memory','memories_1.sqlite'],docs:['docs'],runtime:['auth.json','history.jsonl','logs']})) for(const name of names) {
    const p=join(home,name), k=await kind(p);
    add(items,{category,label:name,scope:'profile',origin:'native-home',path:p,reason:k==='missing'?'Missing':k==='file'?'Present; contents are not inspected':k==='directory'?'Present; contents are not inspected':k});
    if(category==='memory'&&k==='directory') {
      const entries=await safeNames(p);
      if(entries?.length) for(const entry of entries) add(items,{category:'memory',label:entry.name,scope:'profile',origin:name,path:join(p,entry.name),reason:entry.isFile()?'Document name only; contents are not inspected':entry.isDirectory()?'Directory name only; contents are not inspected':'Unsupported memory entry'});
      else if(entries) add(items,{category:'memory',label:name,scope:'profile',origin:'native-home',path:p,reason:'No memory documents'});
      if(entries?.partial) add(items,{category:'memory',label:`additional ${name}`,scope:'profile',origin:'native-home',path:p,reason:'Memory inventory is partial'});
    }
    if(category==='docs'&&k==='directory') {
      const entries=await safeNames(p);
      if(entries?.length) for(const entry of entries) add(items,{category:'docs',label:entry.name,scope:'profile',origin:'native-home',path:join(p,entry.name),reason:'Document name only; contents are not inspected'});
      else if(entries) add(items,{category:'docs',label:name,scope:'profile',origin:'native-home',path:p,reason:'No documents'});
      if(entries?.partial) add(items,{category:'docs',label:'additional documents',scope:'profile',origin:'native-home',path:p,reason:'Document inventory is partial'});
    }
  }
  let config=null; try { config=parse(await safeText(join(home,'config.toml'))??''); } catch {}
  for(const [category,key] of [['hooks','hooks'],['mcp','mcp_servers']]) {
    const configured=Object.hasOwn(config??{},key);
    const definitions=config?.[key];
    const names=Array.isArray(definitions)?definitions.map((v,i)=>String(v?.name??i)):definitions&&typeof definitions==='object'?Object.keys(definitions):[];
    add(items,{category,label:key,scope:category==='mcp'?'plugin':'profile',origin:'config.toml',path:join(home,'config.toml'),reason:configured?'Present; configuration values are not inspected':'Missing configuration'});
    for(const name of names) add(items,{category,label:String(redactValue(name)).slice(0,128),scope:category==='mcp'?'plugin':'profile',origin:'config.toml',path:join(home,'config.toml'),reason:'Definition metadata only; secrets and commands omitted'});
  }
  const configuredPlugins=config?.plugins;
  const enabledNames=Array.isArray(configuredPlugins)?configuredPlugins.map((p,i)=>String(p?.name??p?.id??i))
    :configuredPlugins&&typeof configuredPlugins==='object'?Object.keys(configuredPlugins):[];
  for(const name of enabledNames) add(items,{category:'plugin',label:String(redactValue(name)).slice(0,128),scope:'plugin',origin:'config.toml',path:join(home,'config.toml'),reason:'Configured plugin name only; installation and activation are unverified'});
}

/** Build a non-mutating, content-free inventory for one named profile or Default. */
export async function inspectProfile(store, name, { defaultUserHome = homedir(), includeProjects = true, mainConversationsOnly = false, copyOnly = false } = {}) {
  const profile=name.toLowerCase()==='default' ? {name:'Default'} : find(await store.read(),name);
  const endpoint=await resolveNativeSettingsHome(store,profile.name,{defaultUserHome}), home=endpoint.home;
  const items=[],projects=[],limitations=[
    'Filesystem presence does not prove that Codex loads or activates an item.',
    'Credential, conversation, memory, and plugin bodies are never inspected or returned.'
  ];
  await settings(home,items,'profile',profile.name);
  await skillDirs(home,'profile',profile.name,items);
  const effectiveUserHome=profile.name==='Default'?defaultUserHome:join(endpoint.root,'user-home');
  const userAgents=join(effectiveUserHome,'.agents');
  await skillDirs(userAgents,'user',profile.name==='Default'?'user':'profile-user-home',items);
  if (!copyOnly) {
    add(items,{category:'skill',label:'system skills',scope:'system',origin:'native-runtime',reason:'System skill roots are not discoverable from native home'});
    limitations.push('System-provided skills are not discoverable; plugin inventory covers direct native-home entries and safe manifest metadata only.');
  }
  if(profile.name!=='Default') {
    const sharedAgents=join(defaultUserHome,'.agents');
    await skillDirs(sharedAgents,'user','machine-user (Dock-dependent)',items);
    for(const item of items) if(item.origin==='machine-user (Dock-dependent)') {
      item.copyable=false; delete item.transfer; item.reason ??='Shared machine settings may apply to Dock; not part of this profile HOME.';
    }
    limitations.push('Named CLI user settings are read from this profile’s user-home; machine-user settings are shown as Dock-dependent and are not copied.');
  }
  if (!copyOnly) {
    await runtimeItems(home,items,limitations);
    await collectProjects(store,profile,home,defaultUserHome,items,projects,limitations,{includeProjects,mainConversationsOnly});
    if(mainConversationsOnly) limitations.push('Only recognized main conversations are shown; subagents, side chats and unclassified thread sources are excluded.');
  } else {
    limitations.push('Copy discovery is limited to supported settings and standalone instructions, agents, rules, and skills; integrations, conversations, memory, and project-owned resources are excluded.');
  }
  const sections=[...new Set(items.map(x=>x.category))].sort().map(category=>{
    const subset=items.filter(x=>x.category===category),statusCounts={};
    for(const item of subset) statusCounts[item.status]=(statusCounts[item.status]??0)+1;
    return {category,count:subset.length,statusCounts};
  });
  return {profile:{name:profile.name,home},items,sections,projects,limitations};
}
