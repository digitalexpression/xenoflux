import { useRef } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { apiGet } from '@/api/client';
import type { SessionInspection } from '@/api/types';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { Disclosure } from '@/components/controls';
import { InfoNotice, SimulatedNote } from '@/components/notices';
import { SessionReplayView, type ReplayHandle } from '@/components/session-replay';
import { SessionHarness } from '@/components/session-harness';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { ClosingResponse } from './Report';

const number = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString();
const duration = (value: number | null) => value === null ? 'Unknown' : `${(value / 1000).toLocaleString()} s`;
const clients: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', copilot: 'GitHub Copilot' };
type Facet = 'overview' | 'activity' | 'harness' | 'context' | 'usage' | 'outcome' | 'source';
const facets: { id: Facet; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'activity', label: 'Activity' }, { id: 'harness', label: 'Harness' },
  { id: 'context', label: 'Context' }, { id: 'usage', label: 'Usage' }, { id: 'outcome', label: 'Outcome' }, { id: 'source', label: 'Source' },
];
const legacySections: Record<string, Facet> = { '#session-harness': 'harness', '#session-usage': 'usage', '#session-history': 'activity' };

export function Session() {
  const { ref = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const facet = facets.find(item => item.id === params.get('section'))?.id ?? legacySections[location.hash] ?? 'overview';
  function facetHref(section: Facet) {
    const next = new URLSearchParams(params);
    next.set('section', section);
    return `?${next}`;
  }
  const showActivity = () => setParams(current => { const next = new URLSearchParams(current); next.set('section', 'activity'); return next; });
  function openSourceEvent(sessionId: string, eventId: string) {
    showActivity();
    replay.current?.openSourceEvent('a', sessionId, eventId);
  }
  const info = useInfo();
  const view = useResource(() => apiGet<SessionInspection>(`/api/sessions/inspect/${encodeURIComponent(ref)}`), ref);
  const replay = useRef<ReplayHandle>(null);
  const data = view.data;
  const roots = data?.replay?.sessions.filter(session => session.parentId === null) ?? [];
  const root = roots.length === 1 ? roots[0] : undefined;
  const openingTask = root?.events.find(event => event.kind === 'message' && event.role === 'user');
  return <Page current="sessions" title={data?.title ?? 'Session inspection'}>
    {view.error ? <LoadError error={view.error} onRetry={view.reload} /> : null}
    {view.loading && !data ? <Loading label="Reading retained session evidence…" /> : null}
    {data ? <>
      <PageTitle breadcrumb={[{ label: 'Sessions', to: '/sessions' }, { label: 'Inspect session' }]} title={data.title}
        subtitle={`${data.profile} · ${clients[data.client ?? ''] ?? 'Client unknown'} · ${data.mode}`}
        actions={<><Link className="btn" to={`/sessions/native?compareWith=${encodeURIComponent(ref)}`}>Compare with another session</Link><Link className="btn" to={data.exportHref}>Export session</Link></>} />
      {info?.mode === 'demo' ? <SimulatedNote /> : null}
      <p className="text-body font-medium">{data.execution.text} · Task success is not verified by completion alone.</p>
      <nav aria-label="Session sections" className="session-facets">
        {facets.map(item => <Link key={item.id} to={facetHref(item.id)} preventScrollReset aria-current={facet === item.id ? 'page' : undefined}>{item.label}</Link>)}
      </nav>
      <p className="hint">{data.mode} · {data.frozen ? 'Frozen report' : 'Retained snapshot'} · Missing evidence stays unknown. <Link to={facetHref('source')}>View coverage and limits</Link></p>
      <div hidden={facet !== 'overview'}>
        <section className="session-overview" aria-labelledby="session-overview-title">
          <h2 id="session-overview-title" className="text-heading">Overview</h2>
          <dl className="session-facts text-ui tabular-nums">
            <div><dt>Recorded sessions</dt><dd>{data.replay ? data.replay.sessions.length.toLocaleString() : 'Unknown'}</dd></div>
            <div><dt>Captured tokens</dt><dd>{number(data.workflow.counters.total)}</dd></div>
            <div><dt>Recorded span</dt><dd>{duration(data.workflow.durationMs)}</dd></div>
          </dl>
          <p className="hint">{data.workflow.coverageNote}</p>
        </section>
      </div>
      <div hidden={facet !== 'overview' && facet !== 'context'}>
        <section className="flex flex-col gap-3" aria-labelledby="opening-task-title">
          <h2 id="opening-task-title" className="text-heading">First retained user message</h2>
          <p className="session-task text-body">{openingTask?.body ? openingTask.body.slice(0, 600) + (openingTask.body.length > 600 ? '…' : '') : 'No readable user message is available in this capture.'}</p>
          <p className="hint">Earlier messages and effective context may be missing.</p>
          {openingTask && root ? <div><Button onClick={() => openSourceEvent(root.id, openingTask.id)}>Read user message in Activity</Button></div> : null}
        </section>
      </div>
      <div hidden={facet !== 'source'}>
      <InfoNotice title="Evidence available for this session">
        <p>{data.mode === 'Historical import' ? 'A bounded reading of saved history. Tools, settings and usage depend on what the native reader exposes.' : data.mode === 'Retained xfx capture' ? 'Retained evidence from an xfx-owned run. Native client internals are visible only where its interface reports them.' : 'The capture origin is unknown. Available observations and their limits are shown below.'}</p>
        <p>This view stays on the evidence read when it was opened. Later session activity and today’s profile files are not added.</p>
        {data.frozen ? <p>Shown from the frozen report{data.savedAt ? ` · saved ${data.savedAt}` : ' · save time unknown'}.</p> : null}
        <dl className="flex flex-wrap gap-x-6 gap-y-2 mt-2 text-ui">{data.coverage.map(row => <div key={row.name}><dt className="font-medium">{row.name}</dt><dd>{row.state}{row.note ? <p className="hint">{row.note}</p> : null}</dd></div>)}</dl>
      </InfoNotice>
      </div>
      <div hidden={facet !== 'overview' && facet !== 'outcome'}>
      {data.replay ? <section className="flex flex-col gap-3" aria-labelledby="session-response">
        <h2 id="session-response" className="text-heading">Last recorded response</h2>
        <ClosingResponse single replay={data.replay} side="a" profile={data.profile}
          onOpen={(side, evidence, trigger) => { showActivity(); replay.current?.openEvent(side, evidence, trigger); }} />
      </section> : null}
      {!data.replay ? <InfoNotice title="Recorded response unavailable">No replay was retained. Completion alone does not verify task success.</InfoNotice> : null}
      </div>
      <div hidden={facet !== 'harness'}><SessionHarness data={data} section="harness" onOpenCompaction={openSourceEvent} /></div>
      <div hidden={facet !== 'context'}><SessionHarness data={data} section="context" sectionId="session-context" titleId="context-title"
        onOpenCompaction={openSourceEvent} /></div>
      <div hidden={facet !== 'usage'}>
      <section id="session-usage" className="flex flex-col gap-3 scroll-mt-4" aria-labelledby="usage-title">
        <h2 id="usage-title" className="text-heading">Time and tokens</h2>
        <dl className="flex flex-wrap gap-x-6 gap-y-3 text-ui tabular-nums">
          {([['Input', data.workflow.counters.input], ['Cached input (within input)', data.workflow.counters.cachedInput], ['Output', data.workflow.counters.output], ['Reasoning (within output)', data.workflow.counters.reasoning], ['Captured total', data.workflow.counters.total]] as const).map(([name, value]) => <div key={name}><dt className="font-medium">{name}</dt><dd>{number(value)}</dd></div>)}
          <div><dt className="font-medium">Recorded span</dt><dd>{duration(data.workflow.durationMs)}</dd></div>
        </dl>
        <p className="hint">{data.workflow.usageNote}</p><p className="hint">{data.workflow.timingNote}</p><p className="hint">{data.workflow.coverageNote}</p>
        <Disclosure label={`Per-session measurements (${data.agents.length})`} expandedLabel="Hide per-session measurements">
          <ul className="list-none flex flex-col gap-3">{data.agents.map(agent => <li key={agent.id} className="text-ui wrap-anywhere">
            <p className="font-medium">{agent.name} · {number(agent.counters.total)} tokens · {duration(agent.durationMs)}</p>
            <p className="meta">{agent.id}</p><p className="hint">{agent.usageNote} {agent.timingNote}</p>
          </li>)}</ul>
        </Disclosure>
      </section>
      </div>
      <div hidden={facet !== 'activity'}>
      <div id="session-history" className="scroll-mt-4">{data.replay ? <SessionReplayView ref={replay} visible={facet === 'activity'} sides={[{ side: 'a', profile: data.profile, client: data.client ?? undefined, replay: data.replay }]} />
        : <InfoNotice title="Recorded activity unavailable">No replay was retained. The evidence and its limits remain inspectable.</InfoNotice>}</div>
      </div>
      <div hidden={facet !== 'source'}><div className="session-source">
      <Disclosure label="Session identity and source" expandedLabel="Hide session identity and source">
        <dl className="flex flex-col gap-2 text-ui wrap-anywhere"><div><dt className="font-medium">Native session</dt><dd className="font-mono">{data.sessionId ?? 'Not recorded'}</dd></div>
          <div><dt className="font-medium">Source kind</dt><dd>{data.sourceKind}</dd></div><div><dt className="font-medium">Original surface</dt><dd>{data.surface ?? 'Unknown'}</dd></div>
          {data.readContext ? <div><dt className="font-medium">Import read context</dt><dd>{data.readContext} · This identifies the reader’s context, not the original execution.</dd></div> : null}</dl>
      </Disclosure>
      <InfoNotice title="What we could not see" headingLevel={2}><ul className="list-disc pl-5">{data.limits.map(limit => <li key={limit}>{limit}</li>)}</ul></InfoNotice>
      </div></div>
    </> : null}
  </Page>;
}
