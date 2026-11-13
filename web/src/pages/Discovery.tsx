import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { apiGet } from '@/api/client';
import type { DiscoveryView, InstallationObservation, SetupObservation } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { Loading, Page, PageTitle } from '@/components/layout';
import { ErrorPanel, SimulatedNote } from '@/components/notices';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';

export function Discovery() {
  const view = useResource(({ background }) => apiGet<DiscoveryView>(`/api/discovery${background ? '' : '?fresh=1'}`), 'discovery', { live: true });
  const data = view.data;
  const lastCheck = useRef<DiscoveryView | null>(null);
  const [changes, setChanges] = useState('');
  useEffect(() => {
    if (!data) return;
    const before = lastCheck.current;
    lastCheck.current = data;
    if (!before) return;
    const changed = data.clients.flatMap(client => {
      const old = before.clients.find(item => item.client === client.client);
      if (!old) return [`${client.name} findings changed.`];
      return (['cli', 'desktop'] as const).flatMap(surface => {
        if (JSON.stringify(old[surface]) === JSON.stringify(client[surface])) return [];
        return [`${client.name} ${surface === 'cli' ? 'CLI' : 'desktop app'} installation changed.`];
      });
    });
    const snapshot = ({ checkedAt: _checkedAt, ...findings }: DiscoveryView) => JSON.stringify(findings);
    if (snapshot(before) !== snapshot(data)) setChanges(changed.join(' ') || 'Existing setups and profile findings changed.');
  }, [data]);
  const previous = data && (view.loading || view.error);
  const canContinue = data?.registry.kind === 'readable' && !view.loading && !view.error;
  return (
    <Page current="setup" title="Find clients and profiles">
      <PageTitle title="Find clients and profiles" subtitle="Start with the clients and setups already on this Mac before creating another profile."
        actions={<Button disabled={view.loading} onClick={view.reload}>{view.loading ? 'Checking…' : 'Check again'}</Button>} />
      <p className="muted max-w-[72ch]">Checks installation metadata and known folders. Does not start clients, check sign-in or change profiles. Finding a client or folder does not mean it is ready to use.</p>
      <p className="hint">Checks automatically every 5 seconds while this page is active.</p>
      <div role="status" aria-live="polite" className="hint">
        {previous ? view.loading ? 'Previous check, refreshing…' : 'Previous check, could not refresh.'
          : view.loading ? 'Looking for clients and profiles…' : data ? 'Discovery check complete.' : 'Discovery could not complete.'}
      </div>
      {data ? <p className="hint">Checked {new Date(data.checkedAt).toLocaleString()}</p> : null}
      {changes ? <p className="hint" role="status">{changes}</p> : null}
      {view.error ? <ErrorPanel title="Could not refresh discovery">{view.error.message} {data ? 'Previous findings are shown. ' : ''}Checks retry automatically, or use Check again.</ErrorPanel> : null}
      {view.loading && !data ? <Loading label="Inspecting known locations…" /> : null}
      {data ? <>
        {data.simulated ? <SimulatedNote /> : null}
        <Disclosure label="Show checked locations" expandedLabel="Hide checked locations">
          <ul className="list-disc pl-5 hint">{data.scope.map(item => <li key={item} className="wrap-anywhere">{item}</li>)}</ul>
        </Disclosure>
        <section className="flex flex-col gap-5" aria-labelledby="installations">
          <h2 id="installations" className="text-heading">Installed clients</h2>
          <p className="hint max-w-[72ch]">Open clients with a selected profile from Profiles. Claude and GitHub Copilot Desktop support separate profile storage; Desktop sign-in and task execution remain unverified.</p>
          {data.clients.map(client => <div key={client.client} className="grid gap-3 min-[800px]:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1.4fr)] border-b pb-4" style={{ borderColor: 'var(--color-divider)' }}>
            <h3 className="text-body font-semibold">{client.name}</h3>
            <Installation label={`${client.name} CLI`} observation={client.cli} />
            <Installation label={client.client === 'claude-code' ? 'Claude desktop app' : `${client.name} desktop app`} observation={client.desktop} note={client.desktopNote} />
          </div>)}
        </section>
        <section className="flex flex-col gap-5" aria-labelledby="existing-setups">
          <h2 id="existing-setups" className="text-heading">Existing setups and profiles</h2>
          {data.registry.kind === 'blocked' ? <div className="notice" role="note"><strong>Registry needs attention.</strong> {data.registry.reason} Profile operations remain blocked until the registry passes validation. Original files are unchanged.</div> : null}
          {data.clients.map(client => <div key={client.client} className="flex flex-col gap-2">
            <h3 className="text-body font-semibold">{client.name}</h3>
            {client.setups.map(item => <Setup key={item.key} item={item} />)}
          </div>)}
          {data.attention.length ? <div className="flex flex-col gap-2"><h3 className="text-body font-semibold">Needs attention</h3>{data.attention.map(item => <Setup key={item.key} item={item} />)}</div> : null}
          {data.limits.length ? <div className="notice"><h3 className="font-semibold">Inspection limits</h3><ul className="list-disc pl-5">{data.limits.map(item => <li key={item} className="wrap-anywhere">{item}</li>)}</ul></div> : null}
        </section>
      </> : null}
      <section className="flex flex-col gap-3" aria-labelledby="next-step">
        <h2 id="next-step" className="text-heading">Choose what to do next</h2>
        <p className="muted max-w-[72ch]">Continue to use an existing profile, create a separate one, or copy selected settings.</p>
        <div className="flex flex-wrap gap-3">
          {canContinue ? <Link className="btn btn-primary" to="/profiles">Continue to profiles</Link> : <Button disabled>Continue to profiles</Button>}
          <Link className="btn" to="/">Continue to comparisons</Link>
        </div>
        {!canContinue ? <p className="hint">Complete a successful check with a readable registry before continuing to profile operations.</p> : null}
      </section>
    </Page>
  );
}

function Installation({ label, observation, note }: { label: string; observation: InstallationObservation; note?: string }) {
  return <div className="flex flex-col gap-1 min-w-0">
    <span className="hint font-medium wrap-anywhere">{label}</span>
    <div className="min-w-0"><p>{observation.label}</p>
      {observation.kind === 'found' ? <Disclosure label={`Show ${label} details`} expandedLabel={`Hide ${label} details`}>
        <p className="hint wrap-anywhere">{observation.location}</p><p className="hint">Version {observation.version ?? 'not checked'}</p>{note ? <p className="hint">{note}</p> : null}
      </Disclosure> : <p className="hint wrap-anywhere">{observation.reason}</p>}
    </div>
  </div>;
}
function Setup({ item }: { item: SetupObservation }) {
  return <div className="border-b py-2 grid items-start gap-x-4 gap-y-1 min-w-0 min-[800px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]" style={{ borderColor: 'var(--color-divider)' }}>
    <div className="min-w-0"><p className="font-medium wrap-anywhere">{item.name}</p><p className="hint">{item.origin}</p>{item.inspectHref ? <Link to={item.inspectHref}>Inspect setup</Link> : null}</div>
    <p className="wrap-anywhere">{item.label}</p>
    <Disclosure label={`Show details for ${item.name}`} expandedLabel={`Hide details for ${item.name}`}>
      <div className="hint flex flex-col gap-1"><p className="wrap-anywhere">{item.reason}</p>{item.location ? <p className="wrap-anywhere">{item.location}</p> : null}</div>
    </Disclosure>
  </div>;
}
