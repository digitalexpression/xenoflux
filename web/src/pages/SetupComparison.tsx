import { useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeftRight } from 'lucide-react';
import { apiGet } from '@/api/client';
import type { SetupChoice, SetupOptions, SetupComparison as View, SetupGroup, SetupItem } from '@/api/types';
import { ComparisonBadge } from '@/components/badges';
import { Disclosure, SegmentedControl, SummaryTiles, type TileKey } from '@/components/controls';
import { DiffBlock } from '@/components/diff';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { InfoNotice, SimulatedNote, WarningAlert } from '@/components/notices';
import { ProfileChip, SideText, SummaryText } from '@/components/profile';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { useResource } from '@/lib/useResource';
import { cn } from '@/lib/cn';
import { SeparateSetupInventories, setupChoiceKey, setupChoices, setupInspectHref, setupClientLabels, setupLabel, setupParams, setupSelection, type SetupSelection } from '@/components/setup-inventory';

const TILE_LABEL: Record<TileKey, SetupItem['label']> = { different: 'different', same: 'same', cannotCompare: 'cannot-compare' };
const FILTER_LABEL: Record<TileKey, string> = { different: 'Different only', same: 'Same only', cannotCompare: 'Could not compare only' };

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
      <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: 'Compare setups' }]} title="Compare setups"
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
  const a = first.name, b = second.name;
  const info = useInfo();
  const view = useResource(() => apiGet<View>('/api/compare/setups', { ...setupParams(first, second, repo), fresh: '1' }), JSON.stringify([first, second, repo]));
  const options = useResource(() => apiGet<SetupOptions>('/api/setups/options'), 'setup-options', { live: true });
  const [preset, setPreset] = useState<'attention' | 'all'>('attention');
  const [only, setOnly] = useState<TileKey | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [showSame, setShowSame] = useState<Record<string, boolean>>({});
  const [changing, setChanging] = useState(false);
  const searchId = useId();
  const data = view.data;

  const noDifferences = data !== null && data.counts.different === 0;
  const effectivePreset = noDifferences ? 'all' : preset;
  const visible = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.groups.map(group => ({ ...group, items: group.items.filter(item =>
      (only ? item.label === TILE_LABEL[only] : effectivePreset === 'all' || item.label !== 'same' || showSame[group.id])
      && (!q || `${item.name} ${item.scope} ${item.category}`.toLowerCase().includes(q))) }));
  }, [data, only, effectivePreset, query, showSame]);
  const items = visible.flatMap(g => g.items);
  const current = items.find(item => item.id === selected) ?? items[0] ?? null;
  const total = visible.reduce((n, g) => n + g.items.length, 0);

  return (
    <Page current="compare" title="Compare setups">
      <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: 'Compare setups' }]} title="Compare setups"
        subtitle={data ? `${data.readAt} · read-only: nothing is copied, activated, signed in or opened. Past sessions keep the setup recorded when they ran.` : undefined} />
      {info?.mode === 'demo' ? <SimulatedNote /> : null}
      {data?.blocked ? <WarningAlert title={data.blocked} live /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <ProfileChip side="a" name={a} meta={setupClientLabels[first.client]} />
        <Button size="icon" aria-label="Swap the two profiles" onClick={() => onChange(second, first, repo)}><ArrowLeftRight size={18} aria-hidden="true" /></Button>
        <ProfileChip side="b" name={b} meta={setupClientLabels[second.client]} />
        {data?.project ? <span className="text-ui">in <span className="font-mono">{data.project}</span></span> : null}
        <Button className="ml-auto" onClick={() => setChanging(true)}>Change profiles…</Button>
        <Button onClick={view.reload} busy={view.loading} busyLabel="Reading setups…">Refresh setups</Button>
      </div>
      <div className="flex flex-wrap gap-4"><Link to={setupInspectHref(first, repo)}>Inspect {setupLabel(first)}</Link><Link to={setupInspectHref(second, repo)}>Inspect {setupLabel(second)}</Link></div>
      {view.error ? <>{data ? <p className="hint">Previous read shown. Refresh failed; these observations have not been updated.</p> : null}<LoadError error={view.error} onRetry={view.reload} /></> : null}
      {data?.copyHref ? <div><Link className="btn" to={data.copyHref}>Preview copying selected settings</Link></div> : null}
      {data?.separate ? <>
        <InfoNotice title="Separate setup inventories"><p>{data.separate.reason}</p></InfoNotice>
        <SeparateSetupInventories a={data.separate.a} b={data.separate.b} aLabel={setupLabel(first)} bLabel={setupLabel(second)} />
      </> : <SummaryTiles counts={data?.counts ?? null} loading={view.loading && !data} active={only}
        onFilter={key => { setOnly(key); setSelected(null); }}
        captions={{ different: 'Where the two setups differ. Start here.' }} />}
      {data?.limits && !data.separate ? (
        <InfoNotice title="Reading limits">
          <p>{data.limits.text}</p>
          <Disclosure label="Show sources" expandedLabel="Hide sources">
            <div className="overflow-x-auto">
              <table className="text-ui w-full border-collapse">
                <thead><tr className="text-left"><th className="py-1 pr-4 font-semibold">Source</th><th className="py-1 pr-4"><SideText side="a">{a}</SideText></th><th className="py-1"><SideText side="b">{b}</SideText></th></tr></thead>
                <tbody>{data.limits.coverage.map(row => <tr key={row.area} className="border-t" style={{ borderColor: 'var(--color-divider)' }}><td className="py-1 pr-4">{row.area}</td><td className="py-1 pr-4">{row.a}</td><td className="py-1">{row.b}</td></tr>)}</tbody>
              </table>
            </div>
          </Disclosure>
        </InfoNotice>
      ) : null}
      {view.loading && !data ? <Loading label="Reading both setups… Results appear as each part finishes. No client is opened." /> : null}
      {data && !data.blocked && !data.separate ? (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[220px] max-w-[420px]">
              <label htmlFor={searchId} className="field-label">Find an item</label>
              <input id={searchId} type="search" className="input" value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} />
            </div>
            {!noDifferences ? <SegmentedControl label="Which items to list" value={only ? null : effectivePreset} onChange={value => { setPreset(value); setOnly(null); setSelected(null); }}
              options={[{ value: 'attention', label: 'Needs attention' }, { value: 'all', label: 'Everything' }]} /> : null}
            <p className="hint" role="status">{total} {total === 1 ? 'item' : 'items'} in this view{only ? ` · ${FILTER_LABEL[only]}` : ''}</p>
          </div>
          {noDifferences ? <p className="text-body font-medium">No differences within what was read. {data.counts.cannotCompare ? `${data.counts.cannotCompare} couldn’t be compared, so these setups aren’t confirmed identical.` : ''}</p> : null}
          {total === 0 ? (
            <div className="panel flex flex-col gap-2 items-start">
              <p>Nothing matches this view.</p>
              <Button onClick={() => { setQuery(''); setOnly(null); setPreset('all'); setSelected(null); }}>Clear filters</Button>
            </div>
          ) : (
            <div className="@container flex flex-wrap gap-6 items-start">
              <div className="flex flex-col gap-4" style={{ flex: '999 1 540px', minWidth: 0 }}>
                {visible.filter(group => group.items.length || (!query.trim() && effectivePreset === 'attention' && !only && group.counts.same)).map(group => (
                  <GroupPanel key={group.id} group={group} full={data.groups.find(g => g.id === group.id)!} selectedId={current?.id ?? null}
                    onSelect={setSelected} showingSame={Boolean(showSame[group.id]) || effectivePreset === 'all'} canShowSame={!only && effectivePreset === 'attention'}
                    onShowSame={() => { setShowSame(value => ({ ...value, [group.id]: !value[group.id] })); setSelected(null); }} />
                ))}
              </div>
              {current ? <DetailPanel item={current} a={a} b={b} /> : null}
            </div>
          )}
        </>
      ) : null}
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

