import { useId, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import type { NativeAppEntry, NativeAppOpenResult, NativeAppsView } from '@/api/types';
import { LoadError } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';

export function NativeApps() {
  const [busy, setBusy] = useState<NativeAppEntry['client'] | null>(null);
  const apps = useResource(({ background }) => apiGet<NativeAppsView>(`/api/apps${background ? '' : '?fresh=1'}`), 'native-apps', { live: true, paused: busy !== null });
  const pending = useRef(false);
  const sessionInputId = useId();
  const [sessionId, setSessionId] = useState('');
  const [openingSession, setOpeningSession] = useState(false);
  const sessionValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const available = apps.data?.apps.filter(app => app.status === 'available' && app.appKey) ?? [];

  async function open(app: NativeAppEntry, session?: string) {
    if (pending.current || apps.error || apps.loading || !app.appKey || (session !== undefined
      && (app.client !== 'copilot' || app.sessionNavigation !== 'available' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(session)))) return;
    pending.current = true;
    setBusy(app.client); setOpeningSession(session !== undefined); setMessage(null);
    try {
      const result = await apiPost<NativeAppOpenResult>('/api/apps/open', { client: app.client, appKey: app.appKey, ...(session !== undefined ? { sessionId: session } : {}) });
      setMessage({ error: false, text: result.message });
    } catch (error) {
      setMessage({ error: true, text: `${(error as Error).message} Check apps again before retrying.` });
      apps.reload();
    } finally { pending.current = false; setBusy(null); setOpeningSession(false); }
  }

  if (!available.length && !apps.error && !message) return null;
  return <section className="native-apps flex flex-col gap-3" aria-labelledby="native-apps-heading">
    <h3 id="native-apps-heading" className="text-body font-semibold">Native apps</h3>
    <p className="text-ui">These controls open an app with its existing setup. Use a profile’s Desktop row for separate storage. Desktop sign-in and task execution remain unverified.</p>
    {available.length ? <ul className="native-app-list">
      {available.map(app => <li key={app.client} className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0"><p className="font-medium">{app.name}</p>
            {app.version || app.build ? <p className="hint">{app.version ? `Version ${app.version}` : ''}{app.build ? ` · Build ${app.build}` : ''}</p> : null}</div>
          <Button onClick={() => void open(app)} disabled={busy !== null || Boolean(apps.error) || apps.loading} busy={busy === app.client && !openingSession} busyLabel={`Opening ${app.name}…`}>Open {app.name}</Button>
        </div>
        {app.client === 'copilot' && app.sessionNavigation === 'available' ? <details>
          <summary className="text-ui cursor-pointer">Open an existing Copilot session</summary>
          <form className="mt-3 flex min-w-0 flex-col gap-3" onSubmit={event => { event.preventDefault(); if (sessionValid) void open(app, sessionId); }}>
            <div>
              <label className="field-label" htmlFor={sessionInputId}>Copilot app-local session ID</label>
              <input id={sessionInputId} className="input font-mono" value={sessionId} onChange={event => setSessionId(event.target.value)}
                required pattern="[A-Za-z0-9]([A-Za-z0-9_]|-){0,127}" autoComplete="off" spellCheck={false}
                disabled={busy !== null || Boolean(apps.error) || apps.loading} aria-invalid={sessionId.length > 0 && !sessionValid ? true : undefined} aria-describedby={`${sessionInputId}-hint`} />
              <p id={`${sessionInputId}-hint`} className="hint">Use the app-local ID. GitHub task and runtime IDs aren’t interchangeable. Use up to 128 letters, numbers, underscores or hyphens; start with a letter or number.</p>
            </div>
            <Button type="submit" className="self-start max-w-full" disabled={busy !== null || Boolean(apps.error) || apps.loading} busy={busy === app.client && openingSession}
              busyLabel="Opening existing session link…">Open existing session link</Button>
          </form>
        </details> : null}
      </li>)}
    </ul> : null}
    {message ? <p className={message.error ? 'alert-error' : 'notice'} role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
    {apps.error ? <><p className="hint">{apps.data ? 'Previous app findings are shown. ' : ''}Opening is unavailable until a check succeeds. Checks retry automatically.</p><LoadError error={apps.error} onRetry={apps.reload} /></> : <div><Button onClick={apps.reload} disabled={apps.loading || busy !== null}>Check apps again</Button></div>}
  </section>;
}
