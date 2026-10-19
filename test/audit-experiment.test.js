import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, bind, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { observeAuditProfileAccess } from '../src/audit-profile.js';
import { previewAuditExperiment, runAuditExperiment } from '../src/audit-runner.js';
import { cleanAuditExperiment, recoverAuditExperiment, showAuditRecord } from '../src/audit-experiment.js';
import { readAuditRecord } from '../src/audit-experiment-store.js';
import { createExperiment, createExperimentRun, writeAuditState } from '../src/audit-experiment-store.js';
import { validateAuditSpec } from '../src/audit-spec.js';
import { authorizeAuditWorkspaceParent, createAuditWorkspace } from '../src/audit-workspace.js';
import { compareAuditRuns } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
import { evaluateAuditSeries, resumeAuditSeries, runAuditSeries } from '../src/audit-series.js';
import { auditQualityFingerprint } from '../src/audit-quality.js';

const execFile = promisify(execFileCallback);
const version = '0.162.0-alpha.17.2';
const cliPath = fileURLToPath(new URL('../bin/xfx.js', import.meta.url));

async function git(root, ...args) {
  return (await execFile('git', ['-C', root, ...args], { env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Audit Fixture', GIT_AUTHOR_EMAIL: 'audit-fixture@invalid',
    GIT_COMMITTER_NAME: 'Audit Fixture', GIT_COMMITTER_EMAIL: 'audit-fixture@invalid',
  } })).stdout.trim();
}

function appServer(counterPath, protocolErrorsPath, pauseOnTurnStartMarker = null, pausePidMarker = null) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const VERSION = ${JSON.stringify(version)};
const PAUSE_ON_TURN_START = ${JSON.stringify(pauseOnTurnStartMarker)};
const PAUSE_PID_MARKER = ${JSON.stringify(pausePidMarker)};
const { createServer } = require('node:http');
if (process.argv.includes('--version')) { process.stdout.write('codex-cli ' + VERSION + '\\n'); process.exit(0); }
const configArgs = process.argv.slice(2);
const configValues = [];
for (let i = 0; i < configArgs.length; i++) if (configArgs[i] === '-c') configValues.push(configArgs[++i] ?? '');
const exporterConfig = configValues.find(value => value.startsWith('otel.exporter=')) ?? '';
const endpoint = exporterConfig.match(/endpoint="(http:\\/\\/127\\.0\\.0\\.1:\\d+\\/v1\\/logs)"/)?.[1];
const token = exporterConfig.match(/"x-xfx-telemetry-token"="([a-f0-9]{64})"/)?.[1];
const event = (threadId, turnId, skillName, scope, invocationType = 'explicit', pluginId) => ({
  attributes: [
    ['event.name','codex.skill_invocation'],['conversation.id',threadId],['turn.id',turnId],
    ['skill.name',skillName],['skill.scope',scope],['skill.invocation_type',invocationType],
    ...(pluginId ? [['skill.plugin_id',pluginId]] : []),
  ].map(([key,stringValue])=>({key,value:{stringValue}})),
  timeUnixNano:'1760500000000000000',
});
async function sendTelemetry() {
  if (!endpoint || !token) return;
  const body = JSON.stringify({resourceLogs:[{scopeLogs:[{logRecords:[
    event('11111111-1111-4111-8111-111111111111','root-turn','shared','repo'),
    event('11111111-1111-4111-8111-111111111111','root-turn','shared','user','explicit','market/shared'),
    event('11111111-1111-4111-8111-111111111111','root-turn','shared','system','implicit'),
    event('22222222-2222-4222-8222-222222222222','child-turn','child-skill','repo'),
    event('foreign-thread','foreign-turn','uncatalogued-skill','repo'),
  ]}]}]});
  const response = await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-xfx-telemetry-token':token},body});
  fs.appendFileSync(${JSON.stringify(counterPath + '.telemetry')}, JSON.stringify({endpoint:!!endpoint,token:!!token,status:response.status}) + '\\n');
}

