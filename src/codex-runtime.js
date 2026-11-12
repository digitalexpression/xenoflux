// Owns one Codex app-server connection. Capture/coordination owns admission,
// durable checkpoints and interpretation of notifications on this connection.
import { isDeepStrictEqual } from 'node:util';
import { runAuditProcess } from './audit-process.js';
import { validateNativeRequest, validateNativeResponse } from './native-requests.js';

export function createCodexRuntime({ runProcess = runAuditProcess } = {}) {
  const handles = new WeakSet();
  let completion = null;
  function owned(handle, live = true) {
    if (!handles.has(handle)) throw new Error('Foreign Codex runtime handle');
    if (live && (handle.closed || handle.signal.aborted || handle.inputClosed))
      throw new Error('Codex runtime is stopped');
    return handle;
  }
  function send(handle, message) {
    owned(handle);
    const line = JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
    if (handle.waiter) { const wake = handle.waiter; handle.waiter = null; wake({ value: line, done: false }); }
    else handle.outgoing.push(line);
  }
  function finish(handle) {
    owned(handle, false);
    handle.inputClosed = true;
    handle.requests.clear();
    if (handle.waiter) { handle.waiter({ done: true }); handle.waiter = null; }
  }
  function request(handle, method, params, timeoutMs = 30000) {
    owned(handle);
    const id = ++handle.sequence, key = String(id);
    const response = new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        handle.pending.delete(key); reject(new Error(`rpc-timeout:${method}`));
      }, timeoutMs);
      handle.pending.set(key, { timer, resolve, reject, method });
    });
    send(handle, { id, method, params });
    return response;
  }
  async function initialize(binding, callbacks = {}, signal) {
    const controller = new AbortController();
    const handle = { controller, closed: false, inputClosed: false, outgoing: [], waiter: null,
      sequence: 0, pending: new Map(), requests: new Map(), evidence: new WeakMap(),
      sessionId: null, turnId: null, process: null, capabilities: null,
      scope: { client: binding.client ?? 'codex', jobId: binding.jobId, profileId: binding.profileId } };
    handles.add(handle);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    handle.signal = combined;
    combined.addEventListener('abort', () => { handle.requests.clear(); }, { once: true });
    const input = { [Symbol.asyncIterator]() { return {
      next() {
        if (handle.outgoing.length && !handle.inputClosed) return Promise.resolve({ value: handle.outgoing.shift(), done: false });
        if (handle.inputClosed || handle.closed) return Promise.resolve({ done: true });
        return new Promise(resolve => { handle.waiter = resolve; });
      },
      return() { finish(handle); return Promise.resolve({ done: true }); },
    }; } };
    handle.completion = completion = runProcess({ ...binding.processOptions,
      executable: binding.executable?.path ?? binding.executable, args: binding.args, cwd: binding.workspace,
      signal: combined, input, onSpawn: async info => { handle.process = info; await callbacks.onSpawn?.(info); },
      onEvent: async packet => {
        const message = packet.value;
        if (packet.stream === 'stdout' && message && typeof message === 'object'
          && message.id !== undefined && typeof message.method !== 'string'
          && (message.result !== undefined || message.error !== undefined)) {
          const waiter = handle.pending.get(String(message.id));
          if (!waiter) { await callbacks.onWarning?.('unmatched-rpc-response'); return; }
          handle.pending.delete(String(message.id));
          if (waiter.timer) clearTimeout(waiter.timer);
          if (message.error) {
            const error = new Error(`rpc-error:${waiter.method}`);
            if (Number.isSafeInteger(message.error.code)) error.rpcCode = message.error.code;
            waiter.reject(error);
          } else {
            if (message.result && typeof message.result === 'object') handle.evidence.set(message.result, { sourceLine: packet.lineNumber });
            waiter.resolve(message.result);
          }
          return;
        }
        if (packet.stream === 'stdout' && message?.id !== undefined && typeof message.method === 'string') {
          // Capture validates active actor/turn and bounded action details before
          // presenting the request. Keep the original bytes for exact replies.
          const key = `${typeof message.id}:${message.id}`;
          if (handle.requests.size < 10000 && !handle.requests.has(key)) handle.requests.set(key, structuredClone(message));
        }
        if (packet.stream === 'stdout' && message?.method === 'item/completed') {
          const p = message.params;
          for (const [key, value] of handle.requests) if (value.params?.threadId === p?.threadId
            && value.params?.turnId === p?.turnId && value.params?.itemId === p?.item?.id) handle.requests.delete(key);
        }
        if (packet.stream === 'stdout' && message?.method === 'turn/completed') {
          const p = message.params;
          for (const [key, value] of handle.requests) if (value.params?.threadId === p?.threadId
            && value.params?.turnId === p?.turn?.id) handle.requests.delete(key);
        }
        await callbacks.onEvent?.(packet);
      },
    }).finally(() => {
      handle.closed = true;
      finish(handle);
      for (const waiter of handle.pending.values()) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new Error(`rpc-error:${waiter.method}`));
      }
      handle.pending.clear();
    });
    // Observe failures immediately, including startup failure before initialize.
    handle.completion.catch(() => {});
    try {
      handle.capabilities = await request(handle, 'initialize', callbacks.initializeParams ?? {
        clientInfo: { name: 'xfx-runtime', title: 'Xenoflux Runtime', version: '1' }, capabilities: { experimentalApi: true },
      });
      send(handle, { method: 'initialized', params: {} });
      return handle;
    } catch (error) {
      controller.abort();
      await handle.completion.catch(() => {});
      throw error;
    }
  }
  async function createSession(handle, params) {
    owned(handle);
    if (handle.sessionStarted) throw new Error('Codex session already initialized');
    handle.sessionStarted = true;
    const started = await request(handle, 'thread/start', params);
    if (typeof started?.thread?.id === 'string') handle.sessionId = started.thread.id;
    return started;
  }
  async function submit(handle, frozenTask, timeoutMs) {
    owned(handle);
    if (!handle.sessionId || frozenTask.threadId !== handle.sessionId || handle.submitted)
      throw new Error('Codex task requires the exact initialized session and one submission');
    handle.submitted = true;
    const result = await request(handle, 'turn/start', frozenTask, timeoutMs);
    handle.turnId = result?.turn?.id ?? null;
    return result;
  }
  function respond(handle, nativeRequest, answer) {
    owned(handle);
    const key = `${typeof nativeRequest?.id}:${nativeRequest?.id}`;
    const original = handle.requests.get(key);
    if (!original || !isDeepStrictEqual(validateNativeRequest(original), nativeRequest))
      throw new Error('Stale or changed Codex native request');
    validateNativeResponse(nativeRequest, answer);
    send(handle, { id: nativeRequest.id, result: answer });
    handle.requests.delete(key);
  }
  async function cancel(handle) {
    owned(handle, false);
    handle.requests.clear();
    let turn = { status: 'not-observed' };
    try {
      if (!handle.closed && !handle.controller.signal.aborted && handle.sessionId && handle.turnId) {
        await request(handle, 'turn/interrupt', { threadId: handle.sessionId, turnId: handle.turnId }, 1000);
        turn = { status: 'acknowledged' };
      }
    } catch { turn = { status: 'unconfirmed' }; }
    finally { handle.controller.abort(); }
    const process = await handle.completion;
    return { turn, shutdown: process.shutdown, process };
  }
  async function inspect(handle, nativeRef) {
    owned(handle);
    if (['client', 'jobId', 'profileId'].some(key => nativeRef?.[key] != null && nativeRef[key] !== handle.scope[key]))
      throw new Error('Codex native reference scope does not match');
    if (!nativeRef?.sessionId || nativeRef.sessionId !== handle.sessionId
      || nativeRef.turnId != null && nativeRef.turnId !== handle.turnId)
      throw new Error('Codex inspection requires the exact existing native session');
    return request(handle, 'thread/read', { threadId: nativeRef.sessionId, includeTurns: true });
  }
  return { initialize, createSession, submit, respond, cancel, inspect, request, finish,
    get completion() { return completion; } };
}
