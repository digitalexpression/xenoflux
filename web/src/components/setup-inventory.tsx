import { useId, useState } from 'react';
import type { ProfileClient, SetupChoice, SetupInventory, SetupInventoryGroup, SetupSourceItem } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { InfoNotice } from '@/components/notices';

export const setupClientLabels: Record<ProfileClient, string> = { codex: 'Codex', 'claude-code': 'Claude Code', copilot: 'Copilot CLI' };
export type SetupSelection = Pick<SetupChoice, 'name' | 'client'>;
export function setupSelection(name: string, client: string | null): SetupSelection | null {
  if (!name || (client !== null && !['codex', 'claude-code', 'copilot'].includes(client))) return null;
  return { name, client: client === 'claude-code' || client === 'copilot' ? client : 'codex' };
}
export function setupLabel(selection: SetupSelection) { return `${selection.name} · ${setupClientLabels[selection.client]}`; }
export function setupParams(a: SetupSelection, b?: SetupSelection, repo = '') {
  return { a: a.name, ...(a.client === 'codex' ? {} : { aClient: a.client }), ...(b ? { b: b.name, ...(b.client === 'codex' ? {} : { bClient: b.client }) } : {}), ...(repo ? { repo } : {}) };
}
export function setupInspectHref(selection: SetupSelection, repo = '') {
  return `/profiles/${encodeURIComponent(selection.name)}/setup?${new URLSearchParams({ client: selection.client, ...(repo ? { repo } : {}) })}`;
}
export function setupChoices(choices: SetupChoice[], selections: (SetupSelection | null)[]) {
  const result = [...choices];
  for (const selection of selections) {
    if (selection && !result.some(choice => choice.name === selection.name && choice.client === selection.client)) {
      result.push({ ...selection, key: `unavailable-${JSON.stringify(selection)}`, label: setupLabel(selection), available: false, reason: 'This setup is no longer available. Choose a setup explicitly.' });
    }
  }
  return result;
}
export function setupChoiceKey(choices: SetupChoice[], selection: SetupSelection | null) {
  return choices.find(choice => choice.name === selection?.name && choice.client === selection.client)?.key ?? '';
}