fs.appendFileSync(${JSON.stringify(counterPath)}, 'app-server\\n');
let buffer = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result}) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method,params}) + '\\n');
const reject = (id, message) => { fs.appendFileSync(${JSON.stringify(protocolErrorsPath)}, message + '\\n'); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32602,message:'invalid fixture request'}}) + '\\n'); };
const only = (params, keys) => Object.keys(params ?? {}).every(key => keys.includes(key));
const entries = cwd => {
  const home = process.env.HOME, codex = process.env.CODEX_HOME;
  return [
    {name:'shared',description:'PRIVATE_USER_SKILL_DESCRIPTION',enabled:true,path:path.join(home,'.agents/skills/shared/SKILL.md'),scope:'user'},
    {name:'shared',description:'PRIVATE_PROJECT_SKILL_DESCRIPTION',enabled:true,path:path.join(cwd,'.agents/skills/shared/SKILL.md'),scope:'repo'},
    {name:'shared',description:'PRIVATE_SYSTEM_SKILL_DESCRIPTION',enabled:true,path:path.join(codex,'skills/.system/shared/SKILL.md'),scope:'system'},
    {name:'shared',description:'PRIVATE_ADMIN_SKILL_DESCRIPTION',enabled:true,path:'/etc/codex/skills/shared/SKILL.md',scope:'admin'},
    {name:'shared',description:'PRIVATE_PLUGIN_SKILL_DESCRIPTION',enabled:true,path:path.join(codex,'plugins/cache/market/shared/skills/shared/SKILL.md'),scope:'user',pluginId:'market/shared'},
    {name:'child-skill',description:'PRIVATE_CHILD_SKILL_DESCRIPTION',enabled:true,path:path.join(cwd,'.agents/skills/child-skill/SKILL.md'),scope:'repo'}
  ];
};
function fail(id, message) { reject(id, message); }
async function respond(message) {
  const {id,method,params={}} = message;
  if (PAUSE_ON_TURN_START) fs.appendFileSync(PAUSE_ON_TURN_START + '.routes', String(method) + '\\n');
  if (id === undefined && method === 'initialized' && only(params,[])) return;
  if (method === 'initialize') {
    if (!only(params,['clientInfo','capabilities']) || params.clientInfo?.name !== 'xfx-audit' || params.clientInfo?.version !== '1' || params.capabilities?.experimentalApi !== true || !only(params.capabilities,['experimentalApi'])) return fail(id,'initialize-schema');
    return reply(id,{serverInfo:{name:'fixture-app-server',version:VERSION}});
  }
  if (method === 'skills/list') {
    if (!only(params,['cwds','forceReload']) || !Array.isArray(params.cwds) || params.cwds.length !== 1 || params.forceReload !== false) return fail(id,'skills-list-schema');
    const cwd = params.cwds[0];
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return fail(id,'skills-list-cwd');
    return reply(id,{data:[{cwd,skills:entries(cwd),errors:[]} ]});
  }
  if (method === 'thread/start') {
    if (!only(params,['ephemeral','experimentalRawEvents','sandbox','approvalPolicy','historyMode']) || !path.isAbsolute(process.cwd())
      || params.ephemeral !== false || params.experimentalRawEvents !== false || params.sandbox !== 'workspace-write'
      || params.approvalPolicy !== 'never' || params.historyMode !== 'paginated') return fail(id,'thread-start-schema');
    return reply(id,{cwd:process.cwd(),thread:{id:'11111111-1111-4111-8111-111111111111',sessionId:'root-session',cwd:process.cwd()},model:(fs.readFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'utf8').match(/^model\\s*=\\s*"([^"]+)"/m)||[])[1],reasoningEffort:'medium'});
  }
  if (method === 'turn/start') {
    const policy=params.sandboxPolicy;
    if (!only(params,['threadId','cwd','sandboxPolicy','approvalPolicy','input']) || params.threadId !== '11111111-1111-4111-8111-111111111111'
      || params.cwd !== process.cwd() || params.approvalPolicy !== 'never' || params.sandbox !== undefined
      || !Array.isArray(params.input) || !params.input.some(item => item.type === 'text')
      || !policy || policy.type !== 'workspaceWrite' || JSON.stringify(policy.writableRoots) !== JSON.stringify([params.cwd])
      || policy.networkAccess !== false || policy.excludeTmpdirEnvVar !== false || policy.excludeSlashTmp !== false) return fail(id,'turn-start-schema');
    const model=(fs.readFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'utf8').match(/^model\\s*=\\s*"([^"]+)"/m)||[])[1] ?? 'unknown';
    fs.writeFileSync(path.join(params.cwd,'result.txt'), 'model=' + model + '\\n', {mode:0o600});
    if (PAUSE_ON_TURN_START) fs.writeFileSync(PAUSE_ON_TURN_START, 'turn-started\\n', {flag:'wx',mode:0o600});
    reply(id,{turn:{id:'root-turn',status:'inProgress'}});
    notify('turn/started',{threadId:'11111111-1111-4111-8111-111111111111',turn:{id:'root-turn',status:'inProgress'}});
    for (const method of ['item/agentMessage/delta','item/commandExecution/outputDelta','turn/diff/updated','turn/moderationMetadata','thread/readState/changed'])
      notify(method,{threadId:'11111111-1111-4111-8111-111111111111',...(method==='thread/readState/changed'?{}:{turnId:'root-turn'}),
        itemId:'root-read',delta:'PRIVATE_STREAM_PAYLOAD',diff:'PRIVATE_STREAM_PATCH',metadata:{secret:'PRIVATE_MODERATION_PAYLOAD'},readState:'unread'});
    if (PAUSE_ON_TURN_START) { if (PAUSE_PID_MARKER) fs.writeFileSync(PAUSE_PID_MARKER,String(process.pid),{flag:'wx',mode:0o600}); setInterval(()=>{},1000); return; }
    const projectSkill=path.join(params.cwd,'.agents/skills/shared/SKILL.md');
    notify('item/completed',{threadId:'11111111-1111-4111-8111-111111111111',turnId:'root-turn',completedAtMs:20,item:{id:'root-read',type:'commandExecution',command:'cat .agents/skills/shared/SKILL.md',commandActions:[{type:'read',path:projectSkill}],cwd:params.cwd,status:'completed',exitCode:0,aggregatedOutput:'PRIVATE_TOOL_OUTPUT'}});
    notify('thread/tokenUsage/updated',{threadId:'11111111-1111-4111-8111-111111111111',turnId:'root-turn',tokenUsage:{last:{inputTokens:11,outputTokens:4,cachedInputTokens:2,reasoningOutputTokens:1,totalTokens:15},total:{inputTokens:11,outputTokens:4,cachedInputTokens:2,reasoningOutputTokens:1,totalTokens:15}}});
    notify('item/completed',{threadId:'11111111-1111-4111-8111-111111111111',turnId:'root-turn',completedAtMs:30,item:{id:'delegate-one',type:'collabAgentToolCall',receiverThreadIds:['22222222-2222-4222-8222-222222222222'],threadId:'11111111-1111-4111-8111-111111111111',prompt:'PRIVATE_DELEGATION_PROMPT'}});
    notify('turn/started',{threadId:'22222222-2222-4222-8222-222222222222',turn:{id:'child-turn',status:'inProgress'}});
    notify('thread/tokenUsage/updated',{threadId:'22222222-2222-4222-8222-222222222222',turnId:'child-turn',tokenUsage:{last:{inputTokens:3,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:1,totalTokens:5},total:{inputTokens:3,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:1,totalTokens:5}}});
    notify('turn/completed',{threadId:'22222222-2222-4222-8222-222222222222',turn:{id:'child-turn',status:'completed'}});
    notify('turn/completed',{threadId:'11111111-1111-4111-8111-111111111111',turn:{id:'root-turn',status:'completed'}});
    notify('mcpServer/startupStatus/updated',{name:'fixture-mcp',status:'ready'});
    notify('item/started',{threadId:'11111111-1111-4111-8111-111111111111',turnId:'root-turn',startedAtMs:25,item:{id:'mcp-call',type:'mcpToolCall',server:'fixture-mcp',tool:'lookup',pluginId:'fixture-plugin',arguments:'PRIVATE_MCP_ARGUMENTS'}});
    notify('item/completed',{threadId:'11111111-1111-4111-8111-111111111111',turnId:'root-turn',completedAtMs:35,item:{id:'mcp-call',type:'mcpToolCall',server:'fixture-mcp',tool:'lookup',pluginId:'fixture-plugin',status:'completed',result:'PRIVATE_MCP_RESULT'}});
    notify('item/completed',{threadId:'22222222-2222-4222-8222-222222222222',turnId:'child-turn',completedAtMs:45,item:{id:'dynamic-call',type:'dynamicToolCall',namespace:'fixture',tool:'inspect',success:true,arguments:'PRIVATE_DYNAMIC_ARGUMENTS'}});
    await sendTelemetry();
    return;
  }
  if (method === 'thread/read') {
    if (!only(params,['threadId','includeTurns']) || params.threadId !== '22222222-2222-4222-8222-222222222222' || params.includeTurns !== false) return fail(id,'thread-read-schema');
    return reply(id,{thread:{id:'22222222-2222-4222-8222-222222222222',parentThreadId:'11111111-1111-4111-8111-111111111111',sessionId:'root-session',cwd:path.join(process.cwd(),'child'),status:{type:'idle'}}});
  }
  if (method === 'thread/items/list') {
    if (!only(params,['threadId','cursor','limit']) || params.threadId !== '22222222-2222-4222-8222-222222222222' || !Number.isInteger(params.limit) || params.cursor !== undefined) return fail(id,'items-list-schema');
    const cwd=path.join(process.cwd(),'child'), skillPath=path.join(cwd,'.agents/skills/child-skill/SKILL.md');
    return reply(id,{data:[{turnId:'child-turn',startedAtMs:40,completedAtMs:50,item:{id:'child-read',type:'commandExecution',command:'cat .agents/skills/child-skill/SKILL.md',commandActions:[{type:'read',path:skillPath}],cwd,status:'completed',exitCode:0,aggregatedOutput:'PRIVATE_CHILD_TOOL_OUTPUT'}}],nextCursor:null});
  }
  return fail(id,'unsupported-method:' + String(method));
}
let pending = Promise.resolve();
process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const i=buffer.indexOf('\\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line){pending=pending.then(()=>respond(JSON.parse(line))).catch(error=>{fs.appendFileSync(${JSON.stringify(protocolErrorsPath)},'parse-or-handler-error\\n');process.exitCode=2;});}}});
process.stdin.on('end',()=>pending.finally(()=>process.exit(process.exitCode ?? 0)));
`;
}

async function runObserveAccessFixture(profile, options = {}) {
  const result = await observeAuditProfileAccess(profile, { ...options, inspectResources: async () => [] });
  let auditLeaseHeld = false;
  if (options.store && profile?.home) {
    const leases = await readdir(join(options.store.directory, 'audits', 'leases')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const leaseName = createHash('sha256').update(profile.home).digest('hex');
    auditLeaseHeld = leases.includes(leaseName);
  }
  options.onObserved?.({ profile: profile?.profileName, status: result.status, clients: result.clients,
    sourceReservation: result.sourceReservation, auditLeaseHeld });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.deepEqual(result.clients, []);
  assert.equal(result.sourceReservation, null);
  return result;
}

async function fixture(t, { pauseOnTurnStartMarker = null, pauseOnTurnStartPidMarker = null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-experiment-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'source'); await mkdir(repo, { mode: 0o700 });
  await git(repo, 'init', '--quiet');
  await git(repo, 'config', 'user.name', 'Audit Fixture');
  await git(repo, 'config', 'user.email', 'audit-fixture@invalid');
  const sharedSkill = join(repo, '.agents', 'skills', 'shared', 'SKILL.md');
  const childSkill = join(repo, 'child', '.agents', 'skills', 'child-skill', 'SKILL.md');
  await mkdir(dirname(sharedSkill), { recursive: true, mode: 0o700 });
  await mkdir(dirname(childSkill), { recursive: true, mode: 0o700 });
  await writeFile(sharedSkill, 'PRIVATE_REPOSITORY_SKILL_BODY\n', { mode: 0o600 });
  await writeFile(childSkill, 'PRIVATE_CHILD_SKILL_BODY\n', { mode: 0o600 });
  await writeFile(join(repo, 'README.md'), 'same committed baseline\n', { mode: 0o600 });
  await git(repo, 'add', '-A'); await git(repo, 'commit', '-qm', 'fixture baseline');
  const commit = await git(repo, 'rev-parse', 'HEAD');
  const counter = join(root, 'app-server-launches.txt'), protocolErrors = join(root, 'protocol-errors.txt'), telemetry = `${counter}.telemetry`;
  const executable = join(root, 'fake-codex');
  await writeFile(executable, appServer(counter, protocolErrors, pauseOnTurnStartMarker, pauseOnTurnStartPidMarker), { mode: 0o700 });
  const native = await Promise.all(['alpha','beta'].map(name => prepareNativeHome({
    directory: join(root, `native-${name}`), executable, codexVersion: version,
  })));
  const storeDirectory = join(root, 'store'); await mkdir(storeDirectory, { mode: 0o700 });
  const store = new Store(storeDirectory);
  await store.update(async data => {
    create(data, 'Alpha'); create(data, 'Beta');
    await bind(data, 'Alpha', repo); await bind(data, 'Beta', repo);
  });
  for (const [index, name] of ['Alpha','Beta'].entries()) {
    await registerHome(store, name, native[index].root, { executable, version });
    await writeFile(join(native[index].home, 'config.toml'), `model = "model-${name.toLowerCase()}"\nmodel_reasoning_effort = "medium"\ncli_auth_credentials_store = "file"\nsqlite_home = ${JSON.stringify(native[index].home)}\n`, { mode: 0o600 });
    await writeFile(join(native[index].home, 'auth.json'), `{"api_key":"PRIVATE_PROFILE_SECRET_${name}"}\n`, { mode: 0o600 });
  }
  const savedStore = await readFile(store.file);
  const savedConfigs = await Promise.all(native.map(home => readFile(join(home.home, 'config.toml'))));
  const savedAuth = await Promise.all(native.map(home => readFile(join(home.home, 'auth.json'))));
  const spec = { schemaVersion: 1, repository: repo, revision: commit, task: 'Write result.txt from the selected profile model.',
    profiles: [{ name: 'Alpha' }, { name: 'Beta' }], limits: { runMs: 30000, experimentMs: 90000, outputBytes: 1024 * 1024 },
    checks: [{ name: 'mutating-check', argv: [process.execPath, '-e', "const fs=require('node:fs');fs.appendFileSync('result.txt','check-end\\n');process.exit(fs.readFileSync('result.txt','utf8').includes('model-beta')?9:0)"], timeoutMs: 10000 }],
    sandbox: 'workspace-write', allowIncompleteCapture: true };
  return { root, repo, commit, counter, protocolErrors, telemetry, executable, native, store, savedStore, savedConfigs, savedAuth, spec };
}

async function launchCount(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

async function waitForPidExit(pid, timeoutMs = 5000) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture-owned child process ${pid} did not exit after coordinator EOF`);
}

