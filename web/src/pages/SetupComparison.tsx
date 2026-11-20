import { useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeftRight, RefreshCw, Users } from 'lucide-react';
import { apiGet } from '@/api/client';
import type { SetupChoice, SetupOptions, SetupComparison as View, SetupItem, Side } from '@/api/types';
import { ComparisonBadge } from '@/components/badges';
import { Disclosure } from '@/components/controls';
import { DiffBlock } from '@/components/diff';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { SimulatedNote, WarningAlert } from '@/components/notices';
import { SideText } from '@/components/profile';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { useResource } from '@/lib/useResource';
import { cn } from '@/lib/cn';
import { setupChoiceKey, setupChoices, setupInspectHref, setupLabel, setupParams, setupSelection, type SetupSelection } from '@/components/setup-inventory';
import { SetupComparisonCoverage, SetupComparisonInventory } from '@/components/setup-comparison-inventory';

import { SetupComparisonWorkspace, SetupInspectorSides, SetupReadingCoverage, setupSides,
  type SetupProfiles, type SetupResultGroup, type SetupResultRow } from '@/components/setup-comparison-layout';

const contentFilters = [
  { value: 'all', label: 'All items' }, { value: 'different', label: 'Different' },
  { value: 'same', label: 'Same' }, { value: 'cannot-compare', label: 'Could not compare' },
];

export function SetupComparison() {
  const [params, setParams] = useSearchParams();
  const first = setupSelection(params.get('a') ?? '', params.get('aClient'));
  const second = setupSelection(params.get('b') ?? '', params.get('bClient'));
  const repo = params.get('repo') ?? '';
  if (!first || !second) return <ChooseProfiles first={first} repo={repo} />;
  return <ComparisonView key={JSON.stringify([first, second, repo])} first={first} second={second} repo={repo} onChange={(x, y, repository) => setParams(setupParams(x, y, repository))} />;
}

function ChooseProfiles({ first, repo }: { first: SetupSelection | null; repo: string }) {
  const navigate = useNavigate();
  const options = useResource(() => apiGet<SetupOptions>('/api/setups/options'), 'setup-options', { live: true });
  const available = options.data?.choices.filter(choice => choice.available) ?? [];
  const managed = available.filter(choice => choice.name !== 'Default');
  const initialA = first ?? managed[0] ?? available[0] ?? null;
  const initialB = first ? available.find(choice => choice.name !== first.name || choice.client !== first.client) ?? null
    : managed[1] ?? available.find(choice => choice.name !== initialA?.name || choice.client !== initialA.client) ?? null;
  return (
    <Page current="compare" title="Compare setups">
      <PageTitle breadcrumb={[{ label: 'Comparisons', to: '/comparisons' }, { label: 'Compare setups' }]} title="Compare setups"
        subtitle="Choose two profiles from the same or different clients. This reads current local sources; nothing is copied, activated, signed in or opened." />
      {options.error ? <LoadError error={options.error} onRetry={options.reload} /> : null}
      {options.loading && !options.data ? <Loading label="Reading setup choices…" rows={1} /> : null}
      {options.data?.warnings.map((warning, index) => <p className="text-ui" key={index}>{warning}</p>)}
      {options.data ? <ProfilePairForm choices={options.data.choices} initial={[initialA, initialB]} initialRepo={repo} unavailable={Boolean(options.error)} onSubmit={(x, y, repository) => navigate(`/compare/setups?${new URLSearchParams(setupParams(x, y, repository))}`)} submitLabel="Compare setups" /> : null}
      {options.data && available.length < 2 ? <WarningAlert title="You need two readable setups">Choose an existing native setup or <Link to="/profiles?create=1">create a profile</Link>.</WarningAlert> : null}
    </Page>
  );
}

