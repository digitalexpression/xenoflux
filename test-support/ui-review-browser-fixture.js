import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createUiRunsFixture } from './ui-runs-fixture.js';

const until = async (read, predicate, message) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
};

/** Real UI server and engine with a disposable native app-server executable. */
export async function createUiReviewBrowserFixture({ mode = 'complete' } = {}) {
  const app = await createUiRunsFixture();
  try {
    await writeFile(app.executable, fakeCodexAppServer(mode), { mode: 0o700 });
    await chmod(app.executable, 0o700);
    await seedNativeHistory(app, 'baseline', '00000000-0000-4000-8000-000000000001', 'baseline');
    await seedNativeHistory(app, 'strict-review', '00000000-0000-4000-8000-000000000002', 'strict-review');
    const comparison = await app.provider.runPreview({ task: 'Disposable browser review fixture', files: '',
      a: 'baseline', b: 'strict-review', repository: app.repository, commit: 'HEAD', checks: [] });
    if (!comparison.ready) throw new Error(`Fixture comparison preview failed: ${JSON.stringify(comparison)}`);
    const started = await app.provider.startRun({ previewToken: comparison.previewToken });
    const run = await until(() => app.provider.run({ id: started.id }), value => value.state !== 'running',
      'fixture comparison did not finish');
    if (run.state !== 'finished') throw new Error(`Fixture comparison failed: ${JSON.stringify(run)}`);
    const ref = `e.${started.id}`;
    const config = await readFile(join(app.homes.baseline.home, 'config.toml'), 'utf8');
    let releaseStartResponse = () => {};
    if (mode === 'lost-start-response') {
      let release;
      const responseGate = new Promise(resolve => { release = resolve; });
      releaseStartResponse = release;
      const provider = app.provider;
      const realStart = provider.startReviewTask.bind(provider);
      provider.startReviewTask = async input => {
        const result = await realStart(input);
        await responseGate;
        return result;
      };
    }
    return { ...app, ref, releaseStartResponse, reviewEvidence: { executable: app.executable, originalConfig: config } };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function seedNativeHistory(app, profileName, threadId, label) {
  const home = app.homes[profileName === 'baseline' ? 'baseline' : 'strict'].home;
  const rolloutPath = join(home, 'sessions', '2026', '11', '02', `rollout-${threadId}.jsonl`);
  const turnId = label === 'baseline' ? '00000000-0000-4000-8000-000000000101' : '00000000-0000-4000-8000-000000000102';
  const rows = [
    { timestamp: '2026-11-02T10:00:00.000Z', type: 'session_meta', payload: {
      id: threadId, cli_version: '0.153.4', originator: 'codex_cli', cwd: app.repository } },
    { timestamp: '2026-11-02T10:00:01.000Z', type: 'turn_context', payload: {
      turn_id: turnId, cwd: app.repository, model: 'fixture-model', effort: 'medium' } },
    { timestamp: '2026-11-02T10:00:02.000Z', type: 'event_msg', payload: {
      type: 'user_message', message: `Synthetic retained replay event for ${label}.` } },
    { timestamp: '2026-11-02T10:00:03.000Z', type: 'event_msg', payload: {
      type: 'task_complete', turn_id: turnId, success: true } },
  ];
  await mkdir(join(home, 'sessions', '2026', '11', '02'), { recursive: true, mode: 0o700 });
  await writeFile(rolloutPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
  const database = new DatabaseSync(join(home, 'state_5.sqlite'));
  database.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, source TEXT, rollout_path TEXT);');
  database.prepare('INSERT OR REPLACE INTO threads (id,cwd,title,created_at,updated_at,archived,source,rollout_path) VALUES (?,?,?,?,?,?,?,?)')
    .run(threadId, app.repository, `Synthetic ${label} citation fixture`, Date.now() - 1000, Date.now(), 0, 'cli', rolloutPath);
  database.close();
}

function fakeCodexAppServer(scenario) {
  return `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('codex 0.153.4\\n'); process.exit(0); }
const fs = require('node:fs');
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
const threadId = 'browser-review-thread', sessionId = 'browser-review-session', turnId = 'browser-review-turn';
const responseText = 'The frozen comparison shows one useful difference; this is a task-scoped review.';
const partialText = 'Partial review text retained before the task stopped.';
const scenario = ${JSON.stringify(scenario)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let completed = false;
const partial = () => send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId,
  item: { id: 'partial-answer', type: 'agentMessage', phase: 'final_answer', text: partialText } } });
const request = (id, method, params) => send({ jsonrpc: '2.0', id, method, params });
const nextRequest = index => {
  const common = { threadId, turnId, itemId: 'native-item' };
  if (index === 0) return request(77, 'item/commandExecution/requestApproval', { ...common, startedAtMs: 1,
    command: 'cat report.md', cwd: process.cwd(), availableDecisions: ['accept', 'decline'] });
  if (index === 1) {
    send({ jsonrpc: '2.0', method: 'item/started', params: { ...common, item: { id: 'native-item', type: 'fileChange', status: 'inProgress',
      changes: [{ path: 'report.md', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\\n-old citation\\n+new citation' }] } } });
    return request(78, 'item/fileChange/requestApproval', { ...common, startedAtMs: 2, reason: 'Review a changed report citation', grantRoot: process.cwd() });
  }
  const networkPermission = { network: { enabled: true } };
  if (index === 2 || index === 3) return request(78 + index, 'item/permissions/requestApproval', { ...common,
    startedAtMs: 2 + index, cwd: process.cwd(), reason: index === 2 ? 'Allow report lookup' : 'Allow optional network follow-up', permissions: networkPermission });
  if (index === 4) return request(82, 'item/tool/requestUserInput', { ...common,
    questions: [{ id: 'include-detail', header: 'Detail', question: 'Should the review include a detailed explanation?',
      options: [{ label: 'Yes, include detail', description: 'Include a short explanation.' },
        { label: 'No, keep it brief', description: 'Keep the response concise.' }] }], isBlocking: true });
  completed = true;
  send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
};
lines.on('line', line => {
  const message = JSON.parse(line), { id, method, params = {} } = message;
  if (id >= 77 && message.result) {
    if (scenario === 'lost-start-response') {
      completed = true;
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      return;
    }
    fs.appendFileSync(__filename + '.responses', JSON.stringify({ id, result: message.result }) + '\\n');
    const index = id === 77 ? 0 : id === 78 ? 1 : id - 78;
    nextRequest(index + 1);
    return;
  }
  const result = value => send({ jsonrpc: '2.0', id, result: value });
  if (method === 'initialize') return result({ serverInfo: { name: 'browser-fixture', version: '0.153.4' } });
  if (method === 'initialized') return;
  if (method === 'skills/list') return result({ data: [{ cwd: params.cwds[0], skills: [], errors: [] }] });
  if (method === 'thread/start') {
    if (Object.hasOwn(params, 'cwd')) return send({ jsonrpc: '2.0', id,
      error: { code: -32602, message: 'Ordinary thread/start must inherit the process cwd' } });
    const cwd = process.cwd();
    result({ cwd, model: 'gpt-6-luna', reasoningEffort: 'medium', thread: { id: threadId, sessionId, cwd } });
    send({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: threadId, sessionId, cwd } } });
    return;
  }
  if (method === 'turn/start') {
    const prompt = params.input[0].text;
    const marker = 'Frozen report: ';
    const reportPath = prompt.slice(prompt.indexOf(marker) + marker.length).split(String.fromCharCode(10))[0].trim();
    let reportText;
    try { reportText = fs.readFileSync(reportPath, 'utf8'); } catch { process.exit(31); }
    const startsPath = __filename + '.starts';
    fs.writeFileSync(startsPath, String(Number(fs.existsSync(startsPath) ? fs.readFileSync(startsPath, 'utf8') : '0') + 1));
    fs.writeFileSync(__filename + '.observed', JSON.stringify({ reportPath, reportText, prompt }));
    result({ turn: { id: turnId, status: 'inProgress' } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    partial();
    if (scenario === 'unsupported') return request(77, 'item/unknown/requestApproval', { threadId, turnId, itemId: 'unknown', startedAtMs: 1 });
    if (scenario === 'cancel') return nextRequest(0);
    nextRequest(0);
    return;
  }
  if (method === 'thread/read') return result({ thread: { id: threadId, sessionId, turns: [{ id: turnId, status: completed ? 'completed' : 'inProgress', itemsView: 'full',
    items: [{ id: completed ? 'browser-final' : 'partial-answer', type: 'agentMessage', phase: 'final_answer', text: completed ? responseText : partialText }] }] } });
  if (method === 'turn/interrupt') { completed = false; return result({}); }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported fixture method' } });
});
`;
}
