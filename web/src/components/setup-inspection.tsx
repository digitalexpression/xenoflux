import { useId, useRef, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, FileText, ListTree, PanelRight, Search } from 'lucide-react';
import type { SetupInventory, SetupSourceItem } from '@/api/types';
import { Disclosure, SegmentedControl } from '@/components/controls';
import { SetupCategoryGroup } from '@/components/setup-comparison-layout';
import { SourceDetails } from '@/components/setup-inventory';
import { Button } from '@/components/ui/button';

type EvidenceView = 'details' | 'files';
const evidenceViews: { value: EvidenceView; label: string }[] = [
  { value: 'details', label: 'Details' }, { value: 'files', label: 'Source preview' },
];

function matches(item: SetupSourceItem, query: string) {
  return `${item.name} ${item.category} ${item.scope} ${item.origin} ${item.status} ${item.sources.map(source => source.where).join(' ')}`.toLowerCase().includes(query);
}

function sourceCount(count: number) {
  return `${count} ${count === 1 ? 'source' : 'sources'}`;
}

export function SetupInventoryBrowser({ inventory }: { inventory: SetupInventory }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<EvidenceView>('details');
  const searchInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();
  const groups = inventory.groups.map(group => ({
    ...group,
    items: needle ? group.items.filter(item => matches(item, needle)) : group.items,
  })).filter(group => !needle || group.items.length);
  const hasDefaultSource = (item: SetupSourceItem) => Boolean(needle) || item.status !== 'missing';
  const defaultGroup = groups.find(group => group.items.some(hasDefaultSource));
  const visibleGroups = groups.map(group => ({ ...group, open: openGroups[group.id] ?? (Boolean(needle) || group.id === defaultGroup?.id) }));
  const currentGroup = groups.find(group => group.items.some(item => item.id === selected)) ?? defaultGroup;
  const current = currentGroup?.items.find(item => item.id === selected) ?? currentGroup?.items.find(hasDefaultSource);
  const currentView = current?.files.length ? view : 'details';
  const total = groups.reduce((count, group) => count + group.items.length, 0);
  const anyOpen = visibleGroups.some(group => group.open);
  const foldLabel = anyOpen ? 'Collapse all groups' : 'Expand all groups';

  function search(value: string) {
    setQuery(value);
    setSelected(undefined);
    setOpenGroups({});
    if (results.current) results.current.scrollTop = 0;
  }

  return <section className="setup-compare-workspace setup-inspection-workspace" aria-label="Setup source inventory">
    <div className="setup-compare-list">
      <div className="setup-compare-inspector-header"><h2 className="flex items-center gap-2"><ListTree size={16} aria-hidden="true" /> Sources</h2>
        <span className="hint setup-compare-count ml-auto" role="status">{sourceCount(total)}</span>
      </div>
      <div className="setup-compare-search">
        <label className="setup-compare-search-input"><Search size={16} aria-hidden="true" />
          <input ref={searchInput} className="input" type="search" aria-label="Find a source" placeholder="Find a source…" value={query} onChange={event => search(event.target.value)} />
        </label>
        <Button size="icon" aria-label={foldLabel} title={foldLabel} disabled={!groups.length}
          onClick={() => setOpenGroups(Object.fromEntries(groups.map(group => [group.id, !anyOpen])))}>
          {anyOpen ? <ChevronsDownUp size={16} aria-hidden="true" /> : <ChevronsUpDown size={16} aria-hidden="true" />}
        </Button>
      </div>
      <div className="setup-inspection-columns setup-inspection-column-head hint" aria-hidden="true"><span>Source</span><span>Kind</span><span>Status</span></div>
      <div ref={results} className="setup-compare-results" role="region" aria-label="Setup sources" tabIndex={0}>
        {visibleGroups.map(group => {
          const missing = needle ? [] : group.items.filter(item => item.status === 'missing');
          const shown = group.items.filter(hasDefaultSource);
          function rows(items: SetupSourceItem[]) {
            return <ul className="list-none p-0">{items.map(item => <SourceRow key={item.id} item={item} selected={item.id === current?.id} onSelect={() => setSelected(item.id)} />)}</ul>;
          }
          return <SetupCategoryGroup key={group.id} category={group.id} label={group.label} open={group.open}
            description={group.items.length ? `${sourceCount(group.items.length)}${missing.length ? ` · ${missing.length} missing` : ''}` : 'No sources observed'}
            onToggle={() => setOpenGroups(value => ({ ...value, [group.id]: !group.open }))}>
            {shown.length ? rows(shown) : null}
            {missing.length ? <Disclosure className="setup-inspection-missing" label={`Show ${missing.length} missing sources`} expandedLabel={`Hide ${missing.length} missing sources`}>{rows(missing)}</Disclosure> : null}
            <p className="setup-compare-notice hint wrap-anywhere">{group.coverage || 'Coverage is unknown.'}</p>
          </SetupCategoryGroup>;
        })}
        {!groups.length ? <div className="flex flex-wrap items-center gap-2 p-3">
          <p className="text-ui">{needle ? 'No sources match this search.' : 'No source inventory was returned. See Reading limits for coverage.'}</p>
          {needle ? <Button variant="ghost-link" onClick={() => { search(''); searchInput.current?.focus(); }}>Clear search</Button> : null}
        </div> : null}
      </div>
    </div>
    <aside className="setup-compare-inspector" aria-label="Inspector">
      <div className="setup-compare-inspector-header"><PanelRight size={16} aria-hidden="true" /> Inspector</div>
      <div className="setup-compare-inspector-summary">
        {current && currentGroup ? <p className="setup-inspection-category hint">{currentGroup.label}</p> : null}
        <h2 className="text-body font-semibold wrap-anywhere" aria-live="polite" title={current?.name}>{current?.name ?? 'No source selected'}</h2>
        {current ? <p className="hint wrap-anywhere">{[current.status, current.scope, current.origin].filter(Boolean).join(' · ')}</p> : null}
      </div>
      {current?.files.length ? <div className="setup-inspection-evidence-tabs">
        <SegmentedControl label="Inspector view" options={evidenceViews} value={currentView} onChange={setView} />
      </div> : null}
      <div key={`${current?.id}:${currentView}`} className="setup-compare-evidence" role="region" aria-label="Selected source evidence" tabIndex={0}>
        {current ? <>
          <SourceDetails item={current} view={currentView} />
          {currentView === 'details' && currentGroup?.coverage ? <p className="hint wrap-anywhere">{currentGroup.coverage}</p> : null}
        </> : <p className="hint">{needle ? 'Clear the search or try another term.' : 'Choose a source to see its evidence.'}</p>}
      </div>
    </aside>
  </section>;
}

function SourceRow({ item, selected, onSelect }: { item: SetupSourceItem; selected: boolean; onSelect: () => void }) {
  const description = useId();
  return <li className="setup-compare-result" data-selected={selected || undefined}>
    <button type="button" aria-label={`Inspect ${item.name} source`} aria-describedby={description}
      aria-current={selected || undefined} className="setup-inspection-columns setup-compare-result-button text-left" onClick={onSelect}>
      <span className="flex min-w-0 items-center gap-2"><FileText size={15} className="shrink-0 muted" aria-hidden="true" />
        <span className="text-ui font-semibold truncate" title={item.name}>{item.name}</span>
      </span>
      <span className="hint truncate" title={item.category}>{item.category}</span>
      <span className="hint wrap-anywhere" id={description}>{item.status}<span className="sr-only"> · {item.scope} · {item.origin}</span></span>
    </button>
  </li>;
}
