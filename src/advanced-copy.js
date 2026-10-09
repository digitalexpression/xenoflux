// Selective copy of individually inventoried Codex items. Selection IDs are
// resolved against a fresh inventory; no path supplied by a caller is used.
import { lstat, open, readdir, realpath, mkdir, writeFile, rename, unlink, rmdir, readFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { inspectProfile } from './profile-inventory.js';
import { resolveNativeSettingsHome } from './native-copy.js';
import { redactText, redactValue } from './redact.js';
import { privateDirectory } from './metadata.js';

const MAX_FILES = 256, MAX_FILE = 4 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024;
const sha = data => createHash('sha256').update(data).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const validRel = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/')
  && path.split('/').every(p => p && p !== '.' && p !== '..' && /^[A-Za-z0-9_.-]+$/.test(p));

async function ownedDir(path) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(path) !== path || s.uid !== process.getuid() || (s.mode & 0o022) || (s.mode & 0o7000))
    throw new Error('Unsafe advanced-copy directory: ' + path);
  return s;
}
const MAX_SERIALIZED_CONFIG = 256 * 1024;
async function readSafe(path, { text = false } = {}) {
  let h;
  try { h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Unsafe advanced-copy file: ' + path); }
  try {
    const s = await h.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o022) || (s.mode & 0o7000) || s.size > MAX_FILE)
      throw new Error('Unsafe or oversized advanced-copy file: ' + path);
    const data = await h.readFile();
    if (data.length > MAX_FILE) throw new Error('Advanced-copy file exceeds size limit');
    if (!text) return { data, mode: s.mode & 0o777 };
    if (data.includes(0)) throw new Error('Expected text in advanced-copy file: ' + path);
    let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new Error('Invalid UTF-8 advanced-copy file: ' + path); }
    return { data, content, mode: s.mode & 0o777 };
  } finally { await h.close(); }
}
async function parentSafe(root, path, { allowMissing = false } = {}) {
  if (!inside(root, path)) throw new Error('Advanced-copy path escapes its native home');
  const rel = relative(root, dirname(path));
  let cursor = root;
  for (const part of rel ? rel.split(sep) : []) { cursor = join(cursor, part); try { await ownedDir(cursor); } catch (e) { if (!allowMissing || e.code !== 'ENOENT') throw e; } }
}
async function tree(root, sourcePath, destination, {allowEmpty=false}={}) {
  if (!inside(root, sourcePath) || !validRel(destination)) throw new Error('Invalid advanced-copy item path');
  const out = [];
  let total = 0, entries = 0; const directories=[];
  async function walk(src, dst, depth) {
    if (depth > 12 || out.length >= MAX_FILES) throw new Error('Advanced-copy package exceeds entry or depth limit');
    const s = await lstat(src);
    if (s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o022) || (s.mode & 0o7000)) throw new Error('Unsafe advanced-copy package entry: ' + src);
    if (s.isDirectory()) {
      if((s.mode&0o700)!==0o700) throw new Error('Unsupported advanced-copy package directory mode: '+src);
      if (++entries > MAX_FILES) throw new Error('Advanced-copy package exceeds entry limit');
      if (await realpath(src) !== src) throw new Error('Non-canonical advanced-copy directory');
      directories.push({path:dst,mode:s.mode&0o777});
      for (const e of (await readdir(src, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        if (!/^[A-Za-z0-9_.-]+$/.test(e.name) || e.name === '.' || e.name === '..') throw new Error('Unsafe advanced-copy entry name');
        if (e.name.startsWith('.') || ['.git','.env','.npmrc','auth.json'].includes(e.name)) throw new Error('Hidden or credential-like skill package entry is unsupported: ' + e.name);
        await walk(join(src, e.name), dst + '/' + e.name, depth + 1);
      }
      return;
    }
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o022) || (s.mode & 0o7000) || s.size > MAX_FILE) throw new Error('Unsafe advanced-copy package file: ' + src);
    if (++entries > MAX_FILES) throw new Error('Advanced-copy package exceeds entry limit');
    const loaded = await readSafe(src);
    if (!loaded) throw new Error('Advanced-copy source changed during scan');
    total += loaded.data.length;
    if (total > MAX_TOTAL) throw new Error('Advanced-copy package exceeds total size limit');
    if (/\.(?:md|toml|rules|txt|json|yaml|yml|sh|py|js|ts)$/i.test(src)) {
      const text=new TextDecoder('utf-8',{fatal:true}).decode(loaded.data);
      if(redactText(text,src)!==text) throw new Error('Credential-like content in selected skill package: '+src);
    }
    out.push({ path: dst, after: loaded.data, afterMode: loaded.mode, sha256: sha(loaded.data) });
  }
  await walk(sourcePath, destination, 0);
  if (!out.length&&!allowEmpty) throw new Error('Cannot copy an empty skill package');
  return {files:out,directories};
}
async function resolveSelection(store, source, selection, defaultUserHome) {
  if (!Array.isArray(selection) || selection.some(x => typeof x !== 'string') || new Set(selection).size !== selection.length)
    throw new Error('Choose zero or more inventoried item IDs');
  const inventory = await inspectProfile(store, source, { defaultUserHome, includeProjects: false, copyOnly:true });
  const byId = new Map(inventory.items.map(x => [x.id, x]));
  const items = selection.map(id => {
    const item = byId.get(id);
    if (!item || item.copyable !== true || !item.transfer) throw new Error('Selected item is no longer available or copyable; refresh the inventory');
    if (!['config','instruction','agent','skill','rule'].includes(item.transfer.kind)) throw new Error('Unsupported selected item');
    return item;
  });
  return { inventory, items };
}
export async function selectAdvancedComponents(store, source, components, {defaultUserHome=homedir()}={}) {
  const inventory=await inspectProfile(store,source,{defaultUserHome,includeProjects:false,copyOnly:true});
  const profileItems=inventory.items.filter(item=>item.scope==='profile'&&item.origin===inventory.profile.name&&item.copyable&&item.transfer);
  const inScope=inventory.items.filter(item=>item.scope==='profile'&&item.origin===inventory.profile.name);
  if(components.includes('config')&&inScope.some(item=>item.category==='config'&&item.label==='config.toml'&&!/^Missing/.test(item.reason??''))) {
    const reason=inScope.find(item=>item.category==='config'&&item.label==='config.toml')?.reason??'';
    if(reason.includes('custom model provider')) throw new Error('Config copy does not support custom model providers');
    throw new Error('Source configuration is unsafe or unsupported; no config changes were selected');
  }
  if(components.includes('instructions')&&inScope.some(item=>item.category==='instruction'&&!item.copyable&&!/^Missing/.test(item.reason??'')))
    throw new Error('A selected source instruction file is unsafe or unsupported');
  if(components.includes('agents')&&inScope.some(item=>item.category==='agent'&&item.label==='agents'&&!/^No /.test(item.reason??'')))
    throw new Error('Source agent directory is unsafe or unsupported');
  if(components.includes('agents')&&inScope.some(item=>item.category==='agent'&&item.label==='additional agents'))
    throw new Error('Source agent inventory is partial; category copy is refused to avoid silently skipping agent files');
  return profileItems.filter(item=>{
    if(item.transfer.kind==='config') {
      const key=item.transfer.key;
      return components.includes(key.startsWith('agents.')||key==='features.multi_agent'?'agents':'config');
    }
    if(item.transfer.kind==='instruction') return components.includes('instructions');
    if(item.transfer.kind==='agent') return components.includes('agents');
    return false;
  }).map(item=>item.id);
}
export async function validateAdvancedSelection(store, source, selection, { defaultUserHome = homedir() } = {}) {
  const { inventory, items } = await resolveSelection(store, source, selection, defaultUserHome);
  const sourceEndpoint=await resolveNativeSettingsHome(store,source,{defaultUserHome});
  // Read every selected source payload now, before profile creation. This is
  // deliberately reused by planning so unsafe packages never reach the UI as eligible.
  const root = inventory.profile.home;
  const previews=[];
  for (const item of items) {
    const payload=await sourcePayload(item,root,defaultUserHome,sourceEndpoint);
    const files=payload.kind==='tree'?payload.files:payload.kind==='file'?[payload.file]:[];
    previews.push({id:item.id,label:item.label,status:'new',origin:item.origin,scope:item.scope,sourcePath:item.transfer.sourcePath,changes:payload.kind==='config'?[{path:'config.toml:'+payload.key,action:'new',after:previewValue(payload.value)}]:files.map(f=>({path:f.path,action:'add',after:preview(f.after,f.path),afterMode:f.afterMode}))});
  }
  return { valid: true, selection: items.map(x => x.id), source: inventory.profile, items:previews };
}
async function sourcePayload(item, profileHome, defaultUserHome, sourceEndpoint) {
  const t = item.transfer;
  if (!validRel(t.path) || typeof t.sourcePath !== 'string') throw new Error('Invalid generated transfer descriptor');
  const expectedRoot = item.scope !== 'user' ? profileHome : item.origin === 'user' ? join(defaultUserHome,'.agents') : join(sourceEndpoint.root,'user-home','.agents');
  const expected = join(expectedRoot, t.path);
  if (resolve(t.sourcePath) !== expected || !inside(expectedRoot, expected)) throw new Error('Generated item path does not match its inventory scope');
  await parentSafe(expectedRoot, expected);
  if (t.kind === 'config') {
    const f = await readSafe(expected, { text: true }); if (!f) throw new Error('Selected config source is missing');
    const config = parse(f.content), key = t.key;
    if ((config.model_provider ?? 'openai') !== 'openai' || Object.hasOwn(config.model_providers ?? {}, 'openai'))
      throw new Error('Config copy does not support custom model providers in the source');
    if (typeof key !== 'string' || !/^(?:[A-Za-z_][\w-]*|agents\.[A-Za-z_][\w-]*|features\.multi_agent)$/.test(key)) throw new Error('Unsupported config key');
    const value = key.includes('.') ? key.split('.').reduce((o,k) => o?.[k], config) : config[key];
    if (!['string','number','boolean'].includes(typeof value) && !(Array.isArray(value) && value.every(x => typeof x === 'string'))) throw new Error('Unsupported selected config value');
    if (JSON.stringify(redactValue(value, key)) !== JSON.stringify(value)) throw new Error('Credential-like content in selected setting; copy refused: '+t.path+':'+key);
    return { kind:'config', key, value, sourcePath:expected };
  }
  if (t.kind === 'skill') return { kind:'tree', ...await tree(expectedRoot, expected, t.path) };
  const f = await readSafe(expected, { text: true }); if (!f) throw new Error('Selected source file is missing');
  if(redactText(f.content,expected)!==f.content) throw new Error('Credential-like content in selected settings; copy refused: '+t.path);
  return { kind:'file', file:{ path:t.path, after:f.data, afterMode:f.mode, sha256:sha(f.data) } };
}
function getKey(object,key) { return key.split('.').reduce((v,k) => v?.[k],object); }
function setKey(object,key,value) { const parts=key.split('.'); let node=object; for(const part of parts.slice(0,-1)) { node[part] ??=Object.create(null); node=node[part]; } node[parts.at(-1)]=value; }
function preview(data,path) {
  if (data === null) return null;
  try { return redactText(new TextDecoder('utf-8',{fatal:true}).decode(data),path); }
  catch { return `[binary ${data.length} bytes sha256:${sha(data).slice(0,16)}]`; }
}

