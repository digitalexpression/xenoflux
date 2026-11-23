import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeftRight, CircleHelp, Columns2, Equal, GitCompareArrows } from 'lucide-react';
import type { ExecutionSelection, NativeClientId, RunProfileOption, RunRequest, Side } from '@/api/types';
import { useExecutionCatalog, useExecutionControls } from '@/components/ExecutionFields';
import { SideText } from '@/components/profile';
import { Button } from '@/components/ui/button';

export const runProfileKey = (profile: Pick<RunProfileOption, 'client' | 'name'>) => profile.client ? `${profile.client}:${profile.name}` : profile.name;
const AUTO_LOAD_MODELS = 'xenoflux-run-auto-load-models';

const fields = [
  { id: 'profile', label: 'Profile' },
  { id: 'model', label: 'Model' },
  { id: 'reasoningEffort', label: 'Reasoning effort' },
  { id: 'permissionMode', label: 'Permission mode' },
  { id: 'route', label: 'Auto route' },
] as const;
type Field = typeof fields[number]['id'];
type Setup = { name: string; client?: NativeClientId; execution: ExecutionSelection };
type Pair = Record<Side, Setup>;
const differences = {
  same: { label: 'Same', Icon: Equal },
  different: { label: 'Different', Icon: GitCompareArrows },
  unknown: { label: 'Unknown', Icon: CircleHelp },
};
type Difference = keyof typeof differences;

const clientOf = (setup: Setup) => setup.client ?? 'codex';
const valueOf = (setup: Setup, field: Field) => field === 'profile' ? setup.name : setup.execution[field];

function changeFor(setups: Pair, field: Field): Difference {
  const left = valueOf(setups.a, field), right = valueOf(setups.b, field);
  const sameClient = clientOf(setups.a) === clientOf(setups.b);
  if (!left || !right) return 'unknown';
  if (field === 'profile') return sameClient && left === right ? 'same' : 'different';
  if (!sameClient && (field !== 'model' || left === right)) return 'unknown';
  if (field === 'model' && (left === 'auto' || right === 'auto') && left === right) return 'unknown';
  return left === right ? 'same' : 'different';
}

function pairedFields(setups: Pair) {
  const auto = setups.a.execution.model === 'auto' || setups.b.execution.model === 'auto';
  return fields.filter(field => field.id !== 'route' || auto);
}

export function runSetupDifferenceCount(setups: Pair) {
  return pairedFields(setups).filter(field => changeFor(setups, field.id) === 'different').length;
}

function SetupGrid({ children }: { children: ReactNode }) {
  return <div role="table" aria-label="Left and Right setup settings" className="run-paired-grid">
    <div className="run-paired-row run-paired-heading" role="row">
      <span role="columnheader">Field</span>
      <div role="columnheader" data-side="a"><SideText side="a">Left</SideText> <span className="meta">· Runs first</span></div>
      <div role="columnheader" data-side="b"><SideText side="b">Right</SideText> <span className="meta">· Runs second</span></div>
      <span role="columnheader">Change</span>
    </div>
    {children}
  </div>;
}

function SetupRow({ label, a, b, change }: { label: string; a: ReactNode; b: ReactNode; change?: Difference }) {
  const result = change ? differences[change] : null;
  return <div className="run-paired-row" role="row">
    <div role="rowheader" className="run-paired-label text-ui font-medium">{label}</div>
    <div role="cell" className="run-paired-cell"><span className="run-paired-narrow meta side-a font-semibold" aria-hidden="true">Left</span>{a}</div>
    <div role="cell" className="run-paired-cell"><span className="run-paired-narrow meta side-b font-semibold" aria-hidden="true">Right</span>{b}</div>
    <div role="cell" className="run-paired-result" data-change={change}>
      {result ? <span className="flex items-center gap-1"><result.Icon size={14} aria-hidden="true" /> {result.label}</span> : null}
    </div>
  </div>;
}

