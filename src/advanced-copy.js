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
async function tree(root, sourcePath, destination) {
  if (!inside(root, sourcePath) || !validRel(destination)) throw new Error('Invalid advanced-copy item path');
  const out = [];
  let total = 0, entries = 0;
  async function walk(src, dst, depth) {
    if (depth > 12 || out.length >= MAX_FILES) throw new Error('Advanced-copy package exceeds entry or depth limit');
    const s = await lstat(src);
    if (s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o022) || (s.mode & 0o7000)) throw new Error('Unsafe advanced-copy package entry: ' + src);
    if (s.isDirectory()) {
      if (++entries > MAX_FILES) throw new Error('Advanced-copy package exceeds entry limit');
      if (await realpath(src) !== src) throw new Error('Non-canonical advanced-copy directory');
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
  if (!out.length) throw new Error('Cannot copy an empty skill package');
  return out;
}
async function resolveSelection(store, source, selection, defaultUserHome) {
  if (!Array.isArray(selection) || !selection.length || selection.some(x => typeof x !== 'string') || new Set(selection).size !== selection.length)
    throw new Error('Choose one or more inventoried item IDs');
  const inventory = await inspectProfile(store, source, { defaultUserHome, includeProjects: false });
  const byId = new Map(inventory.items.map(x => [x.id, x]));
  const items = selection.map(id => {
    const item = byId.get(id);
    if (!item || item.copyable !== true || !item.transfer) throw new Error('Selected item is no longer available or copyable; refresh the inventory');
    if (!['config','instruction','agent','skill','rule'].includes(item.transfer.kind)) throw new Error('Unsupported selected item');
    return item;
  });
  return { inventory, items };
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
    previews.push({id:item.id,label:item.label,status:'new',changes:payload.kind==='config'?[{path:'config.toml:'+payload.key,action:'new',after:previewValue(payload.value)}]:files.map(f=>({path:f.path,action:'add',after:preview(f.after,f.path)}))});
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
    if (typeof key !== 'string' || !/^(?:[A-Za-z_][\w-]*|agents\.[A-Za-z_][\w-]*|features\.multi_agent)$/.test(key)) throw new Error('Unsupported config key');
    const value = key.includes('.') ? key.split('.').reduce((o,k) => o?.[k], config) : config[key];
    if (!['string','number','boolean'].includes(typeof value) && !(Array.isArray(value) && value.every(x => typeof x === 'string'))) throw new Error('Unsupported selected config value');
    if (JSON.stringify(redactValue(value, key)) !== JSON.stringify(value)) throw new Error('Credential-like content in selected setting; copy refused: '+t.path+':'+key);
    return { kind:'config', key, value, sourcePath:expected };
  }
  if (t.kind === 'skill') return { kind:'tree', files:await tree(expectedRoot, expected, t.path) };
  const f = await readSafe(expected, { text: true }); if (!f) throw new Error('Selected source file is missing');
  if(redactText(f.content,expected)!==f.content) throw new Error('Credential-like content in selected settings; copy refused: '+t.path);
  return { kind:'file', file:{ path:t.path, after:f.data, afterMode:f.mode, sha256:sha(f.data) } };
}
function getKey(object,key) { return key.split('.').reduce((v,k) => v?.[k],object); }
function setKey(object,key,value) { const parts=key.split('.'); let node=object; for(const part of parts.slice(0,-1)) { node[part] ??=Object.create(null); node=node[part]; } node[parts.at(-1)]=value; }
function preview(data,path) {
  if (data === null) return null;
  try { const value=redactText(new TextDecoder('utf-8',{fatal:true}).decode(data),path); return value.length>220?value.slice(0,217)+'...':value; }
  catch { return `[binary ${data.length} bytes sha256:${sha(data).slice(0,16)}]`; }
}

