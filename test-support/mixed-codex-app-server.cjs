const { readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

if (process.argv.includes('--version')) {
  process.stdout.write('codex 0.153.4\n');
  process.exit(0);
}

const sessionId = '00000000-0000-4000-8000-000000000001';
const threadId = sessionId, turnId = 'fixture-turn', cwd = process.cwd();
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const notify = (method, params) => send({ method, params });
const item = { id: 'fixture-answer', type: 'agentMessage', phase: 'final_answer', text: 'Codex fixture completed.' };
const started = () => ({ id: turnId, status: 'inProgress' });
let status = null;

createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  const reply = result => send({ id, result });
  switch (method) {
    case 'initialize': return reply({ serverInfo: { name: 'fixture', version: '0.153.4' } });
    case 'initialized': return;
    case 'account/read': return reply({ account: { type: 'chatgpt' } });
    case 'model/list': return reply({ data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture',
      isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null });
    case 'skills/list': return reply({ data: [] });
    case 'thread/start': {
      const sandbox = params.sandbox ? { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite', networkAccess: false } : null;
      return reply({ cwd, thread: { id: threadId, sessionId, cwd }, model: 'fixture', reasoningEffort: 'low', sandbox,
        approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer });
    }
    case 'command/exec': return reply({ exitCode: 0, stdout: '', stderr: '' });
    case 'turn/start': {
      if (!readFileSync('README.md', 'utf8').includes('Disposable U3 project')) throw new Error('Unexpected fixture input');
      reply({ turn: started() });
      notify('turn/started', { threadId, turn: started() });
      const optionalReview = params.input[0].text.includes('Frozen report: ');
      if (!optionalReview) notify('item/completed', { threadId, turnId, item });
      status = optionalReview ? 'failed' : 'completed';
      notify('turn/completed', { threadId, turn: { id: turnId, status } });
      return;
    }
    case 'thread/turns/list': return reply({ data: status ? [{ id: turnId, status, items: status === 'completed' ? [item] : [] }] : [], nextCursor: null });
    case 'thread/read': return reply({ thread: { id: threadId, cwd, turns: status ? [{ id: turnId, status, items: status === 'completed' ? [item] : [] }] : [] } });
    default: return send({ id, error: { code: -32601, message: 'Unsupported fixture method' } });
  }
});