export type RunBindingResult = { bound: string[]; failed: { profile: string; message: string }[]; optionsReloaded: boolean };
type BindProfiles = (repository: string, targets: RunProfileOption[]) => Promise<RunBindingResult>;

function BindRunProfiles({ repository, targets, busy, onBind }: {
  repository: string; targets: RunProfileOption[]; busy: boolean; onBind: BindProfiles;
}) {
  const details = useId();
  const [checkedTargets, setCheckedTargets] = useState<string | null>(null);
  const [result, setResult] = useState<RunBindingResult | null>(null);
  const pending = targets.filter(profile => !result?.bound.includes(profile.name));
  const targetKey = JSON.stringify(pending.map(profile => profile.name));
  const checked = checkedTargets === targetKey;
  if (!pending.length && !result) return null;

  async function bind() {
    if (!checked || busy || !pending.length) return;
    const next = await onBind(repository, pending);
    setResult({ ...next, bound: [...(result?.bound ?? []), ...next.bound] });
  }

  return <div className="run-paired-note flex flex-col gap-2">
    {pending.length ? <>
      <p id={details} className="text-ui wrap-anywhere">Add <code>{repository}</code> to {pending.map(profile => profile.label ?? profile.name).join(', ')}.</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-ui">
          <input type="checkbox" checked={checked} disabled={busy} aria-describedby={details}
            onChange={event => setCheckedTargets(event.target.checked ? targetKey : null)} />
          Bind selected profiles to this repository
        </label>
        <Button disabled={!checked} busy={busy} busyLabel="Binding profiles…" onClick={() => void bind()}>
          {result?.failed.length ? 'Retry binding' : 'Bind profiles'}
        </Button>
      </div>
    </> : null}
    {result ? <div role="status" className="flex flex-col gap-1 text-ui wrap-anywhere">
      {result.bound.length ? <p>Bound {result.bound.join(', ')} to <code>{repository}</code>.</p> : null}
      {result.failed.map(({ profile, message }) => <p key={profile}>Could not bind {profile}. {message}</p>)}
      {result.bound.length && !result.optionsReloaded ? <p>Project options could not be reloaded.</p> : null}
    </div> : null}
  </div>;
}

