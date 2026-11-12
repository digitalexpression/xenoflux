// The current Codex implementation owns its transport; coordinators own job lifecycle.
import { isDeepStrictEqual } from 'node:util';
import { runAuditCapture } from './audit-capture.js';
import { createEnvironmentBinding } from './client-contracts.js';
import { createCaptureProjection } from './capture-projection.js';
import { createCopilotRuntime } from './copilot-runtime.js';
import { createClaudeRuntime } from './claude-runtime.js';
import { createCodexRuntime } from './codex-runtime.js';

export function createClientRuntime({ capture = runAuditCapture, runtimes = {} } = {}) {
  const implementations = { codex: { ...createCodexRuntime(), capture }, 'claude-code': createClaudeRuntime(), copilot: createCopilotRuntime(), ...runtimes };
  const owners = new WeakMap();
  const implementationFor = client => {
    const implementation = Object.hasOwn(implementations, client) ? implementations[client] : null;
    if (!implementation) throw new Error(`No local CLI runtime is available for ${client}`);
    return implementation;
  };
  const operation = (handle, name, ...args) => {
    const implementation = owners.get(handle);
    if (!implementation || typeof implementation[name] !== 'function') throw new Error(`Unavailable runtime operation: ${name}`);
    return implementation[name](handle, ...args);
  };
  return {
    async initialize(binding, callbacks, signal) {
      const implementation = implementationFor(binding?.client ?? 'codex');
      if (typeof implementation.initialize !== 'function') throw new Error('Runtime initialization is unavailable');
      const handle = await implementation.initialize(binding, callbacks, signal);
      owners.set(handle, implementation);
      return handle;
    },
    submit: (handle, task, ...args) => operation(handle, 'submit', task, ...args),
    respond: (handle, request, answer) => operation(handle, 'respond', request, answer),
    cancel: handle => operation(handle, 'cancel'),
    inspect: (nativeRef, { handle } = {}) => handle
      ? operation(handle, 'inspect', nativeRef)
      : { status: 'unavailable', reason: 'Native state is not attached; inspection never initializes or submits a task.' },
    async capture(options) {
    const profile = options.profile;
    const binding = profile?.environmentBinding ? createEnvironmentBinding(profile.environmentBinding) : null;
    const client = profile?.client ?? binding?.client ?? 'codex';
    const implementation = implementationFor(client);
    if (typeof implementation.capture !== 'function') throw new Error(`Runtime capture is unavailable for ${client}`);
    if ((profile?.surface ?? binding?.surface ?? 'cli') !== 'cli'
      || (profile?.executionLocation ?? binding?.executionLocation ?? 'local') !== 'local'
      || binding && (binding.client !== client || binding.surface !== 'cli' || binding.executionLocation !== 'local'))
      throw new Error('This runtime supports local CLI execution only');
    if (binding && (binding.profileId !== profile.profileId || binding.roots.config !== profile.home
      || binding.rootMode !== profile.rootMode || binding.roots.user !== profile.userHome
      || binding.roots.reservation !== (profile.reservationRoot ?? profile.nativeRoot ?? profile.home)
      || (options.executionMode === 'profile' || client !== 'codex') && (binding.workspace !== options.workspace
        || binding.roots.runtime !== (profile.nativeRoot ? profile.home : null))
      || binding.executable.path !== profile.executable || binding.executable.identity !== profile.executableIdentity
      || !isDeepStrictEqual(binding.settingsIdentity, profile.settingsIdentity ?? null)))
      throw new Error('Runtime profile does not match its environment binding');
    const jobId = options.jobId ?? options.limits?.id;
    if (options.jobId && options.limits?.id && options.jobId !== options.limits.id)
      throw new Error('Runtime job identity does not match');
    const qualify = createCaptureProjection({ client, jobId, profile, binding, workspace: options.workspace });
    const result = await implementation.capture({ ...options, ...(jobId ? { limits: { ...options.limits, id: jobId } } : {}), onSession: async (run, evidence) => {
      qualify(run, evidence);
      await options.onSession?.(run, evidence);
    } });
    qualify(result?.run, result?.capture);
    return result;
  } };
}
