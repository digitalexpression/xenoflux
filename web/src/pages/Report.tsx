import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { apiGet } from '@/api/client';
import type { Report as View, SessionReplay, Side } from '@/api/types';
import { SessionReplayView, type ReplayHandle } from '@/components/session-replay';
import { StatusBadge, TagPill } from '@/components/badges';
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

export function Report() {
  const { ref = '' } = useParams();
  const [searchParams] = useSearchParams();
  const info = useInfo();
  const replayRef = useRef<ReplayHandle>(null);
  const view = useResource(() => apiGet<View>(`/api/reports/${encodeURIComponent(ref)}`), ref);
  const data = view.data;
  const base = `/reports/${encodeURIComponent(ref)}`;
  useEffect(() => {
    const value = searchParams.get('event');
    if (!data || !value) return;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.length !== 3 || !['a', 'b'].includes(parsed[0])
        || parsed.slice(1).some(item => typeof item !== 'string')) return;
      replayRef.current?.openSourceEvent(parsed[0], parsed[1], parsed[2]);
    } catch { /* Ignore malformed citation links; report viewing remains available. */ }
  }, [data, searchParams]);
  return (
    <Page current="compare" title={data?.title ?? 'Comparison report'}>
      {view.error ? <LoadError error={view.error} onRetry={view.reload} /> : null}
      {view.loading && !data ? <Loading label="Comparing sessions… reading recorded history only." rows={4} /> : null}
      {data ? <>
        <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: data.breadcrumb, to: data.progressHref ?? (data.saved ? '/reports/open' : '/compare/sessions') }, { label: 'Report' }]}
          title={data.title} actions={<><Link className="btn btn-primary" to={`${base}/reviews?new=1`}>Review</Link><Link className="btn btn-secondary" to={`${base}/export`}>Export report</Link></>} />
        {data.attempt ? data.attempt.cells.every(cell => cell.state === 'completed') ? null : data.attempt.notStarted ? <InfoNotice title={data.attempt.title}>{data.attempt.text}</InfoNotice>
          : <div className="flex flex-col gap-1"><p className="text-body font-semibold">{data.attempt.title}</p><p className="hint">{data.attempt.text}</p></div>
          : data.verification.cells.some(cell => cell.executionFailures?.length) ? <ErrorPanel live={false} title="Native startup problem recorded">
          <ul className="list-disc pl-5">{data.verification.cells.flatMap(cell => (cell.executionFailures ?? []).map(failure => `${cell.profile}: ${failure}`)).map(failure => <li key={failure}>{failure}</li>)}</ul>
        </ErrorPanel> : null}
        {info?.mode === 'demo' ? <SimulatedNote /> : null}
        {data.saved ? <InfoNotice title={<span className="inline-flex flex-wrap gap-2 items-center"><TagPill>Saved report</TagPill>Shown exactly as saved</span>}>
          <p>Saved {data.saved.savedAt}{data.saved.recordedAt === 'time not recorded' ? '' : ` · session recorded ${data.saved.recordedAt}`}. Today’s setup and project files aren’t used.</p>
          {data.saved.notInReport.length ? <p>Not in this report: {data.saved.notInReport.join(', ')}.</p> : null}
        </InfoNotice> : null}

        <div className="report-sides" role="group" aria-label="Compared profiles">
          {[data.a, data.b].map((side, index) => <section aria-label={`${side.profile} task outcome`} key={side.side} className="panel flex flex-col gap-2" style={{ borderTop: `3px solid var(--color-side-${side.side})` }}>
            <span className="meta">{index ? 'Right profile' : 'Left profile'}</span>
            <div><ProfileChip side={side.side} name={side.profile} meta={side.client} /></div>
            {data.replay?.[side.side] ? <>
              <p className="meta">Root model (reported): {data.replayRootContext?.[side.side].model ?? 'Not recorded'}</p>
              <p className="meta">Root reasoning effort (reported): {data.replayRootContext?.[side.side].effort ?? 'Not recorded'}</p>
              {data.replayRootContext?.[side.side].requestedModel
                ? <p className="meta">Requested model: {data.replayRootContext?.[side.side].requestedModel}</p> : null}
              {data.replayRootContext?.[side.side].requestedEffort
                ? <p className="meta">Requested reasoning effort: {data.replayRootContext?.[side.side].requestedEffort}</p> : null}
            </> : null}
            {data.attempt?.cells[index] ? <><p className="text-body font-semibold">{data.attempt.cells[index].text}</p>
              {data.attempt.cells[index].detail ? <p className="hint">{data.attempt.cells[index].detail}</p> : null}</> : null}
          </section>)}
        </div>
        <p className="text-body"><strong className="font-semibold">{associationLead(data.association.basis)}</strong> {data.association.text}</p>

        <section className="flex flex-col gap-3" aria-labelledby="responses">
          <h2 id="responses" className="text-heading">Last recorded response</h2>
          <p className="hint">Responses are shown as recorded. Completion and response text do not verify task success.</p>
          {data.replay?.a || data.replay?.b ? <div className="report-sides">
            {([['a', data.a.profile], ['b', data.b.profile]] as const).map(([side, profile]) => data.replay?.[side]
              ? <ClosingResponse key={side} replay={data.replay[side]!} side={side} profile={profile}
                  onOpen={(sourceSide, evidence, trigger) => replayRef.current?.openEvent(sourceSide, evidence, trigger)} />
              : <ResponseUnavailable key={side} profile={profile} />)}
          </div> : <p className="text-body">No session replay is attached to this report, so a response excerpt cannot be shown.</p>}
        </section>

        <CheckAssessment rows={data.verification.rows ?? []} cells={data.verification.cells} none={data.verification.none} profiles={[data.a.profile, data.b.profile]} />
        <section className="flex flex-col gap-2" aria-label="Reviews">
          <p className="text-ui"><span className="font-medium">Reviews:</span> {data.verification.reviews.href ? <Link to={data.verification.reviews.href}>{data.verification.reviews.text}</Link> : <StatusBadge status="neutral">{data.verification.reviews.text}</StatusBadge>}</p>
        </section>

        {data.replay?.a || data.replay?.b ? <SessionReplayView ref={replayRef} sides={[
          { side: 'a', profile: data.a.profile, replay: data.replay?.a ?? null },
          { side: 'b', profile: data.b.profile, replay: data.replay?.b ?? null },
        ]} /> : null}

        <section className="flex flex-col gap-3" aria-labelledby="time">
          <h2 id="time" className="text-heading">Time and tokens</h2>
          {data.attempt?.notStarted ? <p className="text-body">Model token usage is unavailable because neither task started. This is a startup attempt, not a measured model task.</p> : null}
          <WorkflowMeasurements profiles={[data.a.profile, data.b.profile]} workflow={data.workflowMeasurements}
            agents={data.agentMeasurements} replay={data.replay} timeRows={data.timeTokens.rows}
            footer={data.timeTokens.footer} noTask={data.attempt?.notStarted ?? false} />
          <p className="hint">{data.timeTokens.footer}</p>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="outcome">
          <h2 id="outcome" className="text-heading">Outcome and code</h2>
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
                </Disclosure> : <StatusBadge status="neutral">{patch.status === 'omitted' ? 'Content omitted' : 'Not captured'}</StatusBadge>}
              </section>;
            })}
          </div> : null}
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="conditions">
          <h2 id="conditions" className="text-heading">Conditions</h2>
          <p className="hint">Recorded when each session ran.</p>
          {data.conditions.scopeNote ? <p className="hint">{data.conditions.scopeNote}</p> : null}
          {data.conditions.rows.length === 0 ? <p className="text-body">No recorded condition differs between the two sessions.</p> : null}
          {data.conditions.rows.length ? <PairRows label="Differing conditions" names={[data.a.profile, data.b.profile]} rows={data.conditions.rows.map(row => ({ ...row,
            note: row.intent === 'intended' ? <span className="badge badge-selected">You meant to vary this</span>
              : row.intent === 'not-marked' ? <span className="badge badge-warning">Not marked as intended</span> : undefined,
          }))} /> : null}
          <p className="hint">{data.conditions.footer}</p>
          <Disclosure label="Show all recorded conditions" expandedLabel="Hide all recorded conditions">
            {data.conditions.allRows ? <PairRows label="All recorded conditions" names={[data.a.profile, data.b.profile]} rows={data.conditions.allRows} /> : <dl className="grid gap-x-6 gap-y-1 text-ui" style={{ gridTemplateColumns: 'minmax(140px, auto) 1fr' }}>
              {data.conditions.all.map(fact => <div key={fact.label} className="contents"><dt className="font-medium">{fact.label}</dt><dd className="wrap-anywhere">{fact.value}</dd></div>)}
            </dl>}
          </Disclosure>
          {data.conditions.setupHref ? <Link to={data.conditions.setupHref}>Today’s setup (a separate snapshot)</Link> : null}
        </section>

        <InfoNotice as="section" title="What we could not see" headingLevel={2} className="scroll-mt-4">
          <div>{data.attempt?.notStarted ? <><p>No model task started, so the missing actions, claims and token usage cannot be recovered from this attempt.</p>
            <Disclosure label="Show recorded coverage limits" expandedLabel="Hide recorded coverage limits"><ul className="list-disc pl-5">{data.limits.map(limit => <li key={limit}>{limit}</li>)}</ul></Disclosure></>
            : <ul className="list-disc pl-5 flex flex-col gap-1">{data.limits.length ? data.limits.map(limit => <li key={limit}>{limit}</li>) : <li>Nothing that this report depends on was missing.</li>}</ul>}</div>
        </InfoNotice>

        <footer className="flex flex-col gap-2 pt-4 border-t" style={{ borderColor: 'var(--color-divider)' }}>
          <div className="flex flex-wrap gap-2"><Link className="btn btn-primary" to={`${base}/export`}>Export report</Link><CopyButton text={data.cliCommand} label="Copy CLI command" /></div>
          <p className="hint">Export saves a readable Markdown file and its JSON companion together in one folder.</p>
        </footer>
      </> : null}
    </Page>
  );
}

