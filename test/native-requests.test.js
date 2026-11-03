import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNativeRequest, validateNativeResponse } from '../src/native-requests.js';

const base = { jsonrpc: '2.0', id: 7, method: 'item/commandExecution/requestApproval', params: {
  threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', startedAtMs: 0, command: 'cat report.md', cwd: '/repo',
} };

test('validates command and file decisions and preserves native payload values', () => {
  const request = validateNativeRequest(base);
  assert.equal(request.params.command, 'cat report.md');
  assert.deepEqual(validateNativeResponse(request, { decision: 'acceptForSession' }), { decision: 'acceptForSession' });
  const fileRequest = validateNativeRequest({ ...base, method: 'item/fileChange/requestApproval', params: {
    threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', startedAtMs: 0, reason: 'write files', grantRoot: '/repo',
  } });
  assert.deepEqual(validateNativeResponse(fileRequest, { decision: 'decline' }), { decision: 'decline' });
});

test('restricts managed human command approvals to fresh accept, decline, or cancel', () => {
  const request = validateNativeRequest({ ...base, params: { ...base.params, kind: 'humanCommand' } });
  assert.throws(() => validateNativeResponse(request, { decision: 'acceptForSession' }), /valid native choice/);
  assert.deepEqual(validateNativeResponse(request, { decision: 'accept' }), { decision: 'accept' });
});

test('validates permission grants without inventing a grant', () => {
  const request = validateNativeRequest({ ...base, method: 'item/permissions/requestApproval', params: {
    threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', startedAtMs: 0, cwd: '/repo',
    permissions: { network: { enabled: true } },
  } });
  assert.deepEqual(validateNativeResponse(request, { permissions: { network: { enabled: true } }, scope: 'turn' }),
    { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.throws(() => validateNativeResponse(request, { permissions: { network: { enabled: 'yes' } } }), /enabled must be boolean/);
  assert.deepEqual(validateNativeResponse(request, { permissions: {} }), { permissions: {} }, 'an empty grant is a valid explicit denial');
  assert.throws(() => validateNativeResponse(request, { permissions: { fileSystem: { read: ['/outside'] } } }), /outside the native request/);
  assert.throws(() => validateNativeRequest({ ...request, params: { ...request.params, permissions: { fileSystem: { write: 3 } } } }), /array of paths/);
});

test('validates requested user answers against question ids and native options', () => {
  const request = validateNativeRequest({ ...base, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', questions: [
      { id: 'choice', header: 'Choice', question: 'Pick one', options: [
        { label: 'A', description: 'First' }, { label: 'B', description: 'Second' },
      ] },
      { id: 'notes', header: 'Notes', question: 'Any detail?', isOther: true },
    ],
  } });
  const answer = { answers: { choice: { answers: ['B'] }, notes: { answers: ['user text'] } } };
  assert.deepEqual(validateNativeResponse(request, answer), answer);
  assert.throws(() => validateNativeResponse(request, { answers: { choice: { answers: ['C'] } } }), /native choices/);
  assert.throws(() => validateNativeResponse(request, { answers: { unknown: { answers: ['x'] } } }), /unrequested question/);
  assert.throws(() => validateNativeResponse(request, { answers: { choice: { answers: ['A'] } }, extra: true }), /unsupported field/);
});

test('constrains command decisions to native offered choices and exact proposed amendments', () => {
  const request = validateNativeRequest({ ...base, params: { ...base.params,
    availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: ['cat report.md'],
  } });
  assert.throws(() => validateNativeResponse(request, { decision: 'acceptForSession' }), /not offered/);
  assert.throws(() => validateNativeResponse(request, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm -rf /'] } } }), /valid native choice/);
  const amendmentRequest = validateNativeRequest({ ...base, params: {
    ...base.params, proposedExecpolicyAmendment: ['cat report.md'],
    availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cat report.md'] } }],
  } });
  assert.deepEqual(validateNativeResponse(amendmentRequest, {
    decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cat report.md'] } },
  }).decision, { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cat report.md'] } });
  assert.throws(() => validateNativeResponse(amendmentRequest, { decision: 'accept' }), /not offered/);
  assert.throws(() => validateNativeResponse(amendmentRequest, { decision: { acceptWithExecpolicyAmendment: ['cat report.md'] } }), /execpolicy amendment must be an object/);
  assert.throws(() => validateNativeResponse(amendmentRequest, { decision: { acceptWithExecpolicyAmendment: { execpolicyAmendment: ['cat report.md'] } } }), /unsupported field/);
  const networkRequest = validateNativeRequest({ ...base, params: { ...base.params,
    proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }],
    availableDecisions: [{ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } }],
  } });
  assert.throws(() => validateNativeResponse(networkRequest, { decision: { applyNetworkPolicyAmendment: { networkPolicyAmendment: { host: 'example.com', action: 'allow' } } } }), /unsupported field/);
  assert.throws(() => validateNativeResponse(networkRequest, { decision: { applyNetworkPolicyAmendment: null } }), /network amendment must be an object/);
});

test('rejects unsupported methods and malformed server request shapes by name', () => {
  assert.throws(() => validateNativeRequest({ ...base, method: 'mcpServer/elicitation/request' }), /mcpServer\/elicitation\/request/);
  assert.throws(() => validateNativeRequest({ ...base, params: { ...base.params, threadId: '' } }), /params.threadId/);
  assert.throws(() => validateNativeRequest({ ...base, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', questions: [{ id: 'q', header: 'H', question: 'Q', options: [{ label: 'A' }] }],
  } }), /option.description/);
  assert.throws(() => validateNativeRequest({ ...base, params: { ...base.params, command: 17 } }), /params.command/);
  assert.throws(() => validateNativeRequest({ ...base, params: { ...base.params, surprise: true } }), /unsupported field/);
  assert.throws(() => validateNativeRequest({ ...base, params: null }), /params must be an object/);
  assert.throws(() => validateNativeResponse(validateNativeRequest(base), null), /response must be an object/);
});