/** Build item-granular operations and a redacted UI report. */
export async function buildAdvancedCopy(store, source, target, selection, { defaultUserHome = homedir() } = {}) {
  const { inventory, items } = await resolveSelection(store, source, selection, defaultUserHome);
  const sourceEndpoint = await resolveNativeSettingsHome(store, source, { defaultUserHome });
  const targetEndpoint = await resolveNativeSettingsHome(store, target, { defaultUserHome });
  const destinationInventory=await inspectProfile(store,target,{defaultUserHome,includeProjects:false,copyOnly:true});
  const payloads = [];
  const configItems = items.filter(x => x.transfer.kind === 'config');
  if (configItems.length) {
    if(new Set(configItems.map(x=>x.transfer.key)).size!==configItems.length) throw new Error('Selected config keys collide at the destination');
    const targetPath = join(targetEndpoint.home,'config.toml');
    await parentSafe(targetEndpoint.home,targetPath);
    const current = await readSafe(targetPath,{text:true}); if (!current) throw new Error('Destination configuration is missing');
    const destinationConfig=parse(current.content);
    if((destinationConfig.model_provider??'openai')!=='openai'||Object.hasOwn(destinationConfig.model_providers??{},'openai'))
      throw new Error('Config copy does not support custom model providers in the destination');
    const sourceValues = new Map();
    for(const item of configItems) sourceValues.set(item.id,(await sourcePayload(item,inventory.profile.home,defaultUserHome,sourceEndpoint)).value);
    const beforeObj = parse(current.content), afterObj = parse(current.content);
    for(const item of configItems) {
      const parts=item.transfer.key.split('.'); let node=beforeObj;
      for(const part of parts.slice(0,-1)) {
        if(node[part]===undefined) break;
        if(!node[part]||typeof node[part]!=='object'||Array.isArray(node[part])||node[part] instanceof Date)
          throw new Error('Destination configuration requires a TOML table for '+parts.slice(0,-1).join('.'));
        node=node[part];
      }
    }
    for (const item of configItems) setKey(afterObj,item.transfer.key,sourceValues.get(item.id));
    // Native named homes require this flag for their symlinked CODEX_HOME.
    const enforcedSymlink=afterObj.allow_symlinked_codex_home!==true;
    afterObj.allow_symlinked_codex_home = true;
    const configChanged=Object.keys(afterObj).some(k=>JSON.stringify(afterObj[k])!==JSON.stringify(beforeObj[k]));
    const serialized=configChanged?Buffer.from(stringify(afterObj)):current.data;
    if(!serialized.equals(current.data)&&serialized.length>MAX_SERIALIZED_CONFIG) throw new Error('Selected configuration exceeds the bounded native config limit');
    if(!serialized.equals(current.data)) payloads.push({path:'config.toml',before:current.data, beforeMode:current.mode, after:serialized, afterMode:current.mode});
    for (const item of configItems) {
      const before=getKey(beforeObj,item.transfer.key), after=getKey(afterObj,item.transfer.key);
      item._status=JSON.stringify(before)===JSON.stringify(after)?'identical':before===undefined?'new':'conflict';
      item._before=before; item._after=after;
    }
    configItems[0]._enforcedSymlink=enforcedSymlink;
  }
  const destinations=new Map();
  const packageRoots=new Set();
  for (const item of items.filter(x => x.transfer.kind !== 'config')) {
    const value = await sourcePayload(item,inventory.profile.home,defaultUserHome,sourceEndpoint);
    const files = value.kind === 'tree' ? value.files : [value.file];
    if(value.kind==='tree') {
      if(packageRoots.has(item.transfer.path)) throw new Error('Two selected skills target the same destination package');
      packageRoots.add(item.transfer.path);
      const destRoot=join(targetEndpoint.home,item.transfer.path);
      let beforeTree={files:[],directories:[]};
      try { const st=await lstat(destRoot); if(st.isSymbolicLink()||!st.isDirectory()) throw new Error('Unsafe existing skill destination'); beforeTree=await tree(targetEndpoint.home,destRoot,item.transfer.path,{allowEmpty:true}); }
      catch(e) { if(e.code!=='ENOENT') throw e; }
      const afterDirectories=value.directories;
      const beforeFiles=new Map(beforeTree.files.map(f=>[f.path,f]));
      const afterFiles=new Map(value.files.map(f=>[f.path,f]));
      const beforeDirs=new Map(beforeTree.directories.map(d=>[d.path,d]));
      const afterDirs=new Map(afterDirectories.map(d=>[d.path,d]));
      const overlapsDirectory=(filePath,dirPath)=>filePath===dirPath||dirPath.startsWith(filePath+'/');
      if([...beforeFiles.keys()].some(path=>[...afterDirs.keys()].some(dir=>overlapsDirectory(path,dir)))
        ||[...afterFiles.keys()].some(path=>[...beforeDirs.keys()].some(dir=>overlapsDirectory(path,dir))))
        throw new Error('Skill package file/directory type transition is unsupported: '+item.transfer.path);
      const packagePaths=new Set([...beforeFiles.keys(),...afterFiles.keys()]);
      for(const path of packagePaths) {
        const before=beforeFiles.get(path), after=afterFiles.get(path);
        if(!after) { payloads.push({path,before:before.after,beforeMode:before.afterMode,after:null,afterMode:null}); continue; }
        const prior=before;
        payloads.push({path,before:prior?.after??null,beforeMode:prior?.afterMode??null,after:after.after,afterMode:after.afterMode});
      }
      const directoryChanges=[];
      for(const path of new Set([...beforeDirs.keys(),...afterDirs.keys()])) {
        const before=beforeDirs.get(path), after=afterDirs.get(path);
        if(!after||!before||before.mode!==after.mode) directoryChanges.push({path,before:before?.mode??null,after:after?.mode??null});
      }
      item._package={path:item.transfer.path,before:beforeTree,after:{files:value.files.map(f=>({path:f.path,mode:f.afterMode,sha256:f.sha256})),directories:afterDirectories},directoryChanges};
      item._package.before.files=beforeTree.files.map(f=>({path:f.path,mode:f.afterMode,sha256:f.sha256}));
      item._package.before.directories=beforeTree.directories;
    }
    if(value.kind==='tree') continue;
    for (const file of files) {
      if(destinations.has(file.path)) throw new Error('Two selected items target the same destination: '+file.path);
      destinations.set(file.path,item.id);
      const destination = join(targetEndpoint.home,file.path);
      await parentSafe(targetEndpoint.home,destination,{allowMissing:true});
      const prior = await readSafe(destination);
      payloads.push({path:file.path,before:prior?.data ?? null,beforeMode:prior?.mode ?? null,after:file.after,afterMode:file.afterMode});
    }
  }
  if (payloads.length > MAX_FILES || payloads.reduce((n,f)=>n+(f.before?.length??0)+(f.after?.length??0),0)>MAX_TOTAL) throw new Error('Advanced copy exceeds its bounded payload limit');
  const reports = items.map(item => {
    if(item.transfer.kind==='config') return {id:item.id,label:item.label,origin:item.origin,scope:item.scope,sourcePath:item.transfer.sourcePath,status:item._status,changes:[{path:'config.toml:'+item.transfer.key,action:item._status,before:previewValue(item._before),after:previewValue(item._after)}]};
    const prefix = item.transfer.path;
    const changes = payloads.filter(f => f.path === prefix || f.path.startsWith(prefix + '/'));
    const identical = changes.length > 0 && changes.every(f => f.before && f.after && f.before.equals(f.after) && f.beforeMode === f.afterMode) && !(item._package?.directoryChanges.length);
    const conflict = changes.some(f => f.before && (!f.after||!f.before.equals(f.after) || f.beforeMode !== f.afterMode)) || Boolean(item._package?.directoryChanges.length);
    const reportChanges=changes.map(f=>({path:f.path,action:f.after===null?'remove':f.before===null?'add':f.before.equals(f.after)&&f.beforeMode===f.afterMode?'identical':'replace',before:preview(f.before,f.path),after:preview(f.after,f.path),beforeMode:f.beforeMode,afterMode:f.afterMode}));
    for(const d of item._package?.directoryChanges??[]) reportChanges.push({path:d.path,action:d.after===null?'remove-directory':d.before===null?'add-directory':'mode',beforeMode:d.before,afterMode:d.after});
    return {id:item.id,label:item.label,origin:item.origin,scope:item.scope,sourcePath:item.transfer.sourcePath,status:identical?'identical':conflict?'conflict':'new',changes:reportChanges};
  });
  const createdDirectories=[];
  for(const f of payloads) {
    let d=dirname(join(targetEndpoint.home,f.path));
    while(d!==targetEndpoint.home&&d.startsWith(targetEndpoint.home+sep)) {
      const rel=relative(targetEndpoint.home,d);
      try { await ownedDir(d); break; }
      catch(e) { if(e.code!=='ENOENT') throw e; createdDirectories.push(rel); d=dirname(d); }
    }
  }
  const packages=items.filter(x=>x._package).map(x=>x._package);
  const selectedConfigKeys=new Set(configItems.map(item=>item.transfer.key));
  const selectedPaths=items.filter(item=>item.transfer.kind!=='config').map(item=>item.transfer.path);
  const kept=destinationInventory.items.filter(item=>{
    if(item.status==='missing') return false;
    if(item.scope!=='profile'||item.origin!==targetEndpoint.name) return true;
    if(item.category==='config') return !selectedConfigKeys.has(item.transfer?.key??item.label);
    const path=item.transfer?.path??relative(targetEndpoint.home,item.path??targetEndpoint.home);
    return !selectedPaths.some(selected=>path===selected||path.startsWith(selected+'/'));
  }).map(item=>({id:item.id,label:item.label,category:item.category,origin:item.origin,scope:item.scope,
    destinationPath:item.transfer?.sourcePath??item.path,status:'kept',inventoryStatus:item.status,
    ...(item.reason?{reason:item.reason}:{})}));
  const plan={source:sourceEndpoint,target:targetEndpoint,selection:items.map(x=>x.id),files:payloads,packages,createdDirectories:[...new Set(createdDirectories)]};
  const hash=createHash('sha256').update(JSON.stringify({source:plan.source,target:plan.target,selection:plan.selection,packages,createdDirectories:plan.createdDirectories,files:payloads.map(f=>({path:f.path,before:f.before&&sha(f.before),beforeMode:f.beforeMode,after:f.after&&sha(f.after),afterMode:f.afterMode}))})).digest('hex');
  return {plan,report:{status:'preview',hash,source:inventory.profile,target:{name:targetEndpoint.name,home:targetEndpoint.home},items:reports,kept,destinationLimitations:destinationInventory.limitations,changes:[
    ...payloads.filter(f=>f.before===null||f.after===null||!f.before.equals(f.after)||f.beforeMode!==f.afterMode).map(f=>({path:f.path,action:f.after===null?'remove':f.before===null?'add':'replace',beforeSha256:f.before&&sha(f.before),afterSha256:f.after&&sha(f.after),beforeMode:f.beforeMode,afterMode:f.afterMode})),
    ...packages.flatMap(p=>p.directoryChanges.map(d=>({path:d.path,action:d.after===null?'remove-directory':d.before===null?'add-directory':'directory-mode',beforeMode:d.before,afterMode:d.after})))
  ],notes:['Selected skill packages are replaced exactly; destination-only package files are removed.',...(configItems.some(i=>i._enforcedSymlink)?['Config copy enables the required allow_symlinked_codex_home flag.']:[])]}};
}
function previewValue(value) { if(value===undefined)return null; const text=typeof value==='string'?value:JSON.stringify(value); return redactText(text,'preview'); }

