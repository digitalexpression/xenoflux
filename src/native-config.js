// Older copy journals could contain a serialized configuration up to their
// 384 KiB aggregate limit. Readers retain that bounded recovery envelope.
export const MAX_NATIVE_CONFIG_BYTES = 384 * 1024;
// New copies remain smaller, so an accepted output is safely portable.
export const MAX_COPIED_NATIVE_CONFIG_BYTES = 256 * 1024;

export const CONFIG_KEYS = Object.freeze(['model', 'model_reasoning_effort', 'plan_mode_reasoning_effort', 'model_verbosity',
  'model_context_window', 'model_auto_compact_token_limit', 'personality', 'service_tier',
  'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'project_doc_max_bytes', 'project_doc_fallback_filenames']);
export const AGENT_KEYS = Object.freeze(['max_threads', 'max_concurrent_threads_per_session', 'max_depth', 'job_max_runtime_seconds',
  'default_subagent_model', 'default_subagent_reasoning_effort']);
export const ROLE_KEYS = Object.freeze(['name', 'description', 'model', 'model_reasoning_effort', 'sandbox_mode', 'nickname_candidates', 'developer_instructions']);

export function supportsNativeProvider(config) {
  return (config.model_provider ?? 'openai') === 'openai'
    && !Object.hasOwn(config.model_providers ?? {}, 'openai');
}
