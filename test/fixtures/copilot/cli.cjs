// Inert Content-Length stdio fixture for the installed SDK. Every accepted RPC is logged.
const { appendFileSync, readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join, dirname } = require('node:path');
const logDir = process.argv[process.argv.indexOf('--log-dir') + 1];
const root = process.env.COPILOT_HOME;
const config = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
const workspace = process.cwd();
if (config.invocationLog) appendFileSync(config.invocationLog, JSON.stringify({ workspace, home: process.env.HOME, root }) + '\n', { mode: 0o600 });
const sessionId = '00000000-0000-4000-8000-000000000001';
const transcript = JSON.parse(readFileSync(join(__dirname, 'events.json'), 'utf8').replaceAll('@WORKSPACE@', workspace));
let activeId;
let buffer = Buffer.alloc(0), mode = 'manual', sent = false, permissionResults = 0, rest = [];
const write = value => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...value });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const event = value => write({ method: 'session.event', params: { sessionId: activeId, event: {
  ...value, data: { ...value.data, ...(value.data.ownerSessionId ? { ownerSessionId: activeId } : {}) },
} } });
const metadata = id => ({ sessionId: id, startTime: '2026-01-01T00:00:00.000Z', modifiedTime: '2026-01-01T00:00:01.000Z',
  summary: config.label, context: { cwd: config.wrongCwd ? '/' : workspace }, isRemote: false });

function spawnEscapedDescendant() {
  const sleeper = spawn('/bin/sleep', ['3'], { detached: true, stdio: 'ignore' });
  sleeper.unref();
}

function handle({ method, id, params }) {
  appendFileSync(join(dirname(logDir), 'fixture-rpc.jsonl'), JSON.stringify({ method, params, cwd: workspace, root }) + '\n', { mode: 0o600 });
  const reply = result => write({ id, result });
  switch (method) {
    case 'connect': reply({ ok: true, protocolVersion: 3, version: '1.0.107' }); break;
    case 'status.get': reply({ protocolVersion: 3, version: '1.0.107' }); break;
    case 'auth.getStatus': reply(config.signedOut ? { isAuthenticated: false } :
      { isAuthenticated: true, authType: config.authType ?? 'gh-cli', login: config.login ?? 'fixture-login', host: 'fixture.invalid' }); break;
    case 'models.list': reply({ models: [], auto: { defaultTier: 'balance', tiers: [
      { id: 'balance', type: 'auto', status: { enabled: true, pickerVisible: true } },
      { id: 'fast', type: 'auto', status: { enabled: true, pickerVisible: false } },
      { id: 'fusion', type: 'fusion', status: { enabled: false, pickerVisible: true } },
    ] }, imageModels: [{ id: 'fixture-image-model' }] }); break;
    case 'sessions.list': reply({ sessions: [metadata(sessionId)] }); break;
    case 'session.getMetadata': reply(config.noMetadata ? {} : { session: metadata(params.sessionId) }); break;
    case 'sessions.readPersistedEvents':
      reply({ cursor: 'fixture-cursor', cursorStatus: 'ok', hasMore: false, events: [
        { id: 'stored-1', type: 'user.message', data: { content: 'Stored prompt.' } },
        { id: 'stored-2', type: 'assistant.message', data: { content: config.storedText ?? config.label } },
      ] });
      break;
    case 'session.create':
      if (params.workingDirectory != null || params.trustWorkingDirectory != null) process.exit(3);
      activeId = params.sessionId;
      if (config.wrongCwd && config.escapedDescendant) spawnEscapedDescendant();
      const start = () => {
        if (config.noSessionStart) return;
        const startEvent = { id: 'fixture-session-start', type: 'session.start', data: {
          sessionId: config.wrongStartSession ? sessionId : activeId,
          context: { cwd: config.wrongCwd ? '/' : workspace },
        } };
        if (config.childSessionStart) startEvent.agentId = 'fixture-child';
        event(startEvent);
        if (config.duplicateSessionStart) event({ ...startEvent, id: 'fixture-duplicate-start' });
      };
      if (config.startBeforeResponse) start();
      reply({ sessionId: activeId, workspacePath: null });
      if (!config.startBeforeResponse) {
        if (config.wrongCwd && config.escapedDescendant) setTimeout(start, 400);
        else start();
      }
      break;
    case 'session.model.getCurrent': reply({ modelId: 'auto', autoTier: 'balance' }); break;
    case 'session.permissions.getMode': reply({ mode }); break;
    case 'session.permissions.setMode': mode = params.mode; reply({ success: true, mode }); break;
    case 'session.send': {
      if (sent || params.sessionId !== activeId) process.exit(4);
      sent = true;
      reply({ messageId: 'fixture-message' });
      if (config.escapedDescendant) spawnEscapedDescendant();
      if (config.rateLimited) {
        event({ id: 'fixture-rate-limit', type: 'session.error', data: { errorType: 'rate_limit' } });
        break;
      }
      if (config.noTools) {
        const final = transcript.findLast(value => value.type === 'assistant.message');
        for (const value of transcript.filter(value => value.data.turnId === final.data.turnId || value.type === 'session.idle')) event(value);
        break;
      }
      const lastPermission = transcript.findLastIndex(value => value.type === 'permission.requested');
      if (lastPermission < 0) {
        for (const value of transcript) event(value);
        break;
      }
      for (const value of transcript.slice(0, lastPermission + 1)) event(value);
      rest = transcript.slice(lastPermission + 1);
      break;
    }
    case 'session.permissions.handlePendingPermissionRequest':
      reply({ success: true });
      if (++permissionResults === 2) for (const value of rest) event(value);
      break;
    case 'session.abort':
      event({ id: 'aborted-idle', type: 'session.idle', data: { aborted: true, mode: 'interactive' } });
      reply({});
      break;
    case 'session.detach': reply({ success: true }); break;
    case 'runtime.shutdown': reply({ success: true }); setImmediate(() => process.exit(0)); break;
    default: write({ id, error: { code: -32601, message: 'Unexpected fixture RPC' } });
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const offset = buffer.indexOf('\r\n\r\n');
    if (offset < 0) return;
    const size = Number(/^Content-Length: (\d+)$/i.exec(buffer.subarray(0, offset).toString())?.[1]);
    if (!Number.isSafeInteger(size)) process.exit(5);
    const end = offset + 4 + size;
    if (buffer.length < end) return;
    const request = JSON.parse(buffer.subarray(offset + 4, end));
    buffer = buffer.subarray(end);
    handle(request);
  }
});
