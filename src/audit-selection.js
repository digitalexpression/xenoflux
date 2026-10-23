// A comparison's declarations supplement recorded evidence; they never rewrite it.
const safeLabel = value => typeof value === 'string'
  && /^[\p{L}\p{N}][\p{L}\p{N} ._:+-]{0,159}$/u.test(value);

export function auditSelectionOptions(options = {}) {
  const taskAssociation = options.taskAssociation;
  if (taskAssociation !== undefined && (taskAssociation?.status !== 'user-declared'
    || !safeLabel(taskAssociation.taskId)))
    throw new Error('Same-task declaration requires a plain task label of at most 160 characters');
  const variables = options.declaredVariables ?? [];
  if (!Array.isArray(variables) || variables.length > 50 || variables.some(value => !safeLabel(value)))
    throw new Error('Declared variables must be up to 50 plain labels of at most 160 characters');
  return { ...(taskAssociation ? { taskAssociation: { status: 'user-declared', taskId: taskAssociation.taskId } } : {}),
    declaredVariables: [...new Set(variables)] };
}

// Read only declarations, not previously derived eligibility, from a frozen report.
export function retainedAuditSelectionOptions(selection) {
  try {
    return auditSelectionOptions({
      ...(selection?.declaration ? { taskAssociation: selection.declaration } : {}),
      declaredVariables: selection?.declaredVariables ?? [],
    });
  } catch { return {}; }
}

export function buildAuditSelection(left, right, options, association) {
  const declared = auditSelectionOptions(options);
  const identity = run => ({
    provider: run?.source?.provider === 'codex' || ['native-rollout', 'native-app-server-v2'].includes(run?.source?.kind) ? 'codex' : 'unknown',
    client: ['cli', 'desktop'].includes(run?.source?.client) ? run.source.client : 'unknown',
    profileId: run?.profile?.profileId ?? run?.profile?.id ?? run?.profileId ?? null,
    profileName: run?.profile?.profileName ?? run?.profile?.name ?? run?.profileName ?? null,
    sessionId: run?.source?.nativeSessionId ?? run?.source?.threadId ?? null,
    runId: run?.id ?? null,
  });
  return { schemaVersion: 1, left: identity(left), right: identity(right),
    declaration: declared.taskAssociation ?? null, declaredVariables: declared.declaredVariables,
    taskAssociation: association,
    setupBasis: 'Recorded run evidence only; current profile discovery is a separate snapshot.' };
}
