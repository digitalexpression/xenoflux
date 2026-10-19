import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, stat, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAuditCapture } from '../src/audit-capture.js';
import { parseLiteralSkillRead } from '../src/audit-skill-read.js';

const serverScript = `
let buffer = '';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const readCommand = __READ_COMMAND__;
const instructionFault = __INSTRUCTION_FAULT__;
let loadedCalls = 0;
const skills = [
  { name:'same', description:'private description', enabled:true, path:'/Users/test/.codex/skills/same/SKILL.md', scope:'user' },
  { name:'same', description:'profile-local description', enabled:true, path:'/tmp/profile/skills/same/SKILL.md', scope:'user' },
  { name:'same', description:'duplicate plugin description', enabled:true, path:'/cache/plugin/skills/same/SKILL.md', scope:'user', pluginId:'provider.duplicate' },
  { name:'repo-skill', description:'private repo description', enabled:true, path:'/repo/.agents/skills/repo-skill/SKILL.md', scope:'repo' },
  { name:'system-skill', description:'system description', enabled:true, path:'/Users/test/.codex/skills/.system/system-skill/SKILL.md', scope:'system' },
  { name:'admin-skill', description:'admin description', enabled:true, path:'/etc/codex/skills/admin-skill/SKILL.md', scope:'admin' },
  { name:'plug:skill', description:'plugin description', enabled:true, path:'/cache/plugin/skills/plug/SKILL.md', scope:'user', pluginId:'provider.plugin' }
];
function respond(msg) {
  const {id,method,params={}}=msg;
  const onlyKeys = allowed => Object.keys(params).every(k=>allowed.includes(k));
  if (method==='initialize') {
    if (!onlyKeys(['clientInfo','capabilities']) || params.clientInfo?.name!=='xfx-audit') return send({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid initialize params'}});
    return send({jsonrpc:'2.0',id,result:{serverInfo:{name:'fixture',version:'2'}}});
  }
  if (method==='skills/list') {
    if (!onlyKeys(['cwds','forceReload']) || !Array.isArray(params.cwds)) return send({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid skills/list params'}});
    const cwd=params.cwds?.[0] ?? '/repo';
    const catalog=cwd.endsWith('/grandchild') ? skills.filter(s=>s.scope!=='repo').concat({name:'grandchild-skill',description:'grandchild private text',enabled:true,path:cwd+'/.agents/skills/grandchild-skill/SKILL.md',scope:'repo'})
      : cwd.endsWith('/child') ? skills.filter(s=>s.scope!=='repo').concat({name:'child-skill',description:'child only private text',enabled:true,path:cwd+'/.agents/skills/child-skill/SKILL.md',scope:'repo'}) : skills;
    return send({jsonrpc:'2.0',id,result:{data:[{cwd,skills:catalog,errors:[]}]}});
  }
  if (method==='thread/start') {
    if (!onlyKeys(['ephemeral','experimentalRawEvents','sandbox','approvalPolicy','historyMode']) || !['workspace-write','read-only','danger-full-access'].includes(params.sandbox)
      || params.ephemeral!==false || params.historyMode!=='paginated') return send({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid thread sandbox/history'}});
    return send({jsonrpc:'2.0',id,result:{cwd:'/repo',thread:{id:'root-thread',sessionId:'session-root',cwd:'/repo'},instructionSources:__ROOT_INSTRUCTION_SOURCES__}});
  }
  if (method==='turn/start') {
    const policy = params.sandboxPolicy;
    if (!onlyKeys(['threadId','cwd','sandboxPolicy','approvalPolicy','input']) || !policy || params.sandbox !== undefined || !params.input.some(x=>x.type==='text')
      || (policy.type==='workspaceWrite' && (!Array.isArray(policy.writableRoots) || policy.networkAccess!==false))
      || (policy.type==='readOnly' && policy.networkAccess!==false)
      || !['workspaceWrite','readOnly','dangerFullAccess'].includes(policy.type)) return send({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid turn params'}});
    if (__STALL_TURN_START__) return;
    send({jsonrpc:'2.0',id,result:{turn:{id:'root-turn',status:'inProgress'}}});
    send({jsonrpc:'2.0',method:'turn/started',params:{threadId:'root-thread',turn:{id:'root-turn',status:'inProgress'}}});
    send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'root-thread',turnId:'root-turn',completedAtMs:900,item:{id:'read-skill',type:'commandExecution',command:readCommand,commandActions:[{type:'read',path:'.agents/skills/repo-skill/SKILL.md'}],cwd:'/repo',status:'completed',exitCode:0,aggregatedOutput:'PRIVATE TOOL OUTPUT'}}});
    __PROFILE_READ__
    __FILE_CHANGES__
    send({jsonrpc:'2.0',method:'thread/tokenUsage/updated',params:{threadId:'root-thread',turnId:'root-turn',tokenUsage:{last:{inputTokens:5,outputTokens:2,cachedInputTokens:1,reasoningOutputTokens:0,totalTokens:7},total:{inputTokens:5,outputTokens:2,cachedInputTokens:1,reasoningOutputTokens:0,totalTokens:7}}}});
    __EARLY_THREAD_LINKS__
    __ROOT_LINK_EVENT__
    __UNKNOWN_EVENT__
    __TOOL_EVENTS__
    send({jsonrpc:'2.0',method:'turn/started',params:{threadId:'child-thread',turn:{id:'child-turn',status:'inProgress'}}});
    send({jsonrpc:'2.0',method:'thread/tokenUsage/updated',params:{threadId:'child-thread',turnId:'child-turn',tokenUsage:{last:{inputTokens:1,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0,totalTokens:2},total:{inputTokens:1,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0,totalTokens:2}}}});
    __CHILD_ITEM_EVENT__
    __PROFILE_CHILD_READ__
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'child-thread',turn:{id:'child-turn',status:'completed'}}});
    __INSTRUCTION_STREAM_EVENTS__
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'root-thread',turn:{id:'root-turn',status:'completed'}}});
    return;
  }
  if (method==='thread/read') {
    if (!onlyKeys(['threadId','includeTurns']) || params.includeTurns!==false) return send({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid thread/read params'}});
    if(__FAIL_CHILD_READ__ && params.threadId==='child-thread') return send({jsonrpc:'2.0',id,error:{code:-32000,message:'private thread detail'}});
    const parent=params.threadId==='grandchild-thread' ? __GRANDCHILD_PARENT__ : params.threadId==='foreign-thread' ? 'foreign-parent' : __CHILD_PARENT__;
    const cwd=params.threadId==='grandchild-thread' ? '/repo/child/grandchild' : params.threadId==='foreign-thread' ? '/repo/foreign' : '/repo/child';
    const status=params.threadId==='grandchild-thread' ? {type:'idle'} : __CHILD_STATUS__;
    return send({jsonrpc:'2.0',id,result:{thread:{id:params.threadId,parentThreadId:parent,sessionId:'session-root',cwd,status,path:'/repo/'+params.threadId+'.jsonl'}}});
  }
  if (method==='thread/loaded/list') {
    if (!onlyKeys(['limit','cursor']) || !Number.isInteger(params.limit)) return send({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid loaded-list params'}});
    loadedCalls++;
    const ids = instructionFault==='unloaded' || instructionFault==='lost-after' && loadedCalls>1 ? ['root-thread']
      : ['root-thread','child-thread',...(__GRANDCHILD_LINK__ ? ['grandchild-thread'] : [])];
    return send({jsonrpc:'2.0',id,result:{data:instructionFault==='bad-loaded-list' ? [{}] : ids,nextCursor:null}});
  }
  if (method==='thread/resume') {
    if (!onlyKeys(['threadId','excludeTurns']) || params.excludeTurns!==true || !['child-thread','grandchild-thread'].includes(params.threadId))
      return send({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid owned snapshot request'}});
    const grand = params.threadId==='grandchild-thread', cwd=grand ? '/repo/child/grandchild' : '/repo/child';
    const thread={id:params.threadId,parentThreadId:instructionFault==='wrong-parent' ? 'foreign-parent' : grand ? 'child-thread' : 'root-thread',
      sessionId:instructionFault==='wrong-session' ? 'foreign-session' : 'session-root',cwd,
      status:{type:instructionFault==='active-status' ? 'active' : 'idle'},path:instructionFault==='wrong-path' ? '/foreign.jsonl' : '/repo/'+params.threadId+'.jsonl'};
    return send({jsonrpc:'2.0',id,result:{cwd:instructionFault==='wrong-cwd' ? '/foreign' : cwd,thread,
      instructionSources:instructionFault==='missing-field' ? undefined : [cwd+'/AGENTS.md']}});
  }
  if (method==='thread/items/list') {
    if (!onlyKeys(['threadId','cursor','limit']) || !Number.isInteger(params.limit)) return send({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid thread/items/list params'}});
    if (params.threadId==='child-thread' && __CHILD_ITEMS_UNSUPPORTED__) return send({jsonrpc:'2.0',id,error:{code:-32601,message:'PRIVATE_UNSUPPORTED_DETAIL'}});
    if (params.threadId==='child-thread' && __CHILD_ITEMS_FAILURE__) return send({jsonrpc:'2.0',id,error:{code:-32602,message:'PRIVATE_OTHER_ERROR'}});
    if(params.threadId==='grandchild-thread') return send({jsonrpc:'2.0',id,result:{data:[],nextCursor:null}});
    if(__GRANDCHILD_LINK__) return send({jsonrpc:'2.0',id,result:{data:[{turnId:'child-turn',startedAtMs:1,completedAtMs:2,item:{id:'child-grandchild-link',type:'collabAgentToolCall',receiverThreadIds:['grandchild-thread'],prompt:'private grandchild instructions'}}],nextCursor:null}});
    return send({jsonrpc:'2.0',id,result:{data:[{turnId:'child-turn',startedAtMs:1,completedAtMs:2,item:{id:'child-item',type:'commandExecution',
      command:'cat .agents/skills/child-skill/SKILL.md',commandActions:[{type:'read',path:'.agents/skills/child-skill/SKILL.md'}],cwd:'/repo/child',status:'completed',exitCode:0,aggregatedOutput:'private code output'}}],nextCursor:null}});
  }
  if (method==='thread/turns/list') {
    if (!onlyKeys(['threadId','itemsView','sortDirection','cursor','limit']) || params.itemsView!=='full' || params.sortDirection!=='asc' || !Number.isInteger(params.limit))
      return send({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid thread/turns/list params'}});
    if(params.threadId==='grandchild-thread') return send({jsonrpc:'2.0',id,result:{data:[],nextCursor:null}});
    if (__TURNS_PAGE_MODE__==='missing-data') return send({jsonrpc:'2.0',id,result:{nextCursor:null}});
    if (__TURNS_PAGE_MODE__==='non-array') return send({jsonrpc:'2.0',id,result:{data:{turn:'malformed'},nextCursor:null}});
    const itemsView=__TURN_ITEMS_VIEW__;
    const item=__GRANDCHILD_LINK__ ? {id:'child-grandchild-link',type:'collabAgentToolCall',receiverThreadIds:['grandchild-thread'],prompt:'private grandchild instructions'}
      : {id:'child-item',type:'commandExecution',command:'cat .agents/skills/child-skill/SKILL.md',commandActions:[{type:'read',path:'.agents/skills/child-skill/SKILL.md'}],cwd:'/repo/child',status:'completed',exitCode:0,aggregatedOutput:'private code output'};
    const items=__TURNS_PAGE_MODE__==='bad-item'?[null,item]:[item];
    const turn={id:'child-turn',status:'completed',startedAt:1,completedAt:2,items,...(itemsView==='missing'?{}:{itemsView})};
    return send({jsonrpc:'2.0',id,result:{data:[turn],nextCursor:null}});
  }
  send({jsonrpc:'2.0',id,error:{code:-32601,message:'private server detail'}});
}
process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const i=buffer.indexOf('\\n'); const line=buffer.slice(0,i); buffer=buffer.slice(i+1); if(line) respond(JSON.parse(line)); } });
process.stdin.on('end', () => process.exit(0));
`;

