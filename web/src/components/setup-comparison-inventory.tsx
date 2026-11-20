import { Circle, FileText, Link2 } from 'lucide-react';
import { Link } from 'react-router';
import type { SetupComparison, SetupSourceItem, Side } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { InventoryCoverage, SourceDetails, setupInspectHref, setupLabel } from '@/components/setup-inventory';
import { ProfileIdentity, SetupComparisonWorkspace, SetupInspectorSides, SetupReadingCoverage,
  setupSides as sides, type SetupProfiles, type SetupResultGroup, type SetupResultRow } from '@/components/setup-comparison-layout';

type Inventories = NonNullable<SetupComparison['separate']>;
type SkillSources = Record<Side, SetupSourceItem[]>;
type InventoryRow = SetupResultRow & (
  { kind: 'skill'; sources: SkillSources } |
  { kind: 'source'; side: Side; item: SetupSourceItem }
);

const filters = [
  { value: 'all', label: 'All items' }, { value: 'matches', label: 'Name matches' }, { value: 'one-side', label: 'One side observed' },
];

function sourceCount(count: number) {
  return `${count} ${count === 1 ? 'source' : 'sources'}`;
}

function skillRows(a: SetupSourceItem[], b: SetupSourceItem[]): InventoryRow[] {
  const names = new Map<string, SkillSources>();
  const inputs = { a, b };
  for (const side of sides) {
    for (const item of inputs[side]) {
      if (item.status === 'missing') continue;
      const sources = names.get(item.name) ?? { a: [], b: [] };
      sources[side].push(item);
      names.set(item.name, sources);
    }
  }
  return [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, sources]) => {
    const match = sources.a.length > 0 && sources.b.length > 0;
    const value = (side: Side) => ({
      text: sources[side].length ? sourceCount(sources[side].length) : 'Not observed',
      colored: sources[side].length > 0,
    });
    return {
      kind: 'skill', id: JSON.stringify(['skill', name]), name, sources, filter: match ? 'matches' : 'one-side',
      result: match ? <span className="setup-compare-match"><Link2 size={14} aria-hidden="true" /> Name match</span>
        : <span className="setup-compare-status"><Circle size={13} aria-hidden="true" /> Seen on one side</span>,
      values: { a: value('a'), b: value('b') },
    };
  });
}

function inventoryGroups(inventories: Inventories, profiles: SetupProfiles): SetupResultGroup<InventoryRow>[] {
  const groups = {
    a: new Map(inventories.a.groups.map(group => [group.id, group])),
    b: new Map(inventories.b.groups.map(group => [group.id, group])),
  };
  return [...new Set([...groups.a.keys(), ...groups.b.keys()])].map(id => {
    const a = groups.a.get(id), b = groups.b.get(id);
    const rows: InventoryRow[] = id === 'skills' ? skillRows(a?.items ?? [], b?.items ?? []) : sides.flatMap(side =>
      (groups[side].get(id)?.items ?? []).map((item): InventoryRow => {
        const value = (column: Side) => ({ text: column === side ? item.status : '—', colored: column === side });
        const observed = item.status !== 'missing';
        return {
          kind: 'source', id: JSON.stringify([id, side, item.id]), name: item.name, scope: item.scope,
          side, item, ...(observed ? { filter: 'one-side' } : {}),
          values: { a: value('a'), b: value('b') },
          result: <span className="setup-compare-status"><FileText size={13} aria-hidden="true" /> {observed ? 'Source record' : 'Missing source'}</span>,
        };
      }));
    return { id, label: a?.label ?? b?.label ?? id, rows,
      coverage: <details className="setup-compare-group-coverage">
        <summary>Category reading limits</summary>
        {sides.map(side => <p key={side} className="hint"><strong>{setupLabel(profiles[side])}</strong> · {groups[side].get(id)?.coverage ?? 'Coverage unknown'}</p>)}
      </details> };
  });
}

export function SetupComparisonCoverage({ inventories, profiles, readAt, repo }: {
  inventories: Inventories; profiles: SetupProfiles; readAt: string; repo: string;
}) {
  const partial = sides.some(side => inventories[side].status !== 'present');
  return <SetupReadingCoverage partial={partial}>
    <p className="text-ui">{inventories.reason}</p>
    <p className="hint">{readAt} · Current local sources</p>
    <p className="hint">“Not observed” means this read returned no evidence of the skill name for that profile.</p>
    {sides.map(side => <section key={side} className="flex flex-col gap-2 min-w-0" aria-label={`${setupLabel(profiles[side])} coverage`}>
      <ProfileIdentity profile={profiles[side]} side={side} />
      <InventoryCoverage inventory={inventories[side]} />
      <Link to={setupInspectHref(profiles[side], repo)}>Inspect {setupLabel(profiles[side])}</Link>
    </section>)}
  </SetupReadingCoverage>;
}

export function SetupComparisonInventory({ inventories, profiles, onSwap }: {
  inventories: Inventories; profiles: SetupProfiles; onSwap: () => void;
}) {
  return <SetupComparisonWorkspace profiles={profiles} groups={inventoryGroups(inventories, profiles)} filters={filters} onSwap={onSwap}
    inspect={row => ({
      summary: <div className="text-ui">{row.result}</div>,
      evidence: <>
        <SetupInspectorSides profiles={profiles} values={row.values} />
        {row.kind === 'skill' && row.filter === 'matches' ? <p className="hint">This exact skill name was observed in both profiles. The sources below show where it was found.</p> : null}
        <section className="setup-compare-inspector-side" aria-label="Source locations">
          <h3 className="text-ui font-semibold">Source locations</h3>
          {row.kind === 'skill' ? sides.map(side => <div key={side} className="flex flex-col gap-2">
            <h4 className="hint font-semibold">{profiles[side].name}</h4>
            {row.sources[side].length ? row.sources[side].map(item => <InspectorSource key={item.id} item={item} />) : <p className="hint">Not observed</p>}
          </div>) : <div className="flex flex-col gap-2">
            <h4 className="hint font-semibold">{profiles[row.side].name}</h4><InspectorSource item={row.item} />
          </div>}
        </section>
      </>,
    })} />;
}

function InspectorSource({ item }: { item: SetupSourceItem }) {
  return <div className="flex flex-col gap-1 min-w-0">
    {item.sources.map((source, index) => <div key={index} className="flex items-start gap-2 min-w-0">
      <FileText size={14} className="mt-0.5 shrink-0 muted" aria-hidden="true" />
      <div className="min-w-0">
        <p className="hint font-mono wrap-anywhere">{source.where}</p>
        <p className="hint">{source.scope} · {source.status}</p>
      </div>
    </div>)}
    <Disclosure label={`Inspect ${item.name} source`} expandedLabel={`Hide ${item.name} source`}>
      <SourceDetails item={item} />
    </Disclosure>
  </div>;
}
