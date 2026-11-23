import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowLeftRight, Asterisk, BookOpen, Brain, ChevronDown, ChevronRight, FileText,
  Layers, ListTree, PanelRight, Plug, Search, SlidersHorizontal, Terminal, TriangleAlert, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ProfileClient, Side } from '@/api/types';
import { SegmentedControl } from '@/components/controls';
import { setupClientLabels, type SetupSelection } from '@/components/setup-inventory';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';

export const setupSides = ['a', 'b'] satisfies Side[];
export type SetupProfiles = Record<Side, SetupSelection>;

const categoryIcons: Record<string, LucideIcon> = {
  skills: Layers, settings: SlidersHorizontal, instructions: BookOpen, integrations: Plug, tools: Wrench, memory: Brain,
};
const clientIcons: Record<ProfileClient, LucideIcon> = { codex: Terminal, 'claude-code': Asterisk, copilot: Terminal };

export function SetupCategoryGroup({ category, label, description, open, onToggle, children }: {
  category: string; label: string; description: string; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  const bodyId = useId();
  const Icon = categoryIcons[category] ?? FileText;
  return <section className="setup-compare-group" aria-label={label}>
    <h3><button className="setup-compare-category" type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
      <span className="flex items-center gap-2 font-semibold"><ChevronRight className="setup-compare-chevron" size={14} aria-hidden="true" /><Icon className="setup-compare-category-icon" size={16} aria-hidden="true" />{label}</span>
      <span className="hint text-right">{description}</span>
    </button></h3>
    <div id={bodyId} hidden={!open}>{open ? children : null}</div>
  </section>;
}

export function ProfileIdentity({ profile, side }: { profile: SetupSelection; side: Side }) {
  const Icon = clientIcons[profile.client];
  return <span className="flex items-center gap-2 min-w-0">
    <span className="setup-compare-mark" data-side={side}><Icon size={15} aria-hidden="true" /></span>
    <span className="min-w-0 wrap-anywhere"><strong className="block text-ui font-semibold">{profile.name}</strong>
      <span className="block hint">{setupClientLabels[profile.client]}</span></span>
  </span>;
}

export function SetupReadingCoverage({ partial, children }: { partial?: boolean; children: ReactNode }) {
  return <details className="setup-compare-coverage"
    onBlur={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}
    onKeyDown={event => {
      if (event.key === 'Escape' && event.currentTarget.open) {
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }
    }}>
    <summary className="btn">
      {partial ? <TriangleAlert className="setup-coverage-warning" size={16} aria-hidden="true" /> : null}
      Reading limits <ChevronDown size={14} aria-hidden="true" />
    </summary>
    <div className="setup-compare-coverage-body panel flex flex-col gap-3" role="region" aria-label="Reading limits" tabIndex={0}>{children}</div>
  </details>;
}

export type SetupResultRow = {
  id: string;
  name: string;
  scope?: string;
  filter?: string;
  result: ReactNode;
  values: Record<Side, { text: string; mono?: boolean; colored?: boolean }>;
};
export type SetupResultGroup<Row extends SetupResultRow> = {
  id: string; label: string; rows: Row[]; coverage?: ReactNode;
};
type Detail = { summary?: ReactNode; evidence: ReactNode };

export function SetupInspectorSides({ profiles, values }: { profiles: SetupProfiles; values: SetupResultRow['values'] }) {
  return <div className="setup-compare-evidence-pair">
    {setupSides.map(side => {
      const value = values[side];
      const className = cn('text-meta', value.mono && 'font-mono', value.colored ? `side-${side}` : 'muted');
      return <div key={side} className="setup-compare-evidence-side" data-side={side}>
        <ProfileIdentity profile={profiles[side]} side={side} />
        {value.text.includes('\n')
          ? <pre tabIndex={0} aria-label={`${profiles[side].name} value`} className={cn('setup-compare-value', className)}>{value.text}</pre>
          : <p className={cn('wrap-anywhere', className)}>{value.text}</p>}
      </div>;
    })}
  </div>;
}

const narrowQuery = '(width <= 850px)';
function subscribeToWidth(update: () => void) {
  const query = window.matchMedia(narrowQuery);
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}

export function SetupComparisonWorkspace<Row extends SetupResultRow>({ profiles, groups, filters, onSwap, inspect, notice }: {
  profiles: SetupProfiles; groups: SetupResultGroup<Row>[]; filters: { value: string; label: string }[];
  onSwap: () => void; inspect: (row: Row) => Detail; notice?: ReactNode;
}) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const narrow = useSyncExternalStore(subscribeToWidth, () => window.matchMedia(narrowQuery).matches);
  const rowTrigger = useRef<HTMLButtonElement>(null);
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!narrow) setSheetOpen(false);
  }, [narrow]);

  const needle = query.trim().toLowerCase();
  const filtered = filter !== 'all' || Boolean(needle);
  const visible = groups.map(group => ({ ...group, rows: group.rows.filter(row =>
    (filter === 'all' || row.filter === filter) &&
    (!needle || `${row.name} ${row.scope ?? ''} ${group.label}`.toLowerCase().includes(needle))) }))
    .filter(group => !filtered || group.rows.length);
  const rows = visible.flatMap(group => group.rows);
  const defaultGroup = visible.find(group => group.id === 'skills' && group.rows.length) ?? visible.find(group => group.rows.length);
  const current = rows.find(row => row.id === selected) ?? defaultGroup?.rows[0];
  const detail = current ? inspect(current) : null;

  function updateView() {
    setSelected(undefined);
    setOpenGroups({});
    if (results.current) results.current.scrollTop = 0;
  }

  function choose(row: Row, trigger: HTMLButtonElement) {
    setSelected(row.id);
    if (narrow) {
      rowTrigger.current = trigger;
      setSheetOpen(true);
    }
  }

  const inspector = <>
    <div className="setup-compare-inspector-summary">
      <h2 ref={inspectorHeading} tabIndex={-1} className="text-body font-semibold wrap-anywhere">{current?.name ?? 'No item selected'}</h2>
      {detail?.summary}
    </div>
    <div key={current?.id} className="setup-compare-evidence" role="region" aria-label="Selected item evidence" tabIndex={0}>
      {detail?.evidence ?? <p className="hint">Choose a row to inspect its sources.</p>}
    </div>
  </>;

  return <div className="setup-compare-workspace">
    <section className="setup-compare-list" aria-label="Setup comparison">
      <div className="setup-compare-columns setup-compare-profiles">
        <div className="setup-compare-column-label"><ListTree size={16} aria-hidden="true" /> Item</div>
        {setupSides.map(side => <div key={side}><ProfileIdentity profile={profiles[side]} side={side} /></div>)}
        <div className="setup-compare-result-heading"><span>Result</span>
          <Button size="icon" aria-label="Swap the two profiles" title="Swap profiles" onClick={onSwap}><ArrowLeftRight size={16} aria-hidden="true" /></Button>
        </div>
      </div>
      <div className="setup-compare-search">
        <label className="setup-compare-search-input"><Search size={16} aria-hidden="true" />
          <input className="input" type="search" aria-label="Find an item" placeholder="Find an item…" value={query}
            onChange={event => { setQuery(event.target.value); updateView(); }} />
        </label>
        <SegmentedControl label="Filter results" options={filters} value={filter} onChange={value => { setFilter(value); updateView(); }} />
        <span className="hint setup-compare-count" role="status">{rows.length} {rows.length === 1 ? 'item' : 'items'}</span>
      </div>
      {notice ? <div className="setup-compare-notice hint">{notice}</div> : null}
      <div ref={results} className="setup-compare-results" role="region" aria-label="Comparison results" tabIndex={0}>
        {visible.map(group => {
          const open = openGroups[group.id] ?? (filtered || group.id === defaultGroup?.id);
          return <SetupCategoryGroup key={group.id} category={group.id} label={group.label} open={open}
            description={`${group.rows.length} ${group.rows.length === 1 ? 'item' : 'items'}`}
            onToggle={() => setOpenGroups(value => ({ ...value, [group.id]: !open }))}>
            {group.rows.length ? <ul className="list-none p-0">{group.rows.map(row => <ResultRow key={row.id} row={row} profiles={profiles}
              selected={row.id === current?.id} opensSheet={narrow} onSelect={trigger => choose(row, trigger)} />)}</ul>
              : <p className="setup-compare-notice hint">No items were observed in this category.</p>}
            {group.coverage}
          </SetupCategoryGroup>;
        })}
        {!rows.length && (filtered || !visible.length) ? <div className="flex flex-wrap items-center gap-2 p-3">
          <p className="text-ui">{filtered ? 'Nothing matches this view.' : 'No items were observed.'}</p>
          {filtered ? <Button variant="ghost-link" onClick={() => { setQuery(''); setFilter('all'); updateView(); }}>Clear filters</Button> : null}
        </div> : null}
      </div>
      {narrow && current ? <div className="setup-compare-mobile-action">
        <Button aria-haspopup="dialog" onClick={event => choose(current, event.currentTarget)}><PanelRight size={16} aria-hidden="true" /> View details</Button>
      </div> : null}
    </section>
    {narrow ? <Sheet open={sheetOpen && Boolean(current)} onOpenChange={setSheetOpen}>
      <SheetContent side="bottom" className="setup-compare-sheet" aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); inspectorHeading.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); rowTrigger.current?.focus({ preventScroll: true }); }}>
        <SheetTitle className="setup-compare-inspector-header"><PanelRight size={16} aria-hidden="true" /> Inspector</SheetTitle>
        {inspector}
      </SheetContent>
    </Sheet> : <aside className="setup-compare-inspector" aria-label="Inspector">
      <div className="setup-compare-inspector-header"><PanelRight size={16} aria-hidden="true" /> Inspector</div>
      {inspector}
    </aside>}
  </div>;
}

