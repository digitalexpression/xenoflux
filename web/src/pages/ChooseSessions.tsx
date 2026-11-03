import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { AssociationView, SessionRow, SessionsView, Side } from '@/api/types';
import { TagPill } from '@/components/badges';
import { Disclosure, SegmentedControl } from '@/components/controls';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { ErrorPanel, InfoNotice, SimulatedNote } from '@/components/notices';
import { SideText } from '@/components/profile';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { cn } from '@/lib/cn';

type Client = '' | 'cli' | 'desktop';

export function ChooseSessions() {
  const info = useInfo();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [profile, setProfile] = useState('');
  const [client, setClient] = useState<Client>('');
  // Rows chosen so far, remembered across filters; left is side A.
  const [left, setLeft] = useState<SessionRow | null>(null);
  const [right, setRight] = useState<SessionRow | null>(null);
  const [declared, setDeclared] = useState(false);
  const [taskName, setTaskName] = useState('');
  const [variables, setVariables] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchId = useId(), profileId = useId(), taskId = useId();

  useEffect(() => { const timer = window.setTimeout(() => setDebounced(query), 250); return () => window.clearTimeout(timer); }, [query]);
  const view = useResource(() => apiGet<SessionsView>('/api/sessions', { query: debounced, profile, client }), `${debounced}|${profile}|${client}`);

  // Browse carries the selected row because it may be outside this list's latest 100.
  const preset = params.get('left');
  const presetRow = (location.state as { leftSession?: SessionRow } | null)?.leftSession;
  const appliedPreset = useRef<string | null>(null);
  useEffect(() => {
    const navigationPreset = `${location.key}|${preset}`;
    if (!preset || appliedPreset.current === navigationPreset || !view.data) return;
    const row = presetRow?.key === preset ? presetRow : view.data.sessions.find(s => s.key === preset);
    if (row) {
      appliedPreset.current = navigationPreset;
      setLeft(current => current ?? row);
    }
  }, [preset, presetRow, location.key, view.data]);

  const full = Boolean(left && right);
  const pairKey = left && right ? `${left.key}|${right.key}` : '';
  const [association, setAssociation] = useState<{ key: string; data: AssociationView | null; error: Error | null; loading: boolean }>({ key: '', data: null, error: null, loading: false });
  const currentAssociation = association.key === pairKey ? association : null;
  useEffect(() => {
    if (!pairKey || !left || !right) { setAssociation({ key: '', data: null, error: null, loading: false }); return; }
    let current = true;
    setAssociation({ key: pairKey, data: null, error: null, loading: true });
    apiGet<AssociationView>('/api/compare/sessions/association', { left: left.key, right: right.key }).then(
      data => { if (current) setAssociation({ key: pairKey, data, error: null, loading: false }); },
      (reason: unknown) => { if (current) setAssociation({ key: pairKey, data: null, error: reason instanceof Error ? reason : new Error(String(reason)), loading: false }); },
    );
    return () => { current = false; };
  }, [pairKey, left?.key, right?.key]);
  useEffect(() => {
    const suggested = currentAssociation?.data?.suggestedVariables ?? [];
    setVariables(Object.fromEntries(suggested.map(name => [name, false])));
  }, [currentAssociation?.data]);

  function resetPairChoices() {
    setDeclared(false);
    setTaskName('');
    setVariables({});
  }

  function toggle(row: SessionRow) {
    if (left?.key === row.key) { resetPairChoices(); setLeft(null); return; }
    if (right?.key === row.key) { resetPairChoices(); setRight(null); return; }
    if (!left) { resetPairChoices(); setLeft(row); }
    else if (!right) { resetPairChoices(); setRight(row); }
  }
  const sideOf = (key: string): Side | null => left?.key === key ? 'a' : right?.key === key ? 'b' : null;

  async function compare() {
    if (!left || !right) return;
    if (declared && !taskName.trim()) { setError('Name the task, or untick “I say these are the same task”.'); return; }
    setBusy(true); setError(null);
    try {
      const result = await apiPost<{ ref: string }>('/api/compare/sessions', {
        left: left.key, right: right.key, title: left.title, ...(declared ? { sameTask: taskName.trim() } : {}),
        variables: Object.entries(variables).filter(([, on]) => on).map(([name]) => name),
      });
      navigate(`/reports/${encodeURIComponent(result.ref)}`);
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : String(reason)); setBusy(false); }
  }

  const rows = view.data?.sessions ?? [];
  const status = full
    ? <><SideText side="a">{left!.profile}</SideText> <span aria-hidden="true">⇄</span><span className="sr-only">and</span> <SideText side="b">{right!.profile}</SideText> chosen · untick one to change</>
    : `${[left, right].filter(Boolean).length} of 2 chosen`;
  const selectedHidden = useMemo(() => [left, right].filter((row): row is SessionRow => Boolean(row) && !rows.some(r => r.key === row!.key)), [left, right, rows]);

  return (
    <Page current="compare" title="Choose two sessions">
      <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: 'Compare a task' }, { label: 'Use existing sessions' }]} title="Choose two sessions"
        subtitle="Pick work you did in Codex or ran here. Choosing a session only reads its recorded history." />
      {info?.mode === 'demo' ? <SimulatedNote /> : null}
      {view.data?.partial ? (
        <InfoNotice title="Partly listed">
          <p>{view.data.partial.text}</p>
          <Disclosure label="How to allow access" expandedLabel="Hide how to allow access"><p>{view.data.partial.help}</p></Disclosure>
        </InfoNotice>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[220px]">
          <label htmlFor={searchId} className="field-label">Search task text or project</label>
          <input id={searchId} type="search" className="input" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="min-w-[180px]">
          <label htmlFor={profileId} className="field-label">Profile</label>
          <select id={profileId} className="input" value={profile} onChange={event => setProfile(event.target.value)}>
            <option value="">All profiles</option>
            {view.data?.profiles.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <div>
          <span className="field-label" id="client-label">Client</span>
          <SegmentedControl label="Client" value={client} onChange={setClient} options={[{ value: '', label: 'All' }, { value: 'cli', label: 'CLI' }, { value: 'desktop', label: 'Desktop' }]} />
        </div>
      </div>
      {view.error ? <LoadError error={view.error} onRetry={view.reload} /> : null}
      <section className="panel p-0 overflow-hidden" aria-labelledby="session-list">
        <div className="panel-head flex flex-wrap justify-between gap-2" style={{ borderRadius: 0 }}>
          <h2 id="session-list" className="text-ui font-semibold">{view.data ? `${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}${view.data.truncated ? ' (more are available; narrow the search)' : ''}` : 'Sessions'}</h2>
          <span className="text-ui" role="status">{status}</span>
        </div>
        {view.loading && !view.data ? <div className="p-4"><Loading label="Reading sessions…" /></div> : null}
        {view.data && rows.length === 0 ? (
          debounced || profile || client ? (
            <div className="p-4 flex flex-col gap-2 items-start"><p>No sessions match.</p><Button onClick={() => { setQuery(''); setProfile(''); setClient(''); }}>Clear filters</Button></div>
          ) : (
            <div className="p-4 flex flex-col gap-2 items-start">
              <h3 className="text-body font-semibold">No sessions found yet</h3>
              <p className="muted">Work in Codex CLI or Desktop as usual with two profiles, then come back.{info?.features.runs ? ' Or run the same task in both here.' : ''}</p>
              {info?.features.runs ? <Link className="btn" to="/runs/new">Run a new task</Link> : null}
            </div>
          )
        ) : null}
        <ul className="list-none p-0">
          {rows.map(row => {
            const side = sideOf(row.key);
            const disabled = full && !side;
            return (
              <li key={row.key}>
                <label className="row-select flex-wrap" data-selected={Boolean(side)} data-disabled={disabled}>
                  <input type="checkbox" className="mt-1" checked={Boolean(side)} disabled={disabled} onChange={() => toggle(row)}
                    aria-label={`${row.title}, ${row.profile}, ${row.clientText}, ${row.project}, ${row.recordedAt}, ${row.historyText}${side ? `, ${side === 'a' ? 'left' : 'right'} side` : ''}`}
                    aria-describedby={disabled ? 'limit-reason' : undefined} />
                  <span className="flex flex-col gap-1 flex-1 min-w-[200px]">
                    <span className="font-medium wrap-anywhere">{row.title}</span>
                    <span className="hint">
                      {side ? <SideText side={side}>{row.profile}</SideText> : <span className="font-medium" style={{ color: 'var(--color-text)' }}>{row.profile}</span>}
                      {` · ${row.clientText} · ${row.project} · ${row.recordedAt} · ${row.turns}`}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-2 items-center">
                    {side ? <span className={cn('chip text-meta font-semibold py-0', side === 'a' ? 'chip-a side-a' : 'chip-b side-b')}><span className="chip-dot" aria-hidden="true" />{side === 'a' ? 'Left' : 'Right'}</span> : null}
                    <span className={cn('badge', row.history === 'complete' ? 'badge-same' : 'badge-cannot')}>{row.historyText}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {full ? <p id="limit-reason" className="hint px-4 py-2">Two sessions are chosen. Untick one to choose another.</p> : null}
      </section>

      <section className="panel flex flex-col gap-4" aria-labelledby="your-comparison">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="your-comparison" className="text-heading">Your comparison</h2>
          <Button disabled={!full} onClick={() => { resetPairChoices(); setLeft(right); setRight(left); }}>Swap sides</Button>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))' }}>
          {(['a', 'b'] as const).map(side => {
            const row = side === 'a' ? left : right;
            return (
              <div key={side} className={cn('rounded-control px-4 py-3 flex flex-col gap-0.5', row ? (side === 'a' ? 'edge-a' : 'edge-b') : '')}
                style={row ? { border: `1px solid var(--color-side-${side})` } : { border: '1px dashed var(--color-control-border)' }}>
                <span className="meta font-semibold">{side === 'a' ? 'Left' : 'Right'}</span>
                {row ? <SideText side={side}>{row.profile}</SideText> : <span className="font-semibold muted">Not chosen yet</span>}
                <span className="text-ui wrap-anywhere">{row ? row.title : 'Tick a session in the list'}</span>
                {row ? <span className="meta">{row.clientText} · {row.project} · {row.recordedAt}</span> : null}
              </div>
            );
          })}
        </div>
        {selectedHidden.length ? (
          <div className="flex flex-wrap items-center gap-2 hint">
            <span>{selectedHidden.length === 1 ? 'One chosen session is' : 'Both chosen sessions are'} hidden by the filters and stay chosen.</span>
            {selectedHidden.map(row => <Button key={row.key} variant="ghost-link" onClick={() => toggle(row)}>Untick {row.title} ({row.profile})</Button>)}
          </div>
        ) : null}
        <p className="hint">The first session you tick goes on the left. The report keeps this order.</p>

        {full ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-body font-semibold">Same task?</h3>
            {currentAssociation?.loading ? <p className="hint" role="status">Checking what was recorded…</p> : null}
            {currentAssociation?.error ? <ErrorPanel title="Couldn’t check the task records">{currentAssociation.error.message}</ErrorPanel> : null}
            {currentAssociation?.data ? <AssociationBox view={currentAssociation.data} /> : null}
            <label className="flex gap-3 items-start text-ui">
              <input type="checkbox" checked={declared} onChange={event => setDeclared(event.target.checked)} />
              <span>I say these are the same task</span>
            </label>
            {declared ? (
              <div className="pl-8 flex flex-col gap-1">
                <label htmlFor={taskId} className="field-label">Task name</label>
                <input id={taskId} className="input max-w-[480px]" value={taskName} onChange={event => setTaskName(event.target.value)} />
                <p className="hint">Saved as your statement, not as proof the inputs matched.</p>
              </div>
            ) : null}
            {Object.keys(variables).length ? (
              <Disclosure label="Optional: mark what you meant to vary" expandedLabel="Hide what you meant to vary">
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-ui font-medium">What did you mean to vary?</legend>
                  <p className="hint">Suggested from what was recorded differently. Marked in the report; findings are still shown.</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(variables).map(([name, on]) => (
                      <label key={name} className={cn('btn', on && 'badge-selected')} style={on ? { background: 'var(--color-selected)', color: 'var(--color-on-selected)', borderColor: 'var(--color-action-border)' } : undefined}>
                        <input type="checkbox" checked={on} onChange={() => setVariables(value => ({ ...value, [name]: !on }))} />{name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </Disclosure>
            ) : null}
          </div>
        ) : <p className="hint">Tick two sessions in the list. They can be from different profiles or clients, or the same profile.</p>}
        {error ? <ErrorPanel title="Not compared yet">{error}</ErrorPanel> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!full} busy={busy} busyLabel="Comparing sessions…" onClick={() => void compare()}
            aria-describedby={!full ? 'compare-reason' : undefined}>Compare sessions</Button>
          <span id="compare-reason" className="hint">{full ? 'Reads recorded history only. Nothing is started or resumed.' : 'Choose two sessions first.'}</span>
        </div>
      </section>
    </Page>
  );
}

function AssociationBox({ view }: { view: AssociationView }) {
  const style = view.basis === 'recorded' ? { background: 'var(--color-surface-raised)', border: '1px solid var(--color-divider)' }
    : view.basis === 'unknown' ? { border: '1px dashed var(--color-control-border)' } : undefined;
  if (view.basis === 'recorded-later-differ') return <InfoNotice title={view.title}>{view.text}</InfoNotice>;
  return (
    <div className="rounded-control px-3 py-2.5 flex flex-col gap-1" style={style}>
      <span className="flex flex-wrap items-center gap-2"><TagPill>{view.basis === 'recorded' ? 'Recorded' : 'Unknown'}</TagPill><strong className="font-semibold">{view.title}</strong></span>
      <span className="text-ui">{view.text}</span>
    </div>
  );
}
