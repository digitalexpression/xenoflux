import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../src/profiles.js';
import {createEngineProvider} from '../src/ui-engine.js';
import {startUiServer} from '../src/ui-server.js';
const left='11111111-1111-4111-8111-111111111111',right='22222222-2222-4222-8222-222222222222';
const pair=()=>({left:{sessionId:left},right:{sessionId:right}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function journal({sessionId,directory}){
  const events=[{id:'native-start',type:'session.start',timestamp:'2026-11-10T00:00:00.000Z',data:{sessionId}},
    {id:'native-user',type:'user.message',timestamp:'2026-11-10T00:00:01.000Z',data:{content:'PUBLIC COPILOT QUESTION',transformedContent:'PRIVATE_CANARY_TRANSFORMED'}},
    {id:'native-assistant',type:'assistant.message',timestamp:'2026-11-10T00:00:02.000Z',data:{content:'PUBLIC COPILOT ANSWER',reasoningText:'PRIVATE_CANARY_REASONING',encryptedContent:'PRIVATE_CANARY_ENCRYPTED'}}];
  const bytes=Buffer.from(JSON.stringify({events,cursor:'opaque-cursor',hasMore:false,cursorStatus:'ok'})+'\n'),file='raw-page-01.json';
  await writeFile(join(directory,file),bytes,{mode:0o600,flag:'wx'});
  return {complete:true,runtime:{version:'fixture-new-version',protocolVersion:3},pages:[{file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}],shutdown:{sdkStopJoined:true,childrenClosed:true}};
}
async function fixture(t,options={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'xfx-ui-copilot-import-'))),store=new Store(join(root,'store')),calls=[];
 const provider=createEngineProvider({store,defaultUserHome:join(root,'unused'),reportsRoot:join(root,'reports'),resolveClient:async()=>assert.fail('Import cannot resolve an execution profile'),runContext:{capture:async()=>assert.fail('No model task')},reviewContext:{capture:async()=>assert.fail('No review task')},...options,copilotImportContext:{readJournal:async input=>{calls.push(input.sessionId);return (options.readJournal??journal)(input);}}});
 t.after(async()=>{await provider.close();await rm(root,{recursive:true,force:true});});return {root,store,provider,calls,imports:join(store.directory,'ui-imports')};
}
test('Copilot import HTTP authenticates before any read, validates both IDs and retains public frozen evidence',async t=>{
 const f=await fixture(t),site=join(f.root,'site');await mkdir(site);await writeFile(join(site,'index.html'),'<title>fixture</title>');const server=await startUiServer({provider:f.provider,staticRoot:site,launchToken:'copilot-import-fixture-token'});t.after(()=>server.close());
 const headers={origin:server.origin,'content-type':'application/json','x-xenoflux-request':'1'},post=(path,body,cookie)=>fetch(server.origin+path,{method:'POST',headers:{...headers,...(cookie?{cookie}:{})},body:JSON.stringify(body)});
 assert.equal((await post('/api/reports/import/copilot',pair())).status,401);assert.deepEqual(f.calls,[]);
 const login=await post('/api/session',{token:'copilot-import-fixture-token'}),cookie=login.headers.get('set-cookie').split(';')[0];
 for(const invalid of [{left:{sessionId:left}}, {left:{sessionId:left},right:{sessionId:'ghapp://sessions/id'}}, {left:{sessionId:left},right:{sessionId:right,cliPath:'/untrusted'}}])assert.equal((await post('/api/reports/import/copilot',invalid,cookie)).status,422);
 assert.deepEqual(f.calls,[]);const response=await post('/api/reports/import/copilot',pair(),cookie);assert.equal(response.status,200);const summary=await response.json();assert.equal(summary.origin,'copilot-import');assert.deepEqual(f.calls,[left,right]);
 const report=await f.provider.report({ref:summary.ref});assert.equal(report.a.profile,'Imported Copilot (left)');assert.ok(JSON.stringify(report).includes('PUBLIC COPILOT ANSWER'));assert.ok(!JSON.stringify(report).includes('PRIVATE_CANARY'));
 const receipt=await f.provider.exportReport({ref:summary.ref}),path=join(receipt.folder,receipt.files.find(n=>n.endsWith('.audit.json'))),text=await readFile(path,'utf8');assert.ok(!text.includes('PRIVATE_CANARY'));
 await rm(f.imports,{recursive:true});const reopened=await f.provider.openReport({fileName:'saved.audit.json',text});assert.match(reopened.ref,/^f\./);assert.deepEqual(f.calls,[left,right],'Reopening never reads current native history');
});
test('second Copilot read failure rolls back only new artifacts and releases admission',async t=>{
 let failed=false;const f=await fixture(t,{maxActiveJobs:1,readJournal:async input=>{if(input.sessionId===right&&!failed){failed=true;throw Error('PRIVATE_CANARY_SERVER_ERROR');}return journal(input);}});
 await mkdir(f.imports,{recursive:true,mode:0o700});const caller=join(f.imports,'unrelated');await mkdir(caller);await writeFile(join(caller,'keep'),'UNCHANGED');
 await assert.rejects(f.provider.importCopilotComparison(pair()),e=>e.code==='invalid-copilot-import'&&!e.message.includes('PRIVATE_CANARY'));assert.deepEqual(await readdir(f.imports),['unrelated']);assert.equal(await readFile(join(caller,'keep'),'utf8'),'UNCHANGED');assert.equal((await f.provider.importCopilotComparison(pair())).origin,'copilot-import');
});
test('Copilot imports share capacity and controller shutdown joins admitted reads',async t=>{
 const entered=deferred(),proceed=deferred();let held=false;const f=await fixture(t,{maxActiveJobs:1,readJournal:async input=>{if(!held){held=true;entered.resolve();await proceed.promise;}return journal(input);}});let pending,closing;
 try{pending=f.provider.importCopilotComparison(pair());await entered.promise;await assert.rejects(f.provider.importCopilotComparison(pair()),{status:409,code:'job-capacity'});let closed=false;closing=f.provider.close().then(()=>{closed=true;});await assert.rejects(f.provider.importCopilotComparison(pair()),{status:409,code:'stopping'});assert.equal(closed,false);proceed.resolve();assert.equal((await pending).origin,'copilot-import');await closing;assert.equal(closed,true);assert.deepEqual(f.calls,[left,right]);}finally{proceed.resolve();await pending?.catch(()=>{});await closing?.catch(()=>{});}
});
