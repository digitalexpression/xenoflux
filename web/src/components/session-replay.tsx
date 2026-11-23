import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ChevronRight, CircleDot, CornerDownRight, FileDiff, GitBranch, List, MessageSquare, MessagesSquare, Terminal, Wrench } from 'lucide-react';
import { Message, MessageContent, MessageHeader } from '@/components/ui/message';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Trace, TraceLine, TraceIcon, TraceTitle, TraceDescription } from '@/components/ui/trace';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton } from '@/components/ui/message-scroller';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import type { ReactNode, Ref } from 'react';
import type { ReplayEvent, ReplaySession, SessionReplay } from '@/api/types';
import { Button } from '@/components/ui/button';
import { InfoNotice } from '@/components/notices';
import { SideText } from '@/components/profile';
import { deriveAgentSummaries } from '@/lib/replay-agent-summary';
import type { AgentEvidence } from '@/lib/replay-agent-summary';
import { ReplayAgentPanel } from '@/components/replay-agent-panel';

type Side = 'a' | 'b';
type ReplaySide = { side: Side; profile: string; client?: string; replay: SessionReplay | null };
type Row = { side: Side; profile: string; replay: SessionReplay; session: ReplaySession; event: ReplayEvent; key: string; elapsedMs: number | null };
type ReplayLocation = { selectedKey: string; query: string; inspecting: boolean; revealed: boolean; originSide: Side; originScroll: number; inspectorScroll: number; openDetails: boolean[] };
type ClockSource = NonNullable<ReplayEvent['timestampSource']> | 'recorded';
type ReplayClock = { source: ClockSource; origin: number; span: number | null };
type ReplayPresentation = 'compact' | 'chat';
const NAVIGATION_LIMIT = 8;
const clockLabels: Record<ClockSource, string> = {
  native: 'Native timestamps',
  observed: 'Observed arrival times',
  recorded: 'Recorded timestamps',
};
// Reuse the locale formatter across the thousands of timestamps in a replay.
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function date(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clock(value: string | null): string | null {
  const parsed = date(value);
  return parsed === null ? null : timeFormatter.format(parsed);
}

function elapsed(value: number): string {
  const seconds = Math.round(value / 1000);
  const sign = seconds < 0 ? '−' : '+';
  const absolute = Math.abs(seconds);
  return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, '0')}`;
}

function statusText(event: ReplayEvent): string {
  const reason = event.bodyReason === 'event-body-limit' ? 'The event exceeded the 1 MiB body limit.'
    : event.bodyReason === 'total-body-limit' ? 'The replay reached its aggregate body limit.'
      : event.bodyReason === 'missing-body' || event.bodyReason === 'opaque-or-missing-content' ? 'The native record did not contain readable body text.' : event.bodyReason;
  switch (event.bodyStatus) {
    case 'included': return event.body ? 'Recorded content available' : 'No body recorded';
    case 'truncated': return `Recorded content truncated${reason ? ` · ${reason}` : ''}`;
    case 'omitted': return `Content omitted from this replay${reason ? ` · ${reason}` : ''}`;
    case 'unavailable': return reason === 'not-recorded' ? 'No content recorded' : `Content unavailable${reason ? ` · ${reason}` : ''}`;
  }
}

function sessionName(session: ReplaySession, rootId: string): string {
  return session.id === rootId ? `Root session ${session.id}` : `Child session ${session.id}`;
}

// Join only recorded call identities within the same session and turn. Proximity
// in the timeline is never evidence that an assignment created a particular child.
function delegatedIds(event: ReplayEvent, session: ReplaySession): string[] {
  if (event.childSessionIds?.length) return event.childSessionIds;
  if (!event.callId || !['tool-call', 'tool-result'].includes(event.kind)) return [];
  const group = session.events.filter(item => item.callId === event.callId && item.turnId === event.turnId);
  const calls = group.filter(item => item.kind === 'tool-call');
  const starts = group.filter(item => item.kind === 'delegation' && item.status === 'started');
  return calls.length === 1 && /(?:^|\.)spawn_agent$/.test(calls[0]!.label) && starts.length === 1
    ? starts[0]!.childSessionIds ?? [] : [];
}

function assignment(event: ReplayEvent): { task_name?: string; message?: string } | null {
  if (event.kind !== 'tool-call' || !/(?:^|\.)spawn_agent$/.test(event.label) || !event.body || event.body.length > 20_000) return null;
  try {
    const value = JSON.parse(event.body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function replayNames(replay: SessionReplay | null): Map<string, string> {
  const names = new Map<string, string>();
  for (const session of replay?.sessions ?? []) {
    const parent = replay?.sessions.find(item => item.id === session.parentId);
    const recorded = new Set(parent?.events.flatMap(event => {
      const name = assignment(event)?.task_name;
      return typeof name === 'string' && name.trim() && name.length <= 120 && delegatedIds(event, parent).includes(session.id) ? [name.trim()] : [];
    }) ?? []);
    names.set(session.id, !session.parentId ? 'Main session' : recorded.size === 1 ? [...recorded][0]! : `Child ${session.id.slice(-8)}`);
  }
  return names;
}

function eventLabel(event: ReplayEvent): string {
  // Older frozen captures used a duplicated lifecycle suffix. This changes only
  // presentation; the original label and event identity stay in source details.
  return event.label.replace(/^Delegated agent (started|completed) \1$/, 'Delegated agent $1');
}

function replayClock(replay: SessionReplay | null): ReplayClock | null {
  const roots = replay?.sessions.filter(session => session.parentId === null) ?? [];
  if (roots.length !== 1 || !roots[0]) return null;
  const times: Record<ClockSource, number[]> = { native: [], recorded: [], observed: [] };
  for (const event of roots[0].events) {
    const at = date(event.timestamp);
    if (at !== null) times[event.timestampSource ?? 'recorded'].push(at);
  }
  const sources: ClockSource[] = ['native', 'recorded', 'observed'];
  const source = sources.find(key => times[key].length >= 2) ?? sources.find(key => times[key].length > 0);
  if (!source) return null;
  const rootTimes = times[source];
  const origin = Math.min(...rootTimes);
  return { source, origin, span: rootTimes.length >= 2 ? Math.max(...rootTimes) - origin : null };
}

function eventElapsed(event: ReplayEvent, axis: ReplayClock | null): number | null {
  const at = date(event.timestamp);
  return axis && at !== null && axis.source === (event.timestampSource ?? 'recorded') ? at - axis.origin : null;
}

function layOutTimedStops(rows: Row[], axisSpan: number) {
  const last = [-Infinity, -Infinity, -Infinity, -Infinity];
  const layers = new Map<string, number>();
  for (const row of [...rows].sort((a, b) => a.elapsedMs! - b.elapsedMs!)) {
    const layer = last.findIndex(at => row.elapsedMs! - at >= axisSpan / 16);
    if (layer === -1) return null;
    last[layer] = row.elapsedMs!;
    layers.set(row.key, layer);
  }
  return { layers, count: Math.max(1, last.filter(Number.isFinite).length) };
}

function replayForest(sessions: ReplaySession[]) {
  const ids = new Set(sessions.map(session => session.id));
  const children = new Map<string, ReplaySession[]>();
  const roots: ReplaySession[] = [];
  for (const session of sessions) {
    if (!session.parentId || !ids.has(session.parentId)) roots.push(session);
    else {
      const siblings = children.get(session.parentId) ?? [];
      siblings.push(session);
      children.set(session.parentId, siblings);
    }
  }
  return { children, roots };
}

function stackedSessions(sessions: ReplaySession[]) {
  const { children, roots } = replayForest(sessions);
  const seen = new Set<string>();
  const ordered: ReplaySession[] = [];
  function add(session: ReplaySession) {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    ordered.push(session);
    children.get(session.id)?.forEach(add);
  }
  roots.forEach(add);
  sessions.forEach(add);
  return ordered;
}

function TreeSession({ side, session, rootId, name, search, hasMatches, onAgent, axis, presentation, children, selectedKey, visibleKeys, onSelect, onMove }:
  { side: Side; session: ReplaySession; rootId: string; name: string; search: string; hasMatches: boolean; onAgent: (trigger: HTMLButtonElement) => void; axis: ReplayClock | null; presentation: ReplayPresentation; children: ReactNode; selectedKey: string;
    visibleKeys: Set<string>; onSelect: (event: ReplayEvent, session: ReplaySession, inspect?: boolean) => void; onMove: (delta: number) => void }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  const beforeSearch = useRef<boolean | null>(null);
  useEffect(() => {
    if (!disclosure.current) return;
    if (search) {
      if (beforeSearch.current === null) beforeSearch.current = disclosure.current.open;
      if (hasMatches) {
        disclosure.current.open = true;
      }
    } else if (beforeSearch.current !== null) {
      disclosure.current.open = beforeSearch.current;
      beforeSearch.current = null;
    }
  }, [search, hasMatches]);
  const turnNumbers = new Map<string, { number: number; firstEvent: string }>();
  const turns: { id: string | null; key: string; events: ReplayEvent[] }[] = [];
  for (const event of session.events) {
    if (event.turnId !== null && !turnNumbers.has(event.turnId)) {
      turnNumbers.set(event.turnId, { number: turnNumbers.size + 1, firstEvent: event.id });
    }
    if (turns.at(-1)?.id !== event.turnId) turns.push({ id: event.turnId, key: event.id, events: [] });
    if (visibleKeys.has(`${side}:${session.id}:${event.id}`)) turns.at(-1)!.events.push(event);
  }
  function eventRow(event: ReplayEvent) {
    const key = `${side}:${session.id}:${event.id}`;
    const at = date(event.timestamp);
    const stamp = at === null ? null : timeFormatter.format(at);
    const timeLabel = stamp ? <> · <time dateTime={event.timestamp!}>{stamp}</time></> : null;
    const millis = eventElapsed(event, axis);
    const relative = millis === null ? stamp : elapsed(millis);
    const trigger = {
      'data-replay-event': key, tabIndex: key === selectedKey ? 0 : -1,
      'aria-current': key === selectedKey ? 'true' as const : undefined,
      'aria-label': stamp ? `${eventLabel(event)} · ${stamp}` : eventLabel(event),
      onFocus: () => onSelect(event, session), onClick: () => onSelect(event, session, true),
      onKeyDown: (keyEvent: React.KeyboardEvent<HTMLButtonElement>) => {
        if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') {
          keyEvent.preventDefault(); onMove(keyEvent.key === 'ArrowDown' ? 1 : -1);
        }
      },
    };
    if (presentation === 'chat' && event.kind === 'message') {
      const align = event.role === 'user' ? 'end' : 'start';
      return <Message key={event.id} align={align}>
        <MessageContent>
          <MessageHeader><span>{event.role === 'user' ? 'You' : event.role === 'assistant' ? 'Assistant' : event.label}{timeLabel}</span></MessageHeader>
          <Bubble variant={align === 'end' ? 'secondary' : 'outline'} align={align}>
            <BubbleContent asChild><button type="button" {...trigger}>
              <span className="line-clamp-3 whitespace-pre-wrap">{event.body ? event.body.slice(0, 300) : statusText(event)}</span>
              {event.body && event.body.length > 300 ? <span className="sr-only"> — preview; open for full recorded content</span> : null}
            </button></BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>;
    }
    const marker = event.kind === 'session' || event.kind === 'turn';
    if (presentation === 'chat' && marker) return <Marker key={event.id}><MarkerContent><Button variant="replay" {...trigger}><span>{eventLabel(event)}{timeLabel}</span></Button></MarkerContent></Marker>;
    const Icon = marker ? CircleDot : event.kind === 'message' ? MessageSquare : event.kind === 'file-change' ? FileDiff
      : event.kind === 'delegation' ? GitBranch : event.kind === 'command' ? Terminal : Wrench;
    return <Button key={event.id} variant="replay" {...trigger}>
      <TraceLine status={event.kind === 'error' ? 'error' : undefined}>
        <TraceIcon><Icon /></TraceIcon><TraceTitle>{eventLabel(event)}</TraceTitle>
        {relative ? <TraceDescription>{relative}</TraceDescription> : null}<TraceIcon><ChevronRight /></TraceIcon>
      </TraceLine>
    </Button>;
  }
  return <details ref={disclosure} open={session.parentId === null} className="replay-session flex flex-col gap-3">
    <summary className="cursor-pointer text-ui" aria-label={`${sessionName(session, rootId)} · ${session.status}${session.reason ? ` · ${session.reason}` : ''}`}>
      {name} · {session.events.length} events · {session.status}
    </summary>
    <Button variant="ghost-link" onClick={event => onAgent(event.currentTarget)}>View {name} summary</Button>
    {!session.events.length ? <p className="hint">{session.status === 'ready' ? 'No activity recorded in this session.' : `Activity unavailable: ${session.reason ?? 'The session history could not be read completely.'}`}</p> : null}
    {turns.filter(turn => turn.events.length).map(({ id, key, events }) => {
      const turn = id === null ? null : turnNumbers.get(id)!;
      const disclosureKey = turn?.firstEvent ?? key;
      const groups: ReplayEvent[][] = [];
      if (presentation === 'chat') for (const event of events) {
        const last = groups.at(-1);
        if (!['message', 'session', 'turn'].includes(event.kind) && last && !['message', 'session', 'turn'].includes(last[0]!.kind)) last.push(event);
        else groups.push([event]);
      }
      return <details key={key} open={Boolean(search) || expandedTurns[disclosureKey] !== false} className="flex flex-col gap-3">
        <summary className="cursor-pointer meta" title={id ?? undefined} onClick={event => {
          event.preventDefault();
          if (search) return;
          const open = !(event.currentTarget.parentElement as HTMLDetailsElement).open;
          setExpandedTurns(previous => previous[disclosureKey] === open ? previous : { ...previous, [disclosureKey]: open });
        }}>{turn ? `Turn ${turn.number}${turn.firstEvent === key ? '' : ' · continued'}` : 'Session events'}</summary>
        {presentation === 'compact' ? <Trace>{events.map(eventRow)}</Trace>
          : groups.map(group => group[0] && ['message', 'session', 'turn'].includes(group[0].kind) ? eventRow(group[0]) : <Trace key={group[0]?.id}>{group.map(eventRow)}</Trace>)}
      </details>;
    })}
    {children}
  </details>;
}

export interface ReplayHandle {
  openEvent: (side: Side, evidence: AgentEvidence, trigger: HTMLButtonElement) => void;
  openSourceEvent: (side: Side, sessionId: string, eventId: string) => void;
}

export function SessionReplayView({ sides, ref, visible = true, workspace, onReturnToReport }: {
  sides: [ReplaySide] | [ReplaySide, ReplaySide]; ref?: Ref<ReplayHandle>; visible?: boolean;
  workspace?: 'stacked'; onReturnToReport?: (origin: HTMLButtonElement) => void;
}) {
  const single = sides.length === 1;
  const stacked = workspace === 'stacked';
  const labelled = useId();
  const profileLabel = (side: Side, profile: string) => single ? <span className="font-semibold wrap-anywhere">{profile}</span> : <SideText side={side}>{profile}</SideText>;
  const [selectedKey, setSelectedKey] = useState('');
  const [presentation, setPresentation] = useState<ReplayPresentation>(stacked ? 'compact' : 'chat');
  const [eventOrder, setEventOrder] = useState(false);
  const [sideSelections, setSideSelections] = useState<Record<Side, string>>({ a: '', b: '' });
  const [query, setQuery] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const focusInspectorOnOpen = useRef(false);
  const [agentView, setAgentView] = useState<{ side: Side; sessionId: string } | null>(null);
  const [agentOrigin, setAgentOrigin] = useState<{ side: Side; sessionId: string } | null>(null);
  const agentTrigger = useRef<HTMLButtonElement | null>(null);
  const [reportOrigin, setReportOrigin] = useState<HTMLButtonElement | null>(null);
  const [navigation, setNavigation] = useState<Record<Side, ReplayLocation[]>>({ a: [], b: [] });
  const [revealedSides, setRevealedSides] = useState<Record<Side, boolean>>({ a: false, b: false });
  const preserveSelection = useRef<string | null>(null);
  const clocks = useMemo(() => ({ a: replayClock(sides[0].replay), b: replayClock(sides[1]?.replay ?? null) }), [sides]);
  const all = useMemo<Row[]>(() => sides.flatMap(({ side, profile, replay }) => replay?.sessions.flatMap(session =>
    session.events.map(event => {
      return { side, profile, replay, session, event, key: `${side}:${session.id}:${event.id}`,
        elapsedMs: eventElapsed(event, clocks[side]) };
    })) ?? []), [sides, clocks]);
  const names = useMemo(() => ({ a: replayNames(sides[0].replay), b: replayNames(sides[1]?.replay ?? null) }), [sides]);
  const summaries = useMemo(() => ({ a: deriveAgentSummaries(sides[0].replay ?? { schemaVersion: 1, kind: 'session-replay', sessions: [] }), b: deriveAgentSummaries(sides[1]?.replay ?? { schemaVersion: 1, kind: 'session-replay', sessions: [] }) }), [sides]);
  const agentSummary = agentView ? summaries[agentView.side].get(agentView.sessionId) : null;
  const needle = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => all.filter(row => !needle || revealedSides[row.side]
    || `${row.profile} ${row.session.id} ${names[row.side].get(row.session.id)} ${row.event.kind} ${row.event.label} ${row.event.body ?? ''}`.toLocaleLowerCase().includes(needle)), [all, needle, revealedSides, names]);
  const activeIndex = filtered.findIndex(row => row.key === selectedKey);
  const selected = all.find(row => row.key === selectedKey) ?? null;
  useEffect(() => {
    if (preserveSelection.current === selectedKey) { preserveSelection.current = null; return; }
    if (activeIndex < 0 && filtered[0]) { setSelectedKey(filtered[0].key); setSideSelections(current => ({ ...current, [filtered[0]!.side]: filtered[0]!.key })); }
  }, [activeIndex, filtered, selectedKey]);
  const visibleKeys = new Set(filtered.map(row => row.key));
  const sharedScale = !stacked && Boolean(clocks.a && clocks.a.source === clocks.b?.source);
  const selectedTime = selected ? clock(selected.event.timestamp) : null;

  function revealEvent(key: string) {
    const target = document.querySelector<HTMLButtonElement>(`[data-replay-event="${CSS.escape(key)}"]`);
    let ancestor = target?.parentElement?.closest('details') ?? null;
    while (ancestor) {
      if (!ancestor.open) {
        ancestor.querySelector<HTMLElement>(':scope > summary')?.click();
        ancestor.open = true;
      }
      ancestor = ancestor.parentElement?.closest('details') ?? null;
    }
    return target;
  }

  function focusEvent(key: string, inspector = false) {
    const previousFocus = document.activeElement;
    requestAnimationFrame(() => {
      const target = revealEvent(key);
      // A delayed frame must respect focus moved by a newer user action.
      if (document.activeElement !== previousFocus && document.activeElement !== document.body) return;
      if (inspector) document.getElementById(`${labelled}-inspector-title`)?.focus();
      else target?.focus();
    });
  }

  function showInConversation(key: string) {
    requestAnimationFrame(() => {
      const target = revealEvent(key);
      const viewport = target?.closest<HTMLElement>('[data-replay-side]');
      if (!target || !viewport) return;
      const bounds = viewport.getBoundingClientRect();
      const row = target.getBoundingClientRect();
      if (row.top < bounds.top) viewport.scrollTop += row.top - bounds.top;
      else if (row.bottom > bounds.bottom) viewport.scrollTop += row.bottom - bounds.bottom;
    });
  }

  function setReplayPresentation(view: ReplayPresentation) {
    if (view === presentation) return;
    setPresentation(view);
    if (visibleKeys.has(selectedKey)) showInConversation(selectedKey);
  }

  function select(event: ReplayEvent, session: ReplaySession, side: Side, inspect = false) {
    setAgentView(null);
    if (inspect) { setInspecting(true); setAgentOrigin(null); setReportOrigin(null); }
    const key = `${side}:${session.id}:${event.id}`;
    setSelectedKey(key);
    setSideSelections(current => ({ ...current, [side]: key }));
  }
  function openAgent(sessionId: string, side: Side, trigger: HTMLButtonElement) {
    setReportOrigin(null);
    agentTrigger.current = trigger;
    setNavigation(current => ({ ...current, [side]: [] }));
    setAgentView({ side, sessionId });
    setAgentOrigin({ side, sessionId });
    setInspecting(true);
    requestAnimationFrame(() => document.getElementById(`${labelled}-inspector-title`)?.focus());
  }
  function openAgentEvidence(item: AgentEvidence) {
    if (!agentView) return;
    const row = all.find(row => row.side === agentView.side && row.session.id === item.sessionId && row.event.id === item.event.id);
    if (!row) return;
    if (!visibleKeys.has(row.key)) setRevealedSides(current => ({ ...current, [row.side]: true }));
    setAgentView(null);
    setSelectedKey(row.key);
    setSideSelections(current => ({ ...current, [row.side]: row.key }));
    focusEvent(row.key);
  }
  useImperativeHandle(ref, () => ({
    openEvent(side, evidence, trigger) {
      const row = all.find(row => row.side === side && row.session.id === evidence.sessionId && row.event.id === evidence.event.id);
      if (!row) return;
      focusInspectorOnOpen.current = true;
      setReportOrigin(trigger);
      setAgentView(null);
      setAgentOrigin(null);
      setNavigation(current => ({ ...current, [side]: [] }));
      if (!visibleKeys.has(row.key)) setRevealedSides(current => ({ ...current, [side]: true }));
      setSelectedKey(row.key);
      setSideSelections(current => ({ ...current, [side]: row.key }));
      setInspecting(true);
      focusEvent(row.key, true);
    },
    openSourceEvent(side, sessionId, eventId) {
      const row = all.find(item => item.side === side && item.session.id === sessionId && item.event.id === eventId);
      if (!row) return;
      focusInspectorOnOpen.current = true;
      setReportOrigin(null);
      setAgentView(null);
      setAgentOrigin(null);
      setNavigation(current => ({ ...current, [side]: [] }));
      if (!visibleKeys.has(row.key)) setRevealedSides(current => ({ ...current, [side]: true }));
      setSelectedKey(row.key);
      setSideSelections(current => ({ ...current, [side]: row.key }));
      setInspecting(true);
      focusEvent(row.key, true);
    },
  }));

  function transcriptScroll(side: Side): number {
    return document.querySelector<HTMLElement>(`[data-replay-side="${side}"]`)?.scrollTop ?? 0;
  }
  function restoreScroll(side: Side, scrollTop: number) {
    requestAnimationFrame(() => {
      const viewport = document.querySelector<HTMLElement>(`[data-replay-side="${side}"]`);
      if (viewport) viewport.scrollTop = scrollTop;
    });
  }
  function openDelegated(sessionId: string, side: Side) {
    if (!selected || selected.side !== side || !delegatedIds(selected.event, selected.session).includes(sessionId)) return;
    const child = all.find(row => row.side === side && row.session.id === sessionId);
    if (!child || child.session.parentId !== selected.session.id) return;
    const inspector = document.querySelector<HTMLElement>('.replay-inspector-content');
    const openDetails = [...(inspector?.querySelectorAll('details') ?? [])].map(detail => detail.open);
    const originScroll = transcriptScroll(side);
    const next = [...navigation[side], { selectedKey, query, inspecting, revealed: revealedSides[side], originSide: side, originScroll, inspectorScroll: inspector?.scrollTop ?? 0, openDetails }].slice(-NAVIGATION_LIMIT);
    setNavigation(current => ({ ...current, [side]: next }));
    if (!visibleKeys.has(child.key)) setRevealedSides(current => ({ ...current, [side]: true }));
    setSelectedKey(child.key);
    setSideSelections(current => ({ ...current, [side]: child.key }));
    setInspecting(true);
    focusEvent(child.key);
  }
  function returnToCaller() {
    const previous = selected ? navigation[selected.side].at(-1) : undefined;
    if (!previous) return;
    setNavigation(items => ({ ...items, [previous.originSide]: items[previous.originSide].slice(0, -1) }));
    preserveSelection.current = previous.selectedKey;
    setSelectedKey(previous.selectedKey);
    const previousRow = all.find(row => row.key === previous.selectedKey);
    if (previousRow) setSideSelections(current => ({ ...current, [previousRow.side]: previous.selectedKey }));
    setQuery(previous.query);
    setRevealedSides(current => ({ ...current, [previous.originSide]: previous.revealed }));
    setInspecting(previous.inspecting);
    restoreScroll(previous.originSide, previous.originScroll);
    requestAnimationFrame(() => {
      const inspector = document.querySelector<HTMLElement>('.replay-inspector-content');
      inspector?.querySelectorAll('details').forEach((detail, index) => { detail.open = previous.openDetails[index] ?? false; });
      if (inspector) inspector.scrollTop = previous.inspectorScroll;
    });
    if (previous.inspecting) requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>(`[data-replay-event="${CSS.escape(previous.selectedKey)}"]`);
      (target ?? document.getElementById(`${labelled}-inspector-title`))?.focus({ preventScroll: true });
    });
  }
  function focusInspector() {
    if (inspecting) {
      document.getElementById(`${labelled}-inspector-title`)?.focus();
      return;
    }
    focusInspectorOnOpen.current = true;
    setInspecting(true);
  }
  function move(delta: number, focus = false) {
    if (!filtered.length) return;
    const from = activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex;
    const next = filtered[(from + delta + filtered.length) % filtered.length];
    if (!next) return;
    setSelectedKey(next.key);
    setSideSelections(current => ({ ...current, [next.side]: next.key }));
    setInspecting(true);
    if (focus) focusEvent(next.key);
  }

  function tree(replay: SessionReplay, side: Side) {
    const rootId = replay.sessions.find(session => !session.parentId)?.id ?? '';
    const { children, roots } = replayForest(replay.sessions);
    const matched = new Set(filtered.filter(row => row.side === side).map(row => row.session.id));
    for (const id of [...matched]) {
      let parentId = replay.sessions.find(session => session.id === id)?.parentId;
      const ancestors = new Set<string>();
      while (parentId && !ancestors.has(parentId)) {
        ancestors.add(parentId); matched.add(parentId);
        parentId = replay.sessions.find(session => session.id === parentId)?.parentId;
      }
    }
    const seen = new Set<string>();
    const render = (session: ReplaySession): ReactNode => {
      if (seen.has(session.id)) return <p key={session.id} className="hint">Session {session.id}: repeated or circular lineage omitted.</p>;
      seen.add(session.id);
      return <TreeSession key={session.id} side={side} session={session} rootId={rootId} name={names[side].get(session.id)!} search={revealedSides[side] ? '' : needle} hasMatches={matched.has(session.id)} onAgent={trigger => openAgent(session.id, side, trigger)} axis={clocks[side]} presentation={presentation} selectedKey={sideSelections[side]} visibleKeys={visibleKeys}
        onSelect={(event, row, inspect) => select(event, row, side, inspect)} onMove={delta => move(delta, true)}>
        {children.get(session.id)?.map(render)}
      </TreeSession>;
    };
    return roots.map(session => <MessageScrollerItem key={session.id} messageId={`${side}:${session.id}`}>{render(session)}</MessageScrollerItem>);
  }

  return (
    <section className="replay-workspace flex flex-col gap-4" data-inspecting={visible && inspecting} aria-labelledby={`${labelled}-title`}
      onKeyDown={event => {
        if (event.key !== 'F6') return;
        if (agentView) {
          event.preventDefault();
          const title = document.getElementById(`${labelled}-inspector-title`);
          if (title?.closest('[role="dialog"]')?.contains(document.activeElement) && agentTrigger.current?.isConnected) agentTrigger.current.focus();
          else title?.focus();
          return;
        }
        if (!selected) return;
        event.preventDefault();
        const panel = document.getElementById(`${labelled}-inspector-title`)?.closest('[role="dialog"]');
        if (panel?.contains(document.activeElement)) focusEvent(selected.key);
        else focusInspector();
      }}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={`${labelled}-title`} className="text-heading">Session replay</h2>
          {stacked && all.length ? <div className="flex flex-wrap gap-3">
            <div className="replay-options" role="group" aria-label="Session replay view">
              <Button variant="ghost-link" aria-pressed={presentation === 'compact'} onClick={() => setReplayPresentation('compact')}><List data-icon="inline-start" />Compact</Button>
              <Button variant="ghost-link" aria-pressed={presentation === 'chat'} onClick={() => setReplayPresentation('chat')}><MessagesSquare data-icon="inline-start" />Chat</Button>
            </div>
            <div className="replay-options" role="group" aria-label="Event map scale">
              <Button variant="ghost-link" aria-pressed={!eventOrder} onClick={() => setEventOrder(false)}>Elapsed time</Button>
              <Button variant="ghost-link" aria-pressed={eventOrder} onClick={() => setEventOrder(true)}>Event order</Button>
            </div>
          </div> : null}
        </div>
        {eventOrder ? <p className="hint">Dotted lanes show the recorded order of each session’s events.</p>
          : clocks.a || clocks.b ? <p className="hint">Timed lanes start at each root session’s first timestamp.{sharedScale ? ' The shared scale compares elapsed durations.' : ''}</p> : null}
      </div>
      {sides.some(side => !side.replay) ? <InfoNotice title="Replay is only partly available">
        <p>{sides.map(side => `${side.profile}: ${side.replay ? 'native replay available' : 'native history unavailable'}`).join(' · ')}</p>
      </InfoNotice> : null}
      {sides.some(({ replay }) => replay?.sessions.some(session => session.limits?.length || session.reason)) ? <details className="replay-coverage" open={!all.length}><summary className="cursor-pointer text-ui"><span>Replay coverage</span> · source gaps and capture limits</summary><InfoNotice title="Source details">
        <ul className="list-disc pl-5">{sides.flatMap(({ side, profile, replay }) => replay?.sessions.flatMap(session => [
          ...(session.reason ? [<li key={`${side}:${session.id}:reason`}>{profile} · {names[side].get(session.id)}: {session.reason}</li>] : []),
          ...(session.limits ?? []).map((limit, index) => <li key={`${side}:${session.id}:${index}`}>{profile} · {names[side].get(session.id)}: {limit.message ?? limit.kind}{limit.omitted ? ` (${limit.omitted} records omitted)` : ''}</li>),
        ]) ?? [])}</ul>
      </InfoNotice></details> : null}
      {!stacked ? <p className="hint">Select an agent name for its assignment, result and parent follow-up. Dots open individual events; the conversations below show every recorded event.</p> : null}
      <div className={single || stacked ? "flex flex-col gap-3" : "report-sides"} role="group" aria-label="Session timelines">
        {sides.map(({ side, profile, replay }) => {
          const rootId = replay?.sessions.find(session => !session.parentId)?.id ?? replay?.sessions[0]?.id ?? '';
          const sideClock = clocks[side];
          const sideRows = all.filter(row => row.side === side);
          const times = (sharedScale ? all : sideRows).flatMap(row => row.elapsedMs === null ? [] : [row.elapsedMs]);
          const axisStart = Math.min(0, ...times), axisEnd = Math.max(0, ...times);
          const axisSpan = Math.max(1, axisEnd - axisStart);
          return <section key={side} className="panel replay-timeline flex flex-col gap-2" aria-label={single ? "Session timeline" : `${side === 'a' ? 'Left' : 'Right'} timeline`}>
            {profileLabel(side, profile)}
            {replay ? <>
              <div className={stacked ? 'flex flex-wrap items-baseline gap-x-3 gap-y-1' : 'flex flex-col gap-2'}>
                <p className="hint">{replay.sessions.length} recorded session{replay.sessions.length === 1 ? '' : 's'}{replay.limits?.length ? ` · ${replay.limits.join(' ')}` : ''}</p>
                {sideClock && !eventOrder ? <p className="meta">{clockLabels[sideClock.source]} · scale ends at {elapsed(axisEnd)}{sideClock.span === null ? '' : ` · root span ${elapsed(sideClock.span)}`}</p>
                  : sideRows.length && !eventOrder ? <p className="meta">Event order · no comparable timestamps</p> : null}
              </div>
              {replay.sessions.length ? <ul className="list-none p-0 m-0 flex flex-col gap-3" aria-label={`${profile} recorded session lanes`}>
                {(stacked ? stackedSessions(replay.sessions) : replay.sessions).map(session => {
                  const points = sideRows.filter(row => row.session.id === session.id);
                  const timestamped = eventOrder ? [] : points.filter(row => row.elapsedMs !== null);
                  const placement = stacked ? layOutTimedStops(timestamped, axisSpan) : undefined;
                  const timed = placement === null ? [] : timestamped;
                  const outsideScale = eventOrder || placement === null ? points : points.filter(row => row.elapsedMs === null);
                  const actorTimes = timed.map(row => row.elapsedMs!);
                  const actorSpan = actorTimes.length >= 2 ? `${elapsed(Math.min(...actorTimes))} to ${elapsed(Math.max(...actorTimes))}` : actorTimes.length ? elapsed(actorTimes[0]!) : null;
                  const parentName = session.parentId ? names[side].get(session.parentId) : null;
                  const depth = parentName ? Math.min(session.depth ?? 1, 5) : 0;
                  const active = points.some(row => row.key === sideSelections[side]);
                  return <li key={session.id} className={stacked ? 'replay-stacked-session' : 'flex flex-col gap-1'} data-selected={stacked && active || undefined}>
                    <div className="replay-lane-name flex min-w-0 flex-col" style={stacked && depth ? { paddingInlineStart: `calc(var(--space-8) * ${depth})` } : undefined}>
                      <Button variant="replay" aria-label={`View ${names[side].get(session.id)} summary`} onClick={event => openAgent(session.id, side, event.currentTarget)}>
                        {stacked && parentName ? <CornerDownRight data-icon="inline-start" /> : null}<span className="wrap-anywhere">{names[side].get(session.id)}</span><ChevronRight data-icon="inline-end" />
                      </Button>
                      <span className="meta" title={sessionName(session, rootId)}>{stacked && parentName ? `From ${parentName} · ` : ''}{points.length} {points.length === 1 ? 'event' : 'events'}
                        {actorSpan ? ` · ${actorSpan}` : sideClock && points.length && !eventOrder ? ' · event order' : ''}{session.status !== 'ready' ? ` · ${session.status}` : ''}</span>
                    </div>
                    <div className="min-w-0">
                    {placement === null ? <p className="meta">Crowded timestamps · event order</p> : null}
                    {[{ ordered: false, rows: timed }, { ordered: true, rows: outsideScale }].filter(({ rows }) => rows.length).map(({ ordered, rows }) =>
                    <div key={ordered ? 'order' : 'time'} className={ordered ? "min-w-0 overflow-x-auto" : undefined}>
                      {ordered && timed.length ? <span className="hint">Events outside this time scale</span> : null}
                      <div className="replay-event-lane relative rounded-full" role="group" aria-label={`${sessionName(session, rootId)} event ${ordered ? 'order' : 'time'} lane`} data-event-order={ordered || undefined}
                      style={ordered ? { minWidth: rows.length * 24 } : placement ? { height: placement.count * 24 } : undefined}>
                      {rows.map((row, index) => {
                        const position = ordered ? index / Math.max(1, rows.length - 1) : (row.elapsedMs! - axisStart) / axisSpan;
                        const detail = ordered ? `event ${index + 1} of ${rows.length}` : elapsed(row.elapsedMs!);
                        return <Button key={row.key} variant="ghost-link" size="icon" className="absolute top-0 size-6 min-w-0 rounded-full p-0 border-0"
                        style={{ left: ordered ? `calc((100% - 24px) * ${position})` : `clamp(0px, ${position * 100}%, calc(100% - 24px))`,
                          top: !ordered && placement ? (placement.layers.get(row.key) ?? 0) * 24 : undefined,
                          zIndex: !ordered && position === 0 ? 1 : undefined }}
                        tabIndex={row.key === selectedKey ? 0 : -1}
                        onKeyDown={event => { if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) { event.preventDefault(); move(event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1, true); } }}
                        aria-label={`${profile}: ${eventLabel(row.event)}, ${detail}`} aria-pressed={row.key === sideSelections[side]}
                        onClick={() => {
                          select(row.event, row.session, side, true);
                          if (stacked) {
                            if (!visibleKeys.has(row.key)) setRevealedSides(current => ({ ...current, [side]: true }));
                            showInConversation(row.key);
                          }
                        }} title={`${eventLabel(row.event)} · ${detail}`}><span aria-hidden="true" className="size-2 rounded-full" style={{ background: single ? "var(--color-link-focus)" : `var(--color-side-${side})`, boxShadow: row.key === sideSelections[side] ? '0 0 0 2px var(--color-text)' : undefined }} /></Button>;
                      })}
                    </div></div>)}
                    {stacked && !points.length ? <p className="hint">{session.reason ?? 'No retained events.'}</p> : null}
                    </div>
                  </li>;
                })}
              </ul> : <p className="text-ui">No recorded activity.</p>}
            </> : <p className="text-ui">No native replay was captured for this saved report. {stacked ? 'The original findings are available in Grouped evidence.' : 'The original findings and evidence remain below.'}</p>}
          </section>;
        })}
      </div>
      {all.length ? <div className="flex flex-col gap-3">
        <section className="flex flex-col gap-3" aria-labelledby={`${labelled}-tree-title`}>
          <h3 id={`${labelled}-tree-title`} className="text-body font-semibold">Recorded conversations</h3>
          <div className={stacked ? 'flex flex-wrap items-end gap-2' : 'flex flex-col gap-3'}>
            <label className="flex min-w-36 flex-1 flex-col gap-1 text-ui" htmlFor={`${labelled}-search`}>
              <span className={stacked ? 'sr-only' : undefined}>Search recorded events</span>
              <input id={`${labelled}-search`} className="input" type="search" placeholder={stacked ? 'Search recorded events' : undefined} value={query} onChange={event => { setQuery(event.target.value); setRevealedSides({ a: false, b: false }); restoreScroll('a', 0); restoreScroll('b', 0); }} />
            </label>
            {stacked ? <Button onClick={focusInspector} disabled={!selected}>Inspect selected event</Button> : null}
          </div>
          {needle && (revealedSides.a || revealedSides.b) ? <p className="hint" role="status">Search is temporarily paused on {(["a", "b"] as Side[]).filter(side => revealedSides[side]).map(side => single ? sides[0].profile : side === 'a' ? 'Left' : 'Right').join(' and ')} to show linked events.</p> : null}
          <div className="flex items-center justify-between gap-3"><p className="hint">↑ / ↓ browses events. F6 switches focus between the conversation and inspector.</p>{!stacked ? <Button onClick={focusInspector} disabled={!selected}>Inspect selected event</Button> : null}</div>
          {needle && filtered.length ? <p className="hint" role="status">{sides.map(({ side, profile }) => `${profile}: ${filtered.filter(row => row.side === side).length} events ${revealedSides[side] ? 'shown' : 'match'}`).join(' · ')}</p> : null}
          {!filtered.length ? <p role="status" className="hint">No events match this search.</p> : null}
        </section>
        <div aria-label="Recorded session event trees" className={single ? "flex flex-col gap-4" : "report-sides"}>
          {sides.map(({ side, profile, replay }) => <section key={side} aria-label={`${profile} session tree`} className="panel replay-transcript min-w-0 flex flex-col gap-3">
            {profileLabel(side, profile)}
            {replay ? <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start">
              <div className="replay-chat" data-presentation={presentation}><MessageScroller>
                <MessageScrollerViewport role="region" aria-label="Conversation" data-replay-side={side} tabIndex={0}>
                  <MessageScrollerContent>{tree(replay, side)}</MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller></div>
            </MessageScrollerProvider> : <p className="hint">{profile}: native session tree unavailable.</p>}
          </section>)}
        </div>
      </div> : null}
      <Sheet modal={false} open={visible && inspecting && Boolean(selected || agentView)} onOpenChange={setInspecting}>
        <SheetContent aria-labelledby={`${labelled}-inspector-title`} aria-describedby={`${labelled}-inspector-description`}
          onOpenAutoFocus={event => {
            event.preventDefault();
            if (focusInspectorOnOpen.current) {
              focusInspectorOnOpen.current = false;
              document.getElementById(`${labelled}-inspector-title`)?.focus();
            }
          }}
          onInteractOutside={event => event.preventDefault()}
          onCloseAutoFocus={event => {
            event.preventDefault();
            const focused = document.activeElement;
            // Closing a nonmodal inspector must not steal focus already moved elsewhere.
            if (focused instanceof HTMLElement && focused !== document.body
              && event.target instanceof HTMLElement && !event.target.contains(focused)) {
              setReportOrigin(null);
              return;
            }
            if (reportOrigin?.isConnected) {
              if (onReturnToReport) onReturnToReport(reportOrigin);
              else reportOrigin.focus();
              setReportOrigin(null);
            }
            else if (agentView && agentTrigger.current?.isConnected) agentTrigger.current.focus();
            else if (selected) focusEvent(selected.key);
          }}>
          <SheetHeader><SheetTitle id={`${labelled}-inspector-title`} tabIndex={-1}>{agentView ? 'Agent summary' : 'Event inspector'}</SheetTitle>
            <SheetDescription id={`${labelled}-inspector-description`}>{agentView ? 'Recorded excerpts and direct source links. Missing evidence stays explicit.' : 'Select recorded events while this panel stays open.'}</SheetDescription>
          </SheetHeader>
          {agentView && agentSummary ? <ReplayAgentPanel key={`${agentView.side}:${agentView.sessionId}`} name={names[agentView.side].get(agentView.sessionId) ?? 'Agent'} profile={sides.find(side => side.side === agentView.side)!.profile} summary={agentSummary} onOpen={openAgentEvidence} /> : selected ? <><div key={selected.key} className="replay-inspector-content flex flex-col gap-3">
            <p className="text-ui"><strong>{eventLabel(selected.event)}</strong> · {single ? selected.profile : selected.side === 'a' ? 'Left' : 'Right'} · {selectedTime ? <time dateTime={selected.event.timestamp!}>{selectedTime}</time> : 'Time not recorded'}{selectedTime && selected.event.timestampSource === 'observed' ? ' · observed arrival' : null}</p>
            <p className="hint">{selected.profile} · {names[selected.side].get(selected.session.id)}</p>
            {selected.event.bodyStatus !== 'included' || !selected.event.body ? <p className="hint">{statusText(selected.event)}</p> : null}
            {selected.event.contentOmitted ? <p className="hint" role="note">Some recorded content was omitted for privacy; hidden content is not available in this replay.</p> : null}
            {selected.event.body && (selected.event.kind === 'tool-call' || selected.event.kind === 'tool-result') ? <h3 className="text-ui font-semibold">{selected.event.kind === 'tool-call' ? 'Tool input' : 'Tool result'}</h3> : null}
            {typeof assignment(selected.event)?.message === 'string' && /^gAAAAA[A-Za-z0-9_-]{80,}={0,2}$/.test(assignment(selected.event)!.message!)
              ? <div className="flex flex-col gap-2"><p className="text-ui">Assignment text is opaque in this record; it cannot be read here.</p><details><summary className="cursor-pointer text-ui">Show recorded assignment fields</summary><pre className="code-block whitespace-pre-wrap break-words">{selected.event.body}</pre></details></div>
              : selected.event.body ? selected.event.body.length > 20_000
              ? <details><summary className="cursor-pointer text-ui">Show full recorded content ({selected.event.body.length.toLocaleString()} characters)</summary>
                <pre className="code-block whitespace-pre-wrap break-words">{selected.event.body}</pre></details>
              : <pre className="code-block whitespace-pre-wrap break-words">{selected.event.body}</pre> : null}
            <details><summary className="cursor-pointer text-ui">Source and event details</summary><div className="flex flex-col gap-2 pt-2">
            <p className="hint">Client: {sides.find(side => side.side === selected.side)?.client ?? 'not recorded'} · Recorded label: {selected.event.label}</p>
            <p className="hint">{selected.event.kind} · session {selected.event.sessionId}{selected.event.turnId === null ? '' : ` · turn ${selected.event.turnId}`}{selected.event.sourceLine === null ? '' : ` · source line ${selected.event.sourceLine}`}</p>
            {selectedTime ? <p className="hint">{selected.event.timestampSource === 'observed' ? 'Arrival time observed by Xenoflux' : selected.event.timestampSource === 'native' ? 'Native timestamp from the client' : 'Recorded timestamp'}</p> : null}
            <p className="hint">Source fingerprint: <code>{selected.session.source.fingerprint ?? 'not available'}</code></p>
            <p className="hint">Event reference: <code>{selected.event.id}</code></p>
            {selected.event.status ? <p className="hint">Recorded status: {selected.event.status}</p> : null}
            {selected.event.linkStatus ? <p className="hint">Event linkage: {selected.event.linkStatus.replaceAll('-', ' ')}.</p> : null}
            {selected.event.sourceLines?.length ? <p className="hint">Additional source records: {selected.event.sourceLines.join(', ')}.</p> : null}
</div></details>
            {(() => {
              const linkedId = selected.event.relatedEventId
                ?? all.find(row => row.side === selected.side && row.session.id === selected.session.id && row.event.relatedEventId === selected.event.id)?.event.id;
              const linked = all.find(row => row.side === selected.side && row.session.id === selected.session.id && row.event.id === linkedId);
              return linked ? <Button variant="ghost-link" onClick={() => { if (!visibleKeys.has(linked.key)) setRevealedSides(current => ({ ...current, [selected.side]: true })); setSelectedKey(linked.key); setSideSelections(current => ({ ...current, [selected.side]: linked.key })); focusEvent(linked.key); }}>Go to linked event: {linked.event.label}</Button> : null;
            })()}
            {delegatedIds(selected.event, selected.session).map(id => {
              const child = selected.replay.sessions.find(session => session.id === id);
              const first = all.find(row => row.side === selected.side && row.session.id === id);
              return first && child?.parentId === selected.session.id ? <Button key={id} variant="ghost-link" aria-label={`Open delegated session ${id}`} onClick={() => openDelegated(id, selected.side)}>Open {names[selected.side].get(id)}</Button>
                : <p key={id} className="hint">Delegated session {id}: {child?.reason ?? 'History unavailable or not corroborated.'}</p>;
            })}
            </div><div className="replay-inspector-nav flex flex-col gap-2"><div className="replay-inspector-actions flex flex-col gap-2">
              {reportOrigin ? <Button onClick={() => setInspecting(false)}>Back to recorded response</Button> : null}
              {agentOrigin ? <Button onClick={() => { setAgentView(agentOrigin); requestAnimationFrame(() => document.getElementById(`${labelled}-inspector-title`)?.focus()); }}>Back to {names[agentOrigin.side].get(agentOrigin.sessionId)} summary</Button> : null}
              {selected && navigation[selected.side].length ? <Button className="replay-return" variant="secondary" onClick={returnToCaller}>Return to calling event</Button> : null}
              <div className="flex gap-2 replay-inspector-step">
              <Button onClick={() => move(-1)} disabled={!filtered.length}>Previous matching event</Button>
              <Button onClick={() => move(1)} disabled={!filtered.length}>Next matching event</Button>
              </div></div>
            <p className="hint" aria-live="polite">{filtered.length ? `Event ${Math.max(1, activeIndex + 1)} of ${filtered.length} matching events.` : 'No events match this search.'}</p>
            </div></> : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
