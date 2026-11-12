import { isDeepStrictEqual } from 'node:util';
import { CLAUDE_REQUEST, validateClaudeDecision } from './claude-decoder.js';
import { COPILOT_REQUEST, copilotDecision } from './copilot-events.js';

// Validate supported server-initiated app-server requests before showing them
// and validate the user's explicit response before writing it to that socket.
const METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
function fail(method, detail) { throw new Error(`Unsupported or malformed native request ${method}: ${detail}`); }
function record(value, method, field) {
  if (!object(value)) fail(method, `${field} must be an object`);
}
function string(value, method, field) {
  if (!nonempty(value)) fail(method, `${field} must be a nonempty string`);
}
function keys(value, allowed, method, field) {
  record(value, method, field);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(method, `${field} contains an unsupported field`);
}
function optionalString(value, method, field) {
  if (value != null && typeof value !== 'string') fail(method, `${field} must be a string`);
}
function permissionFileSystem(value, method, field) {
  record(value, method, field);
  keys(value, ['read', 'write', 'globScanMaxDepth', 'entries'], method, field);
  for (const key of ['read', 'write']) if (value[key] != null
    && (!Array.isArray(value[key]) || value[key].some(path => typeof path !== 'string' || !path)))
    fail(method, `${field}.${key} must be an array of paths`);
  if (value.globScanMaxDepth != null && (!Number.isSafeInteger(value.globScanMaxDepth) || value.globScanMaxDepth < 1))
    fail(method, `${field}.globScanMaxDepth must be a positive integer`);
  if (value.entries != null) {
    if (!Array.isArray(value.entries)) fail(method, `${field}.entries must be an array`);
    for (const entry of value.entries) {
      record(entry, method, `${field}.entries[]`);
      keys(entry, ['path', 'access'], method, `${field}.entries[]`);
      record(entry.path, method, `${field}.entries[].path`);
      if (!['read', 'write', 'deny'].includes(entry.access)) fail(method, 'filesystem access is invalid');
      const path = entry.path;
      if (path.type === 'path') { keys(path, ['type', 'path'], method, 'filesystem path'); string(path.path, method, 'filesystem path.path'); }
      else if (path.type === 'glob_pattern') { keys(path, ['type', 'pattern'], method, 'filesystem glob'); string(path.pattern, method, 'filesystem glob.pattern'); }
      else if (path.type === 'special') {
        keys(path, ['type', 'value'], method, 'filesystem special path'); record(path.value, method, 'filesystem special path.value');
        const { kind, ...rest } = path.value;
        if (!['root', 'minimal', 'project_roots', 'tmpdir', 'slash_tmp', 'unknown'].includes(kind)) fail(method, 'filesystem special path kind is unsupported');
        const fields = kind === 'project_roots' ? ['subpath'] : kind === 'unknown' ? ['path', 'subpath'] : [];
        keys(rest, fields, method, 'filesystem special path.value');
        if (kind === 'unknown') string(rest.path, method, 'filesystem special path.path');
        optionalString(rest.subpath, method, 'filesystem special path.subpath');
      } else fail(method, 'filesystem path type is unsupported');
    }
  }
}
function permissionProfile(value, method, field, { request = false } = {}) {
  record(value, method, field);
  keys(value, ['network', 'fileSystem'], method, field);
  if (value.network != null) {
    record(value.network, method, `${field}.network`);
    keys(value.network, ['enabled'], method, `${field}.network`);
    if (value.network.enabled != null && typeof value.network.enabled !== 'boolean') fail(method, `${field}.network.enabled must be boolean`);
  }
  if (value.fileSystem != null) permissionFileSystem(value.fileSystem, method, `${field}.fileSystem`);
  if (request && value.network == null && value.fileSystem == null) fail(method, `${field} must request a permission`);
}
function permissionGrantIsWithinRequest(grant, requested) {
  if (grant.network?.enabled === true && requested.network?.enabled !== true) return false;
  if (grant.fileSystem) {
    const req = requested.fileSystem;
    if (!req) return false;
    for (const key of ['read', 'write']) if (grant.fileSystem[key]?.some(path => !req[key]?.includes(path))) return false;
    if (grant.fileSystem.globScanMaxDepth != null
      && (req.globScanMaxDepth == null || grant.fileSystem.globScanMaxDepth > req.globScanMaxDepth)) return false;
    if (grant.fileSystem.entries?.some(entry => !req.entries?.some(candidate => isDeepStrictEqual(entry, candidate)))) return false;
  }
  return true;
}
function amendment(value, method) {
  record(value, method, 'amendment');
  keys(value, ['host', 'action'], method, 'amendment');
  string(value.host, method, 'amendment.host');
  if (!['allow', 'deny'].includes(value.action)) fail(method, 'amendment.action is invalid');
}
function requestKeys(params, method) {
  const allowed = method === 'item/commandExecution/requestApproval'
    ? ['kind', 'threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId', 'environmentId', 'reason', 'networkApprovalContext', 'command', 'cwd', 'commandActions', 'additionalPermissions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'availableDecisions']
    : method === 'item/fileChange/requestApproval'
      ? ['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'grantRoot']
      : method === 'item/permissions/requestApproval'
        ? ['threadId', 'turnId', 'itemId', 'environmentId', 'startedAtMs', 'cwd', 'reason', 'permissions']
        : ['threadId', 'turnId', 'itemId', 'questions', 'isBlocking', 'autoResolutionMs'];
  keys(params, allowed, method, 'params');
}
function validCommandAction(action, method) {
  record(action, method, 'params.commandActions[]');
  if (!['read', 'listFiles', 'search', 'unknown'].includes(action.type)) return false;
  const fields = action.type === 'read' ? ['type', 'command', 'name', 'path']
    : action.type === 'listFiles' ? ['type', 'command', 'path']
      : action.type === 'search' ? ['type', 'command', 'query', 'path'] : ['type', 'command'];
  keys(action, fields, method, 'params.commandActions[]');
  if (typeof action.command !== 'string') return false;
  if (action.type === 'read') return nonempty(action.name) && nonempty(action.path);
  if (action.type === 'listFiles') return action.path == null || typeof action.path === 'string';
  if (action.type === 'search') return (action.path == null || typeof action.path === 'string') && (action.query == null || typeof action.query === 'string');
  return true;
}
const DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'];
function validateDecisionShape(decision, method, request) {
  if (typeof decision === 'string') return DECISIONS.includes(decision)
    && !(request.params.kind === 'humanCommand' && decision === 'acceptForSession');
  if (method !== 'item/commandExecution/requestApproval' || request.params.kind === 'humanCommand' || !object(decision)) return false;
  const variants = Object.keys(decision);
  if (variants.length !== 1) return false;
  if (variants[0] === 'acceptWithExecpolicyAmendment') {
    const value = decision.acceptWithExecpolicyAmendment;
    keys(value, ['execpolicy_amendment'], method, 'execpolicy amendment');
    const command = value.execpolicy_amendment;
    const proposed = request.params.proposedExecpolicyAmendment;
    return Array.isArray(command) && command.length > 0 && command.every(nonempty)
      && Array.isArray(proposed) && isDeepStrictEqual(command, proposed);
  }
  if (variants[0] === 'applyNetworkPolicyAmendment') {
    const wrapper = decision.applyNetworkPolicyAmendment;
    keys(wrapper, ['network_policy_amendment'], method, 'network amendment');
    const amendment = wrapper.network_policy_amendment;
    return object(amendment) && nonempty(amendment.host) && ['allow', 'deny'].includes(amendment.action)
      && Object.keys(amendment).every(key => ['host', 'action'].includes(key))
      && request.params.proposedNetworkPolicyAmendments?.some(value => isDeepStrictEqual(value, amendment));
  }
  return false;
}

export function validateNativeRequest(message) {
  const method = message?.method;
  if (!METHODS.has(method)) fail(typeof method === 'string' ? method : '<missing method>', 'method is not supported');
  if (!(typeof message.id === 'string' && message.id.length > 0)
    && !(Number.isSafeInteger(message.id) && message.id >= 0)) fail(method, 'request id is invalid');
  const p = message.params;
  record(p, method, 'params');
  requestKeys(p, method);
  for (const key of ['threadId', 'turnId', 'itemId']) string(p[key], method, `params.${key}`);
  if (method !== 'item/tool/requestUserInput' && (!Number.isSafeInteger(p.startedAtMs) || p.startedAtMs < 0))
    fail(method, 'params.startedAtMs must be a nonnegative integer');
  optionalString(p.approvalId, method, 'params.approvalId');
  optionalString(p.environmentId, method, 'params.environmentId');
  optionalString(p.reason, method, 'params.reason');
  if (method === 'item/commandExecution/requestApproval') {
    if (p.kind != null && !['command', 'humanCommand', 'writeStdin'].includes(p.kind)) fail(method, 'params.kind is unsupported');
    optionalString(p.command, method, 'params.command'); optionalString(p.cwd, method, 'params.cwd');
    if (p.networkApprovalContext != null) {
      record(p.networkApprovalContext, method, 'params.networkApprovalContext');
      keys(p.networkApprovalContext, ['host', 'protocol'], method, 'params.networkApprovalContext');
      string(p.networkApprovalContext.host, method, 'params.networkApprovalContext.host');
      if (!['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(p.networkApprovalContext.protocol)) fail(method, 'params.networkApprovalContext.protocol is unsupported');
    }
    if (p.commandActions != null && (!Array.isArray(p.commandActions) || p.commandActions.some(action => !validCommandAction(action, method))))
      fail(method, 'params.commandActions is malformed');
    if (p.additionalPermissions != null) permissionProfile(p.additionalPermissions, method, 'params.additionalPermissions', { request: true });
    if (p.proposedExecpolicyAmendment != null
      && (!Array.isArray(p.proposedExecpolicyAmendment) || !p.proposedExecpolicyAmendment.length || p.proposedExecpolicyAmendment.some(value => typeof value !== 'string' || !value)))
      fail(method, 'params.proposedExecpolicyAmendment must be a nonempty command array');
    if (p.proposedNetworkPolicyAmendments != null) {
      if (!Array.isArray(p.proposedNetworkPolicyAmendments)) fail(method, 'params.proposedNetworkPolicyAmendments must be an array');
      p.proposedNetworkPolicyAmendments.forEach(value => amendment(value, method));
    }
    if (p.availableDecisions != null && (!Array.isArray(p.availableDecisions)
      || p.availableDecisions.some(decision => !validateDecisionShape(decision, method, { params: p }))))
      fail(method, 'params.availableDecisions contains an unsupported choice');
  } else if (method === 'item/fileChange/requestApproval') {
    optionalString(p.grantRoot, method, 'params.grantRoot');
  } else if (method === 'item/permissions/requestApproval') {
    string(p.cwd, method, 'params.cwd');
    permissionProfile(p.permissions, method, 'params.permissions', { request: true });
  }
  if (method === 'item/tool/requestUserInput') {
    if (!Array.isArray(p.questions) || p.questions.length < 1) fail(method, 'params.questions must be a nonempty array');
    const ids = new Set();
    p.questions.forEach((question, index) => {
      record(question, method, `params.questions[${index}]`);
      keys(question, ['id', 'header', 'question', 'isOther', 'isSecret', 'options'], method, `params.questions[${index}]`);
      for (const key of ['id', 'header', 'question']) string(question[key], method, `questions[${index}].${key}`);
      for (const key of ['isOther', 'isSecret']) if (question[key] != null && typeof question[key] !== 'boolean') fail(method, `questions[${index}].${key} must be boolean`);
      if (ids.has(question.id)) fail(method, 'question ids must be unique');
      ids.add(question.id);
      if (question.options != null) {
        if (!Array.isArray(question.options)) fail(method, 'question options must be an array');
        for (const option of question.options) {
          record(option, method, 'question option');
          keys(option, ['label', 'description'], method, 'question option');
          string(option.label, method, 'option.label');
          string(option.description, method, 'option.description');
        }
      }
    });
  }
  if (method === 'item/tool/requestUserInput') {
    if (p.isBlocking != null && typeof p.isBlocking !== 'boolean') fail(method, 'params.isBlocking must be boolean');
    if (p.autoResolutionMs != null && (!Number.isSafeInteger(p.autoResolutionMs) || p.autoResolutionMs < 0)) fail(method, 'params.autoResolutionMs must be a nonnegative integer');
  }
  return { id: message.id, method, params: p };
}

export function validateNativeResponse(request, result) {
  const method = request?.method;
  if (!METHODS.has(method)) fail(typeof method === 'string' ? method : '<missing method>', 'request is not supported');
  record(result, method, 'response');
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    keys(result, ['decision'], method, 'response');
    const decision = result.decision;
    if (!validateDecisionShape(decision, method, request)) fail(method, 'response decision is not a valid native choice');
    if (Array.isArray(request.params.availableDecisions)
      && !request.params.availableDecisions.some(choice => isDeepStrictEqual(choice, decision)))
      fail(method, 'response decision was not offered by the native request');
  } else if (method === 'item/permissions/requestApproval') {
    keys(result, ['permissions', 'scope', 'strictAutoReview'], method, 'response');
    permissionProfile(result.permissions, method, 'response.permissions');
    if (result.scope !== undefined && !['turn', 'session'].includes(result.scope)) fail(method, 'response.scope is invalid');
    if (!permissionGrantIsWithinRequest(result.permissions, request.params.permissions)) fail(method, 'response grants permissions outside the native request');
    if (result.strictAutoReview !== undefined && typeof result.strictAutoReview !== 'boolean') fail(method, 'strictAutoReview must be boolean');
  } else {
    keys(result, ['answers'], method, 'response');
    const questions = request.params.questions;
    if (!object(result.answers)) fail(method, 'response.answers must map question ids to answers');
    const ids = new Set(questions.map(question => question.id));
    for (const [id, answer] of Object.entries(result.answers)) {
      if (!ids.has(id)) fail(method, `response contains unrequested question ${id}`);
      keys(answer, ['answers'], method, `response.answers.${id}`);
      if (!object(answer) || !Array.isArray(answer.answers) || answer.answers.some(value => typeof value !== 'string'))
        fail(method, `answer for ${id} must contain string choices`);
      const question = questions.find(value => value.id === id);
      if (question.options?.length && answer.answers.some(value => !question.options.some(option => option.label === value)) && !question.isOther)
        fail(method, `answer for ${id} is not one of the native choices`);
    }
  }
  return result;
}

/** Validate a decision using the live request's owning native client. */
export function validateClientNativeResponse(client, request, answer) {
  if (client === 'codex') return validateNativeResponse(request, answer);
  if (client === 'claude-code' && request?.method === CLAUDE_REQUEST) return validateClaudeDecision(request, answer);
  if (client === 'copilot' && request?.method === COPILOT_REQUEST) return copilotDecision(answer);
  throw new Error('Native request does not match the selected client.');
}