function safeDestinationPath(path) {
  if (!validRel(path) || !/^(?:config\.toml|AGENTS(?:\.override)?\.md|agents\/[A-Za-z0-9_-]+\.toml|rules\/[A-Za-z0-9_-]+\.rules|skills\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*)$/.test(path)) throw new Error('Invalid advanced-copy journal path');
}
async function putPayload(dir,name,data) {
  await mkdir(join(dir,'payloads'),{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  await privateDirectory(join(dir,'payloads'));
  const p=join(dir,'payloads',name); await writeFile(p,data,{flag:'wx',mode:0o600}); return {path:'payloads/'+name,sha256:sha(data),size:data.length};
}
async function getPayload(dir,ref) {
  if(!ref||typeof ref.path!=='string'||!/^payloads\/[0-9]+-(?:before|after)$/.test(ref.path)||!Number.isSafeInteger(ref.size)||ref.size<0||ref.size>MAX_TOTAL||!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('Invalid advanced-copy payload reference');
  await privateDirectory(join(dir,'payloads'));
  const p=join(dir,ref.path), s=await lstat(p);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)||s.size!==ref.size) throw new Error('Unsafe advanced-copy payload');
  const data=await readFile(p); if(sha(data)!==ref.sha256) throw new Error('Advanced-copy payload changed'); return data;
}
export async function writeAdvanced(home,f,dir,undo=false) {
  const data=undo?(f.before?await getPayload(dir,f.before):null):(f.after?await getPayload(dir,f.after):null);
  const mode=undo?f.beforeMode:f.afterMode, path=join(home,f.path), root=home;
  const rel=relative(root,dirname(path)); let current=root; const created=[];
  for(const part of rel?rel.split(sep):[]) { current=join(current,part); try { await ownedDir(current); } catch(e) { if(e.code!=='ENOENT') throw e; await mkdir(current,{mode:0o700}); await ownedDir(current); created.push(current); } }
  if(data===null) await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
  else { const tmp=join(dirname(path),'.xfx-copy-'+cryptoRandom()+'.tmp'); try { await writeFile(tmp,data,{flag:'wx',mode:mode??0o600}); await chmod(tmp,mode??0o600); await rename(tmp,path); } finally { await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;}); } }
  return created;
}
function cryptoRandom(){return randomUUID();}
export async function matchesAdvanced(home,f,dir,direction,allowBoth=false) {
  const snap=await snapshotAdvanced(home,f);
  const expected=direction==='after'?f.after:f.before, expectedMode=direction==='after'?f.afterMode:f.beforeMode;
  const other=direction==='after'?f.before:f.after, otherMode=direction==='after'?f.beforeMode:f.afterMode;
  if(!((expected===null?snap.sha256===null:snap.sha256===expected.sha256&&snap.mode===expectedMode)
    ||(allowBoth&&(other===null?snap.sha256===null:snap.sha256===other.sha256&&snap.mode===otherMode))))
    throw new Error('Settings changed since the copy; refusing to overwrite: '+f.path);
}
/** Persist bounded binary/package snapshots as separate files, not inline JSON. */
export async function persistAdvancedFiles(dir, files) {
  if(!Array.isArray(files)||files.length>MAX_FILES) throw new Error('Invalid advanced-copy payload set');
  await mkdir(join(dir,'payloads'),{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  await privateDirectory(join(dir,'payloads'));
  let total=0; const out=[];
  for(let i=0;i<files.length;i++) {
    const f=files[i]; safeDestinationPath(f.path);
    const validMode=n=>Number.isInteger(n)&&n>=0&&n<=0o777&&(n&0o022)===0;
    if((f.after!==null&&(!Buffer.isBuffer(f.after)||f.after.length>MAX_FILE))||(f.before!==null&&(!Buffer.isBuffer(f.before)||f.before.length>MAX_FILE))
      ||f.after!==null&&!validMode(f.afterMode)||f.before!==null&&!validMode(f.beforeMode)||(f.before===null&&f.beforeMode!==null)||(f.after===null&&f.afterMode!==null)||(f.before===null&&f.after===null)) throw new Error('Invalid advanced-copy file data');
    total+=(f.after?.length??0)+(f.before?.length??0); if(total>MAX_TOTAL) throw new Error('Advanced-copy payload exceeds size limit');
    const before=f.before?await putPayload(dir,`${i}-before`,f.before):null;
    const after=f.after===null?null:await putPayload(dir,`${i}-after`,f.after);
    out.push({path:f.path,before,beforeMode:f.beforeMode??null,after,afterMode:f.afterMode});
  }
  return out;
}
export async function validateAdvancedFiles(dir, files) {
  if(!Array.isArray(files)||files.length>MAX_FILES) throw new Error('Invalid advanced-copy journal files');
  await privateDirectory(join(dir,'payloads'));
  let total=0; const paths=new Set();
  for(const f of files) {
    safeDestinationPath(f.path); if(paths.has(f.path)) throw new Error('Duplicate advanced-copy journal path'); paths.add(f.path);
    if((!f.after&&!f.before)||f.afterMode!==null&&(!Number.isInteger(f.afterMode)||f.afterMode<0||f.afterMode>0o777||(f.afterMode&0o022)!==0)||f.beforeMode!==null&&(!Number.isInteger(f.beforeMode)||f.beforeMode<0||f.beforeMode>0o777||(f.beforeMode&0o022)!==0)) throw new Error('Invalid advanced-copy file mode');
    const before=f.before?await getPayload(dir,f.before):null, after=f.after?await getPayload(dir,f.after):null;
    total+=(before?.length??0)+(after?.length??0); if(total>MAX_TOTAL) throw new Error('Advanced-copy journal exceeds size limit');
  }
  return true;
}
export async function snapshotAdvanced(home,f) {
  safeDestinationPath(f.path); await parentSafe(home,join(home,f.path),{allowMissing:true});
  const got=await readSafe(join(home,f.path));
  return {sha256:got?sha(got.data):null,mode:got?.mode??null,size:got?.data.length??0};
}
export async function cleanupAdvancedDirectories(home, paths=[]) {
  if(!Array.isArray(paths)||paths.length>3072) throw new Error('Invalid advanced-copy directory cleanup list');
  for(const path of [...new Set(paths)].sort((a,b)=>b.length-a.length)) {
    if(typeof path!=='string'||! /^(?:agents|rules|skills)(?:\/[A-Za-z0-9_.-]+)*$/.test(path)) throw new Error('Unsafe advanced-copy cleanup path');
    const full=join(home,path); if(!inside(home,full)) throw new Error('Advanced-copy cleanup escapes target home');
    try { await ownedDir(full); await rmdir(full); } catch(e) { if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code)) throw e; }
  }
}