async function fixture(t, { command = 'cat .agents/skills/repo-skill/SKILL.md', wrongParent = false, completionDelayMs = 0,
  terminalStatus = 'completed', earlyCompletion = false, emitSkillRead = true, emitChildItem = false, childNextCursor = false,
  stallTurnStart = false, emitFileChanges = false, emitUnknownMethod = false, childStatus = 'idle', emitProfileRead = false, emitProfileChildRead = false,
  emitToolEvents = false, grandchildLink = false, wrongGrandchildParent = false, failChildRead = false,
  emitCollabLink = true, emitSubAgentActivity = false, earlyThreadLinks = false, fileUriCatalog = false, emitErrorNotification = false,
  childItemsUnsupported = false, childItemsFailureCode = null, turnsItemsView = 'full', turnsPageMode = 'normal',
  nativeInstructionSources = false, instructionFault = null, nativeEvents = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-audit-capture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rootTerminalSource = "send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'root-thread',turn:{id:'root-turn',status:'completed'}}});";
  const rootTerminal = `send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'root-thread',turn:{id:'root-turn',status:'${terminalStatus}'}}});`;
  const terminalAction = completionDelayMs ? `setTimeout(()=>${rootTerminal},${completionDelayMs});` : rootTerminal;
  const skillRead = "send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'root-thread',turnId:'root-turn',completedAtMs:900,item:{id:'read-skill',type:'commandExecution',command:readCommand,commandActions:[{type:'read',path:'.agents/skills/repo-skill/SKILL.md'}],cwd:'/repo',status:'completed',exitCode:0,aggregatedOutput:'PRIVATE TOOL OUTPUT'}}});";
  const startResponse = "send({jsonrpc:'2.0',id,result:{turn:{id:'root-turn',status:'inProgress'}}});";
  const rootReadForScript = skillRead.replaceAll("'/repo'", JSON.stringify(dir)).replaceAll('/repo/', `${dir}/`).replace('__READ_COMMAND__', JSON.stringify(command));
  const fileChanges = emitFileChanges ? "const changes=Object.fromEntries(Array.from({length:105},(_,i)=>['/repo/file-'+i,{kind:'modified',diff:'PRIVATE DIFF'}])); send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'root-thread',turnId:'root-turn',item:{id:'many-changes',type:'FileChange',status:'completed',changes}}});" : '';
  const unknownEvent = emitUnknownMethod ? "send({jsonrpc:'2.0',method:'secret.method/private-value',params:{threadId:'root-thread',secret:'PRIVATE_NATIVE_EVENT'}});"
    : emitErrorNotification ? "send({jsonrpc:'2.0',method:'error',params:{threadId:'root-thread',turnId:'root-turn',willRetry:true,error:{message:'PRIVATE_ERROR_MESSAGE',additionalDetails:'PRIVATE_DETAILS',codexErrorInfo:'rateLimitExceeded'}}});" : '';
  let script = serverScript.replaceAll("'/repo'", JSON.stringify(dir)).replaceAll('/repo/', `${dir}/`).replace('__READ_COMMAND__', JSON.stringify(command))
    .replace('__INSTRUCTION_FAULT__', JSON.stringify(instructionFault))
    .replace('__ROOT_INSTRUCTION_SOURCES__', nativeInstructionSources ? JSON.stringify([join(dir, 'AGENTS.md')]) : 'undefined')
    .replace('__INSTRUCTION_STREAM_EVENTS__', nativeInstructionSources && grandchildLink ? `
      send({jsonrpc:'2.0',method:'thread/started',params:{thread:{id:'grandchild-thread',parentThreadId:'child-thread',sessionId:'session-root',cwd:'${dir}/child/grandchild'}}});
      send({jsonrpc:'2.0',method:'turn/started',params:{threadId:'grandchild-thread',turn:{id:'grandchild-turn',status:'inProgress'}}});
      send({jsonrpc:'2.0',method:'thread/tokenUsage/updated',params:{threadId:'grandchild-thread',turnId:'grandchild-turn',tokenUsage:{last:{inputTokens:1,outputTokens:1,totalTokens:2},total:{inputTokens:1,outputTokens:1,totalTokens:2}}}});
      send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'grandchild-thread',turn:{id:'grandchild-turn',status:'completed'}}});
    ` : '')
    .replace('__CHILD_STATUS__', JSON.stringify(childStatus === 'active' ? { type: 'active', activeFlags: [] } : { type: childStatus }))
    .replace('__CHILD_PARENT__', JSON.stringify(wrongParent ? 'unrelated-thread' : 'root-thread'))
    .replace('__GRANDCHILD_PARENT__', JSON.stringify(wrongGrandchildParent ? 'foreign-parent' : 'child-thread'))
    .replaceAll('__GRANDCHILD_LINK__', String(grandchildLink))
    .replace('__FAIL_CHILD_READ__', String(failChildRead))
    .replaceAll('__CHILD_ITEMS_UNSUPPORTED__', String(childItemsUnsupported))
    .replaceAll('__CHILD_ITEMS_FAILURE__', String(childItemsFailureCode !== null))
    .replaceAll('__TURN_ITEMS_VIEW__', turnsItemsView === 'missing' ? "'missing'" : JSON.stringify(turnsItemsView))
    .replaceAll('__TURNS_PAGE_MODE__', JSON.stringify(turnsPageMode))
    .replace('__ROOT_LINK_EVENT__', emitSubAgentActivity
      ? "send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'root-thread',turnId:'root-turn',completedAtMs:1000,item:{id:'subagent-activity',type:'subAgentActivity',agentThreadId:'child-thread',agentPath:'PRIVATE_AGENT_PATH',kind:'started',message:'PRIVATE_AGENT_MESSAGE'}}});"
      : emitCollabLink ? "send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'root-thread',turnId:'root-turn',completedAtMs:1000,item:{id:'collab-1',type:'collabAgentToolCall',receiverThreadIds:['child-thread'],prompt:'DO NOT KEEP THIS PROMPT'}}});" : '')
    .replace('__EARLY_THREAD_LINKS__', earlyThreadLinks ? `
      send({jsonrpc:'2.0',method:'thread/started',params:{thread:{id:'child-thread',parentThreadId:'root-thread',sessionId:'session-root',cwd:'/repo/child'}}});
      send({jsonrpc:'2.0',method:'thread/started',params:{thread:{id:'grandchild-thread',parentThreadId:'child-thread',sessionId:'session-root',cwd:'/repo/child/grandchild'}}});
      send({jsonrpc:'2.0',method:'turn/started',params:{threadId:'grandchild-thread',turn:{id:'grandchild-turn',status:'inProgress'}}});
      send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'grandchild-thread',turn:{id:'grandchild-turn',status:'completed'}}});
      send({jsonrpc:'2.0',method:'thread/started',params:{thread:{id:'foreign-thread',parentThreadId:'root-thread',sessionId:'session-root',cwd:'/repo/foreign'}}});
      send({jsonrpc:'2.0',method:'thread/started',params:{thread:{id:'orphan-thread',parentThreadId:'unobserved-parent',sessionId:'session-root',cwd:'/repo/orphan'}}});
    ` : '')
    .replace('__UNKNOWN_EVENT__', unknownEvent + nativeEvents.map(event => `send(${JSON.stringify(event)});`).join('\n'))
    .replace('__TOOL_EVENTS__', emitToolEvents ? `
      send({jsonrpc:'2.0',method:'item/started',params:{threadId:'root-thread',turnId:'root-turn',startedAtMs:10,item:{id:'mcp-1',type:'mcpToolCall',server:'local',tool:'lookup',arguments:{secret:'PRIVATE_MCP_ARGUMENT'}}}});
      send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'root-thread',turnId:'root-turn',completedAtMs:30,item:{id:'mcp-1',type:'mcpToolCall',status:'completed',server:'local',tool:'lookup',arguments:{secret:'PRIVATE_MCP_ARGUMENT'},result:{secret:'PRIVATE_MCP_RESULT'}}}});
      send({jsonrpc:'2.0',method:'item/started',params:{threadId:'root-thread',turnId:'root-turn',startedAtMs:40,item:{id:'dynamic-1',type:'dynamicToolCall',namespace:'fixture',tool:'search',arguments:{secret:'PRIVATE_DYNAMIC_ARGUMENT'}}}});
      send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'root-thread',turnId:'root-turn',completedAtMs:60,item:{id:'dynamic-1',type:'dynamicToolCall',status:'failed',namespace:'fixture',tool:'search',error:{message:'PRIVATE_DYNAMIC_ERROR'}}}});
      send({jsonrpc:'2.0',method:'mcpServer/startupStatus/updated',params:{threadId:'root-thread',name:'local',status:'ready',error:'PRIVATE_MCP_STARTUP_ERROR'}});
    ` : '')
    .replace('__CHILD_ITEM_EVENT__', emitChildItem ? "send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'child-thread',turnId:'child-turn',completedAtMs:2,item:{id:'child-item',type:'commandExecution',command:'cat .agents/skills/child-skill/SKILL.md',commandActions:[{type:'read',path:'.agents/skills/child-skill/SKILL.md'}],cwd:'/repo/child',status:'completed',exitCode:0,aggregatedOutput:'private code output'}}});" : '')
    .replace('__PROFILE_READ__', emitProfileRead ? "send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'root-thread',turnId:'root-turn',item:{id:'profile-skill-read',type:'commandExecution',command:'cat /tmp/profile/skills/same/SKILL.md',commandActions:[{type:'read',path:'/tmp/profile/skills/same/SKILL.md'}],cwd:'/repo',status:'completed',exitCode:0}}});" : '')
    .replace('__PROFILE_CHILD_READ__', emitProfileChildRead ? "send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'child-thread',turnId:'child-turn',item:{id:'profile-child-skill-read',type:'commandExecution',command:'cat /tmp/profile/skills/same/SKILL.md',commandActions:[{type:'read',path:'/tmp/profile/skills/same/SKILL.md'}],cwd:'/repo/child',status:'completed',exitCode:0}}});" : '')
    .replace('__FILE_CHANGES__', fileChanges)
    .replaceAll('nextCursor:null', `nextCursor:${childNextCursor ? "'next-page'" : 'null'}`)
    .replace(rootTerminalSource, terminalAction)
    .replace('__STALL_TURN_START__', String(stallTurnStart));
  if (fileUriCatalog) script = script.replace('cwd,skills:catalog,errors:[]',
    "cwd,skills:catalog.map(skill=>({...skill,path:'file://'+skill.path})),errors:[]");
  if (!emitSkillRead) script = script.replace(rootReadForScript, '');
  if (earlyCompletion) script = script.replace(startResponse, '').replace(terminalAction, `${terminalAction}${startResponse}`);
  return { dir, script, options: { profile: { profileId: 'fixture-profile', profileName: 'Fixture', home: '/tmp/profile', userHome: '/tmp/user', executable: process.execPath, version: '2.0' },
    workspace: dir, task: 'private task marker', processOptions: { args: ['-e', script], env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5000,
      stdoutPath: join(dir, 'stdout.jsonl'), stderrPath: join(dir, 'stderr.log') } } };
}

test('speaks native app-server protocol and records safe skill inventory, linked agents, events, and per-agent usage', async t => {
  const f = await fixture(t), phases = [], checkpoints = [];
  const { process, run, capture } = await runAuditCapture({ ...f.options, onPhase: phase => phases.push(phase),
    onTaskEnd: state => checkpoints.push({ complete: state.complete, childTerminal: state.run.agents.find(a => a.id === 'child-thread')?.terminal,
      hydrated: state.run.events.some(e => e.kind === 'hydrated:item') }) });
  assert.equal(process.status, 'exited');
  assert.equal(run.status, 'partial');
  assert.deepEqual(phases, ['discovery', 'task', 'capture']);
  assert.deepEqual(run.agents.map(a => [a.id, a.parentId, a.depth]), [['root-thread', null, 0], ['child-thread', 'root-thread', 1]]);
  assert.deepEqual(run.skills.map(s => s.scope), ['user', 'profile', 'user', 'project', 'system', 'admin', 'user', 'project']);
  assert.equal(run.skills.find(s => s.name === 'plug:skill').provider, 'provider.plugin');
  assert.equal(run.skills.find(s => s.name === 'plug:skill').origin, 'plugin');
  assert.equal(run.usage['root-thread'].total.inputTokens, 5);
  assert.equal(run.usage['child-thread'].total.outputTokens, 1);
  assert.deepEqual(run.usage.observations.map(row => [row.agentId, row.turnId, row.mode, row.disposition]), [
    ['root-thread', 'root-turn', 'snapshot', 'accepted'], ['child-thread', 'child-turn', 'snapshot', 'accepted'],
  ]);
  assert.equal(run.usage.observations[0].last.cacheWriteInputTokens, null);
  assert.equal(capture.coverageDetails.usage.byAgent['root-thread'].fields.last.inputTokens.present, 1);
  assert.equal(run.usage.total, null);
  assert.equal(run.events.some(e => e.kind === 'hydrated:item' && e.agentId === 'child-thread'), true);
  assert.equal(run.source.workspace, f.dir);
  assert.equal(new Set(run.turns.map(turn => `${turn.agentId}:${turn.turnId}`)).size, run.turns.length, 'turn/start response and notification describe one turn');
  assert.equal(run.skills.find(s => s.name === 'repo-skill').observations[0].kind, 'definition-read-observed', JSON.stringify(run.skills.find(s => s.name === 'repo-skill').observations));
  assert.equal(run.skills.find(s => s.name === 'repo-skill').catalogs.some(c => c.agentId === 'child-thread'), false);
  assert.equal(run.coverage.skillInventory, 'complete');
  assert.equal(run.coverage.skills, 'partial');
  assert.equal(run.status, 'partial');
    assert.deepEqual(checkpoints, [{ complete: true, childTerminal: true, hydrated: true }]);
  assert.equal(run.skills.some(s => s.name === 'child-skill' && s.catalogs.some(c => c.agentId === 'child-thread')), true);
  assert.equal(run.skills.find(s => s.name === 'repo-skill').catalogs.some(c => c.agentId === 'child-thread'), false);
  assert.equal(run.skills.find(s => s.name === 'child-skill').observations[0].kind, 'definition-read-observed');
  assert.equal(capture.byOrigin.repository, 2);
  assert.equal(capture.byOrigin.plugin, 2);
  assert.equal(capture.byOrigin.profile, 1);
  const report = JSON.stringify({ run, capture });
  for (const forbidden of ['private task marker', 'private description', 'duplicate plugin description', 'DO NOT KEEP', 'private code output', 'private server detail'])
    assert.equal(report.includes(forbidden), false, forbidden);
  assert.equal((await readFile(join(f.dir, 'stdout.jsonl'), 'utf8')).includes('private task marker'), false);
  assert.equal(report.includes('"total":null'), true);
});

test('captures each owned native actor instruction list with its own wire provenance', async t => {
  const f = await fixture(t, { nativeInstructionSources: true, grandchildLink: true });
  f.options.profile.version = '0.163.0-alpha.10.2';
  const checkpoints = [];
  const { run, capture } = await runAuditCapture({ ...f.options,
    onSession: current => checkpoints.push(structuredClone(current.instructionSources)) });
  assert.equal(run.coverage.instructions, 'observed', JSON.stringify(run.warnings));
  assert.equal(capture.capabilities.instructionSources, 'observed');
  assert.deepEqual(run.instructionSources.map(row => [row.agentId, row.source, row.phase, row.status]), [
    ['root-thread', 'thread/start', 'before-task', 'reported'],
    ['child-thread', 'thread/resume-loaded', 'after-task', 'reported'],
    ['grandchild-thread', 'thread/resume-loaded', 'after-task', 'reported'],
  ]);
  assert.equal(new Set(run.instructionSources.flatMap(row => row.sources.map(source => source.id))).size, 3);
  const packets = (await readFile(join(f.dir, 'stdout.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const row of run.instructionSources) {
    assert.equal(packets[row.sourceLine - 1]?.result?.thread?.id, row.agentId);
    assert.equal(packets[row.sourceLine - 1]?.result?.instructionSources.length, row.reportedCount);
    assert.equal(row.sources[0].origin, 'repository');
  }
  assert.equal(JSON.stringify(run.instructionSources).includes(f.dir), false);
  assert.equal(checkpoints[0].length, 1, 'root metadata is checkpointed before task execution');
  assert.equal(checkpoints.at(-1).length, 3);
});

test('never resumes absent or unverified loaded actors to retrieve instruction sources', async t => {
  for (const [instructionFault, reason] of [['unloaded', 'agent-not-loaded'], ['bad-loaded-list', 'loaded-list-unavailable']]) {
    const f = await fixture(t, { nativeInstructionSources: true, instructionFault });
    f.options.profile.version = '0.163.0-alpha.10.2';
    const { run } = await runAuditCapture(f.options);
    assert.equal(run.coverage.instructions, 'partial');
    assert.equal(run.instructionSources[0].status, 'reported');
    assert.equal(run.instructionSources[1].reason, reason);
    const packets = (await readFile(join(f.dir, 'stdout.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(packets.some(packet => packet.result?.thread?.id === 'child-thread' && packet.result?.instructionSources), false);
  }
});

test('invalidates instruction provenance and workflow accounting when loaded snapshot continuity is uncertain', async t => {
  for (const instructionFault of ['wrong-parent', 'wrong-session', 'wrong-cwd', 'wrong-path', 'active-status', 'lost-after']) {
    const f = await fixture(t, { nativeInstructionSources: true, instructionFault });
    f.options.profile.version = '0.163.0-alpha.10.2';
    const { run } = await runAuditCapture(f.options);
    const row = run.instructionSources.find(row => row.agentId === 'child-thread');
    assert.equal(row.status, 'unavailable', instructionFault);
    assert.deepEqual(row.sources, []);
    assert.equal(run.usage.accounting, null, instructionFault);
    assert.ok(run.warnings.includes('instruction-snapshot-continuity-unknown'), instructionFault);
    assert.equal(run.coverage.instructions, 'partial');
  }
});

test('keeps missing and unsupported native instruction sources explicitly unavailable', async t => {
  for (const supported of [false, true]) {
    const f = await fixture(t, { nativeInstructionSources: true, instructionFault: 'missing-field' });
    if (supported) f.options.profile.version = '0.163.0-alpha.10.2';
    const { run } = await runAuditCapture(f.options);
    assert.equal(run.instructionSources[1].status, 'unavailable');
    assert.equal(run.instructionSources[1].reason, supported ? 'field-unavailable' : 'unsupported-native-version');
    assert.equal(run.warnings.includes('instruction-snapshot-continuity-unknown'), false);
    if (!supported) assert.equal(run.coverage.instructions, 'unavailable');
  }
});

test('records an unambiguous structured selection separately from runtime use', async t => {
  const f = await fixture(t);
  f.options.selectedSkills = ['repo-skill'];
  const { process, run } = await runAuditCapture(f.options);
  assert.equal(process.status, 'exited');
  const selected = run.skills.find(s => s.name === 'repo-skill');
  assert.equal(selected.observations[0].kind, 'native-selection-accepted');
  assert.equal(selected.observations.some(o => /invoked|loaded|used/.test(o.kind)), false);
});

test('distinguishes profile-native skills from same-name user and plugin skills across root and child evidence', async t => {
  const f = await fixture(t, { emitProfileRead: true, emitProfileChildRead: true });
  const { run, capture } = await runAuditCapture(f.options);
  const candidates = run.skills.filter(skill => skill.name === 'same');
  const profileSkill = candidates.find(skill => skill.scope === 'profile');
  assert.ok(profileSkill);
  assert.equal(profileSkill.origin, 'profile');
  assert.equal(profileSkill.nativeScope, 'user');
  assert.deepEqual(profileSkill.observations.map(observation => observation.agentId).sort(), ['child-thread', 'root-thread']);
  assert.equal(candidates.filter(skill => skill.origin === 'user').length, 1);
  assert.equal(candidates.filter(skill => skill.origin === 'plugin').length, 1);
  assert.equal(capture.byOrigin.profile, 1);
});

test('rejects an ambiguous same-name structured skill selection before starting a task', async t => {
  const f = await fixture(t);
  f.options.selectedSkills = ['same'];
  const { process, run, capture } = await runAuditCapture(f.options);
  assert.equal(process.status, 'exited');
  assert.equal(run.status, 'unavailable');
  assert.equal(capture.status, 'unavailable');
  assert.equal(capture.errors[0].code, 'ambiguous-skill-selection');
  assert.equal(run.source, undefined);
});

test('caps captured events and marks coverage partial without losing the process result', async t => {
  const f = await fixture(t);
  const { process, run, capture } = await runAuditCapture({ ...f.options, limits: { maxEvents: 1 } });
  assert.equal(process.status, 'exited');
  assert.equal(capture.status, 'partial');
  assert.equal(run.coverage.timeline, 'partial');
  assert.ok(run.warnings.includes('event-limit'));
});

test('only treats one completed literal skill read as observed; masked commands remain intent', async t => {
  const f = await fixture(t, { command: 'cat .agents/skills/repo-skill/SKILL.md; true' });
  const { run } = await runAuditCapture(f.options);
  const observation = run.skills.find(s => s.name === 'repo-skill').observations[0];
  assert.equal(observation.kind, 'resource-read-intent');
  assert.equal(observation.kind.includes('observed'), false);
});

test('matches quoted literal skill reads to native file-URI catalogs without losing profile origins', async t => {
  for (const command of ["/bin/cat '.agents/skills/repo-skill/SKILL.md'", '/usr/bin/cat ".agents/skills/repo-skill/SKILL.md"']) {
    const f = await fixture(t, { command, fileUriCatalog: true });
    const { run } = await runAuditCapture(f.options);
    const skill = run.skills.find(item => item.name === 'repo-skill');
    assert.equal(skill.path, join(f.dir, '.agents/skills/repo-skill/SKILL.md'));
    assert.equal(skill.observations[0].kind, 'definition-read-observed');
    assert.equal(run.skills.some(item => item.scope === 'profile'), true);
  }
});

test('recognizes direct absolute cat binaries as literal skill reads', async t => {
  for (const command of ['/bin/cat .agents/skills/repo-skill/SKILL.md', '/usr/bin/cat .agents/skills/repo-skill/SKILL.md']) {
    const f = await fixture(t, { command });
    const { run } = await runAuditCapture(f.options);
    assert.equal(run.skills.find(skill => skill.name === 'repo-skill').observations[0].kind, 'definition-read-observed', command);
  }
});

test('corroborates absolute cat reads with a single matching native unknown action', async t => {
  for (const mode of ['valid', 'failed', 'compound', 'mismatch', 'missing', 'multiple', 'non-absolute']) {
    const inner = `${mode === 'non-absolute' ? 'cat' : '/bin/cat'} .agents/skills/repo-skill/SKILL.md`;
    const f = await fixture(t, { command: `/bin/zsh -lc '${inner}${mode === 'compound' ? '; true' : ''}'` });
    const action = { type: 'unknown', command: mode === 'mismatch' ? '/bin/cat /different/SKILL.md' : inner };
    const actions = mode === 'missing' ? [] : mode === 'multiple' ? [action, action] : [action];
    f.script = f.script.replace("commandActions:[{type:'read',path:'.agents/skills/repo-skill/SKILL.md'}]", `commandActions:${JSON.stringify(actions)}`);
    if (mode === 'failed') f.script = f.script.replace("exitCode:0,aggregatedOutput", "exitCode:1,aggregatedOutput");
    const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', f.script] } });
    const reads = run.skills.find(s => s.name === 'repo-skill').observations.filter(o => o.kind === 'definition-read-observed');
    assert.equal(reads.length, mode === 'valid' ? 1 : 0, mode);
    if (mode === 'valid') assert.equal(reads[0].evidence.readCorroboration, 'native-unknown-absolute-cat');
    assert.equal(run.coverage.skills, 'partial');
  }
});

test('does not URI-decode a file URI passed to cat into a catalogued filesystem path', async t => {
  const f = await fixture(t, { fileUriCatalog: true });
  const target = join(f.dir, '.agents/skills/repo-skill/SKILL.md');
  f.script = f.script.replace(`const readCommand = ${JSON.stringify('cat .agents/skills/repo-skill/SKILL.md')};`,
    `const readCommand = ${JSON.stringify(`cat 'file://${target}'`)};`);
  const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', f.script] } });
  const skill = run.skills.find(item => item.name === 'repo-skill');
  assert.equal(skill.observations.length, 1);
  assert.equal(skill.observations[0].kind, 'resource-read-intent');
});

test('matches literal read targets through filesystem aliases without changing reported catalog paths', async t => {
  const f = await fixture(t, { command: 'cat alias/.agents/skills/repo-skill/SKILL.md' });
  await mkdir(join(f.dir, '.agents/skills/repo-skill'), { recursive: true });
  await writeFile(join(f.dir, '.agents/skills/repo-skill/SKILL.md'), 'fixture skill');
  await symlink(f.dir, join(f.dir, 'alias'));
  const { run } = await runAuditCapture(f.options);
  const skill = run.skills.find(item => item.name === 'repo-skill');
  assert.equal(skill.observations[0].kind, 'definition-read-observed');
  assert.equal(skill.observations[0].evidence.path, join(f.dir, 'alias/.agents/skills/repo-skill/SKILL.md'));
  assert.equal(skill.path, join(f.dir, '.agents/skills/repo-skill/SKILL.md'));
});

test('does not match a sibling package whose name only shares the catalog path prefix', async t => {
  const f = await fixture(t, { command: 'cat .agents/skills/repo-skill-evil/SKILL.md' });
  await mkdir(join(f.dir, '.agents/skills/repo-skill'), { recursive: true });
  await writeFile(join(f.dir, '.agents/skills/repo-skill/SKILL.md'), 'catalog skill');
  await mkdir(join(f.dir, '.agents/skills/repo-skill-evil'), { recursive: true });
  await writeFile(join(f.dir, '.agents/skills/repo-skill-evil/SKILL.md'), 'sibling skill');
  f.script = f.script.replace("path:'.agents/skills/repo-skill/SKILL.md'", "path:'.agents/skills/repo-skill-evil/SKILL.md'");
  const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', f.script] } });
  assert.equal(run.skills.find(item => item.name === 'repo-skill').observations.length, 0);
});

test('keeps two catalog entries ambiguous when filesystem aliases resolve to one skill file', async t => {
  const f = await fixture(t);
  const skillPath = join(f.dir, '.agents/skills/repo-skill/SKILL.md');
  await mkdir(join(f.dir, '.agents/skills/repo-skill'), { recursive: true });
  await writeFile(skillPath, 'catalog skill');
  await symlink(f.dir, join(f.dir, 'alias'));
  const aliasPath = join(f.dir, 'alias/.agents/skills/repo-skill/SKILL.md');
  f.script = f.script.replace('const skills = [', `const skills = [
    { name:'repo-skill-alias', enabled:true, path:${JSON.stringify(aliasPath)}, scope:'repo', pluginId:'fixture.alias' },`);
  const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', f.script] } });
  assert.ok(run.warnings.includes('ambiguous-skill-read'));
  assert.equal(run.skills.filter(item => item.name.startsWith('repo-skill')).every(item => item.observations.length === 0), true);
});

test('recognizes a strict login-shell literal cat from its executed target when the action path disagrees', async t => {
  const f = await fixture(t, { command: `zsh -lc 'cat ".agents/skills/repo-skill/SKILL.md"'` });
  f.script = f.script.replace("path:'.agents/skills/repo-skill/SKILL.md'", "path:'/stale/catalog/SKILL.md'");
  const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', f.script] } });
  const skill = run.skills.find(item => item.name === 'repo-skill');
  assert.equal(skill.observations.length, 1);
  assert.equal(skill.observations[0].kind, 'definition-read-observed');
  assert.equal(skill.observations[0].evidence.pathAuthority, 'literal-command-target');
  assert.equal(skill.observations[0].evidence.commandWrapper, 'login-shell-command');
  assert.equal(JSON.stringify(run).includes('stale/catalog'), false);
});

test('keeps failed shell reads as intent and compound wrapped commands unresolved', async t => {
  for (const command of [
    `zsh -lc 'cat .agents/skills/repo-skill/SKILL.md'`,
    `zsh -lc 'cat .agents/skills/repo-skill/SKILL.md; true'`,
  ]) {
    const f = await fixture(t, { command });
    if (!command.includes(';')) f.script = f.script.replace('status:\'completed\',exitCode:0,aggregatedOutput', 'status:\'completed\',exitCode:1,aggregatedOutput');
    const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', f.script] } });
    const observation = run.skills.find(item => item.name === 'repo-skill').observations[0];
    assert.equal(observation.kind, 'resource-read-intent');
  }
});

test('parses only literal shell-wrapped cat commands and rejects shell syntax', () => {
  assert.equal(parseLiteralSkillRead("/bin/zsh -lc 'cat \"/tmp/a skill/SKILL.md\"'"), '/tmp/a skill/SKILL.md');
  assert.equal(parseLiteralSkillRead("zsh -lc 'cat /tmp/a\\ b/SKILL.md'"), '/tmp/a b/SKILL.md');
  assert.equal(parseLiteralSkillRead("zsh -lc 'cat \"/tmp/a\u00a0b/SKILL.md\"'"), '/tmp/a\u00a0b/SKILL.md');
  assert.equal(parseLiteralSkillRead("bash -c 'cat /tmp/a/SKILL.md'"), '/tmp/a/SKILL.md');
  for (const command of [
    "zsh -lc 'cat /tmp/a/SKILL.md; true'", "zsh -lc 'cat $SKILL'", "zsh -lc 'cat $(echo x)'",
    "zsh -lc 'cat /tmp/a/SKILL.md > /tmp/out'", "zsh -lc 'cat one two'", "zsh -lc 'cat /tmp/a/SKILL.md' extra",
    "env zsh -lc 'cat /tmp/a/SKILL.md'", "zsh -lc \"cat /tmp/a\\\\ b/SKILL.md\"", 'cat -', 'cat -- /tmp/a/SKILL.md', 'cat /tmp/a/../b/SKILL.md',
  ]) assert.equal(parseLiteralSkillRead(command), null, command);
});

test('does not confuse an all-origin inventory with observed skill use', async t => {
  const f = await fixture(t, { emitSkillRead: false });
  const { run, capture } = await runAuditCapture(f.options);
  assert.equal(run.coverage.skillInventory, 'complete');
  assert.equal(run.coverage.skillUsage, 'partial');
  assert.equal(run.skills.filter(skill => skill.name !== 'child-skill').every(skill => skill.observations.length === 0), true);
  assert.equal(capture.capabilities.skillUseObservability, 'unavailable');
});

test('joins native skill telemetry to root and corroborated child catalogs without guessing unknown or ambiguous skills', async t => {
  const f = await fixture(t);
  let closed = 0;
  const events = [
    { source: 'native-otel-skill-invocation', threadId: 'root-thread', turnId: 'root-turn', skillName: 'repo-skill', scope: 'repo', invocationType: 'explicit', timestampNs: '100' },
    { source: 'native-otel-skill-invocation', threadId: 'child-thread', turnId: 'child-turn', skillName: 'system-skill', scope: 'system', invocationType: 'implicit', timestampNs: '200' },
    { source: 'native-otel-skill-invocation', threadId: 'root-thread', turnId: 'root-turn', skillName: 'same', scope: 'user', invocationType: 'explicit', timestampNs: '300' },
    { source: 'native-otel-skill-invocation', threadId: 'root-thread', turnId: 'root-turn', skillName: 'plug:skill', scope: 'user', pluginId: 'provider.plugin', invocationType: 'explicit', timestampNs: '400' },
    { source: 'native-otel-skill-invocation', threadId: 'root-thread', turnId: 'root-turn', skillName: 'admin-skill', scope: 'admin', invocationType: 'implicit', timestampNs: '450' },
    { source: 'native-otel-skill-invocation', threadId: 'not-linked-thread', turnId: 'foreign-turn', skillName: 'admin-skill', scope: 'admin', invocationType: 'implicit', timestampNs: '500' },
  ];
  const { run, capture } = await runAuditCapture({ ...f.options, telemetryFactory: async () => ({ args: [], snapshot: () => ({ events: [], metadata: {} }), close: async () => {
    closed++;
    return { events, metadata: { delivery: 'best-effort', warnings: [] } };
  } }) });
  assert.equal(closed, 1);
  assert.deepEqual(run.agents.map(agent => agent.id), ['root-thread', 'child-thread']);
  assert.equal(run.skillInvocations.find(event => event.skillName === 'repo-skill').resolution, 'catalogued');
  assert.equal(run.skillInvocations.find(event => event.skillName === 'system-skill').agentId, 'child-thread');
  assert.equal(run.skillInvocations.find(event => event.skillName === 'system-skill').resolution, 'catalogued');
  const ambiguous = run.skillInvocations.find(event => event.skillName === 'same');
  assert.equal(ambiguous.resolution, 'ambiguous');
  assert.equal(ambiguous.candidateSkillIds.length, 3);
  assert.equal(run.skillInvocations.find(event => event.skillName === 'plug:skill').resolution, 'catalogued');
  assert.equal(run.skillInvocations.find(event => event.skillName === 'admin-skill' && event.agentId === 'root-thread').resolution, 'catalogued');
  const foreign = run.skillInvocations.find(event => event.unattributedActorId === 'not-linked-thread');
  assert.equal(foreign.agentId, null);
  assert.equal(foreign.resolution, 'unattributed');
  assert.equal(run.skills.find(skill => skill.name === 'plug:skill').observations[0].kind, 'native-invocation-observed');
  assert.equal(capture.capabilities.skillUseObservability, 'native-runtime-detected');
  assert.equal(run.coverage.skillUsage, 'partial');
  assert.equal(run.skillTelemetry.delivery, 'best-effort');
});

test('discovers a grandchild from hydrated child collaboration metadata before the task-end snapshot', async t => {
  const f = await fixture(t, { grandchildLink: true });
  const checkpoints = [], callbackOrder = [];
  const grandchildTelemetry = { source: 'native-otel-skill-invocation', threadId: 'grandchild-thread', turnId: 'grandchild-turn',
    skillName: 'grandchild-skill', scope: 'repo', invocationType: 'implicit', timestampNs: '700' };
  const { run } = await runAuditCapture({ ...f.options,
    telemetryFactory: async () => ({ args: [], snapshot: () => ({ events: [], metadata: {} }), close: async () => ({ events: [grandchildTelemetry], metadata: { delivery: 'best-effort' } }) }),
    onSession: (snapshot, capture) => {
      if (capture.checkpoint === 'agent-tree-hydrated') {
        callbackOrder.push('tree-checkpoint');
        assert.deepEqual(snapshot.agents.map(agent => agent.id), ['root-thread', 'child-thread', 'grandchild-thread']);
      }
    },
    onTaskEnd: state => { callbackOrder.push('task-end'); checkpoints.push({ complete: state.complete,
      agents: state.run.agents.map(agent => agent.id), hydratedLink: state.run.events.some(event => event.itemId === 'child-grandchild-link') }); } });
  assert.deepEqual(run.agents.map(agent => [agent.id, agent.parentId, agent.depth]), [
    ['root-thread', null, 0], ['child-thread', 'root-thread', 1], ['grandchild-thread', 'child-thread', 2],
  ]);
  assert.equal(run.skills.some(skill => skill.name === 'grandchild-skill' && skill.catalogs.some(catalog => catalog.agentId === 'grandchild-thread')), true);
  assert.equal(run.skillInvocations.find(event => event.skillName === 'grandchild-skill').resolution, 'catalogued');
  assert.equal(run.skillInvocations.find(event => event.skillName === 'grandchild-skill').agentId, 'grandchild-thread');
  assert.deepEqual(checkpoints, [{ complete: true, agents: ['root-thread', 'child-thread', 'grandchild-thread'], hydratedLink: true }]);
  assert.deepEqual(callbackOrder, ['tree-checkpoint', 'task-end']);
  assert.equal(run.coverage.agents, 'complete');
});

test('retains out-of-order startup ancestry and attributes a grandchild without collab items', async t => {
  const f = await fixture(t, { emitCollabLink: false, earlyThreadLinks: true });
  const grandchildTelemetry = { source: 'native-otel-skill-invocation', threadId: 'grandchild-thread', turnId: 'grandchild-turn',
    skillName: 'grandchild-skill', scope: 'repo', invocationType: 'explicit', timestampNs: '800' };
  const { run } = await runAuditCapture({ ...f.options,
    telemetryFactory: async () => ({ args: [], snapshot: () => ({ events: [], metadata: {} }), close: async () => ({ events: [grandchildTelemetry], metadata: { delivery: 'best-effort' } }) }) });
  assert.deepEqual(run.agents.map(agent => [agent.id, agent.parentId, agent.depth]), [
    ['root-thread', null, 0], ['child-thread', 'root-thread', 1], ['grandchild-thread', 'child-thread', 2],
  ]);
  assert.equal(run.agents.some(agent => agent.id === 'foreign-thread'), false);
  assert.equal(run.agents.some(agent => agent.id === 'orphan-thread'), false);
  assert.equal(run.skills.some(skill => skill.name === 'grandchild-skill' && skill.catalogs.some(catalog => catalog.agentId === 'grandchild-thread')), true);
  const invocation = run.skillInvocations.find(event => event.skillName === 'grandchild-skill');
  assert.equal(invocation.agentId, 'grandchild-thread');
  assert.equal(invocation.resolution, 'catalogued');
  assert.equal(run.turns.find(turn => turn.agentId === 'grandchild-thread' && turn.turnId === 'grandchild-turn')?.status, 'completed');
  assert.ok(run.warnings.includes('unverified-child-link'));
  assert.ok(run.warnings.includes('unresolved-agent-links'));
  assert.equal(run.coverage.agents, 'partial');
});

test('rejects a hydrated grandchild link whose exact parent is not corroborated', async t => {
  const f = await fixture(t, { grandchildLink: true, wrongGrandchildParent: true });
  const { run } = await runAuditCapture(f.options);
  assert.deepEqual(run.agents.map(agent => agent.id), ['root-thread', 'child-thread']);
  assert.ok(run.warnings.includes('unverified-child-link'));
  assert.equal(run.coverage.agents, 'partial');
});

test('marks task-end incomplete when a linked child cannot be corroborated', async t => {
  const f = await fixture(t, { failChildRead: true });
  const checkpoints = [];
  const { run } = await runAuditCapture({ ...f.options, onTaskEnd: state => checkpoints.push(state.complete) });
  assert.deepEqual(checkpoints, [false]);
  assert.ok(run.warnings.includes('linked-child-unavailable'));
  assert.equal(run.coverage.agents, 'partial');
});

test('captures MCP and dynamic lifecycle plus deduplicated hydrated child tools without payloads', async t => {
  const f = await fixture(t, { emitToolEvents: true, emitChildItem: true });
  const { run } = await runAuditCapture(f.options);
  const mcp = run.toolInvocations.find(call => call.itemId === 'mcp-1');
  const dynamic = run.toolInvocations.find(call => call.itemId === 'dynamic-1');
  assert.deepEqual([mcp.kind, mcp.status, mcp.startedAtMs, mcp.completedAtMs], ['mcp', 'completed', 10, 30]);
  assert.deepEqual([dynamic.kind, dynamic.status, dynamic.success], ['dynamic', 'failed', false]);
  assert.equal(run.mcp.servers.find(server => server.name === 'local').status, 'ready');
  assert.equal(run.toolInvocations.filter(call => call.itemId === 'child-item' && call.agentId === 'child-thread').length, 1);
  const serialized = JSON.stringify(run);
  for (const secret of ['PRIVATE_MCP_ARGUMENT', 'PRIVATE_MCP_RESULT', 'PRIVATE_DYNAMIC_ARGUMENT', 'PRIVATE_DYNAMIC_ERROR', 'PRIVATE_MCP_STARTUP_ERROR'])
    assert.equal(serialized.includes(secret), false, secret);
});

test('closes the per-process telemetry receiver after an app-server timeout', async t => {
  const f = await fixture(t, { stallTurnStart: true });
  let closed = 0;
  const startedAt = Date.now();
  const { process, capture } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, timeoutMs: 100 },
    telemetryFactory: async () => ({ args: [], snapshot: () => ({ events: [], metadata: {} }), close: async () => { closed++; return { events: [], metadata: {} }; } }) });
  assert.equal(process.status, 'timeout');
  assert.equal(closed, 1);
  assert.ok(Date.now() - startedAt < 1500);
  assert.equal(capture.observer.savedSettingsChanged, false);
});

test('does not admit child receiver IDs when thread/read parent corroboration fails', async t => {
  const f = await fixture(t, { wrongParent: true });
  const { run, capture } = await runAuditCapture(f.options);
  assert.deepEqual(run.agents.map(agent => agent.id), ['root-thread']);
  assert.equal(run.coverage.agents, 'partial');
  assert.ok(run.warnings.includes('unverified-child-link'));
  assert.equal(capture.byAgent['child-thread'], undefined);
});

test('discovers a child from current subAgentActivity metadata without retaining its path or prose', async t => {
  const f = await fixture(t, { emitCollabLink: false, emitSubAgentActivity: true });
  const { run } = await runAuditCapture(f.options);
  assert.deepEqual(run.agents.map(agent => [agent.id, agent.parentId]), [['root-thread', null], ['child-thread', 'root-thread']]);
  assert.equal(run.coverage.agents, 'complete');
  assert.equal(run.toolInvocations.some(call => call.itemId === 'subagent-activity'), false);
  const serialized = JSON.stringify(run);
  assert.equal(serialized.includes('PRIVATE_AGENT_PATH'), false);
  assert.equal(serialized.includes('PRIVATE_AGENT_MESSAGE'), false);
});

test('does not mark a child thread terminal from one completed turn while thread status remains active', async t => {
  const f = await fixture(t, { childStatus: 'active' });
  const checkpoints = [];
  const { run } = await runAuditCapture({ ...f.options, limits: { childCompletionWaitMs: 25 },
    onTaskEnd: state => checkpoints.push(state.complete) });
  assert.deepEqual(checkpoints, [false]);
  assert.ok(run.warnings.includes('linked-child-incomplete'));
  assert.equal(run.agents.find(agent => agent.id === 'child-thread').terminal, false);
  assert.equal(run.coverage.agents, 'partial');
});

test('keeps exact failed terminal status when it arrives before turn/start response and handles delayed completion', async t => {
  const f = await fixture(t, { terminalStatus: 'failed', earlyCompletion: true });
  const { process, run } = await runAuditCapture(f.options);
  assert.equal(process.status, 'exited');
  assert.equal(run.outcome.nativeTurnStatus, 'failed');
  assert.equal(run.warnings.includes('root-turn-completion-missing'), false);
});

test('does not lose root completion after a notification wait timeout', async t => {
  const f = await fixture(t, { completionDelayMs: 1200 });
  const { run } = await runAuditCapture(f.options);
  assert.equal(run.warnings.includes('root-turn-completion-missing'), false);
});

test('maps read-only isolation through native ThreadStart and TurnStart schema fields', async t => {
  const f = await fixture(t);
  const { process } = await runAuditCapture({ ...f.options, sandbox: 'read-only' });
  assert.equal(process.status, 'exited');
});

test('refuses missing, different or inconsistent inherited native working directories before starting a task', async t => {
  for (const reportedCwd of [undefined, '/different-workspace', 'inconsistent']) {
    const f = await fixture(t);
    const reply = `result:{cwd:${JSON.stringify(f.dir)},thread:{id:'root-thread',sessionId:'session-root',cwd:${JSON.stringify(f.dir)}},instructionSources:undefined}`;
    const script = f.script.replace(reply, reportedCwd === 'inconsistent'
      ? `result:{cwd:${JSON.stringify(f.dir)},thread:{id:'root-thread',sessionId:'session-root',cwd:'/different-workspace'}}`
      : `result:{${reportedCwd ? `cwd:${JSON.stringify(reportedCwd)},` : ''}thread:{id:'root-thread',sessionId:'session-root'}}`);
    assert.notEqual(script, f.script, 'fixture changes only the native start response');
    const checkpoints = []; let taskEnds = 0;
    const executable = join(f.dir, 'fake-codex');
    await writeFile(executable, `#!/usr/bin/env node\n${script}`, { mode: 0o700 });
    const { process, run, capture } = await runAuditCapture({ ...f.options,
      profile: { ...f.options.profile, executable },
      processOptions: { ...f.options.processOptions, args: undefined,
        env: { ...f.options.processOptions.env, HOME: f.dir, CODEX_HOME: f.dir } },
      onSession: (_run, capture) => { checkpoints.push(capture.checkpoint); }, onTaskEnd: () => { taskEnds++; } });
    assert.equal(process.status, 'exited');
    assert.deepEqual(checkpoints, ['final'], 'only partial final evidence is retained for an unverified cwd');
    assert.equal(taskEnds, 0, 'no task starts for an unverified cwd');
    assert.equal(capture.observer.runtime.workspace, 'process-cwd-unverified');
    assert.ok(run.warnings.includes('native-workspace-mismatch'));
    assert.equal(run.turns.length, 0);
    assert.equal(run.source, undefined);
  }
});

test('does not double-count a child completed item also present in hydration', async t => {
  const f = await fixture(t, { emitChildItem: true });
  const { run } = await runAuditCapture(f.options);
  assert.equal(run.events.filter(event => event.agentId === 'child-thread' && event.kind === 'command-execution').length, 1);
  assert.equal(run.artifacts.filter(artifact => artifact.agentId === 'child-thread').length, 0);
  assert.equal(run.skills.find(skill => skill.name === 'child-skill').observations.length, 1, JSON.stringify({ events: run.events.filter(event => event.agentId === 'child-thread'), skills: run.skills.filter(skill => skill.name === 'child-skill') }));
  assert.equal(run.events.some(event => event.kind === 'hydrated:item' && event.agentId === 'child-thread'), false);
});

test('marks child item hydration partial when pagination cursor remains at item cap', async t => {
  const f = await fixture(t, { childNextCursor: true });
  const { run, capture } = await runAuditCapture({ ...f.options, limits: { maxItems: 2 },
    onTaskEnd: state => assert.equal(state.complete, false) });
  assert.ok(run.warnings.includes('item-limit'));
  assert.ok(run.warnings.includes('linked-child-items-incomplete'));
  assert.equal(run.coverage.agents, 'partial');
  assert.equal(capture.capabilities.childHydration, 'partial');
});

test('settles a stalled app-server without late task-end callbacks', async t => {
  const f = await fixture(t, { stallTurnStart: true });
  let taskEndCalls = 0;
  const before = Date.now();
  const { process, run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, timeoutMs: 150 },
    onTaskEnd: () => { taskEndCalls++; } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(process.status, 'timeout');
  assert.equal(taskEndCalls, 0);
  assert.ok(Date.now() - before < 1500);
  assert.ok(run.warnings.includes('process-timeout'));
});

test('projects native object-shaped file changes under the global artifact cap', async t => {
  const f = await fixture(t, { emitFileChanges: true });
  const { run } = await runAuditCapture({ ...f.options, limits: { maxArtifacts: 2 } });
  assert.equal(run.artifacts.length, 2);
  assert.ok(run.warnings.includes('file-change-limit'));
  assert.ok(run.artifacts.every(artifact => artifact.kind === 'recorded-file-change' && artifact.path));
  assert.equal(JSON.stringify(run).includes('PRIVATE DIFF'), false);
});

test('projects unknown native methods as a fixed event kind without preserving method text', async t => {
  const f = await fixture(t, { emitUnknownMethod: true });
  const { run } = await runAuditCapture(f.options);
  assert.ok(run.events.some(event => event.kind === 'unknown-native-event'));
  assert.ok(run.warnings.includes('unknown-native-event'));
  const json = JSON.stringify(run);
  assert.equal(json.includes('secret.method/private-value'), false);
  assert.equal(json.includes('PRIVATE_NATIVE_EVENT'), false);
});

test('classifies known streaming and state notifications without exposing payloads or duplicating tools', async t => {
  const methods = ['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'turn/diff/updated',
    'turn/moderationMetadata', 'thread/readState/changed'];
  const nativeEvents = ['root-thread', 'child-thread'].flatMap(threadId => methods.map(method => ({
    jsonrpc: '2.0', method, params: { threadId,
      turnId: method === 'thread/readState/changed' ? 'unrelated-turn' : threadId === 'root-thread' ? 'root-turn' : 'child-turn',
      itemId: 'read-skill', delta: 'PRIVATE_STREAM', diff: 'PRIVATE_PATCH',
      item: { id: 'unexpected-item', type: 'commandExecution', name: 'PRIVATE_EXTRA_ITEM' },
      metadata: { secret: 'PRIVATE_MODERATION' }, readState: { secret: 'PRIVATE_READ_STATE' } },
  })));
  const f = await fixture(t, { nativeEvents });
  const { run } = await runAuditCapture(f.options);
  assert.equal(run.warnings.includes('unknown-native-event'), false);
  for (const agent of ['root-thread', 'child-thread']) for (const method of methods) {
    const events = run.events.filter(event => event.kind === method && event.agentId === agent);
    assert.equal(events.length, 1, `${agent} ${method}`);
    assert.equal(events[0].turnId, method === 'thread/readState/changed' ? undefined : agent === 'root-thread' ? 'root-turn' : 'child-turn');
    if (method.startsWith('item/')) assert.equal(events[0].itemId, 'read-skill');
  }
  assert.equal(run.toolInvocations.length, 3, 'root command, collaboration and hydrated child command only');
  assert.equal(run.toolInvocations.filter(call => call.kind === 'command').length, 2);
  assert.equal(run.coverage.skills, 'partial');
  assert.equal(run.status, 'partial');
  assert.ok(run.warnings.includes('skill-use-observability-limited'));
  assert.doesNotMatch(JSON.stringify(run), /PRIVATE_STREAM|PRIVATE_PATCH|PRIVATE_MODERATION|PRIVATE_READ_STATE|PRIVATE_EXTRA_ITEM/);
});

test('projects the supported retry notification without retaining error prose', async t => {
  const f = await fixture(t, { emitErrorNotification: true });
  const { run } = await runAuditCapture(f.options);
  const event = run.events.find(row => row.kind === 'error');
  assert.equal(event.willRetry, true);
  assert.equal(event.errorCode, 'rateLimitExceeded');
  assert.equal(JSON.stringify(event).includes('PRIVATE_'), false);
});

test('falls back from explicit child items/list method-not-found to full turns/list history', async t => {
  const f = await fixture(t, { childItemsUnsupported: true, emitChildItem: true });
  const { run, capture } = await runAuditCapture(f.options);
  assert.ok(run.turns.some(turn => turn.agentId === 'child-thread' && turn.turnId === 'child-turn' && turn.source === 'thread/turns/list'));
  assert.equal(run.events.filter(event => event.agentId === 'child-thread' && event.itemId === 'child-item').length, 1);
  assert.equal(capture.capabilities.childHydration, 'available');
});

test('discovers grandchildren from fallback full turns before the hydrated tree checkpoint', async t => {
  const f = await fixture(t, { childItemsUnsupported: true, grandchildLink: true });
  const checkpoints = [];
  const { run } = await runAuditCapture({ ...f.options, onSession: async (snapshot, capture) => {
    if (capture.checkpoint === 'agent-tree-hydrated') checkpoints.push(snapshot.agents.map(agent => agent.id));
  } });
  assert.ok(run.agents.some(agent => agent.id === 'grandchild-thread' && agent.parentId === 'child-thread'));
  assert.deepEqual(checkpoints, [['root-thread', 'child-thread', 'grandchild-thread']]);
});

test('does not retry unrelated errors from thread/items/list', async t => {
  const f = await fixture(t, { childItemsFailureCode: -32602 });
  const { run, capture } = await runAuditCapture(f.options);
  assert.ok(run.warnings.includes('linked-child-items-unavailable'));
  assert.equal(run.events.some(event => event.source === 'thread/turns/list'), false);
  assert.notEqual(capture.capabilities.childHydration, 'available');
});

test('does not treat summary or unmarked turns/list items as complete history', async t => {
  for (const view of ['summary', 'missing']) {
    const f = await fixture(t, { childItemsUnsupported: true, turnsItemsView: view });
    const { run, capture } = await runAuditCapture(f.options);
    assert.equal(run.events.some(event => event.agentId === 'child-thread' && event.itemId === 'child-item'), false);
    assert.ok(run.warnings.includes('linked-child-items-not-full'));
    assert.equal(capture.capabilities.childHydration, 'partial');
  }
});

test('marks malformed or missing turns/list pages and turn items as partial history', async t => {
  for (const mode of ['missing-data', 'non-array', 'bad-item']) {
    const f = await fixture(t, { childItemsUnsupported: true, turnsPageMode: mode });
    const { run, capture } = await runAuditCapture(f.options);
    assert.equal(capture.capabilities.childHydration, 'partial', mode);
    assert.ok(run.warnings.includes(mode === 'bad-item' ? 'linked-child-items-malformed' : 'linked-child-turns-malformed'), mode);
  }
});

test('checkpoints the native-owned session before turn start and does not start if checkpoint fails', async t => {
  const f = await fixture(t);
  const checkpoints = [];
  const { run } = await runAuditCapture({ ...f.options, onSession: async (snapshot) => {
    checkpoints.push({ sourceThreadId: snapshot.source?.threadId, turns: snapshot.turns.length });
    if (checkpoints.length === 1) throw new Error('private callback failure');
  } });
  assert.deepEqual(checkpoints, [{ sourceThreadId: 'root-thread', turns: 0 }, { sourceThreadId: 'root-thread', turns: 0 }]);
  assert.equal(run.source.threadId, 'root-thread');
  assert.equal(run.turns.length, 0);
  assert.equal(run.events.length, 0);
  assert.ok(run.warnings.includes('session-checkpoint-failed'));
});

test('checkpoints before the task, after agent hydration, and after final telemetry', async t => {
  const f = await fixture(t);
  const checkpoints = [];
  const { run } = await runAuditCapture({ ...f.options, onSession: async snapshot => {
    checkpoints.push({ threadId: snapshot.source?.threadId, turns: snapshot.turns.length });
    if (checkpoints.length === 2) throw new Error('final persistence failure');
  } });
  assert.equal(checkpoints.length, 3);
  assert.deepEqual(checkpoints[0], { threadId: 'root-thread', turns: 0 });
  assert.equal(checkpoints[1].threadId, 'root-thread');
  assert.ok(checkpoints[1].turns > 0);
  assert.ok(checkpoints[2].turns >= checkpoints[1].turns);
  assert.ok(run.turns.some(turn => turn.agentId === 'root-thread'));
  assert.ok(run.events.length > 0);
});

test('native launch uses a persistent owned thread and private SQLite, logs, and temporary state while reading the bound profile', async t => {
  const f = await fixture(t);
  const home = join(f.dir, 'profile-home'), userHome = join(f.dir, 'profile-user-home');
  await mkdir(home, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  const configPath = join(home, 'config.toml');
  await writeFile(configPath, 'sqlite_home = "/saved/profile/sqlite"\nmodel = "saved-model"\n', { mode: 0o600 });
  const probePath = join(f.dir, 'native-probe.json');
  const nativeExecutable = join(f.dir, 'fake-codex');
  const nativeSource = `#!/usr/bin/env node
import { writeFileSync, statSync, appendFileSync } from 'node:fs';
const args=process.argv.slice(2), config=[];
for(let i=0;i<args.length;i++) if(args[i]==='-c') {
 const option=args[++i]??'';
 if(option.startsWith('sqlite_home=')||option.startsWith('log_dir=')) config.push(option);
}
const value=(key)=>config.find(option=>option.startsWith(key+'='))?.slice(key.length+1);
const pathFor=(key)=>{const encoded=value(key);return encoded?JSON.parse(encoded):null};
const sqlite=pathFor('sqlite_home'),logs=pathFor('log_dir');
writeFileSync(process.env.CAPTURE_PROBE,JSON.stringify({argsTail:args.at(-1),config,env:{home:process.env.HOME,codexHome:process.env.CODEX_HOME,sqlite:process.env.CODEX_SQLITE_HOME,tmp:process.env.TMPDIR},
 dirs:[sqlite,logs,process.env.TMPDIR].map(path=>{const s=statSync(path);return {path,mode:s.mode&0o777}})}));
${f.script.replace("if (method==='thread/start') {", `if (method==='thread/start') {
    if (params.cwd && params.sandbox !== 'read-only') appendFileSync(${JSON.stringify(configPath)}, '\\n[projects.native_saved_trust]\\ntrust_level = "trusted"\\n');`)}
`;
  await writeFile(nativeExecutable, nativeSource, { mode: 0o700 });
  await chmod(nativeExecutable, 0o700);
  const env = { PATH: process.env.PATH ?? '', HOME: userHome, CODEX_HOME: home,
    CODEX_SQLITE_HOME: home, TMPDIR: userHome, TMP: userHome, TEMP: userHome, CAPTURE_PROBE: probePath };
  const { process: processResult, run, capture } = await runAuditCapture({ ...f.options,
    profile: { ...f.options.profile, home, userHome, executable: nativeExecutable },
    processOptions: { ...f.options.processOptions, args: undefined, env } });
  assert.equal(processResult.status, 'exited');
  assert.equal(run.status, 'partial');
  assert.equal(capture.observer.savedSettingsChanged, false);
  assert.equal(run.source.persistence, 'native-owned-session');
  assert.equal(capture.observer.nativeSessionStorage, 'profile-owned-new-rollouts');
  assert.ok(capture.observer.effects.includes('native-owned session files in profile-owned new rollouts'));
  assert.deepEqual(capture.observer.runtime, { sqlite: 'private-per-process', logs: 'private-per-process',
    temporaryFiles: 'private-per-process', threadPersistence: 'native-owned-session', workspace: 'verified-process-cwd' });
  const probe = JSON.parse(await readFile(probePath, 'utf8'));
  const runtimeBase = await realpath(f.dir);
  assert.equal(probe.argsTail, 'app-server');
  assert.equal(probe.env.home, userHome);
  assert.equal(probe.env.codexHome, home);
  assert.equal(probe.env.sqlite, join(runtimeBase, 'runtime/sqlite'));
  assert.equal(probe.env.tmp, join(runtimeBase, 'runtime/tmp'));
  assert.deepEqual(probe.config, [`sqlite_home=${JSON.stringify(join(runtimeBase, 'runtime/sqlite'))}`,
    `log_dir=${JSON.stringify(join(runtimeBase, 'runtime/logs'))}`]);
  assert.ok(probe.dirs.every(directory => directory.mode === 0o700));
  assert.equal(await readFile(configPath, 'utf8'), 'sqlite_home = "/saved/profile/sqlite"\nmodel = "saved-model"\n');
  await assert.rejects(stat(join(f.dir, 'runtime')));
});


test('workspace task-end callback runs only after the owned app-server group has stopped', async t => {
  const f = await fixture(t);
  let spawnedPid, observed;
  f.options.processOptions.onSpawn = info => { spawnedPid = info.pid; };
  const result = await runAuditCapture({ ...f.options, onTaskEnd: evidence => {
    let alive = false;
    try { globalThis.process.kill(spawnedPid, 0); alive = true; } catch {}
    observed = { alive, stopped: evidence.processGroupStopped, complete: evidence.complete, boundary: evidence.boundary };
  } });
  assert.equal(result.process.shutdown.groupTerminated, true);
  assert.deepEqual(observed, { alive: false, stopped: true, complete: true, boundary: 'owned-process-group-stopped-before-checks' });
});

test('does not attribute a child read using a path found only in the parent catalog', async t => {
  const f = await fixture(t, { emitChildItem: true });
  const target = `${f.dir}/.agents/skills/repo-skill/SKILL.md`;
  const script = f.script.replaceAll("command:'cat .agents/skills/child-skill/SKILL.md',commandActions:[{type:'read',path:'.agents/skills/child-skill/SKILL.md'}]",
    `command:${JSON.stringify(`cat ${target}`)},commandActions:[{type:'read',path:${JSON.stringify(target)}}]`);
  const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', script] } });
  const rootSkill = run.skills.find(skill => skill.name === 'repo-skill');
  assert.equal(rootSkill.observations.filter(row => row.agentId === 'root-thread').length, 1);
  assert.equal(rootSkill.observations.some(row => row.agentId === 'child-thread'), false);
});

test('leaves same-path skill provider ambiguity unresolved instead of assigning the first catalog entry', async t => {
  const f = await fixture(t);
  const script = f.script.replace('const skills = [', `const skills = [
    { name:'repo-skill', enabled:true, path:${JSON.stringify(`${f.dir}/.agents/skills/repo-skill/SKILL.md`)}, scope:'repo', pluginId:'fixture.plugin' },`);
  const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', script] } });
  assert.equal(run.skills.filter(skill => skill.name === 'repo-skill').length, 2);
  assert.ok(run.warnings.includes('ambiguous-skill-read'));
  assert.equal(run.skills.filter(skill => skill.name === 'repo-skill').every(skill => skill.observations.length === 0), true);
});

test('does not present enclosing turn timestamps as hydrated tool execution intervals', async t => {
  const f = await fixture(t, { childItemsUnsupported: true });
  const { run } = await runAuditCapture(f.options);
  const tool = run.toolInvocations.find(row => row.agentId === 'child-thread' && row.itemId === 'child-item');
  assert.equal(tool.source, 'thread/turns/list');
  assert.equal(tool.startedAtMs, null);
  assert.equal(tool.completedAtMs, null);
  assert.equal(tool.observedElapsedMs, undefined);
  assert.equal(run.turns.some(turn => turn.agentId === 'child-thread' && turn.turnId === 'child-turn'), true);
});

test('retains terminal root and child turns when their start notifications are missing', async t => {
  const f = await fixture(t, { earlyCompletion: true, terminalStatus: 'failed' });
  const script = f.script.replaceAll(/send\(\{jsonrpc:'2\.0',method:'turn\/started',params:\{threadId:'(?:root|child)-thread',turn:\{id:'(?:root|child)-turn',status:'inProgress'\}\}\}\);/g, '');
  assert.notEqual(script, f.script);
  const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', script] } });
  const root = run.turns.find(turn => turn.agentId === 'root-thread');
  const child = run.turns.find(turn => turn.agentId === 'child-thread');
  assert.equal(root.status, 'failed');
  assert.equal(child.status, 'completed');
  assert.equal(root.observedStartedAt, undefined);
  assert.equal(child.observedStartedAt, undefined);
  assert.ok(root.observedCompletedAt);
  assert.ok(child.observedCompletedAt);
});

test('matches full native plugin identities within the telemetry limit instead of dropping long IDs', async t => {
  const f = await fixture(t);
  const pluginId = `provider.${'a'.repeat(102)}`;
  const script = f.script.replaceAll('provider.plugin', pluginId);
  const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', script] },
    telemetryFactory: async () => ({ args: [], close: async () => ({ events: [{ source: 'native-otel-skill-invocation',
      threadId: 'root-thread', turnId: 'root-turn', skillName: 'plug:skill', scope: 'user', pluginId,
      invocationType: 'explicit', timestampNs: '400' }], metadata: { delivery: 'best-effort' } }) }) });
  assert.equal(run.skills.find(skill => skill.name === 'plug:skill').provider, pluginId);
  assert.equal(run.skillInvocations[0].resolution, 'catalogued');
});

test('persists verified fresh paginated workflow counters while preserving missing-field coverage', async t => {
  const f = await fixture(t);
  const { run } = await runAuditCapture({ ...f.options, profile: { ...f.options.profile, version: '0.163.0-alpha.10.2' } });
  assert.equal(run.source.historyMode, 'paginated');
  assert.equal(run.source.freshThread, true);
  assert.equal(run.usage.accounting.contract, 'codex-thread-own-cumulative-v1');
  assert.equal(run.usage.workflow.status, 'partial');
  assert.deepEqual(run.usage.workflow.values, { inputTokens: 6, outputTokens: 3, cachedInputTokens: 1,
    reasoningOutputTokens: 0, cacheWriteInputTokens: null, totalTokens: 9 });
  assert.equal(run.usage.workflow.scope, 'captured-workflow-agents');
  assert.equal(run.usage.workflow.fields.cacheWriteInputTokens.status, 'unavailable');
  assert.equal(run.usage.total, null, 'the ambiguous unscoped legacy field is never filled');
  assert.equal(run.usage.turns.status, 'partial');
  assert.equal(run.usage.turns.turns.find(row => row.agentId === 'root-thread').values.inputTokens, 5);
});

test('captures root and verified child hooks with safe lifecycle metadata and exact nullable turn ownership', async t => {
  const f = await fixture(t);
  const emit = (method, threadId, turnId, id, scope = 'turn') => `send(${JSON.stringify({ jsonrpc: '2.0', method,
    params: { threadId, turnId, run: { id, eventName: scope === 'thread' ? 'sessionStart' : 'subagentStop',
      handlerType: 'command', executionMode: 'sync', scope, source: 'user', status: method === 'hook/completed' ? 'completed' : 'running',
      startedAt: 100, completedAt: method === 'hook/completed' ? 101 : null, durationMs: method === 'hook/completed' ? 42 : null,
      sourcePath: '/private/HOOK_CONFIG', entries: [{ text: 'PRIVATE_HOOK_OUTPUT' }], statusMessage: 'PRIVATE_HOOK_STATUS' } } })});`;
  const hooks = emit('hook/started', 'root-thread', null, 'root-hook', 'thread')
    + emit('hook/completed', 'root-thread', null, 'root-hook', 'thread')
    + emit('hook/started', 'child-thread', 'child-turn', 'child-hook')
    + emit('hook/completed', 'child-thread', 'child-turn', 'child-hook');
  const anchor = "send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'child-thread'";
  const script = f.script.replace(anchor, hooks + anchor);
  assert.notEqual(script, f.script);
  const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', script] } });
  assert.equal(run.coverage.hooks, 'observed');
  assert.deepEqual(run.hookInvocations.map(row => [row.agentId, row.turnId, row.status, row.durationMs]), [
    ['root-thread', null, 'completed', 42], ['child-thread', 'child-turn', 'completed', 42],
  ]);
  assert.equal(run.events.filter(row => row.kind.startsWith('hook/')).length, 4);
  assert.equal(run.events.find(row => row.kind === 'hook/started').turnId, null);
  for (const secret of ['HOOK_CONFIG', 'PRIVATE_HOOK_OUTPUT', 'PRIVATE_HOOK_STATUS']) assert.equal(JSON.stringify(run).includes(secret), false);
});

test('malformed native records and unresolved actor events keep hook absence partial', async t => {
  const anchor = "send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'child-thread'";
  for (const injection of ["process.stdout.write('INVALID_JSON\\n');",
    "send({jsonrpc:'2.0',method:'hook/completed',params:{threadId:'unlinked-thread',turnId:null,run:{}}});",
    "send({jsonrpc:'2.0',method:'hook/completed',params:{threadId:42,turnId:null,run:{}}});"]) {
    const f = await fixture(t);
    const script = f.script.replace(anchor, injection + anchor);
    const { run } = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, args: ['-e', script] } });
    assert.equal(run.coverage.hooks, 'partial');
    assert.equal(run.usage.turns.status, 'unavailable');
    assert.equal(run.agents.some(agent => agent.id === 'unlinked-thread'), false);
  }
});

