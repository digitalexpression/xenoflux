import { parse, stringify } from 'smol-toml';
import { redactText } from './redact.js';

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
const requiredRoleStrings = ['name', 'description', 'developer_instructions'];
const roleStrings = new Set([...requiredRoleStrings, 'model', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity']);
const localRoleSettings = new Set(['mcp_servers', 'approval_policy', 'approvals_reviewer', 'permissions',
  'default_permissions', 'sandbox_workspace_write']);
const restrictableFeatures = new Set(['shell_tool', 'apps', 'plugins', 'memories', 'request_permissions_tool']);
const isTomlTable = value => value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function portableSkillRestrictions(value) {
  if (!isTomlTable(value)) return false;
  return Object.entries(value).every(([key, setting]) => {
    if (key === 'include_instructions') return setting === false;
    if (key === 'bundled') return isTomlTable(setting) && Object.keys(setting).length === 1 && setting.enabled === false;
    return key === 'config' && Array.isArray(setting) && setting.every(entry => isTomlTable(entry)
      && Object.keys(entry).length === 2 && entry.enabled === false && typeof entry.name === 'string' && entry.name.trim() !== '');
  });
}

export function portableCodexAgent(text, { strip = false } = {}) {
  const unsupported = () => new Error('Unsupported Codex agent definition');
  let agent;
  try { agent = parse(text); } catch { throw unsupported(); }
  if (!requiredRoleStrings.every(key => typeof agent[key] === 'string')) throw unsupported();
  let changed = false;
  for (const [key, value] of Object.entries(agent)) {
    if (roleStrings.has(key) && typeof value === 'string'
      || key === 'nickname_candidates' && Array.isArray(value) && value.every(name => typeof name === 'string')
      || key === 'sandbox_mode' && value === 'read-only'
      || key === 'skills' && portableSkillRestrictions(value)) continue;
    if (key === 'features' && isTomlTable(value)) {
      for (const [feature, enabled] of Object.entries(value)) {
        if (!restrictableFeatures.has(feature) || typeof enabled !== 'boolean' || enabled && !strip) throw unsupported();
        if (enabled) {
          delete value[feature];
          changed = true;
        }
      }
      if (!Object.keys(value).length) delete agent[key];
      continue;
    }
    if (!strip || !(localRoleSettings.has(key)
      || key === 'sandbox_mode' && ['workspace-write', 'danger-full-access'].includes(value))) throw unsupported();
    delete agent[key];
    changed = true;
  }
  const portable = changed ? stringify(agent) : text;
  if (redactText(portable, 'agent.toml') !== portable) throw new Error('Credential-like content in Codex agent definition');
  return portable;
}

export function supportsNativeProvider(config) {
  return (config.model_provider ?? 'openai') === 'openai'
    && !Object.hasOwn(config.model_providers ?? {}, 'openai');
}
