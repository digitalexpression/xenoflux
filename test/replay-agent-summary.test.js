import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const buildDir = await mkdtemp(path.join(os.tmpdir(), 'xenoflux-agent-summary-'))
const configPath = path.join(buildDir, 'tsconfig.json')
await writeFile(configPath, JSON.stringify({
  extends: path.join(root, 'web/tsconfig.json'),
  compilerOptions: { noEmit: false, outDir: buildDir, rootDir: path.join(root, 'web/src'), types: [] },
  files: [path.join(root, 'web/src/lib/replay-agent-summary.ts')],
  include: [],
}))
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', configPath], { stdio: 'pipe' })
await writeFile(path.join(buildDir, 'package.json'), JSON.stringify({ type: 'module' }))
const { deriveAgentSummaries } = await import(pathToFileURL(path.join(buildDir, 'lib/replay-agent-summary.js')).href)
test.after(async () => rm(buildDir, { recursive: true, force: true }))

const event = (id, values = {}) => ({
  id, sessionId: values.sessionId ?? 'root', turnId: null, kind: 'message', label: 'Assistant message',
  timestamp: null, sourceLine: null, bodyStatus: 'included', ...values,
})

function pair({ terminal = true, receipt = true, sender = '/root/worker', later = 'Follow-up references /root/worker.' } = {}) {
  const childId = 'child'
  const resultBody = 'Implemented the requested change.'
  const rootEvents = [
    event('spawn', { sessionId: 'root', role: undefined, kind: 'tool-call', label: 'spawn_agent', callId: 'call-1', turnId: 'turn-1', body: JSON.stringify({ task_name: 'worker', message: 'gAAAAopaque' }) }),
    event('start', { sessionId: 'root', role: undefined, kind: 'delegation', label: 'Delegated agent started', status: 'started', callId: 'call-1', turnId: 'turn-1', childSessionIds: [childId] }),
  ]
  if (receipt) rootEvents.push(event('receipt', { sessionId: 'root', role: 'assistant', label: 'Agent update', body: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${sender}\nPayload:\n${resultBody}` }))
  if (later) rootEvents.push(event('later', { sessionId: 'root', role: 'assistant', timestamp: '2026-10-30T12:00:00Z', body: later }))
  const childEvents = [
    event('new-task', { sessionId: childId, role: 'assistant', label: 'Agent update', body: 'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nChange replay.' }),
    event('result', { sessionId: childId, role: 'assistant', body: resultBody }),
  ]
  if (terminal) childEvents.push(event('done', { sessionId: childId, role: undefined, kind: 'session', label: 'Session completed', status: 'completed' }))
  return {
    schemaVersion: 1,
    kind: 'session-replay',
    sessions: [
      { id: 'root', parentId: null, status: 'ready', source: { fingerprint: null }, events: rootEvents },
      { id: childId, parentId: 'root', status: 'ready', source: { fingerprint: null }, events: childEvents },
    ],
  }
}

test('links a readable opaque assignment and terminal result to their source events', () => {
  const summary = deriveAgentSummaries(pair()).get('child')
  assert.equal(summary.assignment.event.id, 'spawn')
  assert.match(summary.assignmentNote, /opaque/)
  assert.equal(summary.result.event.id, 'result')
  assert.equal(summary.received.event.id, 'receipt')
  assert.deepEqual(summary.followUps.map(item => item.event.id), ['later'])
})

test('does not promote a last assistant message from a readable but unfinished session', () => {
  const summary = deriveAgentSummaries(pair({ terminal: false, receipt: false })).get('child')
  assert.equal(summary.result, null)
  assert.match(summary.resultNote, /no result is identified/)
})

test('a previous completed event cannot certify later resumed-session commentary', () => {
  const replay = pair({ terminal: false, receipt: false })
  const child = replay.sessions[1]
  child.events.splice(1, 0, event('old-done', { sessionId: 'child', role: undefined, kind: 'session', label: 'Session completed', status: 'completed' }))
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.result, null)
})

test('a readable response before an unreadable final assistant event is not reused as the result', () => {
  const replay = pair({ receipt: false })
  replay.sessions[1].events.splice(2, 0, event('unreadable-final', {
    sessionId: 'child', role: 'assistant', bodyStatus: 'unavailable', body: undefined,
  }))
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.result, null)
  assert.match(summary.resultNote, /unreadable/)
})

test('completed event permits the last response but does not claim it was the final answer', () => {
  const summary = deriveAgentSummaries(pair({ receipt: false })).get('child')
  assert.equal(summary.result.event.id, 'result')
  assert.equal(summary.resultNote, 'Last recorded assistant response before completion; final-answer status is not recorded.')
})

test('an exact final-answer receipt may corroborate a result without a terminal event', () => {
  const summary = deriveAgentSummaries(pair({ terminal: false })).get('child')
  assert.equal(summary.result.event.id, 'result')
  assert.equal(summary.received.event.id, 'receipt')
})

test('identical sibling payload and wrong sender cannot receive another child result', () => {
  const replay = pair()
  const root = replay.sessions[0]
  root.events[2].body = root.events[2].body.replace('/root/worker', '/root/other')
  const child = structuredClone(replay.sessions[1])
  child.id = 'sibling'
  child.events = child.events.map(item => ({ ...item, id: `sibling-${item.id}`, sessionId: 'sibling' }))
  child.events[0].body = child.events[0].body.replace('/root/worker', '/root/sibling')
  replay.sessions.push(child)
  const summaries = deriveAgentSummaries(replay)
  assert.equal(summaries.get('child').received, null)
  assert.equal(summaries.get('sibling').received, null)
})

test('final-answer wrapper task name must agree with the recorded direct parent', () => {
  const replay = pair()
  replay.sessions[0].events[2].body = replay.sessions[0].events[2].body.replace('Task name: /root', 'Task name: /root/wrong-parent')
  assert.equal(deriveAgentSummaries(replay).get('child').received, null)
})

test('a matching-looking delivery in a non-parent session is not accepted', () => {
  const replay = pair({ receipt: false })
  replay.sessions.push({ id: 'other', parentId: null, status: 'ready', source: { fingerprint: null }, events: [
    event('foreign-receipt', { sessionId: 'other', role: 'assistant', label: 'Agent update', body: 'Message Type: FINAL_ANSWER\nTask name: worker\nSender: /root/worker\nPayload:\nImplemented the requested change.' }),
  ] })
  assert.equal(deriveAgentSummaries(replay).get('child').received, null)
})

test('orphaned child is not treated as a root or linked to a missing parent', () => {
  const replay = pair()
  replay.sessions[1].parentId = 'missing-parent'
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.assignment, null)
  assert.match(summary.assignmentNote, /parent session is unavailable/)
  assert.equal(summary.received, null)
  assert.match(summary.parentNote, /parent session is unavailable/)
})

test('a linked non-spawn call does not count as an assignment', () => {
  const replay = pair()
  replay.sessions[0].events[0].label = 'shell_command'
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.assignment, null)
  assert.match(summary.assignmentNote, /No unique recorded spawn call/)
})

test('root assignment skips instruction context and later timestamps alone do not count as follow-up', () => {
  const replay = pair({ later: 'The task continued later.' })
  const root = replay.sessions[0]
  root.events.unshift(event('agents', { sessionId: 'root', role: 'user', body: '# AGENTS.md\nInstructions.' }))
  root.events.splice(1, 0, event('request', { sessionId: 'root', role: 'user', body: 'Complete the requested replay work.' }))
  const summary = deriveAgentSummaries(replay).get('root')
  assert.equal(summary.assignment.event.id, 'request')
  assert.equal(summary.parentNote, 'Main session has no parent.')
  assert.deepEqual(summary.followUps, [])
})

test('child receives root opening task only as linked context when its assignment is opaque', () => {
  const replay = pair()
  const root = replay.sessions[0]
  root.events.unshift(event('agents', { sessionId: 'root', role: 'user', body: '# AGENTS.md\nInstructions.' }))
  root.events.splice(1, 0, event('request', { sessionId: 'root', role: 'user', body: 'Complete the requested replay work.' }))
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.assignment.event.id, 'spawn')
  assert.match(summary.assignmentNote, /opaque/)
  assert.equal(summary.taskContext.event.id, 'request')
  assert.equal(summary.taskContext.sessionId, 'root')
})

test('cyclic parent links fail closed when deriving root task context', () => {
  const replay = pair()
  replay.sessions[0].events.unshift(event('request', { sessionId: 'root', role: 'user', body: 'Complete the requested replay work.' }))
  replay.sessions[0].parentId = 'child'
  assert.equal(deriveAgentSummaries(replay).get('child').taskContext, null)
})

test('canonical child references require path boundaries and duplicate names fail closed', () => {
  const replay = pair({ later: 'Follow-up references /root/worker_extra.' })
  assert.deepEqual(deriveAgentSummaries(replay).get('child').followUps, [])
  const duplicate = structuredClone(replay.sessions[1])
  duplicate.id = 'second-child'
  duplicate.events = duplicate.events.map(item => ({ ...item, id: `second-${item.id}`, sessionId: 'second-child' }))
  replay.sessions.push(duplicate)
  assert.equal(deriveAgentSummaries(replay).get('child').received, null)
})


test('namespaced spawn calls use the same recorded assignment identity', () => {
  const replay = pair();
  replay.sessions[0].events[0].label = 'collaboration.spawn_agent';
  assert.equal(deriveAgentSummaries(replay).get('child').assignment.event.id, 'spawn');
});

test('quoted final-answer text in tool output is not a parent receipt', () => {
  const replay = pair();
  const receipt = replay.sessions[0].events.find(event => event.id === 'receipt');
  receipt.kind = 'tool-result';
  receipt.role = undefined;
  assert.equal(deriveAgentSummaries(replay).get('child').received, null);
});


test('an unanswered later task does not reuse the preceding completed response', () => {
  const replay = pair({ receipt: false })
  const child = replay.sessions[1]
  child.events.push(event('next-task', { sessionId: 'child', role: 'user', body: 'Now handle the next request.' }))
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.result, null)
  assert.match(summary.resultNote, /later task or turn started/)
})