function ResultRow({ row, profiles, selected, opensSheet, onSelect }: {
  row: SetupResultRow; profiles: SetupProfiles; selected: boolean; opensSheet: boolean; onSelect: (trigger: HTMLButtonElement) => void;
}) {
  const id = useId();
  return <li className="setup-compare-result" data-selected={selected || undefined}>
    <button type="button" aria-current={selected || undefined} aria-haspopup={opensSheet ? 'dialog' : undefined} aria-labelledby={`${id}-result ${id}-name`}
      aria-describedby={`${id}-a ${id}-b`} className="setup-compare-columns setup-compare-result-button"
      onClick={event => onSelect(event.currentTarget)}>
      <span className="setup-compare-result-badge" id={`${id}-result`}>{row.result}</span>
      <span id={`${id}-name`} className="setup-compare-result-name">
        <strong className="text-ui truncate" title={row.name}>{row.name}</strong>
        {row.scope ? <span className="text-meta muted truncate" title={row.scope}>{row.scope}</span> : null}
      </span>
      {setupSides.map(side => <span key={side} id={`${id}-${side}`} className={cn('setup-compare-result-side text-meta', row.values[side].colored ? `side-${side}` : 'muted')}>
        <span className="sr-only">{profiles[side].name} · </span>
        <span title={row.values[side].text} className={cn('truncate', row.values[side].mono && 'font-mono')}>{row.values[side].text}</span>
      </span>)}
    </button>
  </li>;
}