test('retains early child usage before its link and restores physical source order', async t => {
  const f = await fixture(t);
  const childUsage = f.script.match(/send\(\{jsonrpc:'2\.0',method:'thread\/tokenUsage\/updated',params:\{threadId:'child-thread'[^\n]+/)[0];
  const rootUsage = "send({jsonrpc:'2.0',method:'thread/tokenUsage/updated',params:{threadId:'root-thread'";
  const script = f.script.replace(childUsage, '').replace(rootUsage, childUsage + '\n' + rootUsage);
  const { run } = await runAuditCapture({ ...f.options, profile: { ...f.options.profile, version: '0.163.0-alpha.10.2' },
    processOptions: { ...f.options.processOptions, args: ['-e', script] } });
  assert.equal(run.coverage.agents, 'complete');
  assert.equal(run.usage.turns.status, 'partial', 'only cache-write is unavailable in this fixture');
  assert.deepEqual(run.usage.observations.map(row => row.agentId), ['child-thread', 'root-thread']);
  assert.equal(run.usage.turns.turns.find(row => row.agentId === 'child-thread').values.inputTokens, 1);
});

test('final child counters follow source order when new usage arrives during its catalog RPC', async t => {
  const f = await fixture(t);
  const response = "return send({jsonrpc:'2.0',id,result:{data:[{cwd,skills:catalog,errors:[]}]}});";
  const newer = { jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'child-thread', turnId: 'child-turn',
    tokenUsage: { last: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      total: { inputTokens: 2, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 4 } } } };
  const hook = { jsonrpc: '2.0', method: 'hook/started', params: { threadId: 'child-thread', turnId: 'child-turn', run: {
    id: 'subagent-stop:0:/private/TEST_HOOK_SOURCE/config.toml', eventName: 'subagentStop', handlerType: 'command',
    executionMode: 'sync', scope: 'turn', source: 'user', status: 'running', startedAt: 100, completedAt: null, durationMs: null } } };
  const completed = structuredClone(hook);
  completed.method = 'hook/completed';
  Object.assign(completed.params.run, { status: 'completed', completedAt: 100, durationMs: 5 });
  const childStart = "send({jsonrpc:'2.0',method:'turn/started',params:{threadId:'child-thread'";
  const script = f.script.replace(childStart, `send(${JSON.stringify(hook)});` + childStart)
    .replace(response, `if (cwd.endsWith('/child')) { setTimeout(() => {send(${JSON.stringify(newer)}); send(${JSON.stringify(completed)}); send({jsonrpc:'2.0',id,result:{data:[{cwd,skills:catalog,errors:[]}]}});}, 5); return;} ${response}`);
  const { run } = await runAuditCapture({ ...f.options, profile: { ...f.options.profile, version: '0.163.0-alpha.10.2' },
    processOptions: { ...f.options.processOptions, args: ['-e', script] } });
  assert.equal(run.usage['child-thread'].total.inputTokens, 2);
  assert.equal(run.usage.workflow.values.inputTokens, 7);
  assert.equal(run.usage.turns.turns.find(row => row.agentId === 'child-thread').values.inputTokens, 2);
  assert.equal(run.hookInvocations.length, 1, 'source order pairs buffered hook start with live completion');
  assert.equal(run.hookInvocations[0].status, 'completed');
  assert.equal(run.hookInvocations[0].occurrenceIndex, 0);
  assert.equal(run.coverage.hooks, 'observed');
  assert.equal(JSON.stringify(run).includes('TEST_HOOK_SOURCE'), false);
});