export function RunSetupPair({ setups, selected, profiles, workspace, workspaceEditing, simulated, noSharedRepository, repositorySuggestion,
  binding, catalogRevisions, onBind, onRepositoryChange, onOpenProfiles, onProfileChange, onExecutionChange, onSwap }: {
  setups: Pair; selected: Record<Side, string>; profiles: RunProfileOption[]; workspace: string; workspaceEditing: boolean; simulated?: boolean;
  binding: boolean; catalogRevisions: Record<string, number>; onBind: BindProfiles;
  noSharedRepository: boolean; repositorySuggestion?: string; onRepositoryChange: (path: string) => void; onOpenProfiles: () => void;
  onProfileChange: (side: Side, key: string) => void; onExecutionChange: (side: Side, value: ExecutionSelection) => void;
  onSwap: () => void;
}) {
  const aId = useId(), bId = useId(), autoLoadHint = useId();
  const [autoLoadModels, setAutoLoadModels] = useState(() => {
    try { return sessionStorage.getItem(AUTO_LOAD_MODELS) !== 'false'; } catch { return true; }
  });
  const chosen = {
    a: profiles.find(option => runProfileKey(option) === selected.a),
    b: profiles.find(option => runProfileKey(option) === selected.b),
  };
  const shared = Boolean(selected.a && selected.a === selected.b);
  const repository = workspace.trim();
  const hasWorkspace = Boolean(repository);
  const autoLoad = autoLoadModels && !simulated && !workspaceEditing && hasWorkspace && !binding;
  const leftName = hasWorkspace ? setups.a.name : '';
  const rightName = hasWorkspace ? setups.b.name : '';
  const left = useExecutionCatalog({ profile: leftName, client: setups.a.client, workspace: repository, autoLoad, revision: catalogRevisions[selected.a] });
  const right = useExecutionCatalog({ profile: shared ? '' : rightName, client: setups.b.client, workspace: repository, autoLoad, revision: catalogRevisions[selected.b] });
  const catalogFor = (side: Side) => {
    const catalog = side === 'a' || shared ? left : right;
    if (hasWorkspace || !selected[side]) return catalog;
    return { ...catalog, message: 'Choose a repository to load models.' };
  };
  const a = useExecutionControls({ profile: leftName, client: setups.a.client, value: setups.a.execution, catalog: catalogFor('a'),
    side: 'Left', onChange: value => onExecutionChange('a', value) });
  const b = useExecutionControls({ profile: rightName, client: setups.b.client, value: setups.b.execution, catalog: catalogFor('b'),
    shared, side: 'Right', onChange: value => onExecutionChange('b', value) });
  const needsBinding = [chosen.a, chosen.b].some(profile => profile?.boundRepositories?.length === 0);
  const repositoryUnbound = [left, right].some(catalog => catalog.errorCode === 'profile-repository-unbound');
  const bindingTargets = new Map<string, RunProfileOption>();
  if (!simulated && !workspaceEditing && repository.startsWith('/')) {
    for (const side of ['a', 'b'] as const) {
      const profile = chosen[side];
      const catalog = catalogFor(side);
      if (profile?.boundRepositories && (catalog.errorCode === 'profile-repository-unbound' || profile.boundRepositories.length === 0))
        bindingTargets.set(profile.name, profile);
    }
  }
  const profileSelect = (side: Side, id: string) => {
    const profile = chosen[side];
    const detail = [profile?.surface?.toUpperCase(), profile?.rootMode ? `${profile.rootMode} root` : null, profile?.executionLocation, profile?.readiness].filter(Boolean).join(' · ');
    const unbound = profile?.boundRepositories?.length === 0;
    return <div className="min-w-0">
      <label htmlFor={id} className="sr-only">{side === 'a' ? 'First · left side of the report' : 'Second · right side of the report'}</label>
      <select id={id} className="input" value={selected[side]} disabled={binding} aria-describedby={unbound ? `${id}-binding` : detail ? `${id}-details` : undefined} onChange={event => onProfileChange(side, event.target.value)}>
        <option value="">Choose a profile</option>
        {profiles.map(option => <option key={runProfileKey(option)} value={runProfileKey(option)}>{option.label ?? option.name}</option>)}
      </select>
      {unbound ? <p id={`${id}-binding`} className="meta mt-1">No project bindings.</p>
        : detail ? profile?.ready ? <p id={`${id}-details`} className="sr-only">{detail}</p>
        : <p id={`${id}-details`} className="meta mt-1 wrap-anywhere">{detail}</p> : null}
    </div>;
  };
  const values: Record<Field, Record<Side, ReactNode>> = {
    profile: { a: profileSelect('a', aId), b: profileSelect('b', bId) },
    model: { a: a.model, b: b.model }, reasoningEffort: { a: a.effort, b: b.effort },
    permissionMode: { a: a.permission, b: b.permission }, route: { a: a.route ?? '—', b: b.route ?? '—' },
  };
  return <section className="panel p-0" aria-labelledby="profiles-heading">
    <div className="panel-head run-paired-panel-head">
      <h2 id="profiles-heading" tabIndex={-1} className="run-paired-title"><Columns2 size={16} aria-hidden="true" /> Two setups</h2>
      <Button variant="ghost-link" aria-label="Swap the two sides" disabled={binding} onClick={onSwap}><ArrowLeftRight size={16} aria-hidden="true" /> Swap sides</Button>
    </div>
    <SetupGrid>
      {pairedFields(setups).map(({ id, label }) => <SetupRow key={id} label={label} a={values[id].a} b={values[id].b} change={changeFor(setups, id)} />)}
      <SetupRow label="Model catalogs" a={a.catalogControls} b={b.catalogControls} />
    </SetupGrid>
    <BindRunProfiles key={JSON.stringify([repository, selected.a, selected.b])} repository={repository}
      targets={[...bindingTargets.values()]} busy={binding} onBind={onBind} />
    {repositorySuggestion || noSharedRepository || needsBinding || repositoryUnbound ? <div className="run-paired-note flex flex-wrap items-center gap-x-3 gap-y-1">
      {repositorySuggestion ? <>
        <Button variant="ghost-link" disabled={binding} onClick={() => onRepositoryChange(repositorySuggestion)}>Use shared repository</Button>
        <code className="meta wrap-anywhere">{repositorySuggestion}</code>
      </> : null}
      {noSharedRepository ? <p className="meta">The selected profiles need a shared project binding.</p> : null}
      {!binding && (noSharedRepository || needsBinding || repositoryUnbound) ? <Link className="btn btn-link" to="/profiles" onClick={onOpenProfiles}>Manage project bindings in Profiles</Link> : null}
    </div> : null}
    {!simulated ? <div className="run-paired-note flex flex-col gap-1">
      <label className="flex items-center gap-2 text-ui w-fit">
        <input type="checkbox" checked={autoLoadModels} aria-describedby={autoLoadHint} onChange={event => {
          const enabled = event.target.checked;
          setAutoLoadModels(enabled);
          if (!enabled) { left.cancelAutomatic(); right.cancelAutomatic(); }
          try { sessionStorage.setItem(AUTO_LOAD_MODELS, String(enabled)); } catch { /* Applies to this form when storage is disabled. */ }
        }} />
        Load models automatically in this tab
      </label>
      <p id={autoLoadHint} className="meta">Discovery starts the selected clients without sending a task. It may use sign-in, write native state, or run startup hooks.</p>
    </div> : null}
  </section>;
}

