import { useEffect, useId, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { Link } from 'react-router';
import { apiGet, apiPost } from '@/api/client';
import type { ClientActionResult, SessionsView, StatusKind } from '@/api/types';
import { InspectSessionButton } from '@/components/inspect-session-button';
import { Disclosure, SegmentedControl } from '@/components/controls';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { InfoNotice, SimulatedNote } from '@/components/notices';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { cn } from '@/lib/cn';
import { toggleTray, trayFull, traySide, useTray } from '@/lib/tray';

type Client = '' | 'cli' | 'desktop';

/** The library of recorded sessions: find one, inspect it, or put two in the comparison tray. */
export function BrowseSessions() {
  const info = useInfo();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [profile, setProfile] = useState('');
  const [client, setClient] = useState<Client>('');
  const tray = useTray();
  const full = trayFull(tray);
  const [message, setMessage] = useState<{ status: StatusKind; text: string } | null>(null);
  const searchId = useId(), profileId = useId();
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(query), 250); return () => window.clearTimeout(timer); }, [query]);
  const view = useResource(() => apiGet<SessionsView>('/api/sessions', { query: debounced, profile, client }), JSON.stringify([debounced, profile, client]));
  const rows = view.data?.sessions ?? [];
  const filtered = Boolean(debounced || profile || client);

  async function resume(key: string, profileName: string, client: string) {
    try {
      const result = await apiPost<ClientActionResult>(`/api/profiles/${encodeURIComponent(profileName)}/clients`, { action: client === 'desktop' ? 'focus-desktop' : 'resume', session: key });
      setMessage({ status: result.status, text: result.message });
    } catch (error) { setMessage({ status: 'error', text: (error as Error).message }); }
  }

  return (
    <Page current="sessions" title="Sessions">
      <PageTitle title="Sessions" subtitle="Recorded work from your profiles. Inspect one session, or add two to a comparison."
        actions={<Link className="btn" to="/sessions/native">Choose a session by profile</Link>} />
      {info?.mode === 'demo' ? <SimulatedNote /> : null}
      {message ? <div role="status" className={message.status === 'error' ? 'alert-error' : message.status === 'success' ? 'alert-success' : 'notice'}>{message.text}</div> : null}
      {view.data?.partial ? (
        <InfoNotice title="Partly listed"><p>{view.data.partial.text}</p>
          <Disclosure label="How to allow access" expandedLabel="Hide how to allow access"><p>{view.data.partial.help}</p></Disclosure></InfoNotice>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[220px]">
          <label htmlFor={searchId} className="field-label">Search title or project</label>
          <input id={searchId} type="search" className="input" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="min-w-[180px]">
          <label htmlFor={profileId} className="field-label">Profile</label>
          <select id={profileId} className="input" value={profile} onChange={event => setProfile(event.target.value)}>
            <option value="">All profiles</option>
            {view.data?.profiles.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <div>
          <span className="field-label">Codex surface</span>
          <SegmentedControl label="Client" value={client} onChange={setClient} options={[{ value: '', label: 'All' }, { value: 'cli', label: 'CLI' }, { value: 'desktop', label: 'Desktop' }]} />
        </div>
      </div>
      {view.error ? <LoadError error={view.error} onRetry={view.reload} /> : null}
      {view.loading && !view.data ? <Loading label="Reading sessions…" /> : null}
      {view.data ? (
        <section className="panel p-0 overflow-hidden" aria-labelledby="session-count">
          <div className="panel-head flex flex-wrap justify-between gap-2" style={{ borderRadius: 0 }}>
            <h2 id="session-count" className="text-ui font-semibold" role="status">
              {rows.length} {rows.length === 1 ? 'session' : 'sessions'}{view.data.truncated ? ' (more are available; narrow the search)' : ''}
            </h2>
            {full ? <span id="tray-full" className="text-ui">Two sessions are in the comparison. Remove one to add another.</span> : null}
          </div>
          {rows.length ? (
            <ul className="list-none p-0" aria-label="Sessions">
              {rows.map(row => {
                const side = traySide(tray, row.key);
                const who = `${row.title} (${row.profile})`;
                return (
                  <li key={row.key} className="session-row" data-side={side ?? undefined}>
                    <div className="session-row-main">
                      <span className="font-medium wrap-anywhere">{row.title}</span>
                      <span className="meta wrap-anywhere">{row.project} · {row.recordedAt} · {row.turns}</span>
                    </div>
                    <div className="session-row-profile">
                      <span className={cn('text-ui font-medium wrap-anywhere', side === 'a' && 'side-a', side === 'b' && 'side-b')}>{row.profile}</span>
                      <span className="meta">{row.clientText}</span>
                    </div>
                    <span className={cn('badge', row.history === 'complete' ? 'badge-same' : 'badge-cannot')}>{row.historyText}</span>
                    <div className="session-row-actions">
                      <InspectSessionButton selection={{ key: row.key }} label="Inspect" ariaLabel={`Inspect ${row.title}`} />
                      <Button aria-pressed={Boolean(side)} disabled={full && !side} aria-describedby={full && !side ? 'tray-full' : undefined}
                        aria-label={side ? `Remove ${who} from the comparison` : `Add ${who} to the comparison`} onClick={() => toggleTray(row)}>
                        {side ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
                        {side === 'a' ? 'Left' : side === 'b' ? 'Right' : 'Compare'}
                      </Button>
                      {row.startedHere ? <Link className="btn" to={row.startedHere.reportHref}>Open its report</Link>
                        : info?.features.clientControls ? (
                          <Button onClick={() => void resume(row.key, row.profile, row.client)}>{row.client === 'desktop' ? 'Show in Codex Desktop' : 'Resume in Codex…'}</Button>
                        ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : filtered ? (
            <div className="p-4 flex flex-col gap-2 items-start"><p>No sessions match.</p><Button onClick={() => { setQuery(''); setProfile(''); setClient(''); }}>Clear filters</Button></div>
          ) : (
            <div className="p-4 flex flex-col gap-2 items-start">
              <h3 className="text-body font-semibold">No sessions found yet</h3>
              <p className="muted">Work in Codex CLI or Desktop as usual, then come back.{info?.features.runs ? ' Or run a task here with two profiles.' : ''}</p>
              {info?.features.runs ? <Link className="btn" to="/runs/new">Run a new task</Link> : null}
            </div>
          )}
        </section>
      ) : null}
      <p className="hint">Resume reopens a session in its own profile and client. Browsing and comparing never resume or start anything.</p>
    </Page>
  );
}
