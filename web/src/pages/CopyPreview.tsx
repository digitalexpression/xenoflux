import { useEffect, useId, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { CopyPlan, CopyResult, ProfilesView } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { Loading, LoadError, Page, PageTitle } from '@/components/layout';
import { ErrorPanel, InfoNotice, SimulatedNote, WarningAlert } from '@/components/notices';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';

/** Copy into an existing profile, or create one from selected parts (copy policy). */
export function CopyPreview({ mode }: { mode: 'copy' | 'create' }) {
  const { name: target = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? '';
  const item = params.get('item') ?? undefined;
  const skill = params.get('skill') ?? undefined;
  const newName = params.get('name') ?? '';
  const profiles = useResource(() => apiGet<ProfilesView>('/api/profiles'), 'profiles');
  const sourceId = useId();

  if (mode === 'copy' && !from) {
    const names = profiles.data?.profiles.map(p => p.name).filter(n => n !== target) ?? [];
    return (
      <Page current="profiles" title="Copy settings">
        <PageTitle breadcrumb={[{ label: 'Profiles', to: '/profiles' }, { label: target }, { label: 'Copy settings from another profile' }]}
          title={`Copy settings into ${target}`} subtitle={`Choose the profile to copy from. You’ll see exactly what changes in ${target} before anything is written.`} />
        {profiles.loading && !profiles.data ? <Loading label="Reading profiles…" rows={1} /> : null}
        {profiles.data ? (
          <form className="panel flex flex-col gap-3 max-w-[520px]" onSubmit={event => { event.preventDefault(); const value = new FormData(event.currentTarget).get('from'); if (value) setParams({ from: String(value) }); }}>
            <label htmlFor={sourceId} className="field-label">Copy from</label>
            <select id={sourceId} name="from" className="input font-mono">{names.map(n => <option key={n}>{n}</option>)}</select>
            <div><Button type="submit" variant="primary">Choose items</Button></div>
          </form>
        ) : null}
      </Page>
    );
  }
  return <PlanView key={`${mode}|${target}|${from}|${item}|${newName}`} mode={mode} target={target} from={from} item={item} skill={skill} newName={newName} />;
}

function PlanView({ mode, target, from, item, skill, newName }: { mode: 'copy' | 'create'; target: string; from: string; item?: string; skill?: string; newName: string }) {
  const plan = useResource(() => mode === 'copy'
    ? apiGet<CopyPlan>(`/api/profiles/${encodeURIComponent(target)}/copy`, { from, item, skill })
    : apiGet<CopyPlan>('/api/profiles/new', { name: newName, from }), `${mode}|${target}|${from}|${item}|${newName}`);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CopyResult | null>(null);
  const [error, setError] = useState<{ title: string; text: string; refused?: boolean } | null>(null);
  const reasonId = useId();
  const data = plan.data;
  useEffect(() => { if (data) setSelected(Object.fromEntries(data.items.map(entry => [entry.id, entry.selected]))); }, [data]);

  const chosen = data?.items.filter(entry => selected[entry.id]) ?? [];
  const n = chosen.length;
  const destination = data?.target ?? target;
  const applyLabel = mode === 'copy' ? `Apply ${n} change${n === 1 ? '' : 's'} to ${destination}` : `Create ${destination} with ${n} item${n === 1 ? '' : 's'}`;

  const modeText = (value: number | null) => value === null ? null : value.toString(8).padStart(4, '0');

  async function apply() {
    if (!data || (!n && mode === 'copy')) return;
    setBusy(true); setError(null);
    try {
      const body = { from: data.source, items: chosen.map(entry => entry.id), planToken: data.planToken };
      setResult(mode === 'copy'
        ? await apiPost<CopyResult>(`/api/profiles/${encodeURIComponent(target)}/copy`, body)
        : await apiPost<CopyResult>('/api/profiles/new', { ...body, name: destination }));
    } catch (reason) {
      setError({ title: reason instanceof ApiError && reason.code === 'client-open' ? 'Codex is open in this profile' : 'Nothing was changed', text: (reason as Error).message });
      plan.reload();
    } finally { setBusy(false); }
  }

  async function undo(simulateEdit = false) {
    if (!result?.undo) return;
    setBusy(true); setError(null);
    try { setResult(await apiPost<CopyResult>(`/api/copies/${encodeURIComponent(result.undo.id)}/undo`, simulateEdit ? { simulateEdit } : {})); }
    catch (reason) { setError({ title: 'Can’t undo safely', text: (reason as Error).message, refused: true }); }
    finally { setBusy(false); }
  }

  const crumb = mode === 'copy' ? [{ label: 'Profiles', to: '/profiles' }, { label: target }, { label: 'Copy settings from another profile' }] : [{ label: 'Profiles', to: '/profiles' }, { label: 'Create profile' }];
  return (
    <Page current="profiles" title={data?.title ?? 'Copy settings'}>
      {plan.error ? <LoadError error={plan.error} onRetry={plan.reload} /> : null}
      {plan.loading && !data ? <Loading label="Reading both profiles…" /> : null}
      {data ? (
        <>
          <PageTitle breadcrumb={crumb} title={data.title} subtitle={data.intro} />
          {data.simulated ? <SimulatedNote>Applying and undoing are simulated; no profile files are written.</SimulatedNote> : null}
          {data.origin && !result ? <InfoNotice>{data.origin}</InfoNotice> : null}
          {error ? (error.refused ? <WarningAlert live title={error.title}>{error.text}</WarningAlert> : <ErrorPanel title={error.title}>{error.text}</ErrorPanel>) : null}
          {result ? (
            <section className={result.status === 'applied' ? 'alert-success flex flex-col gap-3' : 'panel flex flex-col gap-3'} role="status" aria-labelledby="result-title">
              <h2 id="result-title" className="text-heading" style={{ color: result.status === 'applied' ? 'var(--color-success)' : undefined }}>{result.status === 'applied' ? '✓ ' : ''}{result.title}</h2>
              {result.changes.length ? <ul className="text-ui list-disc pl-5" style={{ color: 'var(--color-text)' }}>{result.changes.map(change => <li key={change} className="wrap-anywhere">{change}</li>)}</ul> : null}
              <p className="text-ui" style={{ color: 'var(--color-text)' }}>{result.note}</p>
              <div className="flex flex-wrap gap-2">
                {result.undo ? <Button busy={busy} busyLabel="Undoing…" onClick={() => void undo()}>Undo this copy</Button> : null}
                {result.undo && data.simulated ? <Button onClick={() => void undo(true)}>Try undo after a later edit (demo)</Button> : null}
                <Link className="btn" to="/profiles">Back to Profiles</Link>
                {result.status === 'undone' ? <Button onClick={() => { setResult(null); plan.reload(); }}>Start over</Button> : null}
              </div>
              {result.undo ? <p className="hint" style={{ color: 'var(--color-text-muted)' }}>{result.undo.explanation}</p> : null}
            </section>
          ) : (
            <>
              {data.blocked ? (
                <WarningAlert title={data.blocked.title} actions={<Button onClick={plan.reload}>Check again</Button>}>{data.blocked.body}</WarningAlert>
              ) : null}
              <section className="panel p-0 overflow-hidden" aria-labelledby="items-title">
                <h2 id="items-title" className="panel-head text-body font-semibold" style={{ borderRadius: 0 }}>{mode === 'copy' ? `What will change in ${destination}` : `What ${destination} will get`}</h2>
                {data.items.length ? (
                  <ul className="list-none p-0">
                    {data.items.map(entry => (
                      <li key={entry.id}>
                        <label className="row-select" data-selected={Boolean(selected[entry.id])}>
                          <input type="checkbox" className="mt-1" checked={Boolean(selected[entry.id])} onChange={() => setSelected(value => ({ ...value, [entry.id]: !value[entry.id] }))} />
                          <span className="flex flex-col gap-1 min-w-0">
                            <span><span className="font-mono font-medium wrap-anywhere">{entry.name}</span> <span className="hint">{entry.kind}</span></span>
                            <span className="text-ui wrap-anywhere">{entry.change}</span>
                            {entry.note ? <span className="hint">{entry.note}</span> : null}
                            {entry.details?.length ? <Disclosure label="Inspect file changes" expandedLabel="Hide file changes">
                              <ul className="list-disc pl-5 flex flex-col gap-3">
                                {entry.details.map((change, index) => {
                                  const beforeMode = modeText(change.beforeMode), afterMode = modeText(change.afterMode);
                                  return <li key={`${change.path}-${index}`} className="text-ui wrap-anywhere">
                                    <span className="font-mono">{change.path}</span>
                                    <span className="muted"> · {change.action.replaceAll('-', ' ')}</span>
                                    {beforeMode || afterMode ? <span className="meta"> · mode {beforeMode ?? '—'} → {afterMode ?? '—'}</span> : null}
                                    {change.before !== null || change.after !== null ? <dl className="grid gap-2 mt-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))' }}>
                                      {change.before !== null ? <div><dt className="meta">Before</dt><dd className="m-0"><pre className="font-mono text-ui whitespace-pre-wrap break-all max-h-40 overflow-auto">{change.before}</pre></dd></div> : null}
                                      {change.after !== null ? <div><dt className="meta">After</dt><dd className="m-0"><pre className="font-mono text-ui whitespace-pre-wrap break-all max-h-40 overflow-auto">{change.after}</pre></dd></div> : null}
                                    </dl> : null}
                                  </li>;
                                })}
                              </ul>
                            </Disclosure> : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : <p className="p-4 text-ui">Nothing here can be copied: the two profiles already match for everything Xenoflux can copy.</p>}
              </section>
              <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' }}>
                <section className="panel flex flex-col gap-2" aria-labelledby="manual"><h2 id="manual" className="text-body font-semibold">Set up in Codex instead</h2>{data.manual.map(text => <p key={text} className="text-ui">{text}</p>)}</section>
                <section className="panel flex flex-col gap-2" aria-labelledby="never"><h2 id="never" className="text-body font-semibold">Never copied</h2>{data.never.map(text => <p key={text} className="text-ui">{text}</p>)}</section>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {data.blocked ? null : (
                  <Button variant="primary" disabled={mode === 'copy' && !n} busy={busy} busyLabel={mode === 'copy' ? 'Applying…' : 'Creating…'} onClick={() => void apply()}
                    aria-describedby={mode === 'copy' && !n ? reasonId : undefined}>{mode === 'copy' && !n ? 'Nothing selected' : applyLabel}</Button>
                )}
                <Link className="btn" to="/profiles">Cancel</Link>
                {mode === 'copy' && !n && !data.blocked ? <span id={reasonId} className="hint">Choose at least one item.</span> : null}
              </div>
              <p className="hint">{mode === 'copy'
                ? `Checked again just before applying. ${destination}’s Codex must be closed while changes are applied; you’ll be asked first.`
                : `Creating doesn’t open Codex. Sign in to ${destination} from Codex afterwards.`}</p>
            </>
          )}
        </>
      ) : null}
    </Page>
  );
}