async function waitForFile(path, child, readStderr, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (child.exitCode !== null) throw new Error(`Coordinator exited before its persisted-phase gate: ${readStderr()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for persisted-phase gate: ${readStderr()}`);
}

function recoveryWorkerSource() {
  const storeUrl = new URL('../src/profiles.js', import.meta.url).href;
  const recoveryUrl = new URL('../src/audit-experiment.js', import.meta.url).href;
  return `import { Store } from ${JSON.stringify(storeUrl)};
import { recoverAuditExperiment } from ${JSON.stringify(recoveryUrl)};
const [directory, id] = process.argv.slice(2);
const store = new Store(directory);
const result = await recoverAuditExperiment(store, id, { apply: true });
process.stdout.write(JSON.stringify(result));
`;
}

function seriesCoordinatorSource() {
  const storeUrl = new URL('../src/profiles.js', import.meta.url).href;
  const seriesUrl = new URL('../src/audit-series.js', import.meta.url).href;
  const accessUrl = new URL('../src/audit-profile.js', import.meta.url).href;
  return `import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from ${JSON.stringify(storeUrl)};
import { runAuditSeries } from ${JSON.stringify(seriesUrl)};
import { observeAuditProfileAccess } from ${JSON.stringify(accessUrl)};
const [storeDirectory, specPath, readyPath] = process.argv.slice(2);
const store = new Store(storeDirectory), spec = JSON.parse(await readFile(specPath, 'utf8'));
const access = (profile, options) => observeAuditProfileAccess(profile, { ...options, store, inspectResources: async () => [] });
await runAuditSeries(store, spec, { baseDirectory: join(store.directory, 'audits'), observeAccess: access,
  onTrialComplete: async ({ seriesId, slot, report }) => {
    if (slot.index !== 1) return;
    await writeFile(readyPath, JSON.stringify({ seriesId, trialIndex: slot.index, childId: report.id, pid: process.pid }), { flag: 'wx', mode: 0o600 });
    setInterval(() => {}, 1000); await new Promise(() => {});
  } });
`;
}

function repeatedSpec(f) {
  return { ...f.spec,
    task: 'Write one result file from the selected profile model.',
    checks: [{ name: 'optional-diagnostic', argv: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 1000 }, ...f.spec.checks],
    quality: { id: 'result-contract', version: '1', checks: [{ name: 'optional-diagnostic', required: false }, { name: 'mutating-check', required: true }],
      workspace: { maxChangedFiles: 1 },
      rubric: { id: 'human-review', version: '1', required: false,
        criteria: [{ id: 'correctness', label: 'Correctness', maxScore: 5 }] } },
    trials: { count: 3, order: 'balanced', budgetMs: 90000 }, variables: ['profile-model'] };
}

function coordinatorWorkerSource() {
  const storeUrl = new URL('../src/profiles.js', import.meta.url).href;
  const runnerUrl = new URL('../src/audit-runner.js', import.meta.url).href;
  const stateUrl = new URL('../src/audit-experiment-store.js', import.meta.url).href;
  return `import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from ${JSON.stringify(storeUrl)};
import { runAuditExperiment } from ${JSON.stringify(runnerUrl)};
import { writeAuditState, writeAuditCaptureCheckpoint, finalizeAuditRecord, readAuditRecord } from ${JSON.stringify(stateUrl)};
import { observeAuditProfileAccess } from ${JSON.stringify(new URL('../src/audit-profile.js', import.meta.url).href)};
const [storeDirectory, specPath, stage, readyPath, nativeStartedPath] = process.argv.slice(2);
const store = new Store(storeDirectory), spec = JSON.parse(await readFile(specPath, 'utf8'));
const access = (profile, options) => observeAuditProfileAccess(profile, { ...options, store, inspectResources: async () => [] });
let held = false;
async function gate(id, phase) {
  const current = await readAuditRecord(store, id);
  const experimentId = current.record.kind === 'audit-experiment-run' ? current.record.experimentId : id;
  await writeFile(readyPath, JSON.stringify({ experimentId, id, phase, coordinatorPid: process.pid }), { flag: 'wx', mode: 0o600 });
  held = true;
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
async function persistState(targetStore, id, patch) {
  await writeAuditState(targetStore, id, patch);
  if (held || !patch || typeof patch !== 'object') return;
  if (stage === 'setup' && patch.phase === 'setup') return gate(id, 'setup');
  if (stage === 'task' && patch.phase === 'task' && Number.isSafeInteger(patch.process?.pid)) {
    return gate(id, 'task');
  }
}
async function writeCaptureCheckpoint(targetStore, id, payload) {
  const checkpoint = await writeAuditCaptureCheckpoint(targetStore, id, payload);
  if (stage === 'capture' && payload.run?.agents?.length >= 2) await gate(id, 'capture');
  return checkpoint;
}
async function finalize(targetStore, id, report) {
  const current = await readAuditRecord(targetStore, id);
  if (stage === 'finalization' && current.record.kind === 'audit-experiment') return gate(id, 'finalization');
  return finalizeAuditRecord(targetStore, id, report);
}
const result = await runAuditExperiment(store, spec, { baseDirectory: join(store.directory, 'audits'), observeAccess: access,
  writeState: persistState, writeCaptureCheckpoint, finalize });
if (!held) throw new Error('Coordinator stopped before fixture gate: ' + JSON.stringify({
  status: result.status, failureCodes: (result.failures ?? []).map(failure => failure.code) }));
`;
}