/** Build item-granular operations and a redacted UI report. */
export async function buildAdvancedCopy(store, source, target, selection, { defaultUserHome = homedir() } = {}) {
  const { inventory, items } = await resolveSelection(store, source, selection, defaultUserHome);
  const sourceEndpoint = await resolveNativeSettingsHome(store, source, { defaultUserHome });
  const targetEndpoint = await resolveNativeSettingsHome(store, target, { defaultUserHome });
  const payloads = [];
  const configItems = items.filter(x => x.transfer.kind === 'config');
  if (configItems.length) {
    if(new Set(configItems.map(x=>x.transfer.key)).size!==configItems.length) throw new Error('Selected config keys collide at the destination');
    const targetPath = join(targetEndpoint.home,'config.toml');
    await parentSafe(targetEndpoint.home,targetPath);
    const current = await readSafe(targetPath,{text:true}); if (!current) throw new Error('Destination configuration is missing');
    const sourceValues = new Map();
    for(const item of configItems) sourceValues.set(item.id,(await sourcePayload(item,inventory.profile.home,defaultUserHome,sourceEndpoint)).value);
    const beforeObj = parse(current.content), afterObj = parse(current.content);
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
  const retainedByItem=new Map();
  for (const item of items.filter(x => x.transfer.kind !== 'config')) {
    const value = await sourcePayload(item,inventory.profile.home,defaultUserHome,sourceEndpoint);
    const files = value.kind === 'tree' ? value.files : [value.file];
    if(value.kind==='tree') {
      const destRoot=join(targetEndpoint.home,item.transfer.path);
      try {
        const st=await lstat(destRoot);
        if(st.isSymbolicLink()||!st.isDirectory()) throw new Error('Unsafe existing skill destination');
        const existing=await tree(targetEndpoint.home,destRoot,item.transfer.path);
        const selectedPaths=new Set(files.map(f=>f.path));
        retainedByItem.set(item.id,existing.filter(f=>!selectedPaths.has(f.path)).map(f=>({path:f.path,action:'retain',before:preview(f.after,f.path),after:preview(f.after,f.path)})));
      } catch(e) { if(e.code!=='ENOENT') throw e; }
    }
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
    if(item.transfer.kind==='config') return {id:item.id,label:item.label,status:item._status,changes:[{path:'config.toml:'+item.transfer.key,action:item._status,before:previewValue(item._before),after:previewValue(item._after)}]};
    const prefix = item.transfer.path;
    const changes = payloads.filter(f => item.transfer.kind === 'config' ? f.path === 'config.toml' : f.path === prefix || f.path.startsWith(prefix + '/'));
    const identical = changes.length > 0 && changes.every(f => f.before && f.before.equals(f.after) && f.beforeMode === f.afterMode);
    const conflict = changes.some(f => f.before && (!f.before.equals(f.after) || f.beforeMode !== f.afterMode));
    return {id:item.id,label:item.label,status:identical?'identical':conflict?'conflict':'new',changes:[...changes.map(f=>({path:f.path,action:f.before===null?'add':f.before.equals(f.after)&&f.beforeMode===f.afterMode?'identical':'replace',before:preview(f.before,f.path),after:preview(f.after,f.path)})),...(retainedByItem.get(item.id)??[])]};
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
  const plan={source:sourceEndpoint,target:targetEndpoint,selection:items.map(x=>x.id),files:payloads,createdDirectories:[...new Set(createdDirectories)]};
  const hash=createHash('sha256').update(JSON.stringify({source:plan.source,target:plan.target,selection:plan.selection,createdDirectories:plan.createdDirectories,files:payloads.map(f=>({path:f.path,before:f.before&&sha(f.before),beforeMode:f.beforeMode,after:sha(f.after),afterMode:f.afterMode}))})).digest('hex');
  return {plan,report:{status:'preview',hash,source:inventory.profile,target:{name:targetEndpoint.name,home:targetEndpoint.home},items:reports,changes:payloads.map(f=>({path:f.path,action:f.before===null?'add':f.before.equals(f.after)?'identical':'replace',beforeSha256:f.before&&sha(f.before),afterSha256:sha(f.after)})),notes:['Selected standalone skills add or replace source files; destination-only package files are retained.',...(configItems.some(i=>i._enforcedSymlink)?['Config copy enables the required allow_symlinked_codex_home flag.']:[])]}};
}
function previewValue(value) { if(value===undefined)return null; let text=typeof value==='string'?value:JSON.stringify(value); text=redactText(text,'preview'); return text.length>220?text.slice(0,217)+'...':text; }

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
  const data=undo?(f.before?await getPayload(dir,f.before):null):await getPayload(dir,f.after);
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
  let total=0; const out=[];
  for(let i=0;i<files.length;i++) {
    const f=files[i]; safeDestinationPath(f.path);
    const validMode=n=>Number.isInteger(n)&&n>=0&&n<=0o777&&(n&0o022)===0;
    if(!Buffer.isBuffer(f.after)||f.after.length>MAX_FILE||(f.before!==null&&!Buffer.isBuffer(f.before))
      ||!validMode(f.afterMode)||(f.before!==null&&!validMode(f.beforeMode))||(f.before===null&&f.beforeMode!==null)) throw new Error('Invalid advanced-copy file data');
    total+=f.after.length+(f.before?.length??0); if(total>MAX_TOTAL) throw new Error('Advanced-copy payload exceeds size limit');
    const before=f.before?await putPayload(dir,`${i}-before`,f.before):null;
    const after=await putPayload(dir,`${i}-after`,f.after);
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
    if(!f.after||!Number.isInteger(f.afterMode)||f.afterMode<0||f.afterMode>0o777||(f.afterMode&0o022)!==0||f.beforeMode!==null&&(!Number.isInteger(f.beforeMode)||f.beforeMode<0||f.beforeMode>0o777||(f.beforeMode&0o022)!==0)) throw new Error('Invalid advanced-copy file mode');
    const before=f.before?await getPayload(dir,f.before):null, after=await getPayload(dir,f.after);
    total+=(before?.length??0)+after.length; if(total>MAX_TOTAL) throw new Error('Advanced-copy journal exceeds size limit');
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