function ClosingResponse({ replay, side, profile, onOpen }: { replay: SessionReplay; side: Side; profile: string;
  onOpen: (side: Side, evidence: AgentEvidence, trigger: HTMLButtonElement) => void;
}) {
  const summary = useMemo(() => {
    const roots = replay.sessions.filter(session => session.parentId === null);
    return roots.length === 1 ? deriveAgentSummaries(replay).get(roots[0]!.id) : null;
  }, [replay]);
  const event = summary?.result ? replay.sessions.find(session => session.id === summary.result!.sessionId)?.events.find(item => item.id === summary.result!.event.id) : null;
  const body = event?.bodyStatus === 'included' && typeof event.body === 'string' ? event.body : null;
  return <article className="panel min-w-0 flex flex-col gap-3" aria-label={`${profile} last recorded response`} style={{ borderTop: `3px solid var(--color-side-${side})` }}>
    <SideText side={side} className="font-semibold">{profile}</SideText>
    {summary?.result && body !== null ? <>
      <p className="hint">{summary.resultNote ?? 'Recorded main-session response.'} This is not verification of success.</p>
      <Message align="start"><MessageContent><Bubble variant="secondary" className="max-w-full"><BubbleContent className="max-h-64 overflow-y-auto"><pre className="font-sans whitespace-pre-wrap wrap-break-word">{body}</pre></BubbleContent></Bubble></MessageContent></Message>
      <Disclosure label="Read full response" expandedLabel="Hide full response">
        <pre className="code-block max-h-[70vh] overflow-auto whitespace-pre-wrap wrap-break-word" style={{ background: 'var(--color-surface-raised)' }}>{body}</pre>
      </Disclosure>
      <Button variant="secondary" onClick={event => onOpen(side, { ...summary.result!, text: body }, event.currentTarget)}>Open response event</Button>
    </> : <p className="hint">{summary?.resultNote ?? 'A closing response cannot be identified for a unique main session.'}</p>}
  </article>;
}