function GroupPanel({ group, full, selectedId, onSelect, showingSame, canShowSame, onShowSame }:
  { group: SetupGroup; full: SetupGroup; selectedId: string | null; onSelect: (id: string) => void; showingSame: boolean; canShowSame: boolean; onShowSame: () => void }) {
  const hidden = full.counts.same;
  const [allUnknown, setAllUnknown] = useState(false);
  // Long lists of items that couldn't be compared stay reachable without burying the differences.
  const unknown = group.items.filter(item => item.label === 'cannot-compare');
  const shownItems = allUnknown || unknown.length <= 5 ? group.items : group.items.filter(item => item.label !== 'cannot-compare' || unknown.indexOf(item) < 5 || item.id === selectedId);
  return (
    <section className="panel p-0 overflow-hidden" aria-labelledby={`group-${group.id}`}>
      <div className="panel-head flex flex-wrap justify-between gap-2" style={{ borderRadius: 0 }}>
        <h2 id={`group-${group.id}`} className="text-body font-semibold">{group.label}</h2>
        <span className="meta">{group.meta}</span>
      </div>
      <ul className="list-none p-0">
        {shownItems.map(item => <ItemRow key={item.id} item={item} selected={item.id === selectedId} onSelect={() => onSelect(item.id)} />)}
      </ul>
      {unknown.length > 5 ? (
        <div className="px-4 py-2 border-t" style={{ borderColor: 'var(--color-divider)' }}>
          <Button variant="ghost-link" aria-expanded={allUnknown} onClick={() => setAllUnknown(value => !value)}>
            {allUnknown ? 'Show fewer that couldn’t be compared' : `Show ${unknown.length - 5} more that couldn’t be compared`}
          </Button>
        </div>
      ) : null}
      {canShowSame && hidden ? (
        <div className="px-4 py-2 border-t" style={{ borderColor: 'var(--color-divider)' }}>
          <Button variant="ghost-link" aria-expanded={showingSame} onClick={onShowSame}>{showingSame ? `Hide the ${hidden} that are the same` : `Show ${hidden} that ${hidden === 1 ? 'is' : 'are'} the same`}</Button>
        </div>
      ) : null}
    </section>
  );
}