function ProfilePairForm({ choices, initial, initialRepo, onSubmit, submitLabel, unavailable = false }:
  { choices: SetupChoice[]; initial: [SetupSelection | null, SetupSelection | null]; initialRepo: string; onSubmit: (a: SetupSelection, b: SetupSelection, repo: string) => void; submitLabel: string; unavailable?: boolean }) {
  const [a, setA] = useState(initial[0]);
  const [b, setB] = useState(initial[1]);
  const [repo, setRepo] = useState(initialRepo);
  const [error, setError] = useState(false);
  const idA = useId(), idB = useId(), errorId = useId(), repoId = useId();
  const names = setupChoices(choices, [a, b]);
  const aKey = setupChoiceKey(names, a), bKey = setupChoiceKey(names, b);
  const left = names.find(choice => choice.key === aKey), right = names.find(choice => choice.key === bKey);
  const ready = Boolean(left?.available && right?.available && aKey !== bKey && !unavailable);
  return (
    <form className="panel flex flex-col gap-4" onSubmit={event => { event.preventDefault(); if (!ready || !a || !b) { setError(true); return; } onSubmit(a, b, repo.trim()); }}>
      <div className="flex flex-wrap gap-4 items-end">
        <div className="flex-1 min-w-0 basis-[200px]">
          <label htmlFor={idA} className="field-label"><SideText side="a">First</SideText> · left side</label>
          <select id={idA} className="input" value={aKey} onChange={event => { setA(names.find(choice => choice.key === event.target.value) ?? null); setError(false); }}><option value="">Choose a setup</option>{names.map(choice => <option key={choice.key} value={choice.key} disabled={!choice.available}>{choice.label}{!choice.available ? ' · unavailable' : ''}</option>)}</select>
        </div>
        <Button size="icon" aria-label="Swap the two profiles" onClick={() => { setA(b); setB(a); }}><ArrowLeftRight size={18} aria-hidden="true" /></Button>
        <div className="flex-1 min-w-0 basis-[200px]">
          <label htmlFor={idB} className="field-label"><SideText side="b">Second</SideText> · right side</label>
          <select id={idB} className="input" value={bKey} onChange={event => { setB(names.find(choice => choice.key === event.target.value) ?? null); setError(false); }}
            aria-invalid={error || undefined} aria-describedby={error ? errorId : undefined}><option value="">Choose a setup</option>{names.map(choice => <option key={choice.key} value={choice.key} disabled={!choice.available}>{choice.label}{!choice.available ? ' · unavailable' : ''}</option>)}</select>
        </div>
      </div>
      {[left, right].filter(choice => choice && !choice.available).map((choice, index) => <p className="text-ui" key={index}>{choice?.label} · {choice?.reason}</p>)}
      <div><label htmlFor={repoId} className="field-label">Repository scope (optional)</label><input id={repoId} className="input font-mono" value={repo} onChange={event => setRepo(event.target.value)} placeholder="/absolute/path/to/repository" /></div>
      {error ? <p id={errorId} role="alert" className="text-ui" style={{ color: 'var(--color-error)' }}>Choose two different, available setups.</p> : null}
      <div><Button type="submit" variant="primary" disabled={!ready}>{submitLabel}</Button></div>
    </form>
  );
}