function invokeCLI(storeDirectory, ...args) {
  const result = spawnSync(process.execPath, [cliPath, '--store', storeDirectory, '--json', ...args], { encoding: 'utf8', timeout: 60000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('experiment specifications reject ambiguous profiles, unsupported fields, and unbounded commands', () => {
  const base = { schemaVersion: 1, repository: '/tmp/repository', revision: 'HEAD', task: 'Compare setup behavior.', profiles: ['Alpha', 'Beta'] };
  assert.equal(validateAuditSpec(base).profiles.length, 2);
  assert.throws(() => validateAuditSpec({ ...base, ignored: true }), /unsupported experiment specification field/);
  assert.throws(() => validateAuditSpec({ ...base, profiles: ['Alpha', 'alpha'] }), /distinct plain profile names/);
  assert.throws(() => validateAuditSpec({ ...base, checks: [{ name: 'empty', argv: [] }] }), /unique name and argv array/);
  assert.throws(() => validateAuditSpec({ ...base, limits: { outputBytes: 64 * 1024 * 1024 + 1 } }), /outputBytes must be an integer/);
});

test('CLI rejects malformed experiment JSON without reflecting private input', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-spec-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = join(root, 'private-spec.json');
  await writeFile(spec, '{"task": "PRIVATE_EXPERIMENT_TASK", PRIVATE_INVALID_JSON', { mode: 0o600 });
  const result = invokeCLI(root, 'audit', 'run', '--spec', spec, '--dry-run');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /valid UTF-8 JSON/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_EXPERIMENT_TASK|PRIVATE_INVALID_JSON/);
});

test('runs a real bounded two-profile experiment, retains task-end evidence before mutating checks, and supports resume-safe reports', async t => {
  const f = await fixture(t);
  const accessObservations = [];
  const context = { baseDirectory: join(f.store.directory, 'audits'),
    observeAccess: (profile, options) => runObserveAccessFixture(profile, { ...options, store: f.store,
      onObserved: observation => accessObservations.push(observation) }) };
  const preview = await previewAuditExperiment(f.store, f.spec, context);
  assert.equal(preview.status, 'ready', JSON.stringify({ preview, accessObservations }, null, 2));
  const result = await runAuditExperiment(f.store, f.spec, context);
  assert.equal(result.kind, 'audit-experiment-report', JSON.stringify(result, null, 2));
  assert.equal(result.runs.length, 2);
  assert.deepEqual(result.execution.order, ['Alpha', 'Beta']);
  assert.equal(result.execution.parallelism, 1);
  assert.equal(result.execution.retries, 0);
  assert.equal(result.exitCode, 4);
  assert.equal(result.status, 'failed');
  assert.ok(accessObservations.some(item => item.auditLeaseHeld && item.sourceReservation === null),
    'the audit-only lease is active without being misreported as a native client reservation');
  assert.deepEqual(await readFile(f.store.file), f.savedStore);
  assert.deepEqual(await Promise.all(f.native.map(home => readFile(join(home.home, 'config.toml')))), f.savedConfigs);
  assert.deepEqual(await Promise.all(f.native.map(home => readFile(join(home.home, 'auth.json')))), f.savedAuth);
  const launchCountAfterRuns = await launchCount(f.counter);
  assert.ok(launchCountAfterRuns >= 2);
  const telemetryLog = (await readFile(f.telemetry, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(telemetryLog.length, 2);
  assert.ok(telemetryLog.every(item => item.endpoint && item.token && item.status === 200));
  assert.equal(await readFile(f.protocolErrors, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), '');
  assert.equal(await git(f.repo, 'status', '--porcelain=v1'), '');
  for (const home of f.native) await assert.rejects(stat(join(home.root, '.run-lock')), { code: 'ENOENT' });

  const [alpha, beta] = result.runs;
  assert.equal(alpha.profile.profileName, 'Alpha'); assert.equal(beta.profile.profileName, 'Beta');
  assert.equal(alpha.sourceWorkspace.sourceCommit, f.commit); assert.equal(beta.sourceWorkspace.sourceCommit, f.commit);
  const alphaRecord = await readAuditRecord(f.store, alpha.id), betaRecord = await readAuditRecord(f.store, beta.id);
  const alphaReport = alphaRecord.report, betaReport = betaRecord.report;
  assert.ok(alphaReport && betaReport);
  for (const record of [alphaRecord, betaRecord]) {
    assert.equal(record.finalized, true, 'the report is finalized only after its audit lease has been released');
    assert.equal(record.state.reservation, null, 'released reservation state is durably cleared');
    const heldLeases = await readdir(join(f.store.directory, 'audits', 'leases'));
    const profileHome = record.record.profile.home ?? record.record.profile.userHome;
    const leaseName = createHash('sha256').update(profileHome).digest('hex');
    assert.ok(!heldLeases.includes(leaseName), 'no audit-only lease remains after successful finalization');
  }
  assert.equal(alphaReport.source.kind, 'native-app-server-v2');
  assert.equal(alphaReport.source.version, version);
  assert.deepEqual(new Set(alphaReport.skills.map(skill => skill.scope)), new Set(['user','project','system','admin']));
  assert.ok(alphaReport.skills.some(skill => skill.origin === 'plugin' && skill.provider === 'market/shared'));
  assert.deepEqual(new Set(alphaReport.agents.map(agent => agent.id)), new Set(['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']));
  assert.equal(alphaReport.agents.find(agent => agent.id === '22222222-2222-4222-8222-222222222222').parentId, '11111111-1111-4111-8111-111111111111');
  assert.equal(alphaReport.usage['11111111-1111-4111-8111-111111111111'].last.inputTokens, 11);
  assert.equal(alphaReport.usage['22222222-2222-4222-8222-222222222222'].last.outputTokens, 2);
  assert.equal(alphaReport.usage.total, null);
  assert.equal(alphaReport.skillInvocations.length, 5, JSON.stringify({ invocations: alphaReport.skillInvocations,
    telemetry: alphaReport.skillTelemetry, capture: alphaReport.capture, warnings: alphaReport.warnings,
    agents: alphaReport.agents, events: alphaReport.events }, null, 2));
  assert.equal(alphaReport.skillInvocations.filter(item => item.resolution === 'catalogued').length, 4);
  assert.equal(alphaReport.skillInvocations.find(item => item.unattributedActorId === 'foreign-thread')?.resolution, 'unattributed');
  assert.ok(alphaReport.skillInvocations.some(item => item.agentId === '11111111-1111-4111-8111-111111111111' && item.scope === 'repo' && item.resolution === 'catalogued'));
  assert.ok(alphaReport.skillInvocations.some(item => item.agentId === '11111111-1111-4111-8111-111111111111' && item.pluginId === 'market/shared' && item.resolution === 'catalogued'));
  assert.ok(alphaReport.skillInvocations.some(item => item.agentId === '11111111-1111-4111-8111-111111111111' && item.scope === 'system' && item.invocationType === 'implicit'));
  assert.ok(alphaReport.skillInvocations.some(item => item.agentId === '22222222-2222-4222-8222-222222222222' && item.skillName === 'child-skill'));
  assert.equal(alphaReport.skillTelemetry.delivery, 'best-effort');
  assert.match(alphaReport.skillTelemetry.boundary, /not exhaustive/);
  assert.equal(alphaReport.toolInvocations.length, 5, JSON.stringify(alphaReport.toolInvocations, null, 2));
  assert.ok(alphaReport.toolInvocations.some(item => item.kind === 'mcp' && item.agentId === '11111111-1111-4111-8111-111111111111' && item.status === 'completed'));
  assert.ok(alphaReport.toolInvocations.some(item => item.kind === 'dynamic' && item.agentId === '22222222-2222-4222-8222-222222222222'));
  assert.equal(alphaReport.mcp.servers.find(server => server.name === 'fixture-mcp')?.status, 'ready');
  assert.equal(alphaReport.mcp.inventory, 'not-requested');
  const childSkill = alphaReport.skills.find(skill => skill.name === 'child-skill' && skill.catalogs?.some(catalog => catalog.agentId === '22222222-2222-4222-8222-222222222222'));
  assert.ok(childSkill?.observations.some(observation => observation.agentId === '22222222-2222-4222-8222-222222222222'),
    JSON.stringify({ skills: alphaReport.skills.filter(skill => skill.name === 'child-skill').map(skill => ({ path: skill.path, catalogs: skill.catalogs, observations: skill.observations })), capture: alphaReport.capture }, null, 2));
  assert.equal(alpha.outcome.status, 'passed');
  assert.equal(beta.outcome.status, 'failed');
  assert.equal(beta.checks[0].status, 'failed');
  assert.equal(beta.checks[0].exitCode, 9);
  assert.equal(betaReport.outcome.status, 'failed');
  for (const run of [alphaReport, betaReport]) {
    assert.equal(run.outcome.task.status, 'passed');
    assert.equal(run.coverage.outcome, 'complete', 'passed and failed declared checks are both evaluated');
    assert.equal(run.coverage.skills, 'partial');
    assert.equal(run.warnings.includes('unknown-native-event'), false);
    assert.ok(run.events.some(event => event.kind === 'item/agentMessage/delta'));
    assert.doesNotMatch(JSON.stringify(run), /PRIVATE_STREAM_PAYLOAD|PRIVATE_STREAM_PATCH|PRIVATE_MODERATION_PAYLOAD/);
  }
  assert.equal(result.coverage.outcomes, 'complete');
  assert.match(await readFile(alpha.taskEnd.patchPath, 'utf8'), /model=model-alpha/);
  assert.doesNotMatch(await readFile(alpha.taskEnd.patchPath, 'utf8'), /check-end/);
  assert.match(await readFile(alpha.finalWorkspace.patchPath, 'utf8'), /check-end/);
  assert.match(await readFile(beta.taskEnd.patchPath, 'utf8'), /model=model-beta/);
  assert.doesNotMatch(await readFile(beta.taskEnd.patchPath, 'utf8'), /check-end/);
  assert.match(await readFile(beta.finalWorkspace.patchPath, 'utf8'), /check-end/);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(alphaReport) + JSON.stringify(betaReport),
    /PRIVATE_(?:USER|PROJECT|SYSTEM|ADMIN|PLUGIN|CHILD|REPOSITORY)_SKILL_(?:DESCRIPTION|BODY)|PRIVATE_PROFILE_SECRET|PRIVATE_TOOL_OUTPUT|PRIVATE_DELEGATION_PROMPT|PRIVATE_MCP_(?:ARGUMENTS|RESULT)|PRIVATE_DYNAMIC_ARGUMENTS|x-xfx-telemetry-token|127\.0\.0\.1:\d+/);

  const shown = await showAuditRecord(f.store, result.id);
  assert.equal(shown.kind, 'audit-experiment-report'); assert.equal(shown.id, result.id);
  const shownRun = await showAuditRecord(f.store, alpha.id);
  assert.equal(shownRun.kind, 'audit-run'); assert.equal(shownRun.id, alpha.id);
  const compared = compareAuditRuns(alphaReport, betaReport);
  assert.equal(compared.kind, 'audit-comparison');
  const cliShow = invokeCLI(f.store.directory, 'audit', 'show', result.id);
  assert.equal(cliShow.status, 4, cliShow.stderr);
  assert.equal(JSON.parse(cliShow.stdout).kind, 'audit-experiment-report');
  const cliRunShow = invokeCLI(f.store.directory, 'audit', 'show', alpha.id);
  assert.equal(cliRunShow.status, 2, cliRunShow.stderr);
  assert.equal(JSON.parse(cliRunShow.stdout).skillInvocations.length, 5);
  assert.equal(JSON.parse(cliRunShow.stdout).toolInvocations.length, 5);
  assert.equal(JSON.parse(cliRunShow.stdout).coverage.outcome, 'complete');
  assert.equal(JSON.parse(cliRunShow.stdout).mcp.servers.find(server => server.name === 'fixture-mcp')?.status, 'ready');
  assert.doesNotMatch(cliShow.stdout + cliShow.stderr,
    /PRIVATE_(?:USER|PROJECT|SYSTEM|ADMIN|PLUGIN|CHILD|REPOSITORY)_SKILL_(?:DESCRIPTION|BODY)|PRIVATE_PROFILE_SECRET|PRIVATE_TOOL_OUTPUT|PRIVATE_DELEGATION_PROMPT|PRIVATE_MCP_(?:ARGUMENTS|RESULT)|PRIVATE_DYNAMIC_ARGUMENTS|x-xfx-telemetry-token|127\.0\.0\.1:\d+/);
  const cliDiff = invokeCLI(f.store.directory, 'audit', 'diff', alpha.id, beta.id);
  assert.equal(cliDiff.status, 2, cliDiff.stderr);
  const cliDiffReport = JSON.parse(cliDiff.stdout);
  assert.equal(cliDiffReport.kind, 'audit-comparison');
  assert.equal(cliDiffReport.comparison.skillInvocations.left.observedCount, 5);
  const exported = await exportAuditReport(shownRun, { output: join(f.root, 'alpha.json'), format: 'json' });
  assert.equal((await readAuditReport(exported.evidencePath)).id, alpha.id);
  const reopened = await readAuditReport(exported.evidencePath);
  assert.equal(reopened.skillInvocations.length, 5);
  assert.equal(reopened.toolInvocations.length, 5);
  assert.equal(reopened.coverage.outcome, 'complete');
  assert.equal(reopened.coverage.skills, 'partial');
  assert.ok(reopened.events.some(event => event.kind === 'turn/moderationMetadata'));
  assert.equal(reopened.mcp.servers.find(server => server.name === 'fixture-mcp')?.status, 'ready');
  const cliExportPath = join(f.root, 'cli-alpha.json');
  const cliExport = invokeCLI(f.store.directory, 'audit', 'export', alpha.id, '--output', cliExportPath, '--format', 'json');
  assert.equal(cliExport.status, 2, cliExport.stderr);
  assert.equal(JSON.parse(cliExport.stdout).kind, 'audit-export');
  assert.equal((await readAuditReport(cliExportPath)).id, alpha.id);
  assert.equal((await readAuditReport(cliExportPath)).skillInvocations.length, 5);
  assert.equal((await readAuditReport(cliExportPath)).toolInvocations.length, 5);
  assert.equal((await readAuditReport(cliExportPath)).coverage.outcome, 'complete');
  assert.doesNotMatch(cliShow.stdout + cliRunShow.stdout + cliDiff.stdout + cliExport.stdout
    + await readFile(cliExportPath, 'utf8'),
    /PRIVATE_MCP_(?:ARGUMENTS|RESULT)|PRIVATE_DYNAMIC_ARGUMENTS|x-xfx-telemetry-token|127\.0\.0\.1:\d+/);
  const frozenDiff = compareAuditRuns(await readAuditReport(exported.evidencePath), await readAuditReport(exported.evidencePath));
  assert.equal(frozenDiff.left.id, alpha.id); assert.equal(frozenDiff.right.id, alpha.id);
  assert.equal(frozenDiff.left.skillInvocations.length, 5);

  const previewClean = await cleanAuditExperiment(f.store, result.id);
  assert.equal(previewClean.status, 'preview');
  const alphaState = (await readAuditRecord(f.store, alpha.id)).state;
  const betaState = (await readAuditRecord(f.store, beta.id)).state;
  await writeFile(join(alphaState.workspace.directory, 'tampered-after-finalization.txt'), 'foreign change');
  const tamperedPreview = await cleanAuditExperiment(f.store, result.id);
  assert.equal(tamperedPreview.status, 'blocked');
  assert.ok(tamperedPreview.actions.some(action => action.runId === alpha.id && action.status === 'blocked'));
  const cleaned = await cleanAuditExperiment(f.store, result.id, { apply: true });
  assert.equal(cleaned.status, 'blocked');
  assert.ok(cleaned.actions.some(action => action.runId === alpha.id && action.status === 'blocked'));
  await stat(alphaState.workspace.directory);
  if (cleaned.actions.some(action => action.runId === beta.id && action.status === 'cleaned'))
    await assert.rejects(stat(betaState.workspace.directory), { code: 'ENOENT' });
  assert.equal(await launchCount(f.counter), launchCountAfterRuns);
});

test('reconciles a dead coordinator from persisted workspace evidence without rerunning native work; preserves uncertain owners', async t => {
  const f = await fixture(t);
  const spec = { ...f.spec, profiles: [{ name: 'Alpha' }, { name: 'Beta' }], checks: [], setup: [] };
  const experiment = await createExperiment(f.store, { spec, task: 'Interrupted task fixture', profiles: [], baseline: { repository: f.repo, commit: f.commit } });
  const run = await createExperimentRun(f.store, { experimentId: experiment.id,
    profile: { profileId: 'fixture-profile', profileName: 'Alpha', home: f.native[0].home } });
  const owner = { experimentId: experiment.id, runId: run.id };
  const baseDirectory = join(f.store.directory, 'audits');
  await authorizeAuditWorkspaceParent({ parentDirectory: run.directory, baseDirectory, owner });
  const workspace = await createAuditWorkspace({ repository: f.repo, commit: f.commit,
    directory: join(run.directory, 'workspace'), owner });
  await writeFile(join(workspace.directory, 'interrupted-result.txt'), 'partial task output\n', { mode: 0o600 });
  const deadPid = 987654321;
  const stoppedCoordinator = { pid: deadPid, host: hostname(), processIdentity: null };
  await writeAuditState(f.store, run.id, { status: 'running', phase: 'task', coordinator: stoppedCoordinator,
    process: { pid: deadPid, host: hostname() }, workspace: { directory: workspace.directory, owner, active: true } });
  await writeAuditState(f.store, experiment.id, { status: 'running', phase: 'task', coordinator: stoppedCoordinator });
  const telemetryJournal = join(run.directory, 'skill-telemetry.jsonl');
  await writeFile(telemetryJournal, [
    JSON.stringify({ source: 'native-otel-skill-invocation', threadId: 'unknown-recovery-thread', turnId: 'recovery-turn',
      skillName: 'recovered-skill', scope: 'repo', invocationType: 'explicit', timestampNs: '1760500000000000000' }),
    '{"source":"native-otel-skill-invocation","threadId":"truncated',
  ].join('\n'), { flag: 'wx', mode: 0o600 });

  const before = await launchCount(f.counter);
  const recovered = await recoverAuditExperiment(f.store, experiment.id, { apply: true });
  assert.equal(recovered.status, 'recovered', JSON.stringify(recovered, null, 2));
  assert.equal(recovered.runs[0].execution.recovery, 'process-stopped-no-rerun');
  assert.equal(recovered.runs[0].skillInvocations?.[0]?.resolution, 'unattributed');
  assert.equal(recovered.runs[0].skillInvocations?.[0]?.unattributedActorId, 'unknown-recovery-thread');
  assert.ok(recovered.runs[0].skillTelemetry?.warnings.includes('telemetry-journal-truncated-tail'));
  assert.ok(recovered.runs[0].skillTelemetry?.warnings.includes('skill-telemetry-recovered-partial'));
  const recoveredSnapshot = recovered.runs[0].artifacts.find(item => item.kind === 'audit-workspace-snapshot');
  assert.ok(recoveredSnapshot, JSON.stringify(recovered, null, 2));
  assert.match(await readFile(recoveredSnapshot.patchPath, 'utf8'), /interrupted-result/);
  assert.equal((await readAuditRecord(f.store, run.id)).state.workspace.active, false);
  assert.equal(await launchCount(f.counter), before, 'restart recovery must never relaunch the native task');
  const repeated = await recoverAuditExperiment(f.store, experiment.id, { apply: true });
  assert.equal(repeated.status, 'recovered');
  assert.equal(await launchCount(f.counter), before, 'recovery is idempotent and does not rerun the app-server');
  const cleaned = await cleanAuditExperiment(f.store, experiment.id, { apply: true });
  assert.equal(cleaned.status, 'cleaned');
  await assert.rejects(stat(workspace.directory), { code: 'ENOENT' });

  const uncertain = await createExperiment(f.store, { spec, task: 'Uncertain ownership fixture', profiles: [] });
  const candidates = [
    { label: 'live', coordinator: { pid: process.pid, host: hostname() } },
    { label: 'foreign', coordinator: { pid: deadPid, host: 'foreign-host' } },
    { label: 'unknown', coordinator: {} },
  ];
  const uncertainRuns = [];
  for (const item of candidates) {
    const pending = await createExperimentRun(f.store, { experimentId: uncertain.id,
      profile: { profileId: `fixture-${item.label}`, profileName: item.label, home: f.native[0].home } });
    uncertainRuns.push(pending);
    await writeAuditState(f.store, pending.id, { status: 'running', phase: 'task', coordinator: item.coordinator, process: null });
  }
  const uncertainResult = await recoverAuditExperiment(f.store, uncertain.id, { apply: true });
  assert.equal(uncertainResult.status, 'blocked');
  assert.ok(uncertainResult.actions.every(action => action.status === 'blocked'));
  const untouched = await cleanAuditExperiment(f.store, uncertain.id);
  assert.equal(untouched.status, 'blocked');
  assert.ok(untouched.actions.every(action => action.status === 'blocked'));
  for (const pending of uncertainRuns) assert.equal((await readAuditRecord(f.store, pending.id)).finalized, false);
  assert.equal(await launchCount(f.counter), before);
});

test('recovers after killing the owned coordinator at setup, task, capture, and finalization checkpoints', async t => {
  for (const phase of ['setup', 'task', 'capture', 'finalization']) await t.test(phase, async subtest => {
    const markerRoot = await realpath(await mkdtemp(join(tmpdir(), `xfx-audit-crash-${phase}-`)));
    subtest.after(() => rm(markerRoot, { recursive: true, force: true }));
    const nativeStarted = join(markerRoot, 'native-task-started');
    const f = await fixture(subtest, { pauseOnTurnStartMarker: phase === 'task' ? nativeStarted : null });
    const spec = { ...f.spec, task: `Crash-window fixture at ${phase}.`, setup: [], checks: [] };
    const specPath = join(f.root, `crash-${phase}.json`);
    await writeFile(specPath, JSON.stringify(spec), { flag: 'wx', mode: 0o600 });
    const workerPath = join(f.root, `coordinator-${phase}.mjs`), readyPath = join(f.root, `persisted-${phase}.json`);
    await writeFile(workerPath, coordinatorWorkerSource(), { flag: 'wx', mode: 0o600 });
    let stderr = '';
    let coordinator = spawn(process.execPath, [workerPath, f.store.directory, specPath, phase, readyPath, nativeStarted], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    subtest.after(async () => {
      if (!coordinator || coordinator.exitCode !== null || coordinator.signalCode !== null) return;
      coordinator.kill('SIGKILL');
      try { await once(coordinator, 'close'); } catch {}
      try {
        const readyState = JSON.parse(await readFile(readyPath, 'utf8'));
        const record = await readAuditRecord(f.store, readyState.id);
        if (record.state.process?.pid) await waitForPidExit(record.state.process.pid, 3000);
      } catch {}
    });
    coordinator.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    let ready;
    try { ready = await waitForFile(readyPath, coordinator, () => stderr, 18000); }
    catch (error) {
      const launches = await readFile(f.counter, 'utf8').catch(() => 'none');
      const protocol = await readFile(f.protocolErrors, 'utf8').catch(() => 'none');
      const routes = await readFile(nativeStarted + '.routes', 'utf8').catch(() => 'none');
      error.message += `\nlaunches=${launches}\nprotocol=${protocol}\nroutes=${routes}`;
      throw error;
    }
    assert.equal(ready.phase, phase);
    assert.ok(ready.experimentId);
    const experiment = await readAuditRecord(f.store, ready.experimentId);
    const runIds = (experiment.state.runs ?? []).map(item => item.id);
    assert.equal(runIds.length, 2);
    const crashedRunId = phase === 'finalization' ? runIds[0] : ready.id;
    const beforeKill = await readAuditRecord(f.store, crashedRunId);
    if (phase === 'setup') {
      assert.equal(beforeKill.state.phase, 'setup');
      assert.equal(beforeKill.state.workspace.active, true);
      assert.equal(beforeKill.state.process, null);
    } else if (phase === 'task') {
      assert.equal(beforeKill.state.phase, 'task');
      assert.ok(beforeKill.state.process?.pid);
      const deadline = Date.now() + 5000;
      while (await launchCount(f.counter) === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(await launchCount(f.counter) > 0, 'the owned app-server process started before coordinator termination');
    } else if (phase === 'capture') {
      assert.equal(beforeKill.state.phase, 'capture');
      const checkpoint = (await readAuditRecord(f.store, crashedRunId)).captureCheckpoint;
      assert.ok(checkpoint, 'the normalized in-memory session must be durable before coordinator death');
      assert.equal(checkpoint.threadId, '11111111-1111-4111-8111-111111111111');
      assert.equal(checkpoint.run.source.threadId, checkpoint.threadId);
      assert.equal(checkpoint.run.agents.length, 2);
    } else {
      assert.equal(experiment.state.phase, 'finished');
      assert.equal(experiment.finalized, false);
      for (const id of runIds) assert.equal((await readAuditRecord(f.store, id)).finalized, true);
    }

    coordinator.kill('SIGKILL');
    const [, signal] = await once(coordinator, 'close');
    assert.equal(signal, 'SIGKILL');
    if (beforeKill.state.process?.pid) await waitForPidExit(beforeKill.state.process.pid);
    await waitForPidExit(coordinator.pid);
    const launchesBeforeRecovery = await launchCount(f.counter);
    const recoveryPath = join(f.root, `recover-${phase}.mjs`);
    await writeFile(recoveryPath, recoveryWorkerSource(), { flag: 'wx', mode: 0o600 });
    const recoveryProcess = spawnSync(process.execPath, [recoveryPath, f.store.directory, ready.experimentId], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(recoveryProcess.status, 0, recoveryProcess.stderr);
    const recovered = JSON.parse(recoveryProcess.stdout);
    assert.equal(recovered.status, 'recovered', JSON.stringify(recovered, null, 2));
    const recoveredRun = recovered.runs.find(run => run.id === crashedRunId);
    assert.ok(recoveredRun);
    if (phase !== 'finalization') assert.equal(recoveredRun.execution.recovery, 'process-stopped-no-rerun');
    if (phase === 'setup') assert.ok(recoveredRun.artifacts.some(item => item.kind === 'audit-workspace-snapshot'));
    if (phase === 'task') {
      const workspaceSnapshot = recoveredRun.artifacts.find(item => item.kind === 'audit-workspace-snapshot');
      assert.ok(workspaceSnapshot);
      assert.ok(workspaceSnapshot.metadataPath);
    }
    if (phase === 'capture') {
      assert.equal(recoveredRun.taskEnd, undefined, 'a crash before the post-shutdown workspace callback is not task-end evidence');
      assert.equal(recoveredRun.coverage.execution, 'partial');
      assert.equal(recoveredRun.outcome.status, 'unverified');
      const recoveredSnapshot = recoveredRun.artifacts.find(item => item.kind === 'audit-workspace-snapshot' && item.label === 'recovered');
      assert.ok(recoveredSnapshot, 'recovery records its current workspace state without claiming task-end evidence');
      assert.equal(recoveredSnapshot.status, 'changed');
      assert.ok(recoveredSnapshot.metadataPath);
      assert.deepEqual(new Set(recoveredRun.agents.map(agent => agent.id)), new Set([
        '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      ]));
      assert.ok(recoveredRun.events.length > 0, 'recovery keeps the captured event evidence');
    }
    if (phase === 'finalization') {
      assert.ok(recoveredRun.taskEnd?.patchPath);
      assert.equal(recoveredRun.outcome.status, 'not-evaluated');
      assert.ok(recoveredRun.metrics.totalMs > 0);
    }
    assert.equal(await launchCount(f.counter), launchesBeforeRecovery, 'fresh-process recovery must not rerun native work');
    const repeated = spawnSync(process.execPath, [recoveryPath, f.store.directory, ready.experimentId], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).status, 'recovered');
    assert.equal(await launchCount(f.counter), launchesBeforeRecovery, 'recovery retry must remain idempotent');
    for (const home of f.native) await assert.rejects(stat(join(home.root, '.run-lock')), { code: 'ENOENT' });
  });
});

test('executes three balanced quality trials and shows, exports, reopens, and evaluates frozen series evidence', async t => {
  const f = await fixture(t), spec = repeatedSpec(f);
  const before = { store: await readFile(f.store.file), configs: await Promise.all(f.native.map(home => readFile(join(home.home, 'config.toml')))),
    auth: await Promise.all(f.native.map(home => readFile(join(home.home, 'auth.json')))) };
  const context = { baseDirectory: join(f.store.directory, 'audits'),
    observeAccess: (profile, options) => runObserveAccessFixture(profile, { ...options, store: f.store }) };
  const report = await runAuditSeries(f.store, spec, context);
  assert.equal(report.kind, 'audit-series-report', JSON.stringify(report, null, 2));
  assert.equal(report.plan.length, 3);
  assert.deepEqual(report.plan.map(item => item.profileOrder), [['Alpha', 'Beta'], ['Beta', 'Alpha'], ['Alpha', 'Beta']]);
  assert.equal(report.coverage.plannedSlots, 3);
  assert.equal(report.coverage.missingSlots, 0);
  assert.equal(await launchCount(f.counter), 6, 'each of six planned profile runs starts exactly one app server');
  for (const name of ['Alpha', 'Beta']) {
    const summary = report.profiles.find(item => item.profileName === name);
    assert.equal(summary.planned, 3);
    assert.equal(summary.executed, 3);
    assert.equal(summary.quality.denominator, 3);
    assert.equal(summary.quality.notRun, 0);
    assert.equal(summary.quality.passed, name === 'Alpha' ? 3 : 0);
    assert.equal(summary.quality.failed, name === 'Beta' ? 3 : 0);
  }
  for (const trial of report.trials) {
    assert.deepEqual(new Set(trial.profiles.map(item => item.profileName)), new Set(['Alpha', 'Beta']));
    for (const profile of trial.profiles) {
      assert.ok(profile.run);
      assert.equal(profile.run.profileSettings.status, 'unchanged');
      assert.equal(profile.run.runningClients.status, 'unchanged');
    }
  }
  assert.deepEqual(await readFile(f.store.file), before.store);
  assert.deepEqual(await Promise.all(f.native.map(home => readFile(join(home.home, 'config.toml')))), before.configs);
  assert.deepEqual(await Promise.all(f.native.map(home => readFile(join(home.home, 'auth.json')))), before.auth);
  for (const home of f.native) await assert.rejects(stat(join(home.root, '.run-lock')), { code: 'ENOENT' });

  const shown = invokeCLI(f.store.directory, 'audit', 'show', report.id);
  assert.equal(shown.status, report.exitCode, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).kind, 'audit-series-report');
  const jsonPath = join(f.root, 'series.json'), markdownPath = join(f.root, 'series.md');
  const jsonExport = invokeCLI(f.store.directory, 'audit', 'export', report.id, '--output', jsonPath, '--format', 'json');
  assert.equal(jsonExport.status, report.exitCode, jsonExport.stderr);
  const markdownExport = invokeCLI(f.store.directory, 'audit', 'export', report.id, '--output', markdownPath, '--format', 'markdown');
  assert.equal(markdownExport.status, report.exitCode, markdownExport.stderr);
  const frozen = await readAuditReport(jsonPath);
  const frozenMarkdownData = await readAuditReport(`${markdownPath}.audit.json`);
  assert.equal(frozen.kind, 'audit-series-report');
  assert.deepEqual(frozen, frozenMarkdownData);
  const original = await readAuditRecord(f.store, report.id);
  assert.equal(original.record.baseline.commit, f.commit);
  for (const slot of original.record.plan) {
    const child = await readAuditRecord(f.store, slot.experimentId);
    assert.equal(child.record.baseline.repository.commit, original.record.baseline.commit, 'every child trial pins the same source baseline');
  }
  assert.deepEqual(original.report, frozen, 'CLI show and both exports derive from the same immutable series report');
  assert.match(await readFile(markdownPath, 'utf8'), /Trial|Alpha/);

  const alphaRun = report.trials[0].profiles.find(item => item.profileName === 'Alpha').run;
  assert.equal(alphaRun.checks.find(check => check.name === 'optional-diagnostic').status, 'failed');
  assert.equal(alphaRun.checks.find(check => check.name === 'mutating-check').status, 'passed', 'an optional diagnostic failure must not suppress the later required check');
  const review = { schemaVersion: 1, runId: alphaRun.id,
    fingerprint: auditQualityFingerprint(spec.quality, spec.checks), reviewer: 'reviewer@example.test',
    reviewedAt: '2026-10-16T12:00:00.000Z', ratings: [{ criterionId: 'correctness', score: 4,
      rationale: 'The requested result is present.', evidenceRefs: [`run:${alphaRun.id}`] }] };
  const reviewPath = join(f.root, 'reviews.json');
  await writeFile(reviewPath, JSON.stringify({ schemaVersion: 1, reviews: [review] }), { flag: 'wx', mode: 0o600 });
  const evaluatedCLI = invokeCLI(f.store.directory, 'audit', 'evaluate', report.id, '--spec', reviewPath);
  assert.equal(evaluatedCLI.status, report.exitCode, evaluatedCLI.stderr);
  const evaluated = JSON.parse(evaluatedCLI.stdout);
  assert.equal(evaluated.kind, 'audit-evaluation-report');
  assert.notEqual(evaluated.id, report.id);
  const evaluationRecord = await readAuditRecord(f.store, evaluated.id);
  assert.equal(evaluationRecord.record.reviews.length, 1);
  assert.equal(evaluationRecord.record.reviews[0].reviewer, review.reviewer);
  const evaluatedRun = evaluated.series.trials[0].profiles.find(item => item.profileName === 'Alpha');
  assert.equal(evaluatedRun.quality.rubric.status, 'reviewed');
  assert.equal(evaluatedRun.quality.rubric.scorePercent, 80);
  assert.equal(evaluatedRun.quality.review.reviewer, review.reviewer);
  assert.equal(evaluated.series.profiles.find(item => item.profileName === 'Alpha').review.scoredN, 1);
  const regenerated = await evaluateAuditSeries(f.store, report.id);
  assert.deepEqual(regenerated.series, original.report, 'evaluation without new reviews deterministically regenerates the frozen series');
  const evaluationPath = join(f.root, 'evaluation.md');
  const evalExport = invokeCLI(f.store.directory, 'audit', 'export', evaluated.id, '--format', 'markdown', '--output', evaluationPath);
  assert.equal(evalExport.status, report.exitCode, evalExport.stderr);
  const frozenEvaluation = invokeCLI(join(f.root, 'empty-controller'), 'audit', 'show', `${evaluationPath}.audit.json`);
  assert.equal(frozenEvaluation.status, report.exitCode, frozenEvaluation.stderr);
  assert.deepEqual(JSON.parse(frozenEvaluation.stdout), evaluated);
  assert.deepEqual((await readAuditRecord(f.store, report.id)).report, original.report, 'human review creates a new revision without mutating the original');
  assert.equal(await launchCount(f.counter), 6, 'reviewing saved evidence launches no more tasks');
});

test('SIGKILL after the first finalized child report resumes only unstarted stable trial slots', async t => {
  const f = await fixture(t), spec = repeatedSpec(f), specPath = join(f.root, 'series-spec.json');
  await writeFile(specPath, JSON.stringify(spec), { flag: 'wx', mode: 0o600 });
  const workerPath = join(f.root, 'series-coordinator.mjs'), readyPath = join(f.root, 'series-child-finalized.json');
  await writeFile(workerPath, seriesCoordinatorSource(), { flag: 'wx', mode: 0o600 });
  let stderr = '';
  const coordinator = spawn(process.execPath, [workerPath, f.store.directory, specPath, readyPath], { stdio: ['pipe', 'ignore', 'pipe'] });
  coordinator.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (coordinator.exitCode !== null || coordinator.signalCode !== null) return;
    coordinator.kill('SIGKILL');
    try { await once(coordinator, 'close'); } catch {}
  });
  const ready = await waitForFile(readyPath, coordinator, () => stderr, 30000);
  assert.equal(ready.trialIndex, 1);
  const series = await readAuditRecord(f.store, ready.seriesId);
  const plannedIds = series.record.plan.map(slot => slot.experimentId);
  assert.equal(new Set(plannedIds).size, 3);
  const firstChild = await readAuditRecord(f.store, ready.childId);
  assert.equal(firstChild.finalized, true, 'pause occurs after durable final child report creation');
  const launchesBeforeKill = await launchCount(f.counter);
  assert.equal(launchesBeforeKill, 2);
  coordinator.kill('SIGKILL');
  const [, signal] = await once(coordinator, 'close');
  assert.equal(signal, 'SIGKILL');
  await waitForPidExit(coordinator.pid);
  const resumed = invokeCLI(f.store.directory, 'audit', 'resume', ready.seriesId);
  assert.ok([0, 2, 4].includes(resumed.status), resumed.stderr);
  const afterResume = JSON.parse(resumed.stdout);
  assert.equal(afterResume.id, ready.seriesId);
  assert.deepEqual(afterResume.plan.map(slot => slot.experimentId), plannedIds);
  assert.equal(afterResume.coverage.plannedSlots, 3);
  assert.equal(afterResume.coverage.missingSlots, 0);
  assert.equal(afterResume.profiles.every(profile => profile.planned === 3 && profile.executed === 3), true);
  assert.equal(await launchCount(f.counter), 6, 'first durable trial was recovered, never relaunched; two unused trials ran');
  assert.equal((await readAuditRecord(f.store, ready.childId)).finalized, true);
  assert.deepEqual(await readFile(f.store.file), f.savedStore);
  assert.deepEqual(await Promise.all(f.native.map(home => readFile(join(home.home, 'config.toml')))), f.savedConfigs);
  assert.deepEqual(await Promise.all(f.native.map(home => readFile(join(home.home, 'auth.json')))), f.savedAuth);
  for (const home of f.native) await assert.rejects(stat(join(home.root, '.run-lock')), { code: 'ENOENT' });
});

test('SIGTERM during an audit resume cancels the active native task and leaves started slots unreplayed', async t => {
  const marker = join(await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-resume-term-'))), 'native-task-started');
  t.after(() => rm(dirname(marker), { recursive: true, force: true }));
  const pidMarker = `${marker}.pid`;
  const f = await fixture(t, { pauseOnTurnStartMarker: marker, pauseOnTurnStartPidMarker: pidMarker });
  const spec = { ...repeatedSpec(f), trials: { count: 2, order: 'balanced', budgetMs: 90000 } };
  const context = { baseDirectory: join(f.store.directory, 'audits'),
    observeAccess: (profile, options) => runObserveAccessFixture(profile, { ...options, store: f.store }),
    onTrialPrepared: async ({ slot }) => {
      if (slot.trialIndex === 0) throw Object.assign(new Error('fixture interruption before native work'), { code: 'fixture-stop-before-task' });
    } };
  const created = await runAuditSeries(f.store, spec, context);
  assert.equal(created.status, 'blocked');
  assert.equal(await launchCount(f.counter), 0, 'the preparation stop occurs before any native task');
  const seriesBefore = await readAuditRecord(f.store, created.id);
  const plannedIds = seriesBefore.record.plan.map(slot => slot.experimentId);
  assert.equal(seriesBefore.state.trials[0].status, 'starting');

  let stdout = '', stderr = '';
  const child = spawn(process.execPath, [cliPath, '--store', f.store.directory, '--json', 'audit', 'resume', created.id],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    try { await once(child, 'close'); } catch {}
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { await stat(marker); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (child.exitCode !== null) throw new Error(`audit resume exited before native task pause: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await stat(marker);
  assert.equal(await launchCount(f.counter), 1, 'only the first run in the unused trial slot has started');
  const seriesAtPause = await readAuditRecord(f.store, created.id);
  assert.deepEqual(seriesAtPause.record.plan.map(slot => slot.experimentId), plannedIds);
  assert.equal(seriesAtPause.state.trials[0].status, 'interrupted', 'the prior started slot remains recorded as interrupted');
  assert.equal(seriesAtPause.state.trials[1].status, 'starting');
  const nativePid = Number(await readFile(pidMarker, 'utf8'));
  assert.ok(Number.isSafeInteger(nativePid) && nativePid > 0, 'fixture identifies its paused native process');

  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(code, 130, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.id, created.id);
  assert.equal(report.status, 'interrupted');
  assert.equal(report.coverage.plannedSlots, 2);
  assert.equal(report.coverage.missingSlots, 1);
  assert.equal(await launchCount(f.counter), 1, 'resume stops the active task without starting the next profile or replaying slot zero');
  await waitForPidExit(nativePid);

  const savedSeries = await readAuditRecord(f.store, created.id);
  assert.deepEqual(savedSeries.record.plan.map(slot => slot.experimentId), plannedIds);
  assert.equal(savedSeries.state.trials[0].status, 'interrupted');
  assert.equal(savedSeries.state.trials[1].status, 'recorded');
  const savedTrial = await readAuditRecord(f.store, plannedIds[1]);
  assert.equal(savedTrial.report.status, 'cancelled');
  const cancelled = savedTrial.report.runs.find(run => run.execution?.status === 'cancelled' || run.status === 'cancelled');
  assert.ok(cancelled, 'the report retains evidence that the active task was cancelled');
  assert.equal(savedTrial.report.runs.filter(run => run.status === 'not-started' || run.phase === 'not-started').length, 1);
  assert.deepEqual(await readFile(f.store.file), f.savedStore);
  assert.deepEqual(await Promise.all(f.native.map(home => readFile(join(home.home, 'config.toml')))), f.savedConfigs);
  assert.deepEqual(await Promise.all(f.native.map(home => readFile(join(home.home, 'auth.json')))), f.savedAuth);
  for (const home of f.native) await assert.rejects(stat(join(home.root, '.run-lock')), { code: 'ENOENT' });
  const leaseNames = await readdir(join(f.store.directory, 'audits', 'leases')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(leaseNames, [], 'audit leases are released after cancellation');
});