function ItemRow({ item, selected, onSelect }: { item: SetupItem; selected: boolean; onSelect: () => void }) {
  const different = item.label === 'different';
  return (
    <li className="border-b last:border-b-0" style={{ borderColor: 'var(--color-divider)' }}>
      <button id={selected ? 'selected-setup-item' : undefined} type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined}
        className={cn('row-select w-full text-left border-0 flex-wrap items-center')} data-selected={selected}
        style={{ background: selected ? undefined : 'transparent', minHeight: 52 }}>
        <span className="w-[160px] flex-none"><ComparisonBadge label={item.label} exactState={item.exactState} /></span>
        <span className={cn('font-mono text-ui wrap-anywhere', different ? 'font-semibold' : item.label === 'same' ? 'muted' : 'font-medium')}>{item.name}</span>
        <span className="hint">{item.scope}</span>
        <span className={cn('text-ui ml-auto', !different && 'muted')}>
          {item.reason && !different ? item.reason : <SummaryText parts={item.summary} colored={different} />}
        </span>
      </button>
      {selected ? <div className="px-4 pb-3 @min-[944px]:hidden">
        <a className="btn" href="#detail-title" aria-label={`View details for ${item.name}`}>View details</a>
      </div> : null}
    </li>
  );
}

function DetailPanel({ item, a, b }: { item: SetupItem; a: string; b: string }) {
  return (
    <aside aria-labelledby="detail-title" className="panel flex flex-col gap-4" style={{ flex: '1 1 380px', borderTop: '3px solid var(--color-link-focus)', minWidth: 0 }}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2 items-center"><ComparisonBadge label={item.label} exactState={item.exactState} /><span className="text-ui font-medium">{item.exactText}</span></div>
        <h2 id="detail-title" tabIndex={-1} className="font-mono text-body font-semibold wrap-anywhere scroll-mt-4">{item.name}</h2>
        <p className="meta">{item.category} · {item.scope}</p>
        {item.reason ? <p className="text-ui">{item.reason}</p> : null}
      </div>
      <a className="btn self-start @min-[944px]:hidden" href="#selected-setup-item">Back to selected item</a>
      {item.detail.values ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))' }}>
          {item.detail.values.map(box => (
            <div key={box.side} className={cn('rounded-control px-3 py-2 flex flex-col gap-1', item.label === 'different' ? (box.side === 'a' ? 'edge-a' : 'edge-b') : '')}
              style={item.label === 'different' ? undefined : { border: '1px solid var(--color-divider)' }}>
              {item.label === 'different' ? <SideText side={box.side} className="text-meta">{box.label}</SideText> : <span className="meta">{box.label}</span>}
              <span className={cn('text-ui whitespace-pre-wrap wrap-anywhere', box.mono && 'font-mono', item.label === 'different' ? (box.side === 'a' ? 'side-a' : 'side-b') : 'muted')}>{box.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {item.detail.diff ? <DiffBlock lines={item.detail.diff} a={a} b={b} label={`Differences in ${item.name}`} /> : null}
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
      <div className="flex flex-wrap gap-2">
        {item.actions.packageHref ? <Link className="btn" to={item.actions.packageHref}>Open package files</Link> : null}
        {item.actions.copy ? <Link className="btn" to={item.actions.copy.href}>{item.actions.copy.label}</Link> : null}
      </div>
      {item.actions.guidance?.length ? (
        <Disclosure label="How to set this up in Codex" expandedLabel="Hide setup steps">
          <ol className="list-decimal pl-5 text-ui flex flex-col gap-1">{item.actions.guidance.map(step => <li key={step}>{step}</li>)}</ol>
        </Disclosure>
      ) : null}
    </aside>
  );
}

function SetupSources({ sources, a, b }: { sources: SetupItem['detail']['sources']; a: string; b: string }) {
  return <>{sources.map((source, index) => <div key={`${source.side}|${source.where}|${index}`} className="text-ui wrap-anywhere">
    <dt className="font-medium">{source.side === 'a' ? a : source.side === 'b' ? b : `${a} and ${b}`} · {source.scope}</dt>
    <dd className="muted"><span className="font-mono">{source.where}</span> · {source.status}</dd>
  </div>)}</>;
}
