// Explicit native catalog probes submit no task. Cache reads never launch a client.
import { isDeepStrictEqual } from 'node:util';
import { runAuditProcess } from './audit-process.js';
import { createEnvironmentBinding } from './client-contracts.js';

export const CATALOG_TTL_MS = 5 * 60 * 1000;
const MAX_PAGES = 100, MAX_MODELS = 5000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
function text(value, label, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
    throw fail('catalog-invalid-response', `Invalid catalog ${label}`);
  return value;
}
function optionalText(value, label, max) { return value == null ? null : text(value, label, max); }
function boolean(value, label) {
  if (value !== undefined && typeof value !== 'boolean') throw fail('catalog-invalid-response', `Invalid catalog ${label}`);
  return value ?? null;
}
function normalizeModel(value) {
  if (!object(value)) throw fail('catalog-invalid-response', 'Invalid catalog model');
  const efforts = value.supportedReasoningEfforts;
  if (efforts != null && (!Array.isArray(efforts) || efforts.length > 128))
    throw fail('catalog-invalid-response', 'Invalid catalog effort options');
  const options = efforts == null ? null : efforts.map(option => {
    if (!object(option)) throw fail('catalog-invalid-response', 'Invalid catalog effort option');
    return { reasoningEffort: text(option.reasoningEffort, 'effort'),
      description: optionalText(option.description, 'effort description', 8192) };
  });
  if (options && new Set(options.map(option => option.reasoningEffort)).size !== options.length)
    throw fail('catalog-invalid-response', 'Duplicate catalog effort');
  return { id: text(value.id, 'model ID'), model: text(value.model, 'model identifier'),
    displayName: optionalText(value.displayName, 'display name', 8192),
    hidden: boolean(value.hidden, 'visibility'), isDefault: boolean(value.isDefault, 'default model'),
    supportedReasoningEfforts: options, defaultReasoningEffort: optionalText(value.defaultReasoningEffort, 'default effort'),
    effortCapability: options === null ? 'unknown' : options.length ? 'supported' : 'unsupported' };
}

/** Reuse on an initialized owned connection immediately before explicit task selection. */
export async function readCodexModels(request, { signal } = {}) {
  const models = [], cursors = new Set(), ids = new Set(), names = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) throw fail('catalog-cancelled', 'Model discovery was cancelled');
    const response = await request('model/list', { cursor, limit: 100, includeHidden: true });
    if (signal?.aborted) throw fail('catalog-cancelled', 'Model discovery was cancelled');
    if (!object(response) || !Array.isArray(response.data) || response.data.length > MAX_MODELS
      || models.length + response.data.length > MAX_MODELS)
      throw fail('catalog-invalid-response', 'Invalid model/list response');
    for (const row of response.data) {
      const model = normalizeModel(row);
      if (ids.has(model.id) || names.has(model.model)) throw fail('catalog-invalid-response', 'Duplicate catalog model');
      ids.add(model.id); names.add(model.model); models.push(model);
    }
    cursor = optionalText(response.nextCursor, 'page cursor', 4096);
    if (cursor === null) {
      if (!models.length) throw fail('catalog-empty', 'The native client returned no available models');
      return models;
    }
    if (cursors.has(cursor)) throw fail('catalog-invalid-response', 'Repeated model/list cursor');
    cursors.add(cursor);
  }
  throw fail('catalog-page-limit', 'Model discovery exceeded its page limit');
}

function contextScope(context) {
  const binding = createEnvironmentBinding(context.profile.environmentBinding);
  if (binding.surface !== 'cli' || binding.executionLocation !== 'local')
    throw fail('catalog-unsupported-context', 'Model discovery requires a local CLI profile');
  if (context.workspace !== binding.workspace) throw fail('catalog-context-changed', 'Catalog workspace does not match the profile');
  return { environmentBinding: binding, workspace: context.workspace,
    accountScope: optionalText(context.accountScope, 'account scope'),
    connectionGeneration: context.connectionGeneration == null ? null : text(String(context.connectionGeneration), 'connection generation') };
}
function accountObservation(response) {
  if (!object(response) || !(response.account === null || object(response.account)))
    throw fail('catalog-invalid-response', 'Invalid account/read response');
  const account = response.account;
  // Display/account metadata can detect changes within this probe; it cannot prove credential routing.
  return { public: { status: 'unverified', type: optionalText(account?.type, 'account type'), id: null },
    comparison: JSON.stringify([account?.type ?? null, account?.email ?? null, account?.planType ?? null, account?.workspaceName ?? null]) };
}