function ComparisonView({ first, second, repo, onChange }: { first: SetupSelection; second: SetupSelection; repo: string; onChange: (a: SetupSelection, b: SetupSelection, repo: string) => void }) {
  const info = useInfo();
  const view = useResource(() => apiGet<View>('/api/compare/setups', { ...setupParams(first, second, repo), fresh: '1' }), JSON.stringify([first, second, repo]));
  const options = useResource(() => apiGet<SetupOptions>('/api/setups/options'), 'setup-options', { live: true });
  const [changing, setChanging] = useState(false);
  const data = view.data;
  const profiles = { a: first, b: second };
  const actions = <div className="setup-compare-toolbar" role="group" aria-label="Comparison toolbar">
    {data?.separate ? <SetupComparisonCoverage inventories={data.separate} profiles={profiles} readAt={data.readAt} repo={repo} />
      : data && !data.blocked ? <SameClientCoverage data={data} profiles={profiles} repo={repo} /> : null}
    <Button onClick={() => setChanging(true)}><Users size={16} aria-hidden="true" /> Change profiles…</Button>
    <Button onClick={view.reload} busy={view.loading} busyLabel="Reading setups…" aria-label={view.loading ? 'Reading setups…' : 'Refresh setups'}>
      <RefreshCw size={16} aria-hidden="true" /> Refresh setups
    </Button>
  </div>;

  return (
    <Page current="compare" title="Compare setups" workspace toolbarActions={actions}>
      <PageTitle breadcrumb={[{ label: 'Comparisons', to: '/comparisons' }, { label: 'Compare setups' }]} title="Compare setups" compact />
      {data?.project ? <p className="hint wrap-anywhere">Repository scope <span className="font-mono">{data.project}</span></p> : null}
      {info?.mode === 'demo' ? <SimulatedNote /> : null}
      {data?.blocked ? <WarningAlert title={data.blocked} live /> : null}
      {view.error ? <>{data ? <p className="hint">Previous read shown. Refresh failed; these observations have not been updated.</p> : null}<LoadError error={view.error} onRetry={view.reload} /></> : null}
      {data?.copyHref ? <div><Link className="btn" to={data.copyHref}>Preview copying selected settings</Link></div> : null}
      {view.loading && !data ? <Loading label="Reading both setups…" /> : null}
      {data && !data.blocked ? (data.separate
        ? <SetupComparisonInventory inventories={data.separate} profiles={profiles} onSwap={() => onChange(second, first, repo)} />
        : <SameClientComparison data={data} profiles={profiles} onSwap={() => onChange(second, first, repo)} />) : null}
      <Dialog open={changing} onOpenChange={setChanging}>
        {changing ? (
          <DialogContent title="Change profiles">
            {options.error ? <LoadError error={options.error} onRetry={options.reload} /> : null}
            <ProfilePairForm choices={options.data?.choices ?? []} initial={[first, second]} initialRepo={repo} submitLabel="Compare these" unavailable={options.loading || Boolean(options.error)}
              onSubmit={(x, y, repository) => { setChanging(false); onChange(x, y, repository); }} />
            <DialogClose asChild><Button>Cancel</Button></DialogClose>
          </DialogContent>
        ) : null}
      </Dialog>
    </Page>
  );
}

function SameClientCoverage({ data, profiles, repo }: { data: View; profiles: SetupProfiles; repo: string }) {
  return <SetupReadingCoverage>
    <p className="hint">{data.readAt} · Current local sources</p>
    {data.limits ? <>
      <p className="text-ui">{data.limits.text}</p>
      <table className="setup-coverage-table text-meta" aria-label="Source coverage">
        <thead><tr><th scope="col">Source</th><th scope="col"><SideText side="a">{profiles.a.name}</SideText></th><th scope="col"><SideText side="b">{profiles.b.name}</SideText></th></tr></thead>
        <tbody>{data.limits.coverage.map(row => <tr key={row.area}><th scope="row">{row.area}</th><td>{row.a}</td><td>{row.b}</td></tr>)}</tbody>
      </table>
    </> : null}
    <div className="flex flex-col gap-2">
      {setupSides.map(side => <Link key={side} to={setupInspectHref(profiles[side], repo)}>Inspect {setupLabel(profiles[side])}</Link>)}
    </div>
  </SetupReadingCoverage>;
}

type ContentRow = SetupResultRow & { item: SetupItem };

function itemValue(item: SetupItem, side: Side) {
  const box = item.detail.values?.find(value => value.side === side);
  const source = item.detail.sources.find(record => record.side === side || record.side === 'both');
  const missing = (item.exactState === 'added' && side === 'a') || (item.exactState === 'removed' && side === 'b');
  return {
    text: box?.value ?? (missing ? 'Not present' : source?.status ?? '—'),
    mono: box?.mono, colored: item.label === 'different' && Boolean(box),
  };
}

function SameClientComparison({ data, profiles, onSwap }: { data: View; profiles: SetupProfiles; onSwap: () => void }) {
  const groups: SetupResultGroup<ContentRow>[] = data.groups.map(group => ({
    id: group.id, label: group.label, rows: group.items.map(item => ({
      id: item.id, name: item.name, scope: item.scope, filter: item.label, item,
      values: { a: itemValue(item, 'a'), b: itemValue(item, 'b') },
      result: <ComparisonBadge label={item.label} exactState={item.exactState} />,
    })),
  }));
  const notice = data.counts.different === 0
    ? <>No differences found in the sources read. {data.counts.cannotCompare ? `${data.counts.cannotCompare} could not be compared.` : null}</>
    : null;
  return <SetupComparisonWorkspace profiles={profiles} groups={groups} filters={contentFilters} onSwap={onSwap} notice={notice}
    inspect={row => ({
      summary: <>
        <div className="flex flex-wrap gap-2 items-center">{row.result}<span className="text-ui">{row.item.exactText}</span></div>
        <p className="meta">{row.item.category} · {row.item.scope}</p>
        {row.item.actions.packageHref || row.item.actions.copy ? <div className="flex flex-wrap gap-2">
          {row.item.actions.packageHref ? <Link className="btn" to={row.item.actions.packageHref}>Open package files</Link> : null}
          {row.item.actions.copy ? <Link className="btn" to={row.item.actions.copy.href}>{row.item.actions.copy.label}</Link> : null}
        </div> : null}
      </>,
      evidence: <><SetupInspectorSides profiles={profiles} values={row.values} />
        {row.item.reason ? <p className="text-ui">{row.item.reason}</p> : null}
        <ContentEvidence item={row.item} a={profiles.a.name} b={profiles.b.name} />
      </>,
    })} />;
}

