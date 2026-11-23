import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { Activity, ChevronRight, ClipboardCheck, Download, FileCheck2, GitCompareArrows, Layers3, ShieldHalf, type LucideIcon } from 'lucide-react';
import { apiGet } from '@/api/client';
import type { Report as View, SessionReplay, Side, ComparisonLabel } from '@/api/types';
import { InspectSessionButton } from '@/components/inspect-session-button';
import { SessionReplayView, type ReplayHandle } from '@/components/session-replay';
import { ComparisonBadge, StatusBadge, TagPill } from '@/components/badges';
import { Disclosure } from '@/components/controls';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { ErrorPanel, InfoNotice, SimulatedNote } from '@/components/notices';
import { ProfileChip, SideText } from '@/components/profile';
import { Button } from '@/components/ui/button';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent } from '@/components/ui/message';
import { useResource } from '@/lib/useResource';
import { deriveAgentSummaries, type AgentEvidence } from '@/lib/replay-agent-summary';
import { WorkflowMeasurements } from '@/components/workflow-measurements';
import { CheckAssessment } from '@/components/check-assessment';
import { SessionControlsComparison } from '@/components/session-controls-comparison';

const EVIDENCE = '#report-overview';
const REPLAY = '#report-activity';
const evidenceAnchors = new Set(['#run-facts', '#conditions', '#report-harness', '#report-source', '#time', '#responses', '#outcome', '#assessment']);

function EvidenceGroup({ id, name, icon: Icon, open, children }: {
  id?: string; name: string; icon: LucideIcon; open?: boolean; children: ReactNode;
}) {
  return <details id={id} open={open} className="group/comparison panel scroll-mt-4 p-0">
    <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
      <h2 className="flex min-h-10 items-center gap-2 px-3 py-2 text-body font-semibold">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="flex-1">{name}</span>
        <ChevronRight className="size-4 shrink-0 group-open/comparison:rotate-90" aria-hidden="true" />
      </h2>
    </summary>
    <div className="flex flex-col gap-3 border-t px-3 py-3">{children}</div>
  </details>;
}

