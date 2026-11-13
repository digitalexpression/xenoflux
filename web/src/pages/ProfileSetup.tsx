import { useId, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { apiGet } from '@/api/client';
import type { SetupInspection, SetupOptions } from '@/api/types';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { InfoNotice, SimulatedNote, WarningAlert } from '@/components/notices';
import { SetupInventoryBrowser, setupChoiceKey, setupChoices, setupInspectHref, setupLabel, setupParams, setupSelection, type SetupSelection } from '@/components/setup-inventory';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';

export function ProfileSetup() {
  const { name = '' } = useParams();
  const [params] = useSearchParams();
  const selection = setupSelection(name, params.get('client'));
  const repo = params.get('repo') ?? '';
  if (!selection) return <Page current="profiles" title="Inspect setup"><PageTitle title="Inspect setup" /><WarningAlert title="Choose a supported client"><Link to="/profiles">Open Profiles</Link></WarningAlert></Page>;
  return <Inspection key={JSON.stringify([selection, repo])} selection={selection} repo={repo} />;
}

function Inspection({ selection, repo }: { selection: SetupSelection; repo: string }) {
  const navigate = useNavigate();
  const info = useInfo();
  const options = useResource(() => apiGet<SetupOptions>('/api/setups/options'), 'setup-options', { live: true });
  const inspection = useResource(() => apiGet<SetupInspection>(`/api/profiles/${encodeURIComponent(selection.name)}/setup`, { client: selection.client, ...(repo ? { repo } : {}), fresh: '1' }), JSON.stringify([selection, repo]));
  const [draft, setDraft] = useState(selection);
  const [repository, setRepository] = useState(repo);
  const profileId = useId(), repoId = useId();
  const choices = setupChoices(options.data?.choices ?? [], [selection, draft]);
  const current = choices.find(choice => choice.key === setupChoiceKey(choices, draft));
  const data = inspection.data;
  return <Page current="profiles" title={`Inspect ${selection.name} setup`}>
    <PageTitle breadcrumb={[{ label: 'Profiles', to: '/profiles' }, { label: 'Inspect setup' }]} title={`Inspect setup · ${setupLabel(selection)}`}
      subtitle="Read current local source settings, instructions, skills and integrations before choosing another setup to compare." />
    {info?.mode === 'demo' ? <SimulatedNote /> : null}
    <form className="panel flex flex-col gap-4" onSubmit={event => { event.preventDefault(); if (current?.available) navigate(setupInspectHref(draft, repository.trim())); }}>
      <div className="flex flex-wrap gap-4">
        <div className="flex-1 min-w-0 basis-[240px]"><label className="field-label" htmlFor={profileId}>Profile and client</label>
          <select id={profileId} className="input" value={setupChoiceKey(choices, draft)} onChange={event => { const choice = choices.find(candidate => candidate.key === event.target.value); if (choice) setDraft(choice); }}>
            {choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}{!choice.available ? ' · unavailable' : ''}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-0 basis-[300px]"><label className="field-label" htmlFor={repoId}>Repository scope (optional)</label>
          <input id={repoId} className="input font-mono" value={repository} onChange={event => setRepository(event.target.value)} placeholder="/absolute/path/to/repository" aria-describedby={`${repoId}-hint`} />
          <p id={`${repoId}-hint`} className="hint">Include supported project sources from this local repository.</p>
        </div>
      </div>
      {current && !current.available ? <p className="text-ui">{current.reason}</p> : null}
      {options.data?.warnings.map((warning, index) => <p className="text-ui" key={index}>{warning}</p>)}
      {options.error ? <LoadError error={options.error} onRetry={options.reload} /> : null}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!current?.available || options.loading || Boolean(options.error)}>Inspect setup</Button><Button onClick={inspection.reload} busy={inspection.loading} busyLabel="Reading setup…">Refresh setup</Button></div>
    </form>
    <div className="flex flex-wrap items-center gap-3 text-ui wrap-anywhere">
      <p><strong>{setupLabel(selection)}</strong></p>
      <p>{data?.project || repo ? <>Repository <span className="font-mono">{data?.project ?? repo}</span></> : 'Profile scope · no repository selected'}</p>
      {data ? <p>Read {data.readAt}</p> : null}
      <Link className="btn ml-auto" to={`/compare/setups?${new URLSearchParams(setupParams(selection, undefined, repo))}`}>Compare with…</Link>
    </div>
    <InfoNotice title="Current source evidence"><p>This read shows bounded local sources. Effective precedence, native loading and use in a session are unknown. This is not a historical setup snapshot.</p><p>Refresh setup reads the sources again. File content stays in place while you inspect it.</p></InfoNotice>
    {inspection.error ? <>{data ? <p className="hint">Previous read shown. Refresh failed; these observations have not been updated.</p> : null}<LoadError error={inspection.error} onRetry={inspection.reload} /></> : null}
    {inspection.loading && !data ? <Loading label="Reading setup sources…" /> : null}
    {data ? <SetupInventoryBrowser inventory={data.inventory} /> : null}
  </Page>;
}
