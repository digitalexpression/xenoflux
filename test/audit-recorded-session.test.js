import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,create} from '../src/profiles.js';
import {prepareNativeHome} from '../test-support/native-home-fixture.js';
import {registerHome} from '../src/homes.js';
import {auditNativeSession} from '../src/audit-session.js';
import {exportAuditReport,readAuditReport} from '../src/audit-store.js';
import {compactAuditTrial} from '../src/audit-statistics.js';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const version='0.163.0-alpha.10.2';
const counter=(input,output)=>({input_tokens:input,output_tokens:output,cached_input_tokens:1,reasoning_output_tokens:1,cache_write_input_tokens:0,total_tokens:input+output});
const rec=(type,payload)=>({type,payload});
function rows(thread=id(1),parent=null){
 const turn=id(parent?4:2), second=id(3),usage=counter(20,3),usage2=counter(7,2);
 const start=[rec('session_meta',{id:thread,session_id:id(1),cli_version:version,
  ...(parent?{parent_thread_id:parent,source:{subagent:{thread_spawn:{parent_thread_id:parent}}}}:{})}),
  rec('turn_context',{turn_id:turn,cwd:'/fixture',model:'fixture'}),
  rec('token_usage_record',{thread_id:thread,session_id:id(1),turn_id:turn,root_turn_id:parent?id(2):turn,response_id:'resp-private-response-identity',
   usage,turn_token_usage:usage,thread_token_usage:{...counter(120,13),cached_input_tokens:2,reasoning_output_tokens:2},raw_response:'PRIVATE_BODY'}),
  rec('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:'PRIVATE_FINAL'})];
 if(parent)return start;
 return [...start,rec('turn_context',{turn_id:second,cwd:'/fixture',model:'fixture'}),
  rec('token_usage_record',{thread_id:thread,session_id:id(1),turn_id:second,root_turn_id:second,response_id:'resp-second',
   usage:usage2,turn_token_usage:usage2,thread_token_usage:{...counter(127,15),cached_input_tokens:3,reasoning_output_tokens:3}}),
  rec('event_msg',{type:'task_complete',turn_id:second})];
}
async function fixture(t,sourceRows,{child=false}={}){
 const root=await mkdtemp(join(tmpdir(),'xfx-recorded-session-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const executable=join(root,'never-executed');await writeFile(executable,'#!/bin/sh\nexit 99\n',{mode:0o700});
 const native=await prepareNativeHome({directory:join(root,'native'),executable,codexVersion:version});
 const store=new Store(join(root,'controller'));await store.update(data=>create(data,'Fixture'));
 await registerHome(store,'Fixture',native.root,{executable,version});
 await mkdir(join(native.home,'sessions'),{mode:0o700});
 const rollout=join(native.home,'sessions','root.jsonl');
 await writeFile(rollout,sourceRows.map(JSON.stringify).join('\n')+'\n',{mode:0o600});
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(native.home,'state_5.sqlite'));
 db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, rollout_path TEXT, source TEXT)');
 const insert=db.prepare('INSERT INTO threads VALUES (?, ?, ?, 1, 1, 0, ?, ?)');
 insert.run(id(1),'/fixture','fixture',rollout,'{}');
 if(child){const path=join(native.home,'sessions','child.jsonl');await writeFile(path,rows(id(5),id(1)).map(JSON.stringify).join('\n')+'\n',{mode:0o600});
 insert.run(id(5),'/fixture','child',path,JSON.stringify({subagent:{thread_spawn:{parent_thread_id:id(1)}}}));}
 db.close();return {root,store,rollout};
}

test('historical import retains exact response usage separately from a nonzero resumed prefix and freezes it',async t=>{
 const f=await fixture(t,rows(),{child:true});const before=await readFile(f.rollout);
 const report=await auditNativeSession(f.store,'Fixture',id(1));
 const recorded=report.usage.recorded;
 assert.equal(recorded.status,'complete',JSON.stringify(recorded));
 assert.equal(recorded.threads.length,2);
 assert.equal(recorded.threads[0].baseline.totalTokens,110);
 assert.equal(recorded.threads[0].values.totalTokens,32);
 assert.equal(recorded.values.totalTokens,55);
 assert.equal(recorded.threads[0].turns[1].values.totalTokens,9);
 assert.equal(report.coverage.agents,'partial');
 assert.equal(report.usage.workflow,undefined,'recorded selected-thread usage does not imply fresh workflow totals');
 assert.doesNotMatch(JSON.stringify(recorded),/PRIVATE_BODY|PRIVATE_FINAL|resp-private-response-identity/);
 assert.deepEqual(await readFile(f.rollout),before);
 for(const format of ['json','markdown']){const output=join(f.root,`frozen.${format==='json'?'json':'md'}`);
  const exported=await exportAuditReport(report,{output,format});
  assert.deepEqual((await readAuditReport(exported.evidencePath)).usage.recorded,recorded);}
 assert.deepEqual(compactAuditTrial({runs:[report]}).runs[0].usage.recorded,recorded);
});

test('historical accounting rejects incomplete or conflicting records and does not upgrade legacy token_count',async t=>{
 const changes=[
  ['terminal missing',r=>r.pop()],
  ['duplicate response',r=>{r[5].payload.response_id=r[2].payload.response_id;}],
  ['thread counter conflict',r=>{r[5].payload.thread_token_usage.total_tokens++;}],
  ['foreign response',r=>{r[2].payload.thread_id=id(99);}],
  ['missing explicit response fields',r=>{delete r[2].payload.thread_token_usage;}],
  ['malformed usage turn cannot be silently skipped',r=>{r.splice(3,0,rec('token_usage_record',{
    ...r[2].payload,turn_id:'malformed',response_id:'unattributed-response'}));}],
 ];
 for(const [label,change] of changes)await t.test(label,async sub=>{const r=rows();change(r);const f=await fixture(sub,r);
  const report=await auditNativeSession(f.store,'Fixture',id(1));assert.notEqual(report.usage.recorded.status,'complete',label);
  assert.equal(report.usage.recorded.values.totalTokens,null);});
 const legacy=rows();legacy[0].payload.cli_version='0.157.1';const f=await fixture(t,legacy);
 assert.equal((await auditNativeSession(f.store,'Fixture',id(1))).usage.recorded,undefined);
});