export async function matchesAdvancedPackages(home, packages, direction, allowBoth=false) {
  for(const pkg of packages) {
    const root=join(home,pkg.path); let current;
    try { current=await tree(home,root,pkg.path,{allowEmpty:true}); }
    catch(e) { if(e.code==='ENOENT') current={files:[],directories:[]}; else throw e; }
    const manifest={files:current.files.map(f=>({path:f.path,mode:f.afterMode,sha256:f.sha256})),directories:current.directories};
    const expected=direction==='after'?pkg.after:pkg.before, other=direction==='after'?pkg.before:pkg.after;
    const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    if(same(manifest,expected)||allowBoth&&same(manifest,other)) continue;
    if(!allowBoth) throw new Error('Skill package changed since the copy; refusing to overwrite: '+pkg.path);
    const beforeFiles=new Map(pkg.before.files.map(f=>[f.path,f])), afterFiles=new Map(pkg.after.files.map(f=>[f.path,f]));
    const allowed=new Set([...beforeFiles.keys(),...afterFiles.keys()]);
    if(manifest.files.some(f=>!allowed.has(f.path))||[...allowed].some(path=>{
      const actual=manifest.files.find(x=>x.path===path), before=beforeFiles.get(path), after=afterFiles.get(path);
      if(before&&after&&!actual) return true;
      return actual && ![before,after].filter(Boolean).some(x=>x.sha256===actual.sha256&&x.mode===actual.mode);
    })) throw new Error('Skill package contains unplanned changes; refusing to overwrite: '+pkg.path);
    const beforeDirs=new Map(pkg.before.directories.map(d=>[d.path,d.mode])), afterDirs=new Map(pkg.after.directories.map(d=>[d.path,d.mode]));
    if(manifest.directories.some(d=>!beforeDirs.has(d.path)&&!afterDirs.has(d.path))||[...new Set([...beforeDirs.keys(),...afterDirs.keys()])].some(path=>{
      const actual=manifest.directories.find(d=>d.path===path), before=beforeDirs.get(path), after=afterDirs.get(path);
      if(Number.isInteger(before)&&Number.isInteger(after)&&!actual) return true;
      return actual&&! [before,after].filter(Number.isInteger).includes(actual.mode);
    }))
      throw new Error('Skill package directories contain unplanned changes; refusing to overwrite: '+pkg.path);
  }
}
export async function applyAdvancedPackageDirectories(home, packages, undo=false) {
  for(const pkg of packages) {
    if(typeof pkg?.path!=='string'||!/^skills\/[A-Za-z0-9_-]+$/.test(pkg.path)) throw new Error('Invalid skill package directory operation');
    const dirs=undo?pkg.before.directories:pkg.after.directories;
    for(const d of [...dirs].sort((a,b)=>a.path.length-b.path.length)) {
      if(typeof d.path!=='string'||!(d.path===pkg.path||d.path.startsWith(pkg.path+'/'))
        ||d.path.split('/').some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9_.-]+$/.test(part))
        ||!inside(home,join(home,d.path))||!Number.isInteger(d.mode)||d.mode<0||d.mode>0o777||(d.mode&0o022)!==0||(d.mode&0o700)!==0o700)
        throw new Error('Unsafe skill package directory operation');
      const path=join(home,d.path); await parentSafe(home,path,{allowMissing:true});
      try { await mkdir(path,{mode:d.mode}); } catch(e) { if(e.code!=='EEXIST') throw e; }
      await ownedDir(path);
      await chmod(path,d.mode);
    }
    const keep=new Set(dirs.map(d=>d.path));
    const all=[...pkg.before.directories,...pkg.after.directories].map(d=>d.path).filter(p=>!keep.has(p));
    for(const rel of [...new Set(all)].sort((a,b)=>b.length-a.length)) {
      if(typeof rel!=='string'||!(rel===pkg.path||rel.startsWith(pkg.path+'/'))
        ||rel.split('/').some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9_.-]+$/.test(part)))
        throw new Error('Unsafe skill package directory removal');
      const path=join(home,rel); if(!inside(home,path)) throw new Error('Skill package directory removal escapes native home');
      await parentSafe(home,path,{allowMissing:true});
      try { await rmdir(path); } catch(e) { if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code)) throw e; }
    }
  }
}
