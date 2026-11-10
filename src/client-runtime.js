// The current Codex implementation owns its transport; coordinators own job lifecycle.
import { isDeepStrictEqual } from 'node:util';
import { runAuditCapture } from './audit-capture.js';
import { createEnvironmentBinding, assertEnvironmentBinding, createNativeReference, assertNativeReference } from './client-contracts.js';

export function createClientRuntime({ capture = runAuditCapture } = {}) {
  return { async capture(options) {
    const profile = options.profile;
    const binding = profile?.environmentBinding ? createEnvironmentBinding(profile.environmentBinding) : null;
    const client = profile?.client ?? binding?.client ?? 'codex';
    if (client !== 'codex' || (profile?.surface ?? binding?.surface ?? 'cli') !== 'cli'
      || (profile?.executionLocation ?? binding?.executionLocation ?? 'local') !== 'local'
      || binding && (binding.client !== client || binding.surface !== 'cli' || binding.executionLocation !== 'local'))
      throw new Error('This runtime supports local Codex CLI execution only');
    if (binding && (binding.profileId !== profile.profileId || binding.roots.config !== profile.home
      || binding.rootMode !== profile.rootMode || binding.roots.user !== profile.userHome
      || binding.roots.reservation !== (profile.reservationRoot ?? profile.nativeRoot ?? profile.home)
      || options.executionMode === 'profile' && (binding.workspace !== options.workspace
        || binding.roots.runtime !== (profile.nativeRoot ? profile.home : null))
      || binding.executable.path !== profile.executable || binding.executable.identity !== profile.executableIdentity
      || !isDeepStrictEqual(binding.settingsIdentity, profile.settingsIdentity ?? null)))
      throw new Error('Runtime profile does not match its environment binding');
    const jobId = options.jobId ?? options.limits?.id;
    if (options.jobId && options.limits?.id && options.jobId !== options.limits.id)
      throw new Error('Runtime job identity does not match');
    const qualify = (run, evidence) => {
      if (!run) return;
      if (jobId && run.id && run.id !== jobId) throw new Error('Captured run job identity does not match');
      const identity = { client, surface: 'cli', executionLocation: 'local' };
      if (run.clientIdentity !== undefined) {
        if (!run.clientIdentity || typeof run.clientIdentity !== 'object' || Array.isArray(run.clientIdentity)
          || ![Object.prototype, null].includes(Object.getPrototypeOf(run.clientIdentity))
          || Object.entries(identity).some(([key, value]) => run.clientIdentity[key] != null && run.clientIdentity[key] !== value))
          throw new Error('Captured run client identity does not match its runtime');
      }
      let expectedBinding = binding;
      if (!expectedBinding && profile.profileId && profile.home && profile.userHome && profile.executableIdentity) {
        expectedBinding = createEnvironmentBinding({ client, surface: 'cli', executionLocation: 'local',
          profileId: profile.profileId, rootMode: profile.rootMode ?? 'explicit',
          roots: { config: profile.home, runtime: evidence?.runtimeRoots?.sqlite ?? null,
            user: profile.userHome, reservation: profile.reservationRoot ?? profile.nativeRoot ?? profile.home },
          workspace: options.workspace, executable: { path: profile.executable, identity: profile.executableIdentity,
            version: profile.version ?? null }, settingsIdentity: profile.settingsIdentity ?? null });
      }
      if (run.environmentBinding !== undefined) {
        if (!expectedBinding) throw new Error('Captured environment binding cannot be verified against its dispatch');
        assertEnvironmentBinding(run.environmentBinding, expectedBinding);
      } else if (expectedBinding) run.environmentBinding = expectedBinding;
      if (run.clientIdentity === undefined) run.clientIdentity = identity;
      if (jobId && profile.profileId) {
        const scope = { client, jobId, profileId: profile.profileId };
        const previous = run.nativeReference ? assertNativeReference(run.nativeReference, scope) : null;
        const native = evidence?.nativeReference;
        if (native && ['client', 'jobId', 'profileId'].some(key => Object.hasOwn(native, key)))
          assertNativeReference(native, scope);
        if (native?.sessionId && run.source?.threadId && native.sessionId !== run.source.threadId)
          throw new Error('Captured native session identity does not match');
        for (const key of ['sessionId', 'turnId', 'itemId', 'requestId'])
          if (previous?.[key] && native?.[key] && previous[key] !== native[key])
            throw new Error(`Captured native ${key} identity does not match`);
        if (previous?.sessionId && run.source?.threadId && previous.sessionId !== run.source.threadId)
          throw new Error('Native session identity does not match');
        run.nativeReference = createNativeReference({ ...previous, ...native, ...scope,
          sessionId: run.source?.threadId ?? native?.sessionId ?? previous?.sessionId,
          turnId: evidence?.nativeReference?.turnId ?? previous?.turnId });
      }
      if (evidence?.settingsEvidence) run.settingsEvidence = structuredClone(evidence.settingsEvidence);
    };
    const result = await capture({ ...options, ...(jobId ? { limits: { ...options.limits, id: jobId } } : {}), onSession: async (run, evidence) => {
      qualify(run, evidence);
      await options.onSession?.(run, evidence);
    } });
    qualify(result?.run, result?.capture);
    return result;
  } };
}
