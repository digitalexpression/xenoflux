import type { ReplayEvent, ReplaySession, SessionReplay } from '@/api/types'

export interface AgentEvidence {
  event: ReplayEvent
  sessionId: string
  text: string
}

export interface AgentSummary {
  assignment: AgentEvidence | null
  assignmentNote: string | null
  taskContext?: AgentEvidence | null
  result: AgentEvidence | null
  resultNote: string | null
  received: AgentEvidence | null
  followUps: AgentEvidence[]
  parentNote: string | null
}

const EXCERPT_LIMIT = 400
const WRAPPER_HEADER = /^Message Type: (?:NEW_TASK|MESSAGE|FINAL_ANSWER)\b/m
const FINALITY_NOTE = 'Last recorded assistant response before completion; final-answer status is not recorded.'

function excerpt(text: string): string {
  // Show Markdown link labels in the excerpt; preserve the full body at its source event.
  const value = text.trim().replace(/\[([^\]]+)\]\([^\n)]+\)/g, '$1')
  if (value.length <= EXCERPT_LIMIT) return value
  const cut = value.slice(0, EXCERPT_LIMIT)
  const boundary = cut.lastIndexOf(' ')
  return `${cut.slice(0, boundary > EXCERPT_LIMIT - 80 ? boundary : EXCERPT_LIMIT).trimEnd()}…`
}

function usableBody(event: ReplayEvent): string | null {
  return event.bodyStatus === 'included' && typeof event.body === 'string' && event.body.trim()
    ? event.body.trim()
    : null
}

function isAssistantMessage(event: ReplayEvent): boolean {
  return event.role === 'assistant' && event.kind === 'message'
}

function plainAssistant(event: ReplayEvent): boolean {
  const body = usableBody(event)
  return isAssistantMessage(event) && event.label !== 'Agent update' && (!body || !WRAPPER_HEADER.test(body))
}

function evidence(sessionId: string, event: ReplayEvent, text = usableBody(event) ?? ''): AgentEvidence {
  return { event, sessionId, text: excerpt(text) }
}

