import { useId, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeftRight, FolderOpen, RefreshCw, Users } from 'lucide-react';
import { apiGet } from '@/api/client';
import type { SetupInspection, SetupOptions } from '@/api/types';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { SimulatedNote, WarningAlert } from '@/components/notices';
import { SetupReadingCoverage } from '@/components/setup-comparison-layout';
import { SetupInventoryBrowser } from '@/components/setup-inspection';
import { InventoryCoverage, setupChoiceKey, setupChoices, setupClientLabels, setupInspectHref, setupParams, setupSelection, type SetupSelection } from '@/components/setup-inventory';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
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
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState(selection);
  const [repository, setRepository] = useState(repo);
  const profileId = useId(), repoId = useId();
  const choices = setupChoices(options.data?.choices ?? [], [selection, draft]);
  const current = choices.find(choice => choice.key === setupChoiceKey(choices, draft));
  const data = inspection.data;
  const actions = <div className="setup-compare-toolbar" role="group" aria-label="Inspection toolbar">
    {data ? <SetupReadingCoverage partial={data.inventory.status !== 'complete'}>
      <h2 className="text-ui font-semibold">Current source evidence</h2>
      <p className="hint">Read <time dateTime={data.readAt}>{data.readAt}</time></p>
      <p className="text-ui">Current local sources. Effective precedence, native loading and use in a session are unknown.</p>
      <InventoryCoverage inventory={data.inventory} />
    </SetupReadingCoverage> : null}
    <Button onClick={() => { setDraft(selection); setRepository(repo); setChanging(true); }}><Users size={16} aria-hidden="true" /> Change setup…</Button>
    <Button onClick={inspection.reload} busy={inspection.loading} busyLabel="Reading setup…"><RefreshCw size={16} aria-hidden="true" /> Refresh setup</Button>
    <Link className="btn" to={`/compare/setups?${new URLSearchParams(setupParams(selection, undefined, repo))}`}><ArrowLeftRight size={16} aria-hidden="true" /> Compare with…</Link>
  </div>;

  return <Page current="profiles" title={`Inspect ${selection.name} setup`} workspace toolbarActions={actions}>
    <PageTitle breadcrumb={[{ label: 'Profiles', to: '/profiles' }, { label: 'Inspect setup' }]}
      title={<><span className="sr-only">Inspect setup · </span>{selection.name}</>} titleClassName="text-heading!" />
    <p className="hint flex flex-wrap items-center gap-x-2 gap-y-1 wrap-anywhere">
      <span>{setupClientLabels[selection.client]}</span>
      <span className="inline-flex items-start gap-1 min-w-0"><FolderOpen size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
        {data?.project || repo ? <span>Repository <span className="font-mono">{data?.project ?? repo}</span></span> : 'Profile scope'}
      </span>
    </p>
    {info?.mode === 'demo' ? <SimulatedNote /> : null}
    {inspection.error ? <>{data ? <p className="hint">Previous read shown. Refresh failed; these observations have not been updated.</p> : null}<LoadError error={inspection.error} onRetry={inspection.reload} /></> : null}
    {inspection.loading && !data ? <Loading label="Reading setup sources…" /> : null}
    {data ? <SetupInventoryBrowser inventory={data.inventory} /> : null}
    <Dialog open={changing} onOpenChange={setChanging}>
      {changing ? <DialogContent title="Change setup">
        <form className="flex flex-col gap-4" onSubmit={event => {
          event.preventDefault();
          if (!current?.available || options.loading || options.error) return;
          setChanging(false);
          navigate(setupInspectHref(draft, repository.trim()));
        }}>
          <div><label className="field-label" htmlFor={profileId}>Profile and client</label>
            <select id={profileId} className="input" value={setupChoiceKey(choices, draft)} onChange={event => { const choice = choices.find(candidate => candidate.key === event.target.value); if (choice) setDraft(choice); }}>
              {choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}{!choice.available ? ' · unavailable' : ''}</option>)}
            </select>
          </div>
          <div><label className="field-label" htmlFor={repoId}>Repository scope (optional)</label>
            <input id={repoId} className="input font-mono" value={repository} onChange={event => setRepository(event.target.value)} placeholder="/absolute/path/to/repository" aria-describedby={`${repoId}-hint`} />
            <p id={`${repoId}-hint`} className="hint">Include supported project sources from this local repository.</p>
          </div>
          {current && !current.available ? <p className="text-ui">{current.reason}</p> : null}
          {options.data?.warnings.map((warning, index) => <p className="text-ui" key={index}>{warning}</p>)}
          {options.error ? <LoadError error={options.error} onRetry={options.reload} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={!current?.available || options.loading || Boolean(options.error)}>Inspect setup</Button>
            <DialogClose asChild><Button>Cancel</Button></DialogClose>
          </div>
        </form>
      </DialogContent> : null}
    </Dialog>
  </Page>;
}
