import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { apiGet, apiPost } from '@/api/client';
import type { ClientActionResult, SessionsView, StatusKind } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { InfoNotice, SimulatedNote } from '@/components/notices';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { cn } from '@/lib/cn';

/** Finding and resuming work, separate from comparison. */
export function BrowseSessions() {
  const info = useInfo();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [profile, setProfile] = useState('');
  const [message, setMessage] = useState<{ status: StatusKind; text: string } | null>(null);
  const searchId = useId(), profileId = useId();
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(query), 250); return () => window.clearTimeout(timer); }, [query]);
  const view = useResource(() => apiGet<SessionsView>('/api/sessions', { query: debounced, profile }), `${debounced}|${profile}`);

  async function resume(key: string, profileName: string, client: string) {
    try {
      const result = await apiPost<ClientActionResult>(`/api/profiles/${encodeURIComponent(profileName)}/clients`, { action: client === 'desktop' ? 'focus-desktop' : 'resume', session: key });
      setMessage({ status: result.status, text: result.message });
    } catch (error) { setMessage({ status: 'error', text: (error as Error).message }); }
  }

  return (
    <Page current="sessions" title="Browse sessions">
      <PageTitle title="Browse sessions" subtitle="Recent work from every profile. Resume a session in its own profile, or start a comparison from it." />
      {info?.mode === 'demo' ? <SimulatedNote /> : null}
      {message ? <div role="status" className={message.status === 'error' ? 'alert-error' : message.status === 'success' ? 'alert-success' : 'notice'}>{message.text}</div> : null}
      {view.data?.partial ? (
        <InfoNotice title="Partly listed"><p>{view.data.partial.text}</p>
          <Disclosure label="How to allow access" expandedLabel="Hide how to allow access"><p>{view.data.partial.help}</p></Disclosure></InfoNotice>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[220px]">
          <label htmlFor={searchId} className="field-label">Search task text or project</label>
          <input id={searchId} type="search" className="input" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="min-w-[180px]">
          <label htmlFor={profileId} className="field-label">Profile</label>
          <select id={profileId} className="input" value={profile} onChange={event => setProfile(event.target.value)}>
            <option value="">All profiles</option>
            {view.data?.profiles.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      </div>
      {view.error ? <LoadError error={view.error} onRetry={view.reload} /> : null}
      {view.loading && !view.data ? <Loading label="Reading sessions…" /> : null}
      {view.data ? (
        view.data.sessions.length ? (
          <ul className="panel p-0 list-none" aria-label="Sessions">
            {view.data.sessions.map(row => (
              <li key={row.key} className="flex flex-wrap items-center gap-3 px-4 py-3 border-b last:border-b-0" style={{ borderColor: 'var(--color-divider)' }}>
                <div className="flex flex-col gap-1 flex-1 min-w-[240px]">
                  <span className="font-medium wrap-anywhere">{row.title}</span>
                  <span className="hint"><span className="font-medium" style={{ color: 'var(--color-text)' }}>{row.profile}</span>{` · ${row.clientText} · ${row.project} · ${row.recordedAt} · ${row.turns} · `}
                    <span className={cn(row.history !== 'complete' && 'font-medium')}>{row.historyText.toLowerCase()}</span></span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link className="btn" to={`/compare/sessions?left=${encodeURIComponent(row.key)}`} state={{ leftSession: row }} aria-label={`Compare ${row.title} (${row.profile}) with another session`}>Compare with…</Link>
                  {row.startedHere ? <Link className="btn" to={row.startedHere.reportHref}>Open its report</Link>
                    : info?.features.clientControls ? (
                      <Button onClick={() => void resume(row.key, row.profile, row.client)}>{row.client === 'desktop' ? 'Show in Codex Desktop' : 'Resume in Codex…'}</Button>
                    ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : <div className="panel"><p>{debounced || profile ? 'No sessions match.' : 'No sessions found yet.'}</p></div>
      ) : null}
      <p className="hint">Resume reopens a session in its own profile and client. Browsing and comparing never resume or start anything.</p>
    </Page>
  );
}