export function Report() {
  const { ref = '' } = useParams();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const info = useInfo();
  const viewsRef = useRef<HTMLElement>(null);
  const replayRef = useRef<ReplayHandle>(null);
  const pendingReplay = useRef<{ report: string; open: (replay: ReplayHandle) => void } | null>(null);
  const handledCitation = useRef<string | null>(null);
  const returnHash = useRef(EVIDENCE);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const view = useResource(() => apiGet<View>(`/api/reports/${encodeURIComponent(ref)}`), ref);
  const data = view.data;
  const base = `/reports/${encodeURIComponent(ref)}`;
  const replayVisible = location.hash === REPLAY;
  const citation = searchParams.get('event');
  const workspaceParams = new URLSearchParams(searchParams);
  workspaceParams.delete('event');
  const workspaceSearch = workspaceParams.toString();
  const workspaceTo = (hash: string) => ({ hash, search: workspaceSearch });

  function openReplay(open: (replay: ReplayHandle) => void, trigger?: HTMLButtonElement) {
    if (replayVisible && replayRef.current) {
      open(replayRef.current);
      return;
    }
    if (trigger) returnHash.current = location.hash || EVIDENCE;
    pendingReplay.current = { report: ref, open };
    navigate(workspaceTo(REPLAY), { replace: Boolean(trigger), preventScrollReset: true });
  }

  function returnToEvidence(trigger: HTMLButtonElement) {
    if (!replayVisible || !trigger.isConnected) return;
    returnFocus.current = trigger;
    navigate(workspaceTo(returnHash.current), { replace: true, preventScrollReset: true });
  }

  useLayoutEffect(() => {
    if (!data) return;
    if (replayVisible) {
      const pending = pendingReplay.current;
      pendingReplay.current = null;
      if (pending?.report === ref && replayRef.current) pending.open(replayRef.current);
      else if (!citation) viewsRef.current?.scrollIntoView({ block: 'start' });
      return;
    }
    const trigger = returnFocus.current;
    returnFocus.current = null;
    if (trigger?.isConnected) {
      trigger.focus();
      return;
    }
    if (!evidenceAnchors.has(location.hash)) return;
    const anchor = document.getElementById(location.hash.slice(1));
    for (let details = anchor?.closest('details'); details; details = details.parentElement?.closest('details')) {
      details.open = true;
    }
    anchor?.scrollIntoView({ block: 'start' });
  }, [citation, data, location.hash, location.key, ref, replayVisible]);

  useEffect(() => {
    if (!citation) { handledCitation.current = null; return; }
    if (!data || handledCitation.current === `${ref}:${citation}`) return;
    try {
      const parsed: unknown = JSON.parse(citation);
      if (!Array.isArray(parsed) || parsed.length !== 3) return;
      const [side, sessionId, eventId]: unknown[] = parsed;
      if ((side !== 'a' && side !== 'b') || typeof sessionId !== 'string' || typeof eventId !== 'string') return;
      const session = data.replay?.[side]?.sessions.find(item => item.id === sessionId);
      if (!session?.events.some(event => event.id === eventId)) return;
      handledCitation.current = `${ref}:${citation}`;
      if (replayVisible) replayRef.current?.openSourceEvent(side, sessionId, eventId);
      else {
        pendingReplay.current = { report: ref, open: replay => replay.openSourceEvent(side, sessionId, eventId) };
        navigate({ hash: REPLAY, search: location.search }, { replace: true, preventScrollReset: true });
      }
    } catch { /* Ignore malformed citation links; report viewing remains available. */ }
  }, [citation, data, location.search, navigate, ref, replayVisible]);
  return (
    <Page current="compare" title={data?.title ?? 'Comparison report'}>
      <div className="comparison-report">
      {view.error ? <LoadError error={view.error} onRetry={view.reload} /> : null}
      {view.loading && !data ? <Loading label="Comparing sessions… reading recorded history only." rows={4} /> : null}
      {data ? <>
        <PageTitle breadcrumb={[{ label: 'Comparisons', to: '/comparisons' }, { label: data.breadcrumb, to: data.progressHref ?? (data.retained ? '/sessions' : data.saved ? '/reports/open' : '/compare/sessions') }, { label: 'Report' }]}
          title={data.title} actions={<>
            <Link className="btn btn-secondary" to={`${base}/export`}><Download data-icon="inline-start" />Export report</Link>
            <Link className="btn btn-primary" to={`${base}/reviews?new=1`}><ClipboardCheck data-icon="inline-start" />Review</Link>
          </>} />
        {data.attempt ? data.attempt.cells.every(cell => cell.state === 'completed') ? null : data.attempt.notStarted ? <InfoNotice title={data.attempt.title}>{data.attempt.text}</InfoNotice>
          : <div className="flex flex-col gap-1"><p className="text-body font-semibold">{data.attempt.title}</p><p className="hint">{data.attempt.text}</p></div>
          : data.verification.cells.some(cell => cell.executionFailures?.length) ? <ErrorPanel live={false} title="Native startup problem recorded">
          <ul className="list-disc pl-5">{data.verification.cells.flatMap(cell => (cell.executionFailures ?? []).map(failure => `${cell.profile}: ${failure}`)).map(failure => <li key={failure}>{failure}</li>)}</ul>
        </ErrorPanel> : null}
        {info?.mode === 'demo' ? <SimulatedNote /> : null}
        {data.retained ? <InfoNotice title="Retained comparison">
          <p>Both sides use the evidence already inspected. Native histories and today’s profile files are not reread. Export this comparison to keep it after the app closes.</p>
        </InfoNotice> : null}
        {data.saved ? <InfoNotice title={<span className="inline-flex flex-wrap gap-2 items-center"><TagPill>Saved report</TagPill>Shown exactly as saved</span>}>
          <p>Saved {data.saved.savedAt}{data.saved.recordedAt === 'time not recorded' ? '' : ` · session recorded ${data.saved.recordedAt}`}. Today’s setup and project files aren’t used.</p>
          {data.saved.notInReport.length ? <p>Not in this report: {data.saved.notInReport.join(', ')}.</p> : null}
        </InfoNotice> : null}

        <div className="report-sides comparison-identities" role="group" aria-label="Compared profiles">
          {[data.a, data.b].map((side, index) => <section aria-label={`${side.profile} task outcome`} key={side.side} className="comparison-identity">
            <div className="comparison-identity-heading">
            <div><ProfileChip side={side.side} name={`${index ? 'Right' : 'Left'} · ${side.profile}`} meta={side.client.replace(/^Run here · /, '')} /></div>
            <InspectSessionButton selection={{ report: ref, side: side.side }} label="Inspect" ariaLabel="Inspect session" busyLabel="Reading…" />
            <details className="comparison-side-details">
            <summary className="btn btn-link" aria-label={`Recorded session details for ${side.profile}`}>Details</summary>
            <div>
            <p className="meta">Client · {side.client}</p>
            {side.provenance ? <p className="meta">{[
              side.provenance.basis, side.provenance.profileName, side.provenance.surface?.toUpperCase(),
              side.provenance.rootMode === 'implicit' ? 'stock root' : side.provenance.rootMode === 'explicit' ? 'managed root' : 'root mode unknown',
              side.provenance.executionLocation ?? 'location unknown',
            ].filter(Boolean).join(' · ')}</p> : null}
            {side.permissions ? <p className="meta">Permission mode · requested {side.permissions.requested ?? 'inherited'} · sent {side.permissions.sent ?? 'not recorded'} · confirmed {side.permissions.confirmed ?? 'not recorded'} · turn reported {side.permissions.observed ?? 'not recorded'}</p> : null}
            {side.autoTurns ? <div>
              <p className="text-ui font-medium">Copilot Auto · repeating this pair may route to different models.</p>
              {side.autoTurns.length ? <ul className="list-disc pl-5 text-ui">{side.autoTurns.map((turn, index) =>
                <li key={turn.turnId}>Turn {index + 1} · {turn.models.join(', ') || 'model not recorded'}</li>)}</ul> : <p className="hint">No turn model recorded.</p>}
            </div> : null}
            {data.replay?.[side.side] ? <>
              <p className="meta">Root model (reported): {data.replayRootContext?.[side.side].model ?? 'Not recorded'}</p>
              <p className="meta">Root reasoning effort (reported): {data.replayRootContext?.[side.side].effort ?? 'Not recorded'}</p>
              {data.replayRootContext?.[side.side].requestedModel
                ? <p className="meta">Requested model: {data.replayRootContext?.[side.side].requestedModel}</p> : null}
              {data.replayRootContext?.[side.side].requestedEffort
                ? <p className="meta">Requested reasoning effort: {data.replayRootContext?.[side.side].requestedEffort}</p> : null}
            </> : null}
            </div></details>
            </div>
            {data.attempt?.cells[index] ? <><p className="text-ui font-medium">{data.attempt.cells[index].text}</p>
              {data.attempt.cells[index].detail ? <p className="hint">{data.attempt.cells[index].detail}</p> : null}</> : null}
          </section>)}
        </div>
        <p className="text-body"><strong className="font-semibold">{associationLead(data.association.basis)}</strong> {data.association.text}</p>

        <nav ref={viewsRef} aria-label="Report views" className="session-facets scroll-mt-4">
          <Link className="gap-2" to={workspaceTo(EVIDENCE)} preventScrollReset aria-current={!replayVisible ? 'page' : undefined}>
            <Layers3 className="size-4" aria-hidden="true" />Grouped evidence
          </Link>
          <Link className="gap-2" to={workspaceTo(REPLAY)} preventScrollReset aria-current={replayVisible ? 'page' : undefined}>
            <Activity className="size-4" aria-hidden="true" />Session replay
          </Link>
        </nav>
        <div id="report-overview" hidden={replayVisible}>
          <div className="flex flex-col gap-2">
            <EvidenceGroup id="run-facts" name="Run facts" icon={GitCompareArrows} open>
              {data.overview?.length ? <section className="comparison-run-facts flex flex-col p-0" aria-label="Run facts">
                <PairRows label="Run facts" names={[data.a.profile, data.b.profile]} rows={data.overview} />
                <p className="hint">{data.summaryLine}{data.overview.some(row => row.name === 'Task and capture time') ? ' · Time includes startup and shutdown' : ''}</p>
              </section> : <p className="hint">{data.summaryLine}</p>}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-ui">
                <Link to={workspaceTo(REPLAY)} preventScrollReset>Open session replay</Link>
                <Link to={workspaceTo('#time')} preventScrollReset>Compare time and tokens</Link>
              </div>
              <Disclosure label="Show analytical finding counts" expandedLabel="Hide analytical finding counts">
                <div className="comparison-counts" role="group" aria-label="Recorded finding counts">
                  <div className="comparison-count comparison-count-primary"><strong>{data.counts.different}</strong><span>Different</span></div>
                  <div className="comparison-count"><strong>{data.counts.same}</strong><span>Same</span></div>
                  <div className="comparison-count"><strong>{data.counts.cannotCompare}</strong><span>Inconclusive</span></div>
                  <div className="comparison-count"><strong>{data.verification.none ? 0 : data.verification.rows?.length || 'Unknown'}</strong><span>Checks selected</span></div>
                </div>
              </Disclosure>
            </EvidenceGroup>

            <EvidenceGroup id="time" name="Time and tokens" icon={Layers3}>
              <section className="flex flex-col gap-3" aria-label="Time and tokens evidence">
                {data.attempt?.notStarted ? <p className="text-body">Model token usage is unavailable because neither task started.</p> : null}
                <WorkflowMeasurements profiles={[data.a.profile, data.b.profile]} workflow={data.workflowMeasurements}
                  agents={data.agentMeasurements} replay={data.replay} timeRows={data.timeTokens.rows} reportedUsage={data.reportedUsage}
                  footer={data.timeTokens.footer} noTask={data.attempt?.notStarted ?? false} />
                <p className="hint">{data.timeTokens.footer}</p>
              </section>
            </EvidenceGroup>

            <EvidenceGroup name="Outcome" icon={FileCheck2}>
              <section className="flex flex-col gap-3" aria-labelledby="responses">
                <h2 id="responses" className="text-heading">Last recorded response</h2>
                <p className="hint">Responses are shown as recorded. Completion and response text do not verify task success.</p>
                {data.replay?.a || data.replay?.b ? <div className="report-sides">
                  {([['a', data.a.profile], ['b', data.b.profile]] as const).map(([side, profile]) => data.replay?.[side]
                    ? <ClosingResponse key={side} replay={data.replay[side]!} side={side} profile={profile}
                        onOpen={(sourceSide, evidence, trigger) => openReplay(replay => replay.openEvent(sourceSide, evidence, trigger), trigger)} />
                    : <ResponseUnavailable key={side} profile={profile} />)}
                </div> : <p className="text-body">No session replay is attached to this report, so a response excerpt cannot be shown.</p>}
              </section>

              <CheckAssessment rows={data.verification.rows ?? []} cells={data.verification.cells} none={data.verification.none} profiles={[data.a.profile, data.b.profile]} />
              <section className="flex flex-col gap-2" aria-label="Reviews">
                <p className="text-ui"><span className="font-medium">Reviews:</span> {data.verification.reviews.href ? <Link to={data.verification.reviews.href}>{data.verification.reviews.text}</Link> : <StatusBadge status="neutral">{data.verification.reviews.text}</StatusBadge>}</p>
              </section>

              <section className="flex flex-col gap-3" aria-labelledby="outcome">
                <h3 id="outcome" className="text-heading">Outcome and code</h3>
                {data.outcome.cells ? <><PairRows label="Outcome" names={[data.a.profile, data.b.profile]} rows={[{ name: 'File-change result', a: data.outcome.cells[0], b: data.outcome.cells[1] }]} />
                  <p className="hint">No automatic winner is selected. Review judgments, when attached, are linked above.</p></> : <p className="text-body">{data.outcome.summary}</p>}
                {data.outcome.scopeNote ? <p className="hint">{data.outcome.scopeNote}</p> : null}
                {data.outcome.files.length || data.outcome.code !== null ? <Disclosure label="Show changed files and code" expandedLabel="Hide changed files and code">
                  <div className="flex flex-col gap-3">
                    {data.outcome.files.length ? <div className="overflow-x-auto">
                      <table aria-label="Changed files comparison" className="text-ui border-collapse w-full">
                        <thead><tr className="text-left"><th className="py-1 pr-4">File</th><th className="py-1 pr-4">Evidence type</th><th className="py-1 pr-4"><SideText side="a">{data.a.profile}</SideText></th><th className="py-1"><SideText side="b">{data.b.profile}</SideText></th></tr></thead>
                        {(['tracked', 'ignored', 'mixed', 'observed'] as const).map(category => {
                          const files = data.outcome.files.filter(file => (file.category ?? 'observed') === category);
                          if (!files.length) return null;
                          const categoryTitle = category === 'tracked' ? 'Tracked task changes'
                            : category === 'ignored' ? 'Ignored workspace changes'
                              : category === 'mixed' ? 'Mixed snapshot and observed evidence' : 'Observed edit paths only';
                          return <tbody key={category}><tr><th colSpan={4} className="pt-3 pb-1 text-left font-semibold">{categoryTitle}</th></tr>
                            {files.map(file => <tr key={file.path} className="border-t" style={{ borderColor: 'var(--color-divider)' }}>
                              <td className="py-1 pr-4 font-mono wrap-anywhere">{file.path}</td><td className="py-1 pr-4">{category === 'ignored' ? 'Ignored' : category === 'mixed' ? 'Mixed' : category === 'tracked' ? 'Tracked' : 'Observed event'}</td>
                              <td className="py-1 pr-4">{file.a}</td><td className="py-1">{file.b}</td>
                            </tr>)}</tbody>;
                        })}
                      </table>
                    </div> : null}
                    {data.outcome.code !== null ? <pre className="code-block" style={{ background: 'var(--color-surface-raised)' }}>{data.outcome.code}</pre> : null}
                  </div>
                </Disclosure> : null}
                {data.outcome.patches ? <div className="report-sides">
                  {(['a', 'b'] as const).map(side => {
                    const patch = data.outcome.patches![side];
                    return <section key={side} className="panel flex flex-col gap-2 min-w-0" aria-label={`${data[side].profile} task-end patch`}>
                      <h3 className="text-body font-semibold"><SideText side={side}>{data[side].profile}</SideText> · Task-end patch</h3>
                      <p className="hint">{patch.note}</p>
                      {patch.sourceCommit ? <p className="meta wrap-anywhere">Source baseline: <span className="font-mono">{patch.sourceCommit}</span></p> : null}
                      {patch.text !== null ? <Disclosure label={`Inspect ${data[side].profile} patch`} expandedLabel={`Hide ${data[side].profile} patch`}>
                        <pre className="code-block max-h-[480px] overflow-auto" tabIndex={0} aria-label={`${data[side].profile} captured patch`}>{patch.text}</pre>
                      </Disclosure> : <StatusBadge status="neutral">{patch.status === 'unchanged' ? 'No patch changes' : patch.status === 'omitted' ? 'Content omitted' : 'Not captured'}</StatusBadge>}
                    </section>;
                  })}
                </div> : null}
              </section>
            </EvidenceGroup>

            <EvidenceGroup name="Conditions and coverage" icon={ShieldHalf}>
              <section id="conditions" className="comparison-conditions flex flex-col p-0" aria-labelledby="recorded-conditions">
                <h3 id="recorded-conditions" className="text-heading">Conditions</h3>
                <p className="hint">Recorded when each session ran.</p>
                {data.conditions.scopeNote ? <p className="hint">{data.conditions.scopeNote}</p> : null}
                {data.conditions.rows.length === 0 ? <p className="text-body">No recorded condition differs between the two sessions.</p> : null}
                {(data.conditions.allRows ?? data.conditions.rows).length ? <PairRows classify label="Recorded conditions" names={[data.a.profile, data.b.profile]} rows={(data.conditions.allRows ?? data.conditions.rows).map(row => {
                  const intent = data.conditions.rows.find(item => item.name === row.name)?.intent;
                  return { ...row, note: intent === 'intended' ? <span className="badge badge-selected">You meant to vary this</span>
                    : intent === 'not-marked' ? <span className="badge">Not marked as intended</span> : undefined };
                })} /> : null}
                <p className="hint">{data.conditions.footer}</p>
                {!data.conditions.allRows ? <Disclosure label="Show all recorded conditions" expandedLabel="Hide all recorded conditions">
                  <dl className="grid gap-x-6 gap-y-1 text-ui" style={{ gridTemplateColumns: 'minmax(140px, auto) 1fr' }}>
                    {data.conditions.all.map(fact => <div key={fact.label} className="contents"><dt className="font-medium">{fact.label}</dt><dd className="wrap-anywhere">{fact.value}</dd></div>)}
                  </dl>
                </Disclosure> : null}
                {data.conditions.setupHref ? <Link to={data.conditions.setupHref}>Today’s setup (a separate snapshot)</Link> : null}
              </section>
              <div id="report-harness">
                {data.sessionControls || data.sessionHarness ? <SessionControlsComparison controls={data.sessionControls} harness={data.sessionHarness}
                  profiles={{ a: data.a.profile, b: data.b.profile }}
                  onOpenCompaction={(side, sessionId, eventId) => openReplay(replay => replay.openSourceEvent(side, sessionId, eventId))} /> : null}
              </div>
              <div id="report-source" className="scroll-mt-4"><InfoNotice as="section" title="What we could not see" headingLevel={3}>
                {data.attempt?.notStarted ? <p>Neither task started. This attempt has no model activity or token usage.</p> : null}
                {data.limits.length ? <Disclosure label="Show recorded coverage limits" expandedLabel="Hide recorded coverage limits">
                  <ul className="list-disc pl-5 flex flex-col gap-1">{data.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
                </Disclosure> : <p>All evidence used by this report was available.</p>}
              </InfoNotice></div>
            </EvidenceGroup>
          </div>
        </div>

        <div id="report-activity" hidden={!replayVisible}>
          {data.replay?.a || data.replay?.b ? <SessionReplayView ref={replayRef} visible={replayVisible} workspace="stacked"
            onReturnToReport={returnToEvidence} sides={[
              { side: 'a', profile: data.a.profile, client: data.a.client, replay: data.replay?.a ?? null },
              { side: 'b', profile: data.b.profile, client: data.b.client, replay: data.replay?.b ?? null },
            ]} /> : <InfoNotice title="Session replay unavailable">This report has no retained replay for either side.</InfoNotice>}
        </div>

        {data.cliCommand ? <footer className="border-t pt-3"><CopyButton text={data.cliCommand} label="Copy CLI command" /></footer> : null}
      </> : null}
      </div>
    </Page>
  );
}

export function ClosingResponse({ replay, side, profile, onOpen, single = false }: { replay: SessionReplay; side: Side; profile: string; single?: boolean;
  onOpen: (side: Side, evidence: AgentEvidence, trigger: HTMLButtonElement) => void;
}) {
  const summary = useMemo(() => {
    const roots = replay.sessions.filter(session => session.parentId === null);
    return roots.length === 1 ? deriveAgentSummaries(replay).get(roots[0]!.id) : null;
  }, [replay]);
  const roots = replay.sessions.filter(session => session.parentId === null);
  const fallback = single && !summary?.result && roots.length === 1 ? [...roots[0]!.events].reverse().find(event =>
    event.kind === 'message' && event.role === 'assistant' && event.bodyStatus === 'included' && event.body?.trim()) : null;
  const result = summary?.result ?? (fallback?.body ? { event: fallback, sessionId: fallback.sessionId, text: fallback.body } : null);
  const event = result ? replay.sessions.find(session => session.id === result.sessionId)?.events.find(item => item.id === result.event.id) : null;
  const body = event?.bodyStatus === 'included' && typeof event.body === 'string' ? event.body : null;
  return <article className="panel min-w-0 flex flex-col gap-3" aria-label={`${profile} last recorded response`} style={single ? undefined : { borderTop: `3px solid var(--color-side-${side})` }}>
    {single ? <span className="font-semibold wrap-anywhere">{profile}</span> : <SideText side={side} className="font-semibold">{profile}</SideText>}
    {result && body !== null ? <>
      <p className="hint">{fallback ? 'Last recorded assistant message. Completion and final-answer status are unknown.' : summary?.resultNote ?? 'Recorded main-session response.'} This is not verification of success.</p>
      <Message align="start"><MessageContent><Bubble variant="secondary" className="max-w-full"><BubbleContent className="max-h-64 overflow-y-auto"><pre className="font-sans whitespace-pre-wrap wrap-break-word">{body}</pre></BubbleContent></Bubble></MessageContent></Message>
      <Disclosure label="Read full response" expandedLabel="Hide full response">
        <pre className="code-block max-h-[70vh] overflow-auto whitespace-pre-wrap wrap-break-word" style={{ background: 'var(--color-surface-raised)' }}>{body}</pre>
      </Disclosure>
      <Button variant="secondary" onClick={event => onOpen(side, { ...result, text: body }, event.currentTarget)}>Open response event</Button>
    </> : <p className="hint">{summary?.resultNote ?? 'A closing response cannot be identified for a unique main session.'}</p>}
  </article>;
}

function ResponseUnavailable({ profile }: { profile: string }) {
  return <article className="panel flex flex-col gap-2"><span className="font-semibold">{profile}</span><p className="hint">No native replay was captured for this side.</p></article>;
}

function PairRows({ label, names, rows, classify = false }: { label: string; names: [string, string]; classify?: boolean; rows: {
  name: string; a: ReactNode; b: ReactNode; label?: ComparisonLabel; caveat?: string; note?: ReactNode; scope?: { a: string; b: string };
}[] }) {
  return <div className={`report-pairs${classify ? ' report-pairs-classified' : ''}`} role="table" aria-label={`${label} comparison`}>
    <div className="report-pair-heading" role="row"><span role="columnheader">Item</span>
      {names.map((name, index) => <span role="columnheader" key={index}><SideText side={index ? 'b' : 'a'}>{name}</SideText></span>)}
      {classify ? <span role="columnheader">Recorded result</span> : null}</div>
    {rows.map(row => <Fragment key={row.name}><div className="report-pair-row" role="row">
      <div role="rowheader" className="report-pair-label"><span className="font-medium">{row.name}</span>{row.note}</div>
      {(['a', 'b'] as const).map((side, index) => <div role="cell" className={`report-pair-value report-pair-${side}`} key={side}>
        <span className="report-mobile-label"><SideText side={side}>{names[index]}</SideText></span>{classify && row.label === 'different' ? <SideText side={side}>{row[side]}</SideText> : row[side]}{row.scope ? <p className="hint">{row.scope[side]}</p> : null}
      </div>)}
      {classify ? <div role="cell" className="report-pair-result"><ComparisonBadge label={row.label ?? 'cannot-compare'} /></div> : null}
    </div>{row.caveat ? <div role="row"><div role="cell" aria-colspan={classify ? 4 : 3} className="report-pair-caveat hint">{row.caveat}</div></div> : null}</Fragment>)}
  </div>;
}

function associationLead(basis: View['association']['basis']) {
  return basis === 'recorded' || basis === 'recorded-later-differ' ? 'Same task:' : basis === 'user-declared' ? 'Your statement:' : 'Same task not shown:';
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<'copied' | 'failed' | null>(null);
  return <span className="inline-flex items-center gap-2">
    <Button onClick={() => navigator.clipboard.writeText(text).then(() => setDone('copied'), () => setDone('failed'))}>{label}</Button>
    <span role="status" className="hint">{done === 'copied' ? 'Copied' : done === 'failed' ? `Copy failed; the command is: ${text}` : ''}</span>
  </span>;
}