export function InventoryCoverage({ inventory }: { inventory: SetupInventory }) {
  return <div className="flex flex-col gap-2 min-w-0">
    <p className="text-ui">Discovery {inventory.status}</p>
    {inventory.warnings.length ? <ul className="text-ui list-disc pl-5 wrap-anywhere">{inventory.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    {inventory.coverage.length ? <Disclosure label="Show reading coverage" expandedLabel="Hide reading coverage"><dl className="flex flex-col gap-2 text-ui wrap-anywhere">{inventory.coverage.map((fact, index) => <div key={index}><dt className="font-medium">{fact.label}</dt><dd className="muted">{fact.value}</dd></div>)}</dl></Disclosure> : null}
  </div>;
}

function matches(item: SetupSourceItem, query: string) {
  return `${item.name} ${item.category} ${item.scope} ${item.origin} ${item.status} ${item.sources.map(source => source.where).join(' ')}`.toLowerCase().includes(query);
}

function SourceEvidence({ item, headingLevel }: { item: SetupSourceItem; headingLevel: 3 | 4 }) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  return <li className="py-4 border-t flex flex-col gap-2 min-w-0 wrap-anywhere" style={{ borderColor: 'var(--color-divider)' }}>
    <div className="flex flex-wrap gap-x-4 gap-y-1 justify-between"><Heading className="text-body font-semibold">{item.name}</Heading><span className="text-ui">{item.status}</span></div>
    <p className="hint">{[item.category, item.scope, item.origin].filter(Boolean).join(' · ')}</p>
    {item.sources.map((source, index) => <p className="hint font-mono wrap-anywhere" key={index}>{source.where}</p>)}
    <Disclosure label={`Inspect ${item.name} source`} expandedLabel={`Hide ${item.name} source`}>
      <div className="flex flex-col gap-3 min-w-0">
        <p className="text-ui font-medium">{item.value === null && item.files.length ? 'Source files' : 'Value'} · {item.valueStatus}</p>
        {item.value !== null ? <pre className="text-ui font-mono whitespace-pre-wrap wrap-anywhere">{item.value}</pre> : !item.files.length ? <p className="hint">No value was returned by this read.</p> : null}
        {item.note ? <p className="text-ui">{item.note}</p> : null}
        {item.sources.length ? <dl className="flex flex-col gap-2 text-ui">{item.sources.map((source, index) => <div key={index}><dt className="font-medium">{source.scope} · {source.status}</dt><dd className="font-mono muted wrap-anywhere">{source.where}</dd></div>)}</dl> : null}
        {item.facts.length ? <dl className="flex flex-col gap-2 text-ui">{item.facts.map((fact, index) => <div key={index}><dt className="font-medium">{fact.label}</dt><dd className="muted whitespace-pre-wrap wrap-anywhere">{fact.value}</dd></div>)}</dl> : null}
        {item.files.map((file, index) => <section className="border-t pt-3 flex flex-col gap-2 min-w-0" style={{ borderColor: 'var(--color-divider)' }} key={`${file.path}-${index}`} aria-label={`Source file ${file.path}`}>
          <p className="font-mono text-ui wrap-anywhere">{file.path}</p><p className="hint">{file.status}</p>
          {file.note ? <p className="text-ui">{file.note}</p> : null}
          {file.preview !== null ? <pre className="text-ui font-mono whitespace-pre-wrap wrap-anywhere">{file.preview}</pre> : null}
        </section>)}
      </div>
    </Disclosure>
  </li>;
}

function SourceGroup({ group, query, headingLevel = 3 }: { group: SetupInventoryGroup | undefined; query: string; headingLevel?: 3 | 4 }) {
  const items = group?.items.filter(item => matches(item, query)) ?? [];
  const missing = query ? [] : items.filter(item => item.status === 'missing');
  const shown = query ? items : items.filter(item => item.status !== 'missing');
  return <div className="min-w-0 flex flex-col gap-2">
    <p className="hint wrap-anywhere">{group?.coverage ?? 'No coverage observation was returned for this category. Coverage is unknown.'}</p>
    {items.length ? <>
      <p className="hint">{items.length} source {items.length === 1 ? 'observation' : 'observations'}{missing.length ? ` · ${missing.length} missing` : ''}</p>
      {shown.length ? <ul className="list-none p-0">{shown.map(item => <SourceEvidence key={item.id} item={item} headingLevel={headingLevel} />)}</ul> : null}
      {missing.length ? <Disclosure label={`Show ${missing.length} missing sources`} expandedLabel={`Hide ${missing.length} missing sources`}>
        <ul className="list-none p-0">{missing.map(item => <SourceEvidence key={item.id} item={item} headingLevel={headingLevel} />)}</ul>
      </Disclosure> : null}
    </> : <p className="text-ui">{query && group?.items.length ? 'No sources match this search.' : group ? 'No source observations in this category. Read the coverage above for limits.' : 'No category observations returned.'}</p>}
  </div>;
}

export function SetupInventoryBrowser({ inventory }: { inventory: SetupInventory }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const searchId = useId(), categoryId = useId();
  return <section className="flex flex-col gap-4" aria-label="Setup source inventory">
    <InventoryCoverage inventory={inventory} />
    <InventoryFilters searchId={searchId} categoryId={categoryId} query={query} setQuery={setQuery} category={category} setCategory={setCategory} groups={inventory.groups} />
    {inventory.groups.filter(group => !category || group.id === category).map(group => <section className="panel min-w-0" key={group.id} aria-label={group.label}><h2 className="text-heading mb-2">{group.label}</h2><SourceGroup group={group} query={query.trim().toLowerCase()} /></section>)}
    {!inventory.groups.length ? <InfoNotice title="No source inventory returned"><p>Read the coverage and warnings above. An empty inventory does not establish an empty setup.</p></InfoNotice> : null}
  </section>;
}

function InventoryFilters({ searchId, categoryId, query, setQuery, category, setCategory, groups }: {
  searchId: string; categoryId: string; query: string; setQuery: (value: string) => void; category: string; setCategory: (value: string) => void; groups: Pick<SetupInventoryGroup, 'id' | 'label'>[];
}) {
  return <div className="flex flex-wrap items-end gap-4">
    <div className="flex-1 min-w-0 basis-[280px]"><label htmlFor={searchId} className="field-label">Find a source</label><input className="input" id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="flex-1 min-w-0 basis-[220px]"><label htmlFor={categoryId} className="field-label">Category</label><select className="input" id={categoryId} value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select></div>
  </div>;
}

export function SeparateSetupInventories({ a, b, aLabel, bLabel }: { a: SetupInventory; b: SetupInventory; aLabel: string; bLabel: string }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const searchId = useId(), categoryId = useId();
  const categories = [...a.groups, ...b.groups].filter((group, index, groups) => groups.findIndex(candidate => candidate.id === group.id) === index);
  return <section className="flex flex-col gap-5" aria-label="Separate setup inventories">
    <div className="grid min-[800px]:grid-cols-2 gap-6">{[{ label: aLabel, inventory: a }, { label: bLabel, inventory: b }].map((side, index) => <section key={index} className="min-w-0" aria-label={`${side.label} coverage`}><h2 className="text-body font-semibold wrap-anywhere mb-2">{side.label}</h2><InventoryCoverage inventory={side.inventory} /></section>)}</div>
    <InventoryFilters searchId={searchId} categoryId={categoryId} query={query} setQuery={setQuery} category={category} setCategory={setCategory} groups={categories} />
    {categories.filter(group => !category || group.id === category).map(group => <section className="panel min-w-0" key={group.id} aria-label={group.label}>
      <h2 className="text-heading mb-4">{group.label}</h2>
      <div className="grid min-[800px]:grid-cols-2 gap-6">{[{ label: aLabel, inventory: a }, { label: bLabel, inventory: b }].map((side, index) => <section key={index} className="min-w-0" aria-label={`${side.label} ${group.label}`}><h3 className="text-body font-semibold wrap-anywhere mb-2">{side.label}</h3><SourceGroup group={side.inventory.groups.find(candidate => candidate.id === group.id)} query={query.trim().toLowerCase()} headingLevel={4} /></section>)}</div>
    </section>)}
  </section>;
}