function ResponseUnavailable({ profile }: { profile: string }) {
  return <article className="panel flex flex-col gap-2"><span className="font-semibold">{profile}</span><p className="hint">No native replay was captured for this side.</p></article>;
}

function PairRows({ label, names, rows }: { label: string; names: [string, string]; rows: {
  name: string; a: ReactNode; b: ReactNode; caveat?: string; note?: ReactNode; scope?: { a: string; b: string };
}[] }) {
  return <div className="report-pairs" role="table" aria-label={`${label} comparison`}>
    <div className="report-pair-heading" role="row"><span role="columnheader">Item</span>
      {names.map((name, index) => <span role="columnheader" key={index}><SideText side={index ? 'b' : 'a'}>{name}</SideText></span>)}</div>
    {rows.map(row => <Fragment key={row.name}><div className="report-pair-row" role="row">
      <div role="rowheader" className="report-pair-label"><span className="font-medium">{row.name}</span>{row.note}</div>
      {(['a', 'b'] as const).map((side, index) => <div role="cell" className={`report-pair-value report-pair-${side}`} key={side}>
        <span className="report-mobile-label"><SideText side={side}>{names[index]}</SideText></span>{row[side]}{row.scope ? <p className="hint">{row.scope[side]}</p> : null}
      </div>)}
    </div>{row.caveat ? <div role="row"><div role="cell" aria-colspan={3} className="report-pair-caveat hint">{row.caveat}</div></div> : null}</Fragment>)}
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
