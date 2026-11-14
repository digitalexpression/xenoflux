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

function resumedPair() {
  const replay = pair({ later: null })
  const [parent, child] = replay.sessions
  const correction = 'Corrected the fixture and reran the requested tests.'
  child.events.push(
    event('next-task', { sessionId: 'child', role: 'assistant', label: 'Agent update', body: 'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nCorrect the fixture.' }),
    event('corrected-result', { sessionId: 'child', role: 'assistant', body: correction }),
  )
  parent.events.push(
    event('correction-request', { kind: 'tool-call', label: 'collaboration.followup_task', body: JSON.stringify({ target: '/root/worker', message: 'Correct the fixture.' }) }),
    event('corrected-receipt', { role: 'assistant', label: 'Agent update', body: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\n${correction}` }),
    event('corrected-follow-up', { role: 'assistant', body: 'I used /root/worker to correct the fixture.' }),
  )
  return replay
}

test('a distinct earlier result receipt does not hide the last result of a resumed child', () => {
  const summary = deriveAgentSummaries(resumedPair()).get('child')
  assert.equal(summary.result?.event.id, 'corrected-result')
  assert.equal(summary.received?.event.id, 'corrected-receipt')
  assert.equal(summary.resultNote, null)
  assert.deepEqual(summary.followUps.map(item => item.event.id), ['corrected-follow-up'])
})

test('duplicate exact parent deliveries remain ambiguous across child result cycles', () => {
  const replay = resumedPair()
  const parent = replay.sessions[0]
  parent.events.push({ ...parent.events.find(item => item.id === 'corrected-receipt'), id: 'duplicate-receipt' })
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.received, null)
  assert.equal(summary.result, null)
  assert.deepEqual(summary.followUps, [])
})

test('a later different receipt from the same child cannot corroborate an earlier matching payload', () => {
  const replay = resumedPair()
  replay.sessions[0].events.push(event('later-receipt', { role: 'assistant', label: 'Agent update', body: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nA different later result.' }))
  assert.equal(deriveAgentSummaries(replay).get('child').received, null)
})

test('one old receipt cannot certify an identical payload repeated by a resumed child', () => {
  const replay = resumedPair()
  const [parent, child] = replay.sessions
  child.events.at(-1).body = child.events.find(item => item.id === 'result').body
  parent.events = parent.events.filter(item => item.id !== 'corrected-receipt')
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.received, null)
  assert.equal(summary.result, null)
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

function artifactPair() {
  const replay = pair({ later: 'The child completed its task.' })
  const [parent, child] = replay.sessions
  parent.cwd = child.cwd = '/captured/workspace'
  child.events.splice(1, 0, event('child-change', { sessionId: child.id, kind: 'file-change', status: 'completed',
    body: JSON.stringify({ changes: { '/captured/workspace/test/result.test.js': { type: 'add', content: 'retained test' } } }) }))
  parent.events.push(event('parent-command', { sessionId: parent.id, kind: 'command', status: 'completed',
    body: JSON.stringify({ command: ['/bin/zsh', '-lc', 'node --test test/result.test.js && git status --short'], output: '5 tests passed', exitCode: 0 }) }))
  return replay
}

test('links recorded parent commands to exact child-written artifacts after exact receipt', () => {
  const summary = deriveAgentSummaries(artifactPair()).get('child')
  assert.equal(summary.parentActions.length, 1)
  const action = summary.parentActions[0]
  assert.equal(action.artifactPath, '/captured/workspace/test/result.test.js')
  assert.equal(action.childChange.event.id, 'child-change')
  assert.equal(action.command.event.id, 'parent-command')
  assert.equal(action.command.sessionId, 'root')
  assert.equal(action.command.text, 'node --test test/result.test.js && git status --short')
  assert.equal(action.recordedCommand, 'node --test test/result.test.js && git status --short')
  assert.equal(action.exitCode, 0)
  assert.equal(action.output, '5 tests passed')
  assert.deepEqual(summary.followUps, [])
})

test('records failure exit codes without claiming checks succeeded', () => {
  const replay = artifactPair()
  const command = replay.sessions[0].events.at(-1)
  command.body = JSON.stringify({ command: ['node', '--test', '/captured/workspace/test/result.test.js'], output: '1 test failed', exitCode: 1 })
  const action = deriveAgentSummaries(replay).get('child').parentActions[0]
  assert.equal(action.exitCode, 1)
  assert.equal(action.output, '1 test failed')
})

for (const [name, mutate] of [
  ['missing cwd', replay => { delete replay.sessions[0].cwd }],
  ['different cwd', replay => { replay.sessions[0].cwd = '/different/workspace' }],
  ['same basename in another directory', replay => { const e = replay.sessions[0].events.at(-1); e.body = e.body.replace('test/result.test.js', 'other/result.test.js') }],
  ['command before receipt', replay => { const events = replay.sessions[0].events; events.splice(0, 0, events.pop()) }],
  ['missing receipt', replay => { replay.sessions[0].events = replay.sessions[0].events.filter(e => e.id !== 'receipt') }],
  ['truncated command', replay => { replay.sessions[0].events.at(-1).bodyStatus = 'truncated' }],
  ['missing command body', replay => { delete replay.sessions[0].events.at(-1).body }],
  ['tool call only', replay => { replay.sessions[0].events.at(-1).kind = 'tool-call' }],
  ['missing recorded output', replay => { const e = replay.sessions[0].events.at(-1); const b = JSON.parse(e.body); delete b.output; e.body = JSON.stringify(b) }],
  ['truncated child change', replay => { replay.sessions[1].events.find(e => e.id === 'child-change').bodyStatus = 'truncated' }],
  ['unfinished child change', replay => { replay.sessions[1].events.find(e => e.id === 'child-change').status = 'started' }],
  ['child change after result', replay => { const events = replay.sessions[1].events; events.push(events.splice(1, 1)[0]) }],
  ['foreign parent command', replay => { const command = replay.sessions[0].events.pop(); replay.sessions.push({ ...replay.sessions[0], id: 'foreign', events: [command] }) }],
  ['ambiguous child artifact', replay => { const child = structuredClone(replay.sessions[1]); child.id = 'other-child'; child.events[0].body = child.events[0].body.replace('/root/worker', '/root/other'); replay.sessions.push(child) }],
  ['changed shell cwd', replay => { const e = replay.sessions[0].events.at(-1); e.body = e.body.replace('node --test', 'cd /elsewhere; node --test') }],
  ['unsupported earlier command', replay => { const e = replay.sessions[0].events.at(-1); e.body = e.body.replace('node --test', 'unrecognized_cd_helper && node --test') }],
  ['echo is not a read or check', replay => { const e = replay.sessions[0].events.at(-1); e.body = e.body.replace('node --test', 'echo') }],
]) test(`artifact evidence rejects ${name}`, () => {
  const replay = artifactPair()
  mutate(replay)
  assert.deepEqual(deriveAgentSummaries(replay).get('child').parentActions, [])
})

test('resolves full relative paths and literal inspection commands from retained cwd', () => {
  const replay = artifactPair()
  const e = replay.sessions[0].events.at(-1)
  e.body = JSON.stringify({ command: ['/bin/zsh', '-lc', "sed -n '1,120p' ./test/result.test.js; cat /captured/workspace/test/result.test.js"], output: 'retained file contents', exitCode: 0 })
  const action = deriveAgentSummaries(replay).get('child').parentActions[0]
  assert.match(action.command.text, /sed -n '1,120p'/)
  assert.match(action.command.text, /cat \/captured\/workspace\/test\/result.test.js/)
})

test('unique direct-child basename mentions are explicit parent narrative', () => {
  const replay = pair({ later: 'I integrated worker and ran its checks.' })
  assert.equal(deriveAgentSummaries(replay).get('child').followUps.length, 1)
  const foreign = structuredClone(replay.sessions[1])
  foreign.id = 'foreign-child'; foreign.parentId = 'foreign-parent'
  foreign.events[0].body = foreign.events[0].body.replaceAll('/root', '/foreign')
  replay.sessions.push(foreign)
  assert.equal(deriveAgentSummaries(replay).get('child').followUps.length, 1)
  const sibling = structuredClone(foreign)
  sibling.id = 'ambiguous-sibling'; sibling.parentId = 'root'
  replay.sessions.push(sibling)
  assert.deepEqual(deriveAgentSummaries(replay).get('child').followUps, [])
})

test('generic child statements and partial basename matches are not narrative links', () => {
  for (const later of ['I integrated the child.', 'I integrated worker_extra.', 'I integrated /foreign/worker.']) {
    assert.deepEqual(deriveAgentSummaries(pair({ later })).get('child').followUps, [])
  }
})

test('opaque assignments show a distinct pre-tool child acknowledgement with its source', () => {
  const replay = pair()
  replay.sessions[1].events.splice(1, 0, event('acknowledgement', { sessionId: 'child', role: 'assistant', body: 'I own the requested test file and will cover edge cases.' }))
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.acknowledgement.event.id, 'acknowledgement')
  assert.match(summary.assignmentNote, /opaque/)
})

test('acknowledgements never reuse a final result or post-tool statement', () => {
  assert.equal(deriveAgentSummaries(pair()).get('child').acknowledgement, null)
  const replay = artifactPair()
  replay.sessions[1].events.splice(2, 0, event('too-late', { sessionId: 'child', role: 'assistant', body: 'I wrote the tests.' }))
  assert.equal(deriveAgentSummaries(replay).get('child').acknowledgement, null)
  const readable = pair()
  readable.sessions[0].events[0].body = JSON.stringify({ task_name: 'worker', message: 'Write tests.' })
  readable.sessions[1].events.splice(1, 0, event('acknowledgement', { sessionId: 'child', role: 'assistant', body: 'I will write tests.' }))
  assert.equal(deriveAgentSummaries(readable).get('child').acknowledgement, null)
})

test('opaque assignments expose the nearest same-turn named parent statement separately', () => {
  const replay = pair()
  const parent = replay.sessions[0]
  parent.events.unshift(event('earlier-statement', { role: 'assistant', turnId: 'turn-1', body: 'Assignment for worker: earlier plan.' }),
    event('statement', { role: 'assistant', turnId: 'turn-1', body: 'Assignment for worker: write the requested tests.' }))
  const summary = deriveAgentSummaries(replay).get('child')
  assert.equal(summary.parentAssignmentStatement.event.id, 'statement')
  assert.equal(summary.parentAssignmentStatement.sessionId, 'root')
  assert.match(summary.assignmentNote, /opaque/)
})

for (const [name, statement] of [
  ['another turn', { turnId: 'other-turn', body: 'Assignment for worker: write tests.' }],
  ['generic child name', { turnId: 'turn-1', body: 'Assignment for the child: write tests.' }],
  ['another canonical child', { turnId: 'turn-1', body: 'Assignment for /foreign/worker: write tests.' }],
  ['truncated body', { turnId: 'turn-1', body: 'Assignment for worker: write tests.', bodyStatus: 'truncated' }],
]) test(`parent assignment statement rejects ${name}`, () => {
  const replay = pair()
  replay.sessions[0].events.unshift(event('statement', { role: 'assistant', ...statement }))
  assert.equal(deriveAgentSummaries(replay).get('child').parentAssignmentStatement, null)
})
