import { createEnvironmentBinding, assertEnvironmentBinding, createNativeReference, assertNativeReference } from './client-contracts.js';

// Read version-1 native references without substituting a legacy Codex ID when
// the qualified reference explicitly records the session as missing.
export function retainedNativeReference(run, profile, jobId, legacySessionId) {
  const supplied = run?.nativeReference;
  const client = profile?.client ?? run?.clientIdentity?.client ?? supplied?.client ?? 'codex';
  if (run?.clientIdentity?.client != null && run.clientIdentity.client !== client) return null;
  if (supplied === undefined) return { client, sessionId: client === 'codex' ? legacySessionId ?? null : null, nativeReference: null };
  try {
    const reference = assertNativeReference(supplied, { client, jobId, profileId: profile?.profileId ?? profile?.id });
    if (legacySessionId != null && reference.sessionId !== legacySessionId) return null;
    return { client, sessionId: reference.sessionId, nativeReference: reference };
  } catch { return null; }
}

// Shared record-v1 projection. Native decoders supply IDs and settings evidence;
// missing IDs stay null and contradictory scope is refused before publication.
export function createCaptureProjection({ client, jobId, profile, binding, workspace }) {
  return (run, evidence) => {
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
        workspace, executable: { path: profile.executable, identity: profile.executableIdentity,
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
}