function ContentEvidence({ item, a, b }: { item: SetupItem; a: string; b: string }) {
  return <>
    {item.detail.diff ? <section aria-label="Content diff" className="setup-compare-inspector-side">
      <h3 className="text-ui font-semibold">Content diff</h3>
      <DiffBlock lines={item.detail.diff} a={a} b={b} label={`Differences in ${item.name}`} />
    </section> : null}
    <p className="text-ui">{item.detail.note}</p>
    {item.detail.evidence ? (
      <Disclosure label="Inspect source evidence" expandedLabel="Hide source evidence">
        <div className="flex flex-col gap-4">
          {item.detail.evidence.map(record => (
            <section key={record.id} className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: 'var(--color-divider)' }} aria-label={`${record.name} · ${record.scope}`}>
              <h3 className="text-ui font-semibold">{record.name} · {record.scope}</h3>
              <div className="flex flex-wrap items-center gap-2"><ComparisonBadge label={record.label} exactState={record.exactState} /><span className="text-ui">{record.exactText}</span></div>
              {record.reason ? <p className="text-ui">{record.reason}</p> : null}
              {record.detail.values?.map(box => <p key={box.side} className={cn('text-ui whitespace-pre-wrap wrap-anywhere', record.label === 'different' ? (box.side === 'a' ? 'side-a' : 'side-b') : 'muted')}><span className="font-semibold">{box.label}</span>: <span className="font-mono">{box.value}</span></p>)}
              {record.detail.diff ? <DiffBlock lines={record.detail.diff} a={a} b={b} label={`Differences in ${record.name}`} /> : null}
              <dl><SetupSources sources={record.detail.sources} a={a} b={b} />
                {record.detail.facts.filter(fact => fact.label.startsWith('Cache aliases')).map(fact => <div key={fact.label} className="text-ui wrap-anywhere"><dt className="font-medium">{fact.label}</dt><dd className="muted">{fact.value}</dd></div>)}
              </dl>
            </section>
          ))}
        </div>
      </Disclosure>
    ) : null}
    {item.detail.sources.length || item.detail.facts.length ? (
      <Disclosure label="Where it’s set and what we know" expandedLabel="Hide where it’s set">
        <dl className="flex flex-col gap-2 text-ui">
          <SetupSources sources={item.detail.sources} a={a} b={b} />
          {item.detail.facts.map(fact => <div key={fact.label}><dt className="font-medium">{fact.label}</dt><dd className="muted">{fact.value}</dd></div>)}
        </dl>
      </Disclosure>
    ) : null}
    {item.actions.guidance?.length ? (
      <Disclosure label="How to set this up in Codex" expandedLabel="Hide setup steps">
        <ol className="list-decimal pl-5 text-ui flex flex-col gap-1">{item.actions.guidance.map(step => <li key={step}>{step}</li>)}</ol>
      </Disclosure>
    ) : null}
  </>;
}

function SetupSources({ sources, a, b }: { sources: SetupItem['detail']['sources']; a: string; b: string }) {
  return <>{sources.map((source, index) => <div key={`${source.side}|${source.where}|${index}`} className="text-ui wrap-anywhere">
    <dt className="font-medium">{source.side === 'a' ? a : source.side === 'b' ? b : `${a} and ${b}`} · {source.scope}</dt>
    <dd className="muted"><span className="font-mono">{source.where}</span> · {source.status}</dd>
  </div>)}</>;
}