function parseCall(event: ReplayEvent): Record<string, unknown> | null {
  const body = usableBody(event)
  if (!body) return null
  try {
    const value: unknown = JSON.parse(body)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function assignmentFor(parent: ReplaySession | undefined, child: ReplaySession): Pick<AgentSummary, 'assignment' | 'assignmentNote'> {
  if (child.parentId === null) {
    const firstTask = child.events.find(event => event.role === 'user' && usableBody(event) && !isInstructionBody(usableBody(event)!))
    return firstTask
      ? { assignment: evidence(child.id, firstTask), assignmentNote: null }
      : { assignment: null, assignmentNote: 'No readable user task is distinguishable from recorded instruction context.' }
  }
  if (!parent) return { assignment: null, assignmentNote: 'The recorded direct parent session is unavailable.' }
  const parentName = childName(parent)
  const claimedParent = childParentName(child)
  if (parentName && claimedParent && claimedParent !== parentName) {
    return { assignment: null, assignmentNote: 'The child task wrapper names a different parent than the recorded session relationship.' }
  }
  const starts = parent.events.filter(event => event.kind === 'delegation'
    && event.status === 'started'
    && event.callId && event.turnId
    && event.childSessionIds?.includes(child.id))
  const matches = starts.flatMap(start => parent.events.filter(call => call.kind === 'tool-call'
    && /(?:^|\.)spawn_agent$/.test(call.label)
    && call.callId === start.callId && call.turnId === start.turnId
    && typeof parseCall(call)?.task_name === 'string'
    && typeof parseCall(call)?.message === 'string').map(call => ({ start, call })))
  if (matches.length !== 1) return { assignment: null, assignmentNote: 'No unique recorded spawn call links this child to its direct parent.' }
  const match = matches[0]
  if (!match) return { assignment: null, assignmentNote: 'No unique recorded spawn call links this child to its direct parent.' }
  const { call } = match
  const payload = parseCall(call)
  const prompt = typeof payload?.message === 'string' ? payload.message : null
  const text = prompt && !prompt.startsWith('gAAAA') ? prompt : null
  return {
    assignment: evidence(parent.id, call, text ?? `Recorded spawn call for ${String(payload?.task_name)}.`),
    assignmentNote: text ? null : 'The recorded assignment prompt is opaque and cannot be read in this capture.',
  }
}

function childName(child: ReplaySession): string | null {
  return newTaskMetadata(child)?.taskName ?? null
}

function childParentName(child: ReplaySession): string | null {
  return newTaskMetadata(child)?.sender ?? null
}

function newTaskMetadata(child: ReplaySession): { taskName: string; sender: string } | null {
  const event = child.events.find(item => isAssistantMessage(item) && usableBody(item)?.startsWith('Message Type: NEW_TASK'))
  const body = event ? usableBody(event) : null
  const taskName = body?.match(/^Task name: (.+)$/m)?.[1]
  const sender = body?.match(/^Sender: (.+)$/m)?.[1]
  return taskName && sender ? { taskName, sender } : null
}

function isInstructionBody(body: string): boolean {
  return /^\s*#\s*AGENTS\.md\b/i.test(body)
    || /^\s*<INSTRUCTIONS>/i.test(body)
    || /^\s*<environment_context>/i.test(body)
}

function rootOpeningTask(replay: SessionReplay, session: ReplaySession): AgentEvidence | null {
  const visited = new Set<string>()
  let current = session
  while (current.parentId) {
    if (visited.has(current.id)) return null
    visited.add(current.id)
    const parent = replay.sessions.find(candidate => candidate.id === current.parentId)
    if (!parent) return null
    current = parent
  }
  if (visited.has(current.id)) return null
  const rootTask = current.events.find(event => event.role === 'user' && usableBody(event) && !isInstructionBody(usableBody(event)!))
  return rootTask ? evidence(current.id, rootTask) : null
}

function finalCandidate(session: ReplaySession): ReplayEvent | null {
  const messages = session.events.filter(plainAssistant)
  return messages[messages.length - 1] ?? null
}

function hasTerminalEventAfter(session: ReplaySession, candidate: ReplayEvent): boolean {
  const candidateIndex = session.events.indexOf(candidate)
  return candidateIndex >= 0 && session.events.slice(candidateIndex + 1).some(event => event.kind === 'session' && event.status === 'completed')
}

function terminalResult(session: ReplaySession, candidate: ReplayEvent | null, corroboratedReceipt: boolean): Pick<AgentSummary, 'result' | 'resultNote'> {
  if (!candidate) return { result: null, resultNote: 'No readable final assistant message is recorded.' }
  if (!usableBody(candidate)) {
    return { result: null, resultNote: 'The last recorded assistant response is unreadable in this capture.' }
  }
  const laterTask = session.events.slice(session.events.indexOf(candidate) + 1).some(event =>
    (event.kind === 'message' && event.role === 'user') || (event.kind === 'turn' && event.status === 'started'))
  if (laterTask) return { result: null, resultNote: 'A later task or turn started without a recorded closing response.' }
  if (corroboratedReceipt) return { result: evidence(session.id, candidate), resultNote: null }
  if (hasTerminalEventAfter(session, candidate)) {
    return { result: evidence(session.id, candidate), resultNote: FINALITY_NOTE }
  }
  return { result: null, resultNote: 'No completion event or exact final-answer receipt is recorded; no result is identified.' }
}

function wrapper(body: string): { type: string; taskName: string; sender: string; payload: string } | null {
  const type = body.match(/^Message Type: (FINAL_ANSWER)\s*$/m)?.[1]
  const taskName = body.match(/^Task name: (.+)$/m)?.[1]
  const sender = body.match(/^Sender: (.+)$/m)?.[1]
  const payload = body.match(/^Payload:\n([\s\S]*)$/m)?.[1]?.trimEnd()
  return type && taskName && sender && payload !== undefined ? { type, taskName, sender, payload } : null
}

function receivedByParent(parent: ReplaySession | undefined, candidate: ReplayEvent | null, canonicalName: string | null, parentCanonicalName: string | null, names: string[]): AgentEvidence | null {
  if (!parent || !candidate || !canonicalName) return null
  if (names.filter(name => name === canonicalName).length !== 1) return null
  const exact = parent.events.filter(event => {
    if (!isAssistantMessage(event) || event.label !== 'Agent update') return false;
    const body = usableBody(event)
    const parsed = body ? wrapper(body) : null
    return parsed?.sender === canonicalName
      && (!parentCanonicalName || parsed.taskName === parentCanonicalName)
      && parsed.payload === candidate.body?.trim()
  })
  const siblings = parent.events.flatMap(event => {
    if (!isAssistantMessage(event) || event.label !== 'Agent update') return [];
    const body = usableBody(event)
    const parsed = body ? wrapper(body) : null
    return parsed ? [{ event, parsed }] : []
  }).filter(item => item.parsed.sender === canonicalName
    && (!parentCanonicalName || item.parsed.taskName === parentCanonicalName))
  return exact.length === 1 && siblings.length === 1 && exact[0] ? evidence(parent.id, exact[0]) : null
}

function mentionsCanonicalName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_/-])${escaped}(?![A-Za-z0-9_/-])`).test(text)
}

function followUps(parent: ReplaySession | undefined, received: AgentEvidence | null, canonicalName: string | null, names: string[]): AgentEvidence[] {
  if (!parent || !received || !canonicalName) return []
  if (names.filter(name => name === canonicalName).length !== 1) return []
  const receiptIndex = parent.events.indexOf(received.event)
  return parent.events.slice(receiptIndex + 1).filter(plainAssistant).filter(event => {
    const body = usableBody(event)
    return body !== null && mentionsCanonicalName(body, canonicalName)
  }).map(event => {
    const paragraphs = usableBody(event)!.split(/\n\s*\n/);
    const mentioned = paragraphs.filter(text => mentionsCanonicalName(text, canonicalName));
    const lead = paragraphs[0];
    const text = lead && lead.length < 160 && !mentioned.includes(lead)
      ? [lead, ...mentioned].join('\n\n…\n\n') : mentioned.join('\n\n…\n\n');
    return evidence(parent.id, event, text);
  })
}

/** Derive conservative, event-linked per-agent summaries from this frozen replay only. */
export function deriveAgentSummaries(replay: SessionReplay): Map<string, AgentSummary> {
  const sessions = new Map(replay.sessions.map(session => [session.id, session]))
  const summaries = new Map<string, AgentSummary>()
  for (const session of replay.sessions) {
    const parent = session.parentId ? sessions.get(session.parentId) : undefined
    const assigned = assignmentFor(parent, session)
    const name = childName(session)
    const names = replay.sessions.map(childName).filter((value): value is string => !!value)
    const candidate = finalCandidate(session)
    const received = receivedByParent(parent, candidate, name, childParentName(session), names)
    const completed = terminalResult(session, candidate, !!received)
    const followUp = followUps(parent, received, name, names)
    summaries.set(session.id, {
      ...assigned,
      ...(parent && assigned.assignmentNote ? { taskContext: rootOpeningTask(replay, session) } : {}),
      ...completed,
      received,
      followUps: followUp,
      parentNote: session.parentId === null
        ? 'Main session has no parent.'
        : !parent
          ? 'The recorded parent session is unavailable; delivery and follow-up cannot be established.'
        : received
          ? followUp.length ? null : 'A matching delivery is recorded; no later parent message explicitly names this child.'
          : 'No unique exact parent delivery is linked to this result. Later activity is not treated as evidence of use.',
    })
  }
  return summaries
}