export async function discoverCodexModels({ profile, workspace, signal, stdoutPath, stderrPath,
  timeoutMs = 15000, runProcess = runAuditProcess, onSpawn } = {}) {
  const scope = contextScope({ profile, workspace });
  if (scope.environmentBinding.client !== 'codex')
    throw fail('catalog-unsupported-context', 'Codex model discovery requires the Codex CLI profile');
  let nextId = 0, waiting = null, failure = null, models = [], account = { status: 'unverified', type: null, id: null };
  let initialized = false;
  function requestMessage(method, params) {
    const id = ++nextId;
    let resolve, reject;
    const response = new Promise((yes, no) => { resolve = yes; reject = no; });
    waiting = { id, resolve, reject };
    return { message: JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', response };
  }
  const queue = [], receivers = [];
  let closed = false;
  const send = message => receivers.length ? receivers.shift()({ value: message, done: false }) : queue.push(message);
  const close = () => { closed = true; while (receivers.length) receivers.shift()({ done: true }); };
  const input = { [Symbol.asyncIterator]() { return { next: () => queue.length ? Promise.resolve({ value: queue.shift(), done: false })
    : closed ? Promise.resolve({ done: true }) : new Promise(resolve => receivers.push(resolve)),
  return: async () => { close(); return { done: true }; } }; } };
  const request = async (method, params) => {
    const rpc = requestMessage(method, params); send(rpc.message); return rpc.response;
  };
  const protocol = (async () => {
    try {
      const result = await request('initialize', { clientInfo: { name: 'xfx-model-catalog', title: 'Xenoflux Model Catalog', version: '1' }, capabilities: null });
      if (!object(result)) throw fail('catalog-invalid-response', 'Invalid initialize response');
      initialized = true;
      send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
      let before = null;
      try { before = accountObservation(await request('account/read', { refreshToken: false })); account = before.public; }
      catch (error) { if (error.code !== 'catalog-rpc-error') throw error; }
      models = await readCodexModels(request, { signal });
      if (before) {
        const after = accountObservation(await request('account/read', { refreshToken: false }));
        if (before.comparison !== after.comparison) throw fail('catalog-account-changed', 'Native account changed during model discovery');
      }
    } catch (error) { failure ??= error; }
    finally { close(); }
  })();
  let process;
  try {
    process = await runProcess({ executable: profile.executable, args: [...(profile.launchArgs ?? []), 'app-server'],
      cwd: workspace, env: { ...profile.env }, input, signal, timeoutMs, stdoutPath, stderrPath, onSpawn,
      outputLimitBytes: 8 * 1024 * 1024,
      onEvent: async event => {
        try {
          if (event.stream !== 'stdout') return;
          const message = event.value;
          if (event.parseError || !object(message)) throw fail('catalog-invalid-response', 'Malformed catalog protocol output');
            if (Object.hasOwn(message, 'method')) {
            // Catalog discovery cannot consent to or answer any native request.
            if (Object.hasOwn(message, 'id')) throw fail('catalog-native-request', 'Native client requested interaction during model discovery');
            return;
          }
          if (!waiting || message.id !== waiting.id || (!Object.hasOwn(message, 'result') && !object(message.error)))
            throw fail('catalog-invalid-response', 'Unexpected catalog protocol reply');
          const pending = waiting; waiting = null;
          if (message.error) pending.reject(fail('catalog-rpc-error', 'Native client rejected a catalog request'));
          else pending.resolve(message.result);
        } catch (error) { failure ??= error; throw error; }
      } });
  } finally {
    waiting?.reject(fail('catalog-probe-stopped', 'Model discovery process stopped'));
    close();
    await protocol;
  }
  const ready = !failure && initialized && models.length && process.status === 'exited'
    && process.exitCode === 0 && process.shutdown?.groupTerminated === true && !process.output?.truncated;
  const discoveredAt = new Date().toISOString();
  return { status: ready ? 'ready' : process.status === 'cancelled' ? 'cancelled' : 'unavailable',
    source: 'codex-model/list', scope: { ...scope, account }, models: ready ? models : [],
    capabilities: { models: ready ? 'supported' : 'unknown', effort: !ready ? 'unknown'
      : models.some(model => model.effortCapability === 'supported') ? 'supported'
        : models.every(model => model.effortCapability === 'unsupported') ? 'unsupported' : 'unknown' },
    discoveredAt, expiresAt: new Date(Date.parse(discoveredAt) + CATALOG_TTL_MS).toISOString(), process,
    ...(!ready ? { reason: failure?.code ?? `catalog-${process.status}` } : {}) };
}

export function validateCatalogSelection(snapshot, selection = {}) {
  const modelChoice = selection.model, effortChoice = selection.reasoningEffort;
  if (modelChoice == null && effortChoice == null) return { status: 'inherited', model: null, reasoningEffort: null };
  if (modelChoice != null) text(modelChoice, 'selected model');
  if (effortChoice != null) text(effortChoice, 'selected effort');
  if (snapshot?.status !== 'ready' || !Array.isArray(snapshot.models))
    throw fail('catalog-unavailable', 'Refresh available models before using an explicit model or effort');
  const defaults = snapshot.models.filter(row => row.isDefault === true);
  const model = modelChoice == null ? (defaults.length === 1 ? defaults[0] : null)
    : snapshot.models.find(row => row.model === modelChoice);
  if (!model && modelChoice == null)
    throw fail('catalog-default-unknown', 'The native client did not identify its default model; select a model to validate an explicit effort');
  if (!model || model.hidden === true)
    throw fail('catalog-model-unavailable', 'The selected model is no longer available; refresh and choose an available model');
  if (effortChoice != null && (!Array.isArray(model.supportedReasoningEfforts)
    || !model.supportedReasoningEfforts.some(option => option.reasoningEffort === effortChoice)))
    throw fail('catalog-effort-unavailable', 'The selected effort is unavailable for this model; choose an advertised effort or use the profile default');
  return { status: snapshot.scope?.account?.status === 'verified' ? 'validated' : 'unverified',
    model: modelChoice ?? null, reasoningEffort: effortChoice ?? null };
}

/** Five-minute TTL; setup/auth changes must invalidate. Every refresh reconciles its captured scope. */
export function createClientCatalog({ discover = discoverCodexModels, resolveContext = async context => context,
  now = Date.now, ttlMs = CATALOG_TTL_MS } = {}) {
  const entries = new Map(), generations = new Map();
  const keyOf = context => JSON.stringify(contextScope(context));
  const discarded = (scope, reason, generation, snapshot) => ({ ...(snapshot?.process ? { process: snapshot.process } : {}),
    status: 'unavailable', source: snapshot?.source ?? (scope.environmentBinding.client === 'codex' ? 'codex-model/list' : 'native-catalog'),
    reason, generation, models: [], capabilities: { models: 'unknown', effort: 'unknown' } });
  return {
    get(context) {
      const entry = entries.get(keyOf(context));
      if (!entry) return null;
      const copy = structuredClone(entry.snapshot);
      if (copy.status === 'ready' && now() >= entry.expires) { copy.status = 'stale'; copy.reason = 'catalog-expired'; }
      return copy;
    },
    invalidate(context) {
      const key = keyOf(context); entries.delete(key); generations.set(key, (generations.get(key) ?? 0) + 1);
    },
    async refresh(context, options = {}) {
      const frozen = structuredClone(context), scope = contextScope(frozen), key = JSON.stringify(scope);
      const generation = (generations.get(key) ?? 0) + 1; generations.set(key, generation);
      const current = () => generations.get(key) === generation;
      if (!isDeepStrictEqual(contextScope(await resolveContext(context)), scope) || !current())
        return discarded(scope, 'catalog-context-changed', generation);
      if (options.signal?.aborted) return discarded(scope, 'catalog-cancelled', generation);
      const snapshot = await discover({ ...options, profile: frozen.profile, workspace: frozen.workspace });
      if (!current()) return discarded(scope, 'catalog-superseded', generation, snapshot);
      const reconciled = await resolveContext(context);
      if (!current()) return discarded(scope, 'catalog-superseded', generation, snapshot);
      if (options.signal?.aborted) return discarded(scope, 'catalog-cancelled', generation, snapshot);
      if (!isDeepStrictEqual(contextScope(reconciled), scope)
        || !isDeepStrictEqual(snapshot.scope?.environmentBinding, scope.environmentBinding)
        || snapshot.scope?.workspace !== scope.workspace)
        return discarded(scope, 'catalog-context-changed', generation, snapshot);
      snapshot.scope = { ...scope, account: snapshot.scope.account };
      snapshot.generation = generation;
      snapshot.expiresAt = new Date(now() + ttlMs).toISOString();
      const previous = entries.get(key)?.snapshot;
      if (snapshot.status !== 'ready' && previous) snapshot.lastSuccessful = previous.status === 'ready'
        ? { source: previous.source, discoveredAt: previous.discoveredAt, expiresAt: previous.expiresAt }
        : previous.lastSuccessful ?? null;
      entries.set(key, { snapshot: structuredClone(snapshot), expires: now() + ttlMs });
      return snapshot;
    },
  };
}
