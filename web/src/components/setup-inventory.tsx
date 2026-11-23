import type { ProfileClient, SetupChoice, SetupInventory, SetupSourceItem } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { cn } from '@/lib/cn';

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

export function SourceDetails({ item, view = 'all' }: { item: SetupSourceItem; view?: 'all' | 'details' | 'files' }) {
  const skillEntry = view === 'files' ? item.files.find(file => file.path === 'SKILL.md') : undefined;
  const files = skillEntry ? [skillEntry, ...item.files.filter(file => file !== skillEntry)] : item.files;
  return <div className="setup-source flex flex-col gap-3 min-w-0">
    {view !== 'files' ? <>
      <p className="text-ui font-medium">{item.value === null && item.files.length ? 'Source files' : 'Value'} · {item.valueStatus}</p>
      {item.value !== null ? <pre className="text-ui font-mono whitespace-pre-wrap wrap-anywhere">{item.value}</pre> : !item.files.length ? <p className="hint">No value was returned by this read.</p> : null}
      {item.note ? <p className="text-ui">{item.note}</p> : null}
      {item.sources.length ? <dl className="flex flex-col gap-2 text-ui">{item.sources.map((source, index) => <div key={index}><dt className="font-medium">{source.scope} · {source.status}</dt><dd className="font-mono muted wrap-anywhere">{source.where}</dd></div>)}</dl> : null}
      {item.facts.length ? <dl className="flex flex-col gap-2 text-ui">{item.facts.map((fact, index) => <div key={index}><dt className="font-medium">{fact.label}</dt><dd className="muted whitespace-pre-wrap wrap-anywhere">{fact.value}</dd></div>)}</dl> : null}
    </> : null}
    {view !== 'details' ? files.map((file, index) => <section className={cn('flex flex-col gap-2 min-w-0', (view === 'all' || index > 0) && 'border-t pt-3')} style={{ borderColor: 'var(--color-divider)' }} key={`${file.path}-${index}`} aria-label={`Source file ${file.path}`}>
      <div className={cn('flex gap-2', view === 'files' ? 'flex-wrap items-baseline' : 'flex-col')}>
        <p className="font-mono text-ui wrap-anywhere min-w-0">{file.path}</p><p className="hint">{file.status}</p>
      </div>
      {file.note ? <p className="text-ui">{file.note}</p> : null}
      {file.preview !== null ? <pre className="text-ui font-mono whitespace-pre-wrap wrap-anywhere">{file.preview}</pre> : null}
    </section>) : null}
  </div>;
}