export function RunSetupDifferences({ request, profiles }: { request: RunRequest; profiles: Record<Side, string> }) {
  const [hideMatches, setHideMatches] = useState(false);
  const setup = (side: Side): Setup => ({ name: request[side], client: request.clients?.[side], execution: request.execution?.[side] ?? { reasoningEffort: request.advanced?.reasoningEffort } });
  const setups = { a: setup('a'), b: setup('b') };
  const shown = pairedFields(setups).filter(field => !hideMatches || changeFor(setups, field.id) !== 'same');
  function cell(side: Side, id: Field) {
    const current = setups[side];
    const fallback = id === 'route' ? (current.execution.model === 'auto' ? 'Default route' : '—')
      : id === 'permissionMode' && clientOf(current) === 'codex' ? 'Default permissions' : 'Profile default';
    return <span className="text-ui wrap-anywhere">{id === 'profile' ? profiles[side] : valueOf(current, id) ?? fallback}</span>;
  }
  return <section className="panel p-0" aria-labelledby="run-setup-differences">
    <div className="panel-head run-paired-panel-head">
      <h2 id="run-setup-differences" className="run-paired-title"><GitCompareArrows size={16} aria-hidden="true" /> Setup differences</h2>
      <label className="flex items-center gap-2 text-ui"><input type="checkbox" checked={hideMatches} onChange={event => setHideMatches(event.target.checked)} /> Hide matches</label>
    </div>
    <SetupGrid>{shown.map(({ id, label }) => <SetupRow key={id} label={label} a={cell('a', id)} b={cell('b', id)} change={changeFor(setups, id)} />)}</SetupGrid>
    {!shown.length ? <p className="hint px-3 py-2">The listed settings match.</p> : null}
    <p className="meta run-paired-note">Requested settings. Profile defaults and client-specific controls may be unresolved until launch.</p>
  </section>;
}
