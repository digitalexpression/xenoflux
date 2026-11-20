import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { apiGet } from '@/api/client';
import type { DiscoveryView, InstallationObservation, SetupObservation } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { Loading } from '@/components/layout';
import { ErrorPanel } from '@/components/notices';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { NativeApps } from '@/components/native-apps';

export function ProfileDiscovery() {
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
  const folders = data?.clients.map(client => ({ ...client, setups: client.setups.filter(item => item.kind !== 'found' || !item.inspectHref) }))
    .filter(client => client.setups.length) ?? [];
  return (
    <section className="discovery-section" aria-labelledby="profile-discovery-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="discovery-intro">
          <h2 id="profile-discovery-title" className="sr-only">Client discovery</h2>
          <div className="discovery-check-meta">
            <p role="status" className="hint">
              {previous ? view.loading ? 'Previous check, refreshing…' : 'Previous check, could not refresh.'
                : view.loading ? 'Looking for clients and folders…' : data ? 'Discovery check complete.' : 'Discovery could not complete.'}
            </p>
            {data ? <p className="hint">Checked {new Date(data.checkedAt).toLocaleString()}</p> : null}
          </div>
        </div>
        <Button disabled={view.loading} onClick={view.reload}>{view.loading ? 'Checking…' : 'Check again'}</Button>
      </div>
      {changes ? <p className="hint" role="status">{changes}</p> : null}
      {view.error ? <ErrorPanel title="Could not refresh discovery">{view.error.message} {data ? 'Previous findings are shown. ' : ''}Checks retry automatically, or use Check again.</ErrorPanel> : null}
      {view.loading && !data ? <Loading label="Inspecting known locations…" /> : null}
      {data ? <>
        <Disclosure label="Show checked locations" expandedLabel="Hide checked locations">
          <ul className="list-disc pl-5 hint">{data.scope.map(item => <li key={item} className="wrap-anywhere">{item}</li>)}</ul>
        </Disclosure>
        <section className="discovery-section" aria-labelledby="installations">
          <h3 id="installations" className="text-body font-semibold">Installed clients</h3>
          <p className="hint max-w-[72ch]">Discovery checks installation metadata and known folders. Use a profile’s CLI and Desktop rows for its current status.</p>
          {data.clients.map(client => <div key={client.client} className="discovery-installation-row">
            <h4 className="text-body font-semibold">{client.name}</h4>
            <Installation label={`${client.name} CLI`} observation={client.cli} />
            <Installation label={client.client === 'claude-code' ? 'Claude desktop app' : `${client.name} desktop app`} observation={client.desktop} note={client.desktopNote} />
          </div>)}
        </section>
        <NativeApps />
        {data.registry.kind === 'blocked' || folders.length || data.attention.length || data.limits.length ? <section className="discovery-section" aria-labelledby="discovery-folders">
          <h3 id="discovery-folders" className="text-body font-semibold">Folder and registry findings</h3>
          {data.registry.kind === 'blocked' ? <div className="notice" role="note"><strong>Registry needs attention.</strong> {data.registry.reason} Profile operations remain blocked until the registry passes validation. Original files are unchanged.</div> : null}
          {folders.map(client => <div key={client.client} className="discovery-setup-group">
            <h4 className="text-body font-semibold">{client.name}</h4>
            <div>{client.setups.map(item => <Setup key={item.key} item={item} />)}</div>
          </div>)}
          {data.attention.length ? <div className="flex flex-col gap-2"><h4 className="text-body font-semibold">Needs attention</h4>{data.attention.map(item => <Setup key={item.key} item={item} />)}</div> : null}
          {data.limits.length ? <div className="notice"><h4 className="font-semibold">Inspection limits</h4><ul className="list-disc pl-5">{data.limits.map(item => <li key={item} className="wrap-anywhere">{item}</li>)}</ul></div> : null}
        </section> : null}
      </> : null}
    </section>
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
  return <div className="discovery-setup-row">
    <div className="min-w-0"><p className="font-medium wrap-anywhere">{item.name}</p><p className="hint">{item.origin}</p>{item.inspectHref ? <Link to={item.inspectHref}>Inspect setup</Link> : null}</div>
    <p className="wrap-anywhere">{item.label}</p>
    <Disclosure label={`Show details for ${item.name}`} expandedLabel={`Hide details for ${item.name}`}>
      <div className="hint flex flex-col gap-1"><p className="wrap-anywhere">{item.reason}</p>{item.location ? <p className="wrap-anywhere">{item.location}</p> : null}</div>
    </Disclosure>
  </div>;
}
